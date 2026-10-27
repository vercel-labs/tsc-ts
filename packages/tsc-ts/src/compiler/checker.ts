// The type checker: one `Checker` per program (or per partition of its files), holding the
// type system's caches and the diagnostics it reports.
//
// The checker's logic lives in free functions taking the checker first, grouped by area:
//
// | Module                          | Area                                                    |
// | ------------------------------- | ------------------------------------------------------- |
// | checker-type-factory.ts         | creating and interning types (unions, literals, tuples) |
// | checker-symbols.ts              | merging, aliases, exports, name resolution              |
// | checker-modules.ts              | module resolution, import and export aliases            |
// | checker-declared-types.ts       | declared types of classes, interfaces, aliases, enums   |
// | checker-type-nodes.ts           | `getTypeFromTypeNode`                                   |
// | checker-symbol-types.ts         | types of values: variables, parameters, properties      |
// | checker-members.ts              | members, signatures, index infos, apparent types        |
// | instantiation.ts                | mappers and `instantiateType`                           |
// | relations.ts                    | assignability, comparability, subtype, identity         |
// | type-printer.ts                 | `typeToString`, `symbolToString`, `signatureToString`   |
// | checker-source-file.ts          | `checkSourceFile` and statement dispatch                |
// | checker-expressions.ts          | expressions                                             |
// | checker-calls.ts                | call resolution                                         |
// | checker-statements.ts           | statements                                              |
// | checker-declarations.ts         | variable, function and type declarations                |
// | checker-overloads.ts            | overloads and implementations                           |
// | checker-classes.ts              | classes and interfaces                                  |
// | checker-heritage.ts             | base types, overrides, index constraints, duplicates    |
// | checker-jsx.ts                  | JSX                                                     |
// | checker-javascript.ts           | CommonJS, expando and `this.x` assignment declarations  |
// | checker-jsdoc.ts                | JSDoc type references, `@type` on functions, `@param`   |
// | checker-elaboration.ts          | reporting relation errors at the failing subexpression  |
// | checker-grammar.ts              | grammar checks                                          |
// | checker-flow.ts                 | control flow narrowing                                  |
import type { ModuleSpecifierResult } from './node-builder-names.js';
import type { EmitHelperFileLinks } from './checker-emit-helpers.js';
import { sideOf } from './side-state.js';
import type { Node, PatternAmbientModule, SourceFile } from './ast.js';
import { CompactSymbolLinkTable, IntLinkTable, LinkTable, PagedIdSet, SparseLinkTable } from './link-tables.js';
import { getErrorRangeForNode, getSourceFileOfNode } from './binder-utilities.js';
import {
  Diagnostic,
  type DiagnosticMessage,
  Diagnostics,
  compareDiagnostics,
  equalDiagnostics,
} from './diagnostics.js';
import {
  type CompilerOptions,
  ModuleKind,
  ScriptTarget,
  getEmitScriptTarget,
  getIsolatedModules,
  getStrictOptionValue,
  shouldPreserveConstEnums,
} from './options.js';
import { CheckFlags, Symbol, SymbolFlags, type SymbolTable, getSymbolId } from './symbol.js';
import {
  IndexInfo,
  IntrinsicType,
  LiteralType,
  MemberNames,
  NodeLinks,
  ObjectFlags,
  ObjectType,
  Signature,
  SignatureFlags,
  SymbolLinks,
  type Type,
  TypeFlags,
  TypeMapper,
  TypeParameter,
  TypePredicate,
  TypePredicateKind,
  emptyTypes,
  VarianceFlags,
  TypeListCache,
  TypeListTable,
  type ConditionalType,
  type InterfaceType,
  type TypeChecking,
} from './checker-types.js';
import { getBaseTypes } from './checker-declared-types.js';
import type { ModuleResolution } from './checker-modules.js';
import { getFalseTypeFromConditionalType, getTrueTypeFromConditionalType } from './checker-type-operators.js';
import {
  createArrayType,
  createTypeFromGenericGlobalType,
  getBigIntLiteralType,
  getNumberLiteralType,
  getStringLiteralType,
  getTemplateLiteralType,
  getUnionType,
  newAnonymousType,
  newObjectType,
} from './checker-type-factory.js';
import {
  CheckerNameResolver,
  type LibGlobals,
  type MergedGlobals,
  TableChanges,
  borrowLibGlobals,
  findLibGlobals,
  returnLibGlobals,
  setGlobal,
  SuggestionNameResolver,
  getGlobalStrictFunctionType,
  getGlobalType,
  initializeGlobals,
  mergeAmbientModulesAndAugmentations,
} from './checker-symbols.js';
import { PermissiveMapper, ReportingMapper, RestrictiveMapper, UniqueLiteralMapper } from './instantiation.js';
import {
  Relation,
  RelationKey,
  type InternedRelationKey,
  type Relater,
  TypeComparer,
  type VarianceStackEntry,
} from './relations.js';
import { TypeNodeVisitor, checkSourceFile, produceDeferredDiagnostics } from './checker-source-file.js';
import { checkObjectLiteralDeprecations } from './checker-deprecation.js';
import { InferenceCaches } from './checker-inference.js';
import { AssignmentMarker, type FlowLoopInfo, type FlowState, type FlowWalk } from './checker-narrowing.js';
import type { FlowNode, FlowReduceLabel } from './flow.js';
import { JsxState } from './checker-jsx.js';
import type { IterationTypes } from './checker-iteration.js';
import type { SpreadIndices } from './checker-contextual.js';
import { SourceFileMetadata, getEmitModuleFormatOfFile } from './program-utilities.js';
import type { GrammarChecker } from './checker-grammar.js';
import type { ResolvedModule } from './module-resolution-types.js';
import type { ModuleSpecifierHost } from './module-specifiers.js';
import type { PropertyListIndex } from './checker-members.js';

/** What the checker needs from a program. */
export abstract class CheckerHost {
  abstract getCompilerOptions(): CompilerOptions;
  /** Every file of the program, libraries first, in program order. */
  abstract getSourceFiles(): readonly SourceFile[];
  abstract isSourceFileDefaultLibrary(file: SourceFile): boolean;
  /** How a module name in `file` resolved in `mode`, if the program resolved it. */
  getResolvedModule(_file: SourceFile, _moduleName: string, _mode: ModuleKind): ResolvedModule | undefined {
    return undefined;
  }
  /** The program file for a resolved file name, following project reference redirects. */
  getSourceFileForResolvedModule(_fileName: string): SourceFile | undefined {
    return undefined;
  }
  /** The resolution mode of the module specifier `location` in `file`. */
  getModeForUsageLocation(_file: SourceFile, _location: Node): ModuleKind {
    return ModuleKind.None;
  }
  /** The resolution mode of module names in `file` without a specifier of their own. */
  getDefaultResolutionModeForFile(_file: SourceFile): ModuleKind {
    return ModuleKind.None;
  }
  /** Packages that modules resolved into, by name: whether any of their resolutions was a declaration file. */
  getPackagesMap(): ReadonlyMap<string, boolean> {
    return new Map<string, boolean>();
  }
  /** The declaration output of a referenced project's source file, or `''`. */
  getProjectReferenceOutputDts(_fileName: string): string {
    return '';
  }
  fileExists(_path: string): boolean {
    return false;
  }
  /** The synthetic specifier of a file's implicit JSX runtime import, such as `react/jsx-runtime`, if any. */
  /** The `tslib` import the program adds to `file` under --importHelpers. */
  getImportHelpersImportSpecifier(_file: SourceFile): Node | undefined {
    return undefined;
  }
  getJSXRuntimeImportSpecifier(_file: SourceFile): Node | undefined {
    return undefined;
  }
  /** The globals and module augmentations of the program, if a checker merged them for the others. */
  getMergedGlobals(): MergedGlobals | undefined {
    return undefined;
  }
  /** The format `file` is emitted in when it differs from `module`, else `None`. */
  getImpliedNodeFormatForEmit(_file: SourceFile): ModuleKind {
    return ModuleKind.None;
  }
  /** The module syntax (`ESNext` or `CommonJS`) of the import or export with module specifier `usage`. */
  getEmitSyntaxForUsageLocation(_file: SourceFile, _usage: Node): ModuleKind {
    return ModuleKind.None;
  }
  /** The `package.json` scope and implied module format of a file, if known. */
  getSourceFileMetadata(_file: SourceFile): SourceFileMetadata | undefined {
    return undefined;
  }
  /** The module format `file` is emitted in. */
  getEmitModuleFormatOfFile(file: SourceFile): ModuleKind {
    return getEmitModuleFormatOfFile(
      file.fileName,
      this.getCompilerOptions(),
      this.getSourceFileMetadata(file) ?? new SourceFileMetadata('', '', ModuleKind.None),
    );
  }
  /** What module specifier generation needs; without it, specifiers are relative paths. */
  getModuleSpecifierHost(): ModuleSpecifierHost | undefined {
    return undefined;
  }
}

/**
 * Per-file and global diagnostics, sorted on read like tsgo's DiagnosticsCollection, which keeps one of
 * each set of equal diagnostics.
 */
class DiagnosticCollection {
  private readonly byFile = new Map<string, Diagnostic[]>();
  private readonly sortedFiles = new Set<string>();
  private readonly global: Diagnostic[] = [];
  private globalSorted = true;
  /** The diagnostics at each file, position, end and code, to find an equal one when adding. */
  private readonly byLocation = new Map<string, Diagnostic[]>();
  /** The diagnostics reported since `startLog`, while recording, also those equal to one already added. */
  private log: Diagnostic[] | undefined = undefined;

  /** Adds `diagnostic` unless an equal one was added; returns the one the collection holds. */
  add(diagnostic: Diagnostic): Diagnostic {
    if (this.log !== undefined) this.log.push(diagnostic);
    const file = diagnostic.file;
    const key = `${file === undefined ? '' : file.fileName}\0${diagnostic.pos}\0${diagnostic.end}\0${diagnostic.code}`;
    const existing = this.byLocation.get(key);
    if (existing === undefined) this.byLocation.set(key, [diagnostic]);
    else {
      for (const d of existing) if (equalDiagnostics(d, diagnostic)) return d;
      existing.push(diagnostic);
    }
    if (file === undefined) {
      this.global.push(diagnostic);
      this.globalSorted = false;
      return diagnostic;
    }
    let list = this.byFile.get(file.fileName);
    if (list === undefined) {
      list = [];
      this.byFile.set(file.fileName, list);
    }
    list.push(diagnostic);
    this.sortedFiles.delete(file.fileName);
    return diagnostic;
  }

  forFile(fileName: string): Diagnostic[] {
    const list = this.byFile.get(fileName);
    if (list === undefined) return [];
    if (!this.sortedFiles.has(fileName)) {
      stableSort(list);
      this.sortedFiles.add(fileName);
    }
    return list.slice();
  }

  count(): number {
    let count = this.global.length;
    for (const list of this.byFile.values()) count += list.length;
    return count;
  }

  /** An already reported diagnostic equal to `diagnostic`, if any. */
  lookup(diagnostic: Diagnostic): Diagnostic | undefined {
    const file = diagnostic.file;
    const list = file === undefined ? this.global : this.byFile.get(file.fileName);
    if (list === undefined) return undefined;
    for (const d of list) if (compareDiagnostics(d, diagnostic) === 0) return d;
    return undefined;
  }

  globals(): Diagnostic[] {
    if (!this.globalSorted) {
      stableSort(this.global);
      this.globalSorted = true;
    }
    return this.global.slice();
  }

  /** The global diagnostics `withoutNewGlobals` removed. */
  removedGlobals = 0;

  /** Runs `run`, then removes the global diagnostics it added. */
  withoutNewGlobals<T>(run: () => T): T {
    const outer = this.log;
    const added: Diagnostic[] = [];
    this.log = added;
    try {
      return run();
    } finally {
      this.log = outer;
      if (outer !== undefined) for (const d of added) outer.push(d);
      const globals = new Set<Diagnostic>();
      for (const d of added) if (d.file === undefined) globals.add(d);
      if (globals.size > 0) {
        let kept = 0;
        for (const d of this.global) {
          if (!globals.has(d)) this.global[kept++] = d;
          else this.forget(d);
        }
        this.removedGlobals += this.global.length - kept;
        this.global.length = kept;
      }
    }
  }

  /** Removes the global diagnostic `diagnostic` from the location index. */
  private forget(diagnostic: Diagnostic): void {
    const key = `\0${diagnostic.pos}\0${diagnostic.end}\0${diagnostic.code}`;
    const existing = this.byLocation.get(key);
    if (existing === undefined) return;
    const at = existing.indexOf(diagnostic);
    if (at >= 0) existing.splice(at, 1);
  }

  /** Records the diagnostics added from now on. */
  startLog(): void {
    this.log = [];
  }

  /** The diagnostics added since `startLog`, in order; stops recording. */
  takeLog(): Diagnostic[] {
    const log = this.log!;
    this.log = undefined;
    return log;
  }
}

function stableSort(list: Diagnostic[]): void {
  // Array.prototype.sort is stable.
  list.sort(compareDiagnostics);
}

/** Maximum depth of nested `typeToString` calls before diagnostics are discarded. */
export const maxSerializationLevel = 2;

/**
 * File positions per symbol id in `ExternalModuleContainerIndex.keys`. Symbol ids are int32, so the
 * keys stay exact.
 */
export const fileIndexScale = 2 ** 21;

/** The modules that export each symbol, built once from every module's exports. */
export class ExternalModuleContainerIndex {
  complete = false;
  /**
   * One key per symbol and module that exports it, ascending: the id of the symbol the export
   * resolves to times `fileIndexScale`, plus the module's file position in `Checker.files`. The
   * keys of one symbol are contiguous and in program order.
   */
  keys: number[] = [];
}

/** The checker's caches for symbol accessibility. */
export class SymbolAccessibilityCaches {
  /** Accessible chains by symbol id, then by `chainCacheKey`. */
  readonly accessibleChains = new Map<number, Map<string, Symbol[]>>();
  /** Alias symbols of large tables (globals and exports), by table id. */
  readonly tableAliases = new Map<number, Symbol[]>();
  /** Modules imported by a file that export a symbol, by symbol id then file node id. */
  readonly containersByFile = new Map<number, Map<number, Symbol[]>>();
  /** All modules that export a symbol, by symbol id. */
  readonly containers = new Map<number, Symbol[]>();
  /** The modules each symbol is exported from, built on the first search of all modules. */
  externalModuleContainers: ExternalModuleContainerIndex | undefined = undefined;
  /** The name tables of named class expressions, by node id. */
  readonly classExpressionNames = new Map<number, SymbolTable>();
  /** Computed declaration visibility by node id (see isDeclarationVisible), 0 if not computed. */
  readonly declarationVisibility = new IntLinkTable();
  /** The checker slots (bit `slot + 1`) whose declaration emit marked a node visible, by node id. */
  readonly markedSlots = new IntLinkTable();
  /** The checker slot of the file in declaration emit, -1 before declaration emit. */
  markedSlot = -1;
  /** Counts the times declaration emit left a checker slot. */
  visibilityEpoch = 0;
  /** The epoch at which each slot (index `slot + 1`) was last left. */
  readonly slotsLeftAt: number[] = [0, 0, 0, 0, 0];
}

export class Checker implements TypeChecking {
  readonly host: CheckerHost;
  readonly compilerOptions: CompilerOptions;
  readonly files: readonly SourceFile[];
  readonly fileIndex: Map<SourceFile, number>;
  readonly languageVersion: ScriptTarget;
  readonly strictNullChecks: boolean;
  readonly strictFunctionTypes: boolean;
  readonly strictBindCallApply: boolean;
  readonly strictPropertyInitialization: boolean;
  readonly strictBuiltinIteratorReturn: boolean;
  readonly noImplicitAny: boolean;
  readonly noImplicitThis: boolean;
  readonly legacyDecorators: boolean;
  readonly useUnknownInCatchVariables: boolean;
  readonly exactOptionalPropertyTypes: boolean;
  readonly isolatedModules: boolean;
  readonly preserveConstEnums: boolean;
  readonly noUncheckedIndexedAccess: boolean;

  // Counters for type and signature ids.
  typeCount = 0;
  signatureCount = 0;
  /** Positions of members by name in the tables and lists that lazily instantiated members come from. */
  readonly memberPositionsInLists = new Map<Symbol[], Map<string, number>>();
  /** The property names of the last instantiation of each such list whose table is built on demand. */
  readonly memberNamesOfLists = new Map<Symbol[], MemberNames>();
  /** Long lists of inherited properties, by name. */
  readonly propertiesByName = new Map<Symbol[], Map<string, Symbol>>();
  /** Number of `typeToString` calls in progress. */
  serializationLevel = 0;
  /**
   * `typeToString` results by type, enclosing declaration and flags: the prints that created no types, which a
   * later print with the same inputs repeats exactly (`typeToString`).
   */
  readonly typeStrings = new Map<string, string>();
  /** `symbolToString` results by symbol, then by enclosing declaration and flags, kept as `typeStrings` are. */
  readonly symbolStrings = new Map<Symbol, Map<string, string>>();
  /** Whether `globalObjectType` is set; global type lookups before it can't suggest `typeof`. */
  hasGlobalObjectType = false;
  /** The node being checked, for errors with no better location. */
  currentNode: Node | undefined = undefined;

  readonly diagnostics = new DiagnosticCollection();
  readonly suggestionDiagnostics = new DiagnosticCollection();
  /** Diagnostics and suggestions reported so far, whether kept or not (`resolveExternalModule`'s cache). */
  reports = 0;
  /** `resolveExternalModule` results that reported nothing, by module specifier (checker-modules.ts). */
  readonly moduleResolutions = new Map<Node, ModuleResolution>();
  /**
   * Whether ambient modules and module augmentations are merged. Merging can give a module a new
   * merged symbol, so `resolveExternalModule` keeps results only from then on.
   */
  modulesMerged = false;
  /** Module specifiers of `import("…")` types, by module symbol id, importing file path and resolution mode. */
  readonly moduleSpecifiers = new Map<string, ModuleSpecifierResult>();
  /** Specifier generation for hosts without a program. */
  fallbackModuleSpecifierHost: ModuleSpecifierHost | undefined = undefined;

  // Links of symbols and nodes by symbol and node id (see link-tables.ts). Values that many symbols
  // or nodes have are columns of their own; the rest share one links object per symbol or node,
  // created on first use.
  readonly symbolLinkTable = new SparseLinkTable<SymbolLinks>();
  readonly nodeLinkTable = new SparseLinkTable<NodeLinks>();
  /** The holders of the lazily computed state of types with side state (`sideOf`), by type id. */
  readonly sideHolders = new LinkTable<Type>();
  /** The same for signatures with side state (`signatureSideOf`), by signature id. */
  readonly signatureSideHolders = new LinkTable<Signature>();
  /**
   * The indexes of long property lists that `propertiesRelatedTo` walks; before a list is indexed, its uses
   * so far; null where a list repeats a name.
   */
  readonly propertyListIndexes = new Map<Symbol[], PropertyListIndex | number | null>();
  /** The type of a value symbol. */
  readonly symbolTypes = new LinkTable<Type>();
  /** For instantiated and synthetic symbols, the symbol they come from. */
  readonly symbolTargets = new LinkTable<Symbol>();
  /** The mapper of an instantiated symbol or a mapped type property. */
  readonly symbolMappers = new LinkTable<TypeMapper>();
  /** The literal type of a property name. */
  readonly symbolNameTypes = new LinkTable<Type>();
  /** The mapped type of a mapped type property, or the union/intersection of a synthetic property. */
  readonly symbolContainingTypes = new LinkTable<Type>();
  /** The key type of a mapped type property. */
  readonly symbolKeyTypes = new LinkTable<Type>();
  /** The property a mapped, spread or synthetic property comes from. */
  readonly symbolSyntheticOrigins = new LinkTable<Symbol>();
  /** The left and right properties a spread property combines. */
  readonly symbolLeftSpreads = new LinkTable<Symbol>();
  readonly symbolRightSpreads = new LinkTable<Symbol>();
  /** Bits of SymbolFlags for the meanings in which a symbol was referenced. */
  readonly symbolReferenceKinds = new IntLinkTable();
  /** The resolved symbol of an identifier, entity name or call. */
  readonly resolvedSymbols = new CompactSymbolLinkTable();
  /** The resolved type of a type node or expression. */
  readonly resolvedTypes = new SparseLinkTable<Type>();
  /** The resolved signature of a call-like node or a signature declaration. */
  readonly resolvedSignatures = new SparseLinkTable<Signature>();
  /** Merged symbols, indexed by the id of the symbol merged into them. */
  readonly mergedSymbols: Map<number, Symbol>;
  /**
   * The ids that `mergedSymbols` has, or had: most symbols are merged into none, and `getMergedSymbol`
   * finds that here without probing the map.
   */
  readonly mergedSymbolIds = new PagedIdSet();
  /** Globals merged from the default libraries, shared with other checkers. */
  libGlobals: LibGlobals | undefined;
  /** The program's globals and module augmentations as another checker merged them, shared with it. */
  mergedGlobals: MergedGlobals | undefined;
  /**
   * The diagnostics and suggestions the merges reported: those of the globals, then those of the
   * ambient modules and module augmentations.
   */
  readonly mergeDiagnostics: Diagnostic[][] = [];
  /**
   * This checker's changes to `globals` and `mergedSymbols` when it uses the tables of
   * `libGlobals` in place rather than copies; they are undone when it is disposed.
   */
  globalChanges: TableChanges<string, Symbol> | undefined = undefined;
  mergedSymbolChanges: TableChanges<number, Symbol> | undefined = undefined;
  /** This checker's copies of shared symbols, and the symbols they stand for. */
  readonly sharedSymbolCopies = new Map<Symbol, Symbol>();
  /** Accessible symbol chains and declaration visibility, created on first use. */
  symbolAccessibilityCaches: SymbolAccessibilityCaches | undefined = undefined;

  // Symbols
  readonly globals: SymbolTable;
  readonly resolver: CheckerNameResolver;
  readonly undefinedSymbol: Symbol;
  readonly argumentsSymbol: Symbol;
  readonly requireSymbol: Symbol;
  readonly unknownSymbol: Symbol;
  readonly globalThisSymbol: Symbol;
  readonly unresolvedSymbols = new Map<string, Symbol>();
  /** Widening's optional `undefined` properties by the id of the property each is created from. */
  readonly undefinedProperties = new Map<number, Symbol>();

  // Interning tables.
  readonly stringLiteralTypes = new Map<string, LiteralType>();
  readonly numberLiteralTypes = new Map<number, LiteralType>();
  readonly bigintLiteralTypes = new Map<string, LiteralType>();
  readonly enumLiteralTypes = new Map<string, LiteralType>();
  readonly uniqueESSymbolTypes = new Map<Symbol, Type>();
  /** Unions by a hash of their key; `unionTypes` holds the unions whose key hash was taken. */
  readonly unionTypesByHash = new Map<number, Type>();
  readonly unionTypes = new Map<string, Type>();
  readonly unionOfUnionTypes = new Map<string, Type>();
  /** `unionOfUnionTypes` without an alias, by both ids and the reduction packed into one number. */
  readonly unionOfUnionTypesById = new Map<number, Type>();
  readonly intersectionTypes = new TypeListCache<Type>();
  readonly tupleTypes = new Map<string, Type>();
  readonly indexedAccessTypes = new Map<string, Type>();
  readonly templateLiteralTypes = new Map<string, Type>();
  /** Instantiations of template literal types: the instantiated types, tagged with the template's id. */
  readonly templateLiteralInstantiations = new TypeListCache<Type>();
  /** The type argument lists that references and instantiations keep, one of each (`TypeListTable`). */
  readonly typeLists = new TypeListTable();
  readonly stringMappingTypes = new Map<string, Type>();
  readonly substitutionTypes = new Map<string, Type>();
  readonly subtypeReductionCache = new TypeListCache<Type[]>();
  readonly cachedTypes = new Map<string, Type>();
  /** Cached types by `cachedTypeKey` and by `cachedTypePairKey`, without spelled keys. */
  readonly cachedTypesById = new Map<number, Type>();
  readonly cachedTypesByPair = new Map<number, Type>();
  readonly errorTypes = new Map<string, Type>();

  // Intrinsic types, created in tsgo's order so ids (the last-resort union order) match.
  readonly anyType: IntrinsicType;
  readonly autoType: IntrinsicType;
  readonly wildcardType: IntrinsicType;
  readonly blockedStringType: IntrinsicType;
  readonly errorType: IntrinsicType;
  readonly unresolvedType: IntrinsicType;
  readonly nonInferrableAnyType: IntrinsicType;
  readonly intrinsicMarkerType: IntrinsicType;
  readonly unknownType: IntrinsicType;
  readonly undefinedType: IntrinsicType;
  readonly undefinedWideningType: IntrinsicType;
  readonly missingType: IntrinsicType;
  readonly undefinedOrMissingType: IntrinsicType;
  readonly optionalType: IntrinsicType;
  readonly nullType: IntrinsicType;
  readonly nullWideningType: IntrinsicType;
  readonly stringType: IntrinsicType;
  readonly numberType: IntrinsicType;
  readonly bigintType: IntrinsicType;
  readonly regularFalseType: LiteralType;
  readonly falseType: LiteralType;
  readonly regularTrueType: LiteralType;
  readonly trueType: LiteralType;
  readonly booleanType: Type;
  readonly esSymbolType: IntrinsicType;
  readonly voidType: IntrinsicType;
  readonly neverType: IntrinsicType;
  readonly silentNeverType: IntrinsicType;
  readonly implicitNeverType: IntrinsicType;
  readonly unreachableNeverType: IntrinsicType;
  readonly nonPrimitiveType: IntrinsicType;
  readonly stringOrNumberType: Type;
  readonly stringNumberSymbolType: Type;
  readonly numberOrBigIntType: Type;
  readonly numericStringType: Type;
  readonly templateConstraintType: Type;
  readonly uniqueLiteralType: IntrinsicType;
  readonly emptyObjectType: ObjectType;
  readonly emptyJsxObjectType: ObjectType;
  readonly emptyFreshJsxObjectType: ObjectType;
  readonly emptyTypeLiteralType: ObjectType;
  readonly unknownEmptyObjectType: ObjectType;
  readonly unknownUnionType: Type;
  readonly emptyGenericType: ObjectType;
  readonly anyFunctionType: ObjectType;
  readonly noConstraintType: ObjectType;
  readonly circularConstraintType: ObjectType;
  readonly resolvingDefaultType: ObjectType;
  readonly markerSuperType: TypeParameter;
  readonly markerSubType: TypeParameter;
  readonly markerOtherType: TypeParameter;
  readonly markerSuperTypeForCheck: TypeParameter;
  readonly markerSubTypeForCheck: TypeParameter;
  readonly noTypePredicate: TypePredicate;
  readonly anySignature: Signature;
  readonly unknownSignature: Signature;
  readonly resolvingSignature: Signature;
  readonly silentNeverSignature: Signature;
  readonly enumNumberIndexInfo: IndexInfo;
  readonly anyBaseTypeIndexInfo: IndexInfo;
  readonly emptyStringType: Type;
  readonly zeroType: Type;
  readonly zeroBigIntType: Type;
  readonly typeofType: Type;

  // Mappers that observe the types they map.
  readonly reportUnreliableMapper: TypeMapper;
  readonly reportUnmeasurableMapper: TypeMapper;
  readonly restrictiveMapper: TypeMapper;
  readonly permissiveMapper: TypeMapper;
  readonly uniqueLiteralMapper: TypeMapper;
  /** Set by the reporting mappers during variance measurement. */
  reliabilityFlags = 0;

  // Relations
  readonly subtypeRelation = new Relation();
  readonly strictSubtypeRelation = new Relation();
  readonly assignableRelation = new Relation();
  readonly comparableRelation = new Relation();
  readonly identityRelation = new Relation();
  readonly enumRelation = new Map<string, number>();
  /** A relater that is not in use, kept so that relation checks don't allocate one each. */
  spareRelater: Relater | undefined = undefined;

  // Global types, set by `initializeChecker`.
  globalArrayType: Type;
  globalObjectType: Type;
  globalFunctionType: Type;
  globalCallableFunctionType: Type;
  globalNewableFunctionType: Type;
  globalStringType: Type;
  globalNumberType: Type;
  globalBooleanType: Type;
  globalRegExpType: Type;
  anyArrayType: Type;
  autoArrayType: Type;
  globalReadonlyArrayType: Type;
  anyReadonlyArrayType: Type;
  globalThisType: Type;
  /** Lazily resolved global types and symbols, by name. */
  readonly globalTypeCache = new Map<string, Map<number, Type>>();
  /** Module namespace types with synthetic defaults, by kind and type id. */
  readonly moduleTypeCache = new Map<string, Type>();
  readonly globalSymbolCache = new Map<string, Symbol | null>();

  // Resolution stacks for cycle detection (see pushTypeResolution).
  resolutionStart = 0;
  /** The generic types whose variances are being computed, outermost first. */
  varianceStack: VarianceStackEntry[] = [];

  // Instantiation
  instantiationDepth = 0;
  /** The types being instantiated, outermost first: the first `instantiationDepth` entries are current. */
  readonly instantiationStack: Type[] = [];
  /** The calls being resolved, outermost first: the first `callResolutionDepth` entries are current. */
  readonly callResolutionStack: Node[] = [];
  callResolutionDepth = 0;
  instantiationCount = 0;
  /** Instantiations over the checker's lifetime (statistics). */
  totalInstantiations = 0;
  /** Ids of the mappers of the instantiations in progress: the first `activeMapperDepth` entries are live. */
  activeMapperIds = new Int32Array(16);
  activeMapperDepth = 0;
  /** Per active mapper: its instantiations by type id, created on the first nested write. */
  readonly activeMapperCaches: (Map<number, Type> | undefined)[] = [];
  /** Per active mapper: its instantiations with an alias, by type id and alias key. */
  readonly activeMapperAliasCaches: (Map<string, Type> | undefined)[] = [];
  /**
   * Cleared caches of popped mappers, reused as tsgo's pushActiveMapper reuses the maps
   * popActiveMapper clears: the first `freeMapperCacheCount` are free.
   */
  readonly freeMapperCaches: Map<number, Type>[] = [];
  freeMapperCacheCount = 0;
  /** Empty lists for type arguments that are compared with cached instantiations before any is kept. */
  readonly freeTypeLists: Type[][] = [];
  /**
   * 1 by type id for the anonymous and mapped types whose declaration has no outer type parameters
   * to instantiate (`getObjectTypeInstantiation`).
   */
  readonly withoutOuterTypeParameters = new IntLinkTable();
  conditionalConstraintDepth = 0;

  readonly suggestionResolver: SuggestionNameResolver;
  readonly awaitedTypeStack: number[] = [];
  /** Iteration types by type id and iteration use. */
  readonly iterationTypesCache = new Map<number, IterationTypes>();
  /**
   * Diagnostics reported after the checks of the file being checked, or before the next global
   * diagnostics are read, in the order they were deferred. Reporting them earlier could resolve types
   * that are being resolved.
   */
  deferredDiagnostics: (() => void)[] = [];
  /**
   * The checked object literals of each file whose members may set deprecated properties of their contextual
   * types, reported when the file's suggestion diagnostics are asked for (`checkObjectLiteralDeprecations`).
   */
  readonly objectLiteralsForDeprecations = new Map<SourceFile, Node[]>();
  /** Binding patterns whose implied type is being computed as a contextual type. */
  readonly contextualBindingPatterns: Node[] = [];
  /** The binding pattern or assignment pattern that implied each type. */
  readonly patternForType = new Map<Type, Node>();
  /** Spread element indices of array literals with contextually typed elements. */
  readonly spreadIndices = new Map<Node, SpreadIndices>();
  /** Instantiation expression types by node and expression type id. */
  readonly instantiationExpressionTypes = new Map<string, Type>();
  relationComparers: TypeComparer[] = [];
  readonly relationScratchKey = new RelationKey();
  /** Numbers for relation keys that are spelled as strings (see getRelationKey). */
  readonly relationKeyIds = new Map<string, number>();
  /** Numbers for generic relation keys spelled as tokens, by a hash of the tokens. */
  readonly relationKeyTokens = new Map<number, InternedRelationKey>();
  /** The number of interned relation keys of both kinds. */
  relationKeyCount = 0;
  readonly markerTypes = new Set<Type>();
  readonly arrayVariances: VarianceFlags[] = [VarianceFlags.Covariant];
  nanLiteralType: LiteralType | undefined = undefined;
  /** `{ meta: ImportMeta }`, the type of `import.meta` for symbol queries. */
  importMetaExpressionType: Type | undefined = undefined;

  // Control flow analysis
  flowAnalysisDisabled = false;
  inlineLevel = 0;
  /**
   * Shared flow nodes cached by the walks in progress, with their types: the first
   * `sharedFlowCount` entries are live, later slots are reused.
   */
  readonly sharedFlowNodes: FlowNode[] = [];
  readonly sharedFlowTypes: Type[] = [];
  readonly sharedFlowIncomplete: boolean[] = [];
  sharedFlowCount = 0;
  /**
   * For each walk in progress, by its depth (`flowStateDepth`), once it has cached
   * `sharedFlowIndexThreshold` shared nodes: the index of each node's first entry in the cache above.
   */
  readonly sharedFlowIndexes: Map<FlowNode, number>[] = [];
  /**
   * Flow states, reused as in tsgo's getFlowState/putFlowState: the first `flowStateDepth` belong
   * to walks in progress, the rest are free.
   */
  readonly flowStates: FlowState[] = [];
  flowStateDepth = 0;
  readonly flowLoopCaches = new Map<FlowNode, Map<string, Type>>();
  /** The last long walk of each reference key outside loops: see `FlowWalk`. */
  readonly flowWalks = new Map<string, FlowWalk>();
  flowLoopStack: FlowLoopInfo[] = [];
  /** Types of expressions whose computation needed flow analysis, outside loop back edges. */
  flowTypeCache: Map<Node, Type> | undefined = undefined;
  flowInvocationCount = 0;
  /** The reduce labels being passed, innermost last; each limits its target label's antecedents. */
  flowReduceLabels: FlowReduceLabel[] = [];
  readonly flowNodeReachable = new Map<FlowNode, boolean>();
  readonly flowNodePostSuper = new Map<FlowNode, boolean>();
  lastFlowNode: FlowNode | undefined = undefined;
  lastFlowNodeReachable = false;
  /** Symbols whose explicit type is being found, for flow analysis of self-referential `for...of`. */
  readonly resolvingExplicitTypeOfSymbol = new Set<Symbol>();
  readonly assignmentMarker: AssignmentMarker;
  readonly primitiveTypeAliasSuggestions = new Map<string, Symbol>();

  /** Renamed binding elements in parameters of bodiless signatures, checked for use with their file. */
  readonly renamedBindingElementsInTypes: Node[] = [];
  /** The type parameter whose variance annotation is being checked, to name its marker types. */
  varianceTypeParameter: Type | undefined = undefined;
  /** Whether the statement being checked is unreachable, to report unreachable code once. */
  withinUnreachableCode = false;
  readonly reportedUnreachableNodes = new Set<Node>();
  /** The grammar checker of the file whose expressions are being checked. */
  grammarChecker: GrammarChecker | undefined = undefined;
  /** Nodes queued for a deferred check (checkNodeDeferred), each checked once. */
  readonly deferredNodeIds = new Set<number>();
  readonly typeNodeVisitor: TypeNodeVisitor;

  readonly jsx = new JsxState();
  /** Per file: its tslib module and the emit helpers checked against it (checkExternalEmitHelpers). */
  readonly emitHelperFileLinks = new Map<SourceFile, EmitHelperFileLinks>();
  /** The file checkSourceFile is checking. */
  fileBeingChecked: SourceFile | undefined = undefined;

  // Ambient modules
  readonly ambientModuleSymbols: Symbol[] = [];
  readonly patternAmbientModules: PatternAmbientModule[] = [];
  readonly patternAmbientModuleAugmentations = new Map<string, Symbol>();
  /** The pattern module each entry of `patternAmbientModuleAugmentations` augments. */
  readonly patternAmbientModuleAugmentationTargets = new Map<string, Symbol>();
  readonly moduleImportAttributesTypes = new Map<Symbol, Type>();

  readonly inferenceCaches = new InferenceCaches();
  /** The type resolution stack: the first `resolutionDepth` entries are live, later slots are reused. */
  readonly resolutionTargets: (Symbol | Type | Signature | Node)[] = [];
  readonly resolutionResults: boolean[] = [];
  readonly resolutionPropertyNames: number[] = [];
  resolutionDepth = 0;
  /** The number of resolution cycles found (`pushTypeResolution`). */
  resolutionCycleCount = 0;

  constructor(host: CheckerHost) {
    this.host = host;
    const options = host.getCompilerOptions();
    this.compilerOptions = options;
    this.files = host.getSourceFiles();
    this.fileIndex = new Map<SourceFile, number>();
    for (let i = 0; i < this.files.length; i++) this.fileIndex.set(this.files[i]!, i);
    this.languageVersion = getEmitScriptTarget(options);
    this.strictNullChecks = getStrictOptionValue(options, options.strictNullChecks);
    this.strictFunctionTypes = getStrictOptionValue(options, options.strictFunctionTypes);
    this.strictBindCallApply = getStrictOptionValue(options, options.strictBindCallApply);
    this.strictPropertyInitialization = getStrictOptionValue(options, options.strictPropertyInitialization);
    this.strictBuiltinIteratorReturn = getStrictOptionValue(options, options.strictBuiltinIteratorReturn);
    this.noImplicitAny = getStrictOptionValue(options, options.noImplicitAny);
    this.noImplicitThis = getStrictOptionValue(options, options.noImplicitThis);
    this.legacyDecorators = options.experimentalDecorators === true;
    this.useUnknownInCatchVariables = getStrictOptionValue(options, options.useUnknownInCatchVariables);
    this.exactOptionalPropertyTypes = options.exactOptionalPropertyTypes === true;
    this.isolatedModules = getIsolatedModules(options);
    this.preserveConstEnums = shouldPreserveConstEnums(options);
    this.noUncheckedIndexedAccess = options.noUncheckedIndexedAccess === true;

    this.undefinedSymbol = this.newSymbol(SymbolFlags.Property, 'undefined');
    this.argumentsSymbol = this.newSymbol(SymbolFlags.Property, 'arguments');
    this.requireSymbol = this.newSymbol(SymbolFlags.Property, 'require');
    this.unknownSymbol = this.newSymbol(SymbolFlags.Property, 'unknown');
    const merged = host.getMergedGlobals();
    this.mergedGlobals = merged;
    const libs = merged === undefined ? findLibGlobals(this) : undefined;
    this.libGlobals = libs;
    if (merged !== undefined) {
      this.globals = new Map(merged.globals);
      this.mergedSymbols = new Map(merged.mergedSymbols);
    } else if (libs === undefined) {
      this.globals = new Map<string, Symbol>();
      this.mergedSymbols = new Map<number, Symbol>();
    } else if (libs.borrower === undefined) {
      borrowLibGlobals(this, libs);
      this.globals = libs.globals;
      this.mergedSymbols = libs.mergedSymbols;
    } else {
      this.globals = libs.copyGlobals();
      this.mergedSymbols = libs.copyMergedSymbols();
    }
    for (const id of this.mergedSymbols.keys()) this.mergedSymbolIds.add(id);
    this.globalThisSymbol = this.newSymbol(SymbolFlags.Module, 'globalThis');
    this.globalThisSymbol.checkFlags = CheckFlags.Readonly;
    this.globalThisSymbol.exports = this.globals;
    setGlobal(this, this.globalThisSymbol.name, this.globalThisSymbol);
    this.resolver = new CheckerNameResolver(this);
    this.suggestionResolver = new SuggestionNameResolver(this);
    this.typeNodeVisitor = new TypeNodeVisitor(this);
    this.assignmentMarker = new AssignmentMarker(this);

    this.anyType = this.newIntrinsicType(TypeFlags.Any, 'any', ObjectFlags.None);
    this.autoType = this.newIntrinsicType(TypeFlags.Any, 'any', ObjectFlags.NonInferrableType);
    this.wildcardType = this.newIntrinsicType(TypeFlags.Any, 'any', ObjectFlags.None);
    this.blockedStringType = this.newIntrinsicType(TypeFlags.Any, 'any', ObjectFlags.None);
    this.errorType = this.newIntrinsicType(TypeFlags.Any, 'error', ObjectFlags.None);
    this.unresolvedType = this.newIntrinsicType(TypeFlags.Any, 'unresolved', ObjectFlags.None);
    this.nonInferrableAnyType = this.newIntrinsicType(TypeFlags.Any, 'any', ObjectFlags.ContainsWideningType);
    this.intrinsicMarkerType = this.newIntrinsicType(TypeFlags.Any, 'intrinsic', ObjectFlags.None);
    this.unknownType = this.newIntrinsicType(TypeFlags.Unknown, 'unknown', ObjectFlags.None);
    this.undefinedType = this.newIntrinsicType(TypeFlags.Undefined, 'undefined', ObjectFlags.None);
    this.undefinedWideningType = this.strictNullChecks
      ? this.undefinedType
      : this.newIntrinsicType(TypeFlags.Undefined, 'undefined', ObjectFlags.ContainsWideningType);
    this.missingType = this.newIntrinsicType(TypeFlags.Undefined, 'undefined', ObjectFlags.None);
    this.undefinedOrMissingType = this.exactOptionalPropertyTypes ? this.missingType : this.undefinedType;
    this.optionalType = this.newIntrinsicType(TypeFlags.Undefined, 'undefined', ObjectFlags.None);
    this.nullType = this.newIntrinsicType(TypeFlags.Null, 'null', ObjectFlags.None);
    this.nullWideningType = this.strictNullChecks
      ? this.nullType
      : this.newIntrinsicType(TypeFlags.Null, 'null', ObjectFlags.ContainsWideningType);
    this.stringType = this.newIntrinsicType(TypeFlags.String, 'string', ObjectFlags.None);
    this.numberType = this.newIntrinsicType(TypeFlags.Number, 'number', ObjectFlags.None);
    this.bigintType = this.newIntrinsicType(TypeFlags.BigInt, 'bigint', ObjectFlags.None);
    this.regularFalseType = this.newLiteralType(TypeFlags.BooleanLiteral, 'false', 0, undefined);
    this.falseType = this.newLiteralType(TypeFlags.BooleanLiteral, 'false', 0, undefined);
    this.falseType.regularType = this.regularFalseType;
    this.regularFalseType.freshType = this.falseType;
    this.falseType.freshType = this.falseType;
    this.regularTrueType = this.newLiteralType(TypeFlags.BooleanLiteral, 'true', 0, undefined);
    this.trueType = this.newLiteralType(TypeFlags.BooleanLiteral, 'true', 0, undefined);
    this.trueType.regularType = this.regularTrueType;
    this.regularTrueType.freshType = this.trueType;
    this.trueType.freshType = this.trueType;
    this.booleanType = getUnionType(this, [this.regularFalseType, this.regularTrueType]);
    this.esSymbolType = this.newIntrinsicType(TypeFlags.ESSymbol, 'symbol', ObjectFlags.None);
    this.voidType = this.newIntrinsicType(TypeFlags.Void, 'void', ObjectFlags.None);
    this.neverType = this.newIntrinsicType(TypeFlags.Never, 'never', ObjectFlags.None);
    this.silentNeverType = this.newIntrinsicType(TypeFlags.Never, 'never', ObjectFlags.NonInferrableType);
    this.implicitNeverType = this.newIntrinsicType(TypeFlags.Never, 'never', ObjectFlags.None);
    this.unreachableNeverType = this.newIntrinsicType(TypeFlags.Never, 'never', ObjectFlags.None);
    this.nonPrimitiveType = this.newIntrinsicType(TypeFlags.NonPrimitive, 'object', ObjectFlags.None);
    this.stringOrNumberType = getUnionType(this, [this.stringType, this.numberType]);
    this.stringNumberSymbolType = getUnionType(this, [this.stringType, this.numberType, this.esSymbolType]);
    this.numberOrBigIntType = getUnionType(this, [this.numberType, this.bigintType]);
    this.numericStringType = getTemplateLiteralType(this, ['', ''], [this.numberType]);
    this.templateConstraintType = getUnionType(this, [
      this.stringType,
      this.numberType,
      this.booleanType,
      this.bigintType,
      this.nullType,
      this.undefinedType,
    ]);
    this.uniqueLiteralType = this.newIntrinsicType(TypeFlags.Never, 'never', ObjectFlags.None);
    this.reportUnreliableMapper = new ReportingMapper(this, VarianceReporting.Unreliable);
    this.reportUnmeasurableMapper = new ReportingMapper(this, VarianceReporting.Unmeasurable);
    this.restrictiveMapper = new RestrictiveMapper(this);
    this.permissiveMapper = new PermissiveMapper(this);
    this.uniqueLiteralMapper = new UniqueLiteralMapper(this);
    this.emptyObjectType = newAnonymousType(this, undefined);
    this.emptyJsxObjectType = newAnonymousType(this, undefined);
    this.emptyFreshJsxObjectType = newAnonymousType(this, undefined);
    this.emptyTypeLiteralType = newAnonymousType(this, this.newSymbol(SymbolFlags.TypeLiteral, '￾type'));
    this.unknownEmptyObjectType = newAnonymousType(this, undefined);
    this.unknownUnionType = this.strictNullChecks
      ? getUnionType(this, [this.undefinedType, this.nullType, this.unknownEmptyObjectType])
      : this.unknownType;
    this.emptyGenericType = newAnonymousType(this, undefined);
    sideOf(this, this.emptyGenericType).instantiations = new TypeListCache<Type>();
    this.anyFunctionType = newAnonymousType(this, undefined);
    this.anyFunctionType.objectFlags |= ObjectFlags.NonInferrableType;
    this.noConstraintType = newAnonymousType(this, undefined);
    this.circularConstraintType = newAnonymousType(this, undefined);
    this.resolvingDefaultType = newAnonymousType(this, undefined);
    this.markerSuperType = this.newTypeParameter(undefined);
    this.markerSubType = this.newTypeParameter(undefined);
    this.markerSubType.constraint = this.markerSuperType;
    this.markerOtherType = this.newTypeParameter(undefined);
    this.markerSuperTypeForCheck = this.newTypeParameter(undefined);
    this.markerSubTypeForCheck = this.newTypeParameter(undefined);
    this.markerSubTypeForCheck.constraint = this.markerSuperTypeForCheck;
    this.noTypePredicate = new TypePredicate(TypePredicateKind.Identifier, '<<unresolved>>', 0, this.anyType);
    this.anySignature = this.newSignature(SignatureFlags.None, undefined, emptyTypes, undefined, [], this.anyType, 0);
    this.unknownSignature = this.newSignature(
      SignatureFlags.None,
      undefined,
      emptyTypes,
      undefined,
      [],
      this.errorType,
      0,
    );
    this.resolvingSignature = this.newSignature(
      SignatureFlags.None,
      undefined,
      emptyTypes,
      undefined,
      [],
      this.anyType,
      0,
    );
    this.silentNeverSignature = this.newSignature(
      SignatureFlags.None,
      undefined,
      emptyTypes,
      undefined,
      [],
      this.silentNeverType,
      0,
    );
    this.enumNumberIndexInfo = new IndexInfo(this.numberType, this.stringType, true, undefined, []);
    this.anyBaseTypeIndexInfo = new IndexInfo(this.stringType, this.anyType, false, undefined, []);
    this.emptyStringType = getStringLiteralType(this, '');
    this.zeroType = getNumberLiteralType(this, 0);
    this.zeroBigIntType = getBigIntLiteralType(this, '0');
    const typeofNames = ['bigint', 'boolean', 'function', 'number', 'object', 'string', 'symbol', 'undefined'];
    const typeofTypes: Type[] = [];
    for (const name of typeofNames) typeofTypes.push(getStringLiteralType(this, name));
    this.typeofType = getUnionType(this, typeofTypes);

    // initializeChecker
    this.diagnostics.startLog();
    this.suggestionDiagnostics.startLog();
    initializeGlobals(this);
    this.mergeDiagnostics.push(this.diagnostics.takeLog(), this.suggestionDiagnostics.takeLog());
    this.symbolTypes.set(getSymbolId(this.undefinedSymbol), this.undefinedWideningType);
    this.symbolTypes.set(getSymbolId(this.argumentsSymbol), getGlobalType(this, 'IArguments', 0, true));
    this.symbolTypes.set(getSymbolId(this.unknownSymbol), this.errorType);
    this.symbolTypes.set(
      getSymbolId(this.globalThisSymbol),
      newObjectType(this, ObjectFlags.Anonymous, this.globalThisSymbol),
    );
    this.globalArrayType = getGlobalType(this, 'Array', 1, true);
    this.globalObjectType = getGlobalType(this, 'Object', 0, true);
    this.hasGlobalObjectType = true;
    this.globalFunctionType = getGlobalType(this, 'Function', 0, true);
    this.globalCallableFunctionType = getGlobalStrictFunctionType(this, 'CallableFunction');
    this.globalNewableFunctionType = getGlobalStrictFunctionType(this, 'NewableFunction');
    this.globalStringType = getGlobalType(this, 'String', 0, true);
    this.globalNumberType = getGlobalType(this, 'Number', 0, true);
    this.globalBooleanType = getGlobalType(this, 'Boolean', 0, true);
    this.globalRegExpType = getGlobalType(this, 'RegExp', 0, true);
    this.anyArrayType = createArrayType(this, this.anyType);
    let autoArrayType = createArrayType(this, this.autoType);
    // autoArrayType is a marker, so it must be unique even without a global Array type.
    if (autoArrayType === this.emptyObjectType) autoArrayType = newAnonymousType(this, undefined);
    this.autoArrayType = autoArrayType;
    let readonlyArrayType = getGlobalType(this, 'ReadonlyArray', 1, false);
    if (readonlyArrayType === this.emptyGenericType) readonlyArrayType = this.globalArrayType;
    this.globalReadonlyArrayType = readonlyArrayType;
    this.anyReadonlyArrayType = createTypeFromGenericGlobalType(this, readonlyArrayType, [this.anyType]);
    this.globalThisType = getGlobalType(this, 'ThisType', 1, false);
    this.diagnostics.startLog();
    this.suggestionDiagnostics.startLog();
    mergeAmbientModulesAndAugmentations(this);
    this.modulesMerged = true;
    this.mergeDiagnostics.push(this.diagnostics.takeLog(), this.suggestionDiagnostics.takeLog());
  }

  // ---- Public API

  /** Checks `file` if needed and returns its semantic diagnostics, sorted. */
  getDiagnostics(file: SourceFile): Diagnostic[] {
    const options = this.compilerOptions;
    checkSourceFile(this, file, options.noUnusedLocals === true || options.noUnusedParameters === true);
    return this.diagnostics.forFile(file.fileName);
  }

  /** Checks `file`, including unused identifiers, and returns its suggestion diagnostics. */
  getSuggestionDiagnostics(file: SourceFile): Diagnostic[] {
    checkSourceFile(this, file, true);
    checkObjectLiteralDeprecations(this, file);
    return this.suggestionDiagnostics.forFile(file.fileName);
  }

  /** Diagnostics without a file, such as missing global types. */
  getGlobalDiagnostics(): Diagnostic[] {
    produceDeferredDiagnostics(this);
    return this.diagnostics.globals();
  }

  /**
   * Runs `run` (such as emitting declarations), then forgets the global diagnostics it reported:
   * the program collects global diagnostics before it emits.
   */
  withoutGlobalDiagnostics<T>(run: () => T): T {
    return this.diagnostics.withoutNewGlobals(run);
  }

  /** The global diagnostics `withoutGlobalDiagnostics` forgot so far. */
  forgottenGlobalDiagnostics(): number {
    return this.diagnostics.removedGlobals;
  }

  // ---- Links

  /** The rarely used links of `symbol`, created on first use. */
  symbolLinks(symbol: Symbol): SymbolLinks {
    const id = getSymbolId(symbol);
    let links = this.symbolLinkTable.get(id);
    if (links === undefined) {
      links = new SymbolLinks();
      this.symbolLinkTable.set(id, links);
    }
    return links;
  }

  /** The links of `symbol` if it has any, without creating them. */
  existingSymbolLinks(symbol: Symbol): SymbolLinks | undefined {
    return this.symbolLinkTable.get(symbol.id);
  }

  /** The rarely used links of `node`, created on first use. */
  nodeLinks(node: Node): NodeLinks {
    const id = node.id;
    let links = this.nodeLinkTable.get(id);
    if (links === undefined) {
      links = new NodeLinks();
      this.nodeLinkTable.set(id, links);
    }
    return links;
  }

  /** The links of `node` if it has any, without creating them. */
  existingNodeLinks(node: Node): NodeLinks | undefined {
    return this.nodeLinkTable.get(node.id);
  }

  // ---- Constructors for types, symbols and signatures

  nextTypeId(): number {
    return ++this.typeCount;
  }

  // TypeChecking: for the methods of types tsc-ts's public API calls.

  baseTypesOf(t: InterfaceType): readonly Type[] {
    return getBaseTypes(this, t);
  }

  trueTypeOf(t: ConditionalType): Type {
    return getTrueTypeFromConditionalType(this, t);
  }

  falseTypeOf(t: ConditionalType): Type {
    return getFalseTypeFromConditionalType(this, t);
  }

  newIntrinsicType(flags: TypeFlags, name: string, objectFlags: ObjectFlags): IntrinsicType {
    return new IntrinsicType(flags, objectFlags, this.nextTypeId(), name);
  }

  newLiteralType(flags: TypeFlags, stringValue: string, numberValue: number, symbol: Symbol | undefined): LiteralType {
    return new LiteralType(flags, this.nextTypeId(), symbol, stringValue, numberValue);
  }

  newTypeParameter(symbol: Symbol | undefined): TypeParameter {
    return new TypeParameter(this.nextTypeId(), symbol);
  }

  newSymbol(flags: SymbolFlags, name: string): Symbol {
    const symbol = new Symbol(flags | SymbolFlags.Transient, name);
    return symbol;
  }

  newSymbolWithCheckFlags(flags: SymbolFlags, name: string, checkFlags: CheckFlags): Symbol {
    const symbol = new Symbol(flags | SymbolFlags.Transient, name);
    symbol.checkFlags = checkFlags;
    return symbol;
  }

  newSignature(
    flags: SignatureFlags,
    declaration: Node | undefined,
    typeParameters: Type[],
    thisParameter: Symbol | undefined,
    parameters: Symbol[],
    resolvedReturnType: Type | undefined,
    minArgumentCount: number,
  ): Signature {
    return new Signature(
      ++this.signatureCount,
      flags,
      declaration,
      typeParameters,
      thisParameter,
      parameters,
      resolvedReturnType,
      undefined,
      minArgumentCount,
    );
  }

  // ---- Diagnostics

  /** Reports `message` at `node`, or as a global diagnostic without a node. */
  error(node: Node | undefined, message: DiagnosticMessage, ...args: string[]): Diagnostic {
    return this.addDiagnostic(createDiagnosticForNode(node, message, args));
  }

  /** Reports `diagnostic`; returns the equal diagnostic already reported, if any, else `diagnostic`. */
  addDiagnostic(diagnostic: Diagnostic): Diagnostic {
    this.reports++;
    // Discard diagnostics created while at the maximum number of nested typeToString calls.
    if (this.serializationLevel < maxSerializationLevel) return this.diagnostics.add(diagnostic);
    return diagnostic;
  }

  addSuggestion(diagnostic: Diagnostic): void {
    this.reports++;
    this.suggestionDiagnostics.add(diagnostic);
  }

  /** Reports an error, or a suggestion when `isError` is false. */
  addErrorOrSuggestion(isError: boolean, diagnostic: Diagnostic): void {
    if (isError) this.addDiagnostic(diagnostic);
    else this.addSuggestion(diagnostic);
  }
}

/**
 * Drops a checker's links and type caches. Native builds free memory by reference counting, and
 * the checker's caches, types and mappers reference each other; releasing them early lets most of
 * them go without a cycle collection.
 */
export function disposeChecker(c: Checker): void {
  c.symbolLinkTable.clear();
  c.nodeLinkTable.clear();
  c.symbolTypes.clear();
  c.symbolTargets.clear();
  c.symbolMappers.clear();
  c.symbolNameTypes.clear();
  c.symbolContainingTypes.clear();
  c.symbolKeyTypes.clear();
  c.symbolSyntheticOrigins.clear();
  c.symbolLeftSpreads.clear();
  c.symbolRightSpreads.clear();
  c.symbolReferenceKinds.clear();
  c.resolvedSymbols.clear();
  c.resolvedTypes.clear();
  c.resolvedSignatures.clear();
  c.spareRelater = undefined;
  if (c.globalChanges !== undefined) returnLibGlobals(c);
  else {
    c.mergedSymbols.clear();
    c.globals.clear();
  }
  c.mergedSymbolIds.clear();
  c.sharedSymbolCopies.clear();
  c.memberPositionsInLists.clear();
  c.memberNamesOfLists.clear();
  c.propertiesByName.clear();
  c.symbolAccessibilityCaches = undefined;
  c.unresolvedSymbols.clear();
  c.undefinedProperties.clear();
  c.stringLiteralTypes.clear();
  c.numberLiteralTypes.clear();
  c.bigintLiteralTypes.clear();
  c.enumLiteralTypes.clear();
  c.uniqueESSymbolTypes.clear();
  c.unionTypesByHash.clear();
  c.unionTypes.clear();
  c.unionOfUnionTypes.clear();
  c.unionOfUnionTypesById.clear();
  c.intersectionTypes.clear();
  c.tupleTypes.clear();
  c.indexedAccessTypes.clear();
  c.templateLiteralTypes.clear();
  c.templateLiteralInstantiations.clear();
  c.stringMappingTypes.clear();
  c.substitutionTypes.clear();
  c.subtypeReductionCache.clear();
  c.cachedTypes.clear();
  c.cachedTypesById.clear();
  c.cachedTypesByPair.clear();
  c.iterationTypesCache.clear();
  c.deferredDiagnostics = [];
  c.objectLiteralsForDeprecations.clear();
  c.errorTypes.clear();
  c.globalTypeCache.clear();
  c.globalSymbolCache.clear();
  c.markerTypes.clear();
  c.flowLoopCaches.clear();
  c.flowWalks.clear();
  c.flowNodeReachable.clear();
  c.flowNodePostSuper.clear();
  c.primitiveTypeAliasSuggestions.clear();
  c.patternAmbientModuleAugmentations.clear();
  c.patternAmbientModuleAugmentationTargets.clear();
  c.moduleImportAttributesTypes.clear();
  c.sharedFlowTypes.length = 0;
  c.relationComparers = [];
}

export const enum VarianceReporting {
  Unreliable = 1 << 4,
  Unmeasurable = 1 << 3,
}

/** A diagnostic at `node`'s error range, or a global one without a node. */
export function createDiagnosticForNode(
  node: Node | undefined,
  message: DiagnosticMessage,
  args: string[],
): Diagnostic {
  // Without a node, the diagnostic has no file and an empty range at 0, as in tsgo.
  if (node === undefined) return new Diagnostic(undefined, 0, 0, message, args);
  const file = getSourceFileOfNode(node);
  const range = getErrorRangeForNode(file, node);
  return new Diagnostic(file.diagnosticFile(), range.pos, range.end, message, args);
}

/** A message for `chainDiagnostic`-style elaboration; the location is taken from the head. */
export function messageDiagnostic(message: DiagnosticMessage, args: string[]): Diagnostic {
  return new Diagnostic(undefined, 0, 0, message, args);
}

export { Diagnostics, ScriptTarget };
