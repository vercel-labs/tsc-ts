// Symbols: what the binder declares for each named entity, and the tables that hold them.
import type { ProgramLifetime } from '@scriptc/types';
import type { Node } from './ast.js';
import type { __String, Symbol as PublicSymbol } from '../library/types.js';

export const enum SymbolFlags {
  None = 0,
  /** A `var` or parameter. */
  FunctionScopedVariable = 1 << 0,
  /** A `let` or `const`. */
  BlockScopedVariable = 1 << 1,
  /** A property or enum member. */
  Property = 1 << 2,
  EnumMember = 1 << 3,
  Function = 1 << 4,
  Class = 1 << 5,
  Interface = 1 << 6,
  ConstEnum = 1 << 7,
  RegularEnum = 1 << 8,
  /** An instantiated namespace. */
  ValueModule = 1 << 9,
  /** A namespace with only types. */
  NamespaceModule = 1 << 10,
  /** A type literal or mapped type. */
  TypeLiteral = 1 << 11,
  ObjectLiteral = 1 << 12,
  Method = 1 << 13,
  Constructor = 1 << 14,
  GetAccessor = 1 << 15,
  SetAccessor = 1 << 16,
  /** A call, construct or index signature. */
  Signature = 1 << 17,
  TypeParameter = 1 << 18,
  TypeAlias = 1 << 19,
  /** The local half of an exported value; see `Binder.declareModuleMember`. */
  ExportValue = 1 << 20,
  /** An alias for another symbol, e.g. an import. */
  Alias = 1 << 21,
  /** A class's `prototype` property. */
  Prototype = 1 << 22,
  /** `export *` declarations. */
  ExportStar = 1 << 23,
  Optional = 1 << 24,
  /** Created by the checker. */
  Transient = 1 << 25,
  /** A JavaScript assignment that declares a property, e.g. `fn.prop = 1`. */
  Assignment = 1 << 26,
  /** CommonJS `module` or `module.exports`. */
  ModuleExports = 1 << 27,
  /** A namespace whose only values are const enums. */
  ConstEnumOnlyModule = 1 << 28,
  /** A JavaScript `this.x` property that a method of the same name replaces. */
  ReplaceableByMethod = 1 << 29,
  /** Marks a lookup in the global scope. */
  GlobalLookup = 1 << 30,
  All = (1 << 30) - 1,

  Enum = RegularEnum | ConstEnum,
  Variable = FunctionScopedVariable | BlockScopedVariable,
  Value = Variable |
    Property |
    EnumMember |
    ObjectLiteral |
    Function |
    Class |
    Enum |
    ValueModule |
    Method |
    GetAccessor |
    SetAccessor,
  Type = Class | Interface | Enum | EnumMember | TypeLiteral | TypeParameter | TypeAlias,
  Namespace = ValueModule | NamespaceModule | Enum,
  Module = ValueModule | NamespaceModule,
  Accessor = GetAccessor | SetAccessor,

  // What a declaration of each kind can't merge with.
  FunctionScopedVariableExcludes = Value & ~FunctionScopedVariable,
  BlockScopedVariableExcludes = Value,
  ParameterExcludes = Value,
  PropertyExcludes = Value & ~(Property | Accessor),
  EnumMemberExcludes = Value | Type,
  FunctionExcludes = Value & ~(Function | ValueModule | Class),
  /** Class-interface merging is checked by the checker. */
  ClassExcludes = (Value | Type) & ~(ValueModule | Interface | Function),
  InterfaceExcludes = Type & ~(Interface | Class),
  RegularEnumExcludes = (Value | Type) & ~(RegularEnum | ValueModule),
  ConstEnumExcludes = (Value | Type) & ~ConstEnum,
  ValueModuleExcludes = Value & ~(Function | Class | RegularEnum | ValueModule),
  NamespaceModuleExcludes = None,
  MethodExcludes = Value & ~Method,
  GetAccessorExcludes = Value & ~(SetAccessor | Property),
  SetAccessorExcludes = Value & ~(GetAccessor | Property),
  AccessorExcludes = Value & ~Property,
  TypeParameterExcludes = Type & ~TypeParameter,
  TypeAliasExcludes = Type,
  AliasExcludes = Alias,

  ModuleMember = Variable | Function | Class | Interface | Enum | Module | TypeAlias | Alias,
  ExportHasLocal = Function | Class | Enum | ValueModule,
  BlockScoped = BlockScopedVariable | Class | Enum,
  PropertyOrAccessor = Property | Accessor,
  ClassMember = Method | Accessor | Property,
  ExportSupportsDefaultModifier = Class | Function | Interface,
  ExportDoesNotSupportDefaultModifier = ~ExportSupportsDefaultModifier,
  /** What the language service classifies semantically. */
  Classifiable = Class | Enum | TypeAlias | Interface | TypeParameter | Module | Alias,
  LateBindingContainer = Class | Interface | TypeLiteral | ObjectLiteral | Function,
}

/** Flags of transient symbols created by the checker. */
export const enum CheckFlags {
  None = 0,
  Instantiated = 1 << 0,
  /** A property of a union or intersection type. */
  SyntheticProperty = 1 << 1,
  SyntheticMethod = 1 << 2,
  Readonly = 1 << 3,
  /** In some but not all constituents. */
  ReadPartial = 1 << 4,
  /** In some constituents, and only an index signature in others. */
  WritePartial = 1 << 5,
  HasNonUniformType = 1 << 6,
  HasLiteralType = 1 << 7,
  ContainsPublic = 1 << 8,
  ContainsProtected = 1 << 9,
  ContainsPrivate = 1 << 10,
  ContainsStatic = 1 << 11,
  /** Late-bound from a computed property name. */
  Late = 1 << 12,
  ReverseMapped = 1 << 13,
  OptionalParameter = 1 << 14,
  RestParameter = 1 << 15,
  /** The type is computed on demand. */
  DeferredType = 1 << 16,
  HasNeverType = 1 << 17,
  Mapped = 1 << 18,
  StripOptional = 1 << 19,
  Unresolved = 1 << 20,
  IsDiscriminantComputed = 1 << 21,
  IsDiscriminant = 1 << 22,
  /** Created from an index signature. */
  IndexSymbol = 1 << 23,
  Synthetic = SyntheticProperty | SyntheticMethod,
  NonUniformAndLiteral = HasNonUniformType | HasLiteralType,
  Partial = ReadPartial | WritePartial,
}

/** Fields of Symbol that few symbols set (about one in twenty), allocated on first write. */
export class SymbolRareFields implements ProgramLifetime {
  members: SymbolTable | undefined = undefined;
  exports: SymbolTable | undefined = undefined;
  exportSymbol: Symbol | undefined = undefined;
  /** All declarations of a symbol that has more than one (`getDeclarations`). */
  declarations: Node[] | undefined = undefined;
  /** The value declaration where it is not the first declaration (`Symbol.valueDeclaration`). */
  valueDeclaration: Node | undefined = undefined;
}

/**
 * In `Symbol.bits`, above the check flags: the value declaration is the first declaration. A const enum
 * member, so that native builds read it as a constant rather than as a module variable.
 */
const enum SymbolBits {
  ValueDeclarationIsFirst = 1 << 30,
}

export class Symbol implements ProgramLifetime {
  flags: SymbolFlags;
  /** The check flags, and `SymbolBits.ValueDeclarationIsFirst`. */
  private bits: number;
  readonly name: string;
  /**
   * The first declaration. A symbol with more keeps all of them in its rare fields; read them with
   * `declarationCount`, `declarationAt` and `getDeclarations`. Written only through `setFirst`,
   * which keeps the value declaration.
   */
  declaration: Node | undefined;
  parent: Symbol | undefined;
  private rareFields: SymbolRareFields | undefined;
  /** Assigned on first use by `getSymbolId`, or at creation while threads share the program; 0 until then. */
  id: number;

  constructor(flags: SymbolFlags, name: string) {
    this.flags = flags;
    this.bits = 0;
    this.name = name;
    this.declaration = undefined;
    this.parent = undefined;
    this.rareFields = undefined;
    this.id = idsAtCreation ? takeSymbolId() : 0;
  }

  get checkFlags(): CheckFlags {
    return (this.bits & ~SymbolBits.ValueDeclarationIsFirst) as CheckFlags;
  }

  set checkFlags(flags: CheckFlags) {
    this.bits = (this.bits & SymbolBits.ValueDeclarationIsFirst) | flags;
  }

  /** Makes `node` the first declaration, keeping the value declaration. */
  setFirst(node: Node | undefined): void {
    if ((this.bits & SymbolBits.ValueDeclarationIsFirst) !== 0 && node !== this.declaration) {
      // The value declaration stays what it was.
      this.rareFieldsOrNew().valueDeclaration = this.declaration;
      this.bits &= ~SymbolBits.ValueDeclarationIsFirst;
    }
    this.declaration = node;
  }

  /**
   * The declaration of the symbol's value. Almost always the first declaration, which a bit of `bits`
   * says; any other is kept in the rare fields.
   */
  get valueDeclaration(): Node | undefined {
    if ((this.bits & SymbolBits.ValueDeclarationIsFirst) !== 0) return this.declaration;
    const group = this.rareFields;
    return group === undefined ? undefined : group.valueDeclaration;
  }

  set valueDeclaration(node: Node | undefined) {
    const group = this.rareFields;
    if (node !== undefined && node === this.declaration) {
      this.bits |= SymbolBits.ValueDeclarationIsFirst;
      if (group !== undefined) group.valueDeclaration = undefined;
      return;
    }
    this.bits &= ~SymbolBits.ValueDeclarationIsFirst;
    if (node !== undefined || group !== undefined) this.rareFieldsOrNew().valueDeclaration = node;
  }

  private rareFieldsOrNew(): SymbolRareFields {
    let group = this.rareFields;
    if (group === undefined) {
      group = new SymbolRareFields();
      this.rareFields = group;
    }
    return group;
  }

  /**
   * The declarations, for tsc-ts/api's `Symbol.declarations`. The compiler reads `declaration`,
   * `declarationCount` and `declarationAt`: for a single declaration this builds a list on each read.
   */
  get declarations(): readonly Node[] {
    return getDeclarations(this);
  }

  /** All declarations where there are more than one, else undefined. */
  get moreDeclarations(): Node[] | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.declarations;
  }

  set moreDeclarations(value: Node[] | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().declarations = value;
  }

  get members(): SymbolTable | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.members;
  }

  set members(value: SymbolTable | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().members = value;
  }

  get exports(): SymbolTable | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.exports;
  }

  set exports(value: SymbolTable | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().exports = value;
  }

  /** For the local symbol of an exported declaration, the exported symbol. */
  get exportSymbol(): Symbol | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.exportSymbol;
  }

  set exportSymbol(value: Symbol | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().exportSymbol = value;
  }

  // TypeScript 7's API (tsc-ts/api). The symbols it hands out have their ids assigned.

  /** The name in its escaped form, the key of member and export tables (`escapeSymbolName`). */
  get escapedName(): string {
    return escapeSymbolName(this.name);
  }

  getParent(): Symbol | undefined {
    const parent = this.parent;
    if (parent !== undefined) getSymbolId(parent);
    return parent;
  }

  /** The export symbol, or the symbol itself if it has none. */
  getExportSymbol(): Symbol {
    const exported = this.exportSymbol ?? this;
    getSymbolId(exported);
    return exported;
  }

  /** The members, by escaped name. */
  getMembers(): Map<__String, PublicSymbol> {
    return byEscapedName(this.members);
  }

  /** The exports, by escaped name. */
  getExports(): Map<__String, PublicSymbol> {
    return byEscapedName(this.exports);
  }

  /** Whether this is the symbol of an external module, named by its quoted path. */
  isExternalModule(): boolean {
    return (this.flags & SymbolFlags.Module) !== 0 && tryGetAmbientModuleNameFromSymbolName(this.name) !== undefined;
  }

  /** The flags of this symbol and its export symbol. */
  combinedLocalAndExportSymbolFlags(): SymbolFlags {
    const exportSymbol = this.exportSymbol;
    return exportSymbol === undefined ? this.flags : this.flags | exportSymbol.flags;
  }
}

export type SymbolTable = Map<string, Symbol>;

let nextSymbolId = 0;
// A program shared between threads (parallel-check.ts) is never written, so its symbols get their ids
// when they are created rather than on first use.
let idsAtCreation = false;
// While several threads bind one program (parallel-parse.ts), each takes symbol ids in chunks from a
// shared counter; ids up to `symbolIdLimit` belong to this thread.
let symbolIdLimit = Number.POSITIVE_INFINITY;
let symbolIdCounter: Int32Array | undefined = undefined;
const symbolIdChunk = 4096;

/** Symbols get their ids when they are created from now on (see `idsAtCreation`). */
export function assignSymbolIdsAtCreation(): void {
  idsAtCreation = true;
}

/** Whether symbols get their ids when they are created (`assignSymbolIdsAtCreation`). */
export function symbolIdsAtCreation(): boolean {
  return idsAtCreation;
}

function takeSymbolId(): number {
  // `| 0`: ids stay far below 2^31, and native builds then store `id` as an int32.
  return (nextSymbolId < symbolIdLimit ? ++nextSymbolId : takeSymbolIdChunk()) | 0;
}

function takeSymbolIdChunk(): number {
  const base = Atomics.add(symbolIdCounter!, 0, symbolIdChunk);
  nextSymbolId = base + 1;
  symbolIdLimit = base + symbolIdChunk;
  return nextSymbolId;
}

/**
 * Takes symbol ids in chunks from `counter[0]`, shared by the threads that bind together; with
 * `undefined`, goes back to a plain counter above every id handed out.
 */
export function shareSymbolIds(counter: Int32Array | undefined): void {
  if (counter !== undefined) {
    symbolIdCounter = counter;
    symbolIdLimit = nextSymbolId;
    return;
  }
  if (symbolIdCounter !== undefined) {
    const top = Atomics.load(symbolIdCounter, 0);
    if (top > nextSymbolId) nextSymbolId = top;
  }
  symbolIdCounter = undefined;
  symbolIdLimit = Number.POSITIVE_INFINITY;
}

/** The last symbol id handed out on this thread. */
export function lastSymbolIdValue(): number {
  return nextSymbolId;
}

/** Continues symbol ids above `last` (a checker thread starts above the program it checks). */
export function reserveSymbolIds(last: number): void {
  if (last > nextSymbolId) nextSymbolId = last;
}

/**
 * The declarations of a symbol without any: shared, so never modified. Add declarations with
 * `addDeclaration`, which gives the symbol its own array on the first one.
 */
const noDeclarations: Node[] = [];

/** Appends `node` to the declarations of `symbol`. */
export function addDeclaration(symbol: Symbol, node: Node): void {
  const first = symbol.declaration;
  if (first === undefined) {
    symbol.setFirst(node);
    return;
  }
  const more = symbol.moreDeclarations;
  if (more !== undefined) more.push(node);
  else symbol.moreDeclarations = [first, node];
}

/** The number of declarations of `symbol`. */
export function declarationCount(symbol: Symbol): number {
  if (symbol.declaration === undefined) return 0;
  const more = symbol.moreDeclarations;
  return more !== undefined ? more.length : 1;
}

/** The declaration of `symbol` at `index`, which is below `declarationCount(symbol)`. */
export function declarationAt(symbol: Symbol, index: number): Node {
  return index === 0 ? symbol.declaration! : symbol.moreDeclarations![index]!;
}

/**
 * The declarations of `symbol`, in order. A symbol with one declaration gets a new list each call;
 * hot paths read `declaration`, `declarationCount` and `declarationAt` instead.
 */
export function getDeclarations(symbol: Symbol): readonly Node[] {
  const first = symbol.declaration;
  if (first === undefined) return noDeclarations;
  const more = symbol.moreDeclarations;
  return more !== undefined ? more : [first];
}

/** Whether `node` is a declaration of `symbol`. */
export function hasDeclaration(symbol: Symbol, node: Node): boolean {
  const first = symbol.declaration;
  if (first === undefined) return false;
  if (first === node) return true;
  const more = symbol.moreDeclarations;
  return more !== undefined && more.indexOf(node) >= 0;
}

/** Gives `target` the declarations of `source`; a list of several is shared, as the list was before. */
export function copyDeclarations(target: Symbol, source: Symbol): void {
  target.setFirst(source.declaration);
  target.moreDeclarations = source.moreDeclarations;
}

/** Replaces the declarations of `symbol` with `declarations`, which it keeps when they are more than one. */
export function setDeclarations(symbol: Symbol, declarations: readonly Node[]): void {
  symbol.setFirst(declarations.length !== 0 ? declarations[0] : undefined);
  symbol.moreDeclarations = declarations.length > 1 ? (declarations as Node[]) : undefined;
}

/**
 * The symbols of `table` by escaped name, with their ids assigned, as tsc-ts's public API types them: the map's
 * values are typed as the public Symbol, so a native build returns it as the map that interface declares.
 */
function byEscapedName(table: SymbolTable | undefined): Map<__String, PublicSymbol> {
  const result = new Map<__String, PublicSymbol>();
  if (table !== undefined)
    for (const symbol of table.values()) {
      getSymbolId(symbol);
      result.set(escapeSymbolName(symbol.name) as __String, symbol as unknown as PublicSymbol);
    }
  return result;
}

/** A program-wide id, assigned to each symbol when first requested. */
export function getSymbolId(symbol: Symbol): number {
  let id = symbol.id;
  if (id === 0) {
    id = takeSymbolId();
    symbol.id = id;
  }
  return id;
}

/** The exports table of `symbol`, created if missing. */
export function getExports(symbol: Symbol): SymbolTable {
  let exports = symbol.exports;
  if (exports === undefined) {
    exports = new Map<string, Symbol>();
    symbol.exports = exports;
  }
  return exports;
}

/** The members table of `symbol`, created if missing. */
export function getMembers(symbol: Symbol): SymbolTable {
  let members = symbol.members;
  if (members === undefined) {
    members = new Map<string, Symbol>();
    symbol.members = members;
  }
  return members;
}

/**
 * Starts internal symbol names. A noncharacter, so it never starts an identifier and is
 * vanishingly unlikely in a string-literal property name.
 */
export const internalSymbolNamePrefix = '￾';

/**
 * The module name of an ambient module symbol's name: `"name"`, or for a pattern module with import
 * attributes, the internal symbol name prefix, `"name"pattern@` and the id of the attributes node.
 */
export function tryGetAmbientModuleNameFromSymbolName(name: string): string | undefined {
  if (name.length >= 2 && name.charCodeAt(0) === 0x22 && name.charCodeAt(name.length - 1) === 0x22)
    return name.substring(1, name.length - 1);
  if (!name.startsWith(internalSymbolNamePrefix + '"')) return undefined;
  const markerIndex = name.lastIndexOf('"pattern@');
  if (markerIndex < internalSymbolNamePrefix.length + 2) return undefined;
  return name.substring(internalSymbolNamePrefix.length + 1, markerIndex);
}

export const enum InternalSymbolName {
  /** Call signatures. */
  Call = '￾call',
  /** Constructor implementations. */
  Constructor = '￾constructor',
  /** Construct signatures. */
  New = '￾new',
  /** Index signatures. */
  Index = '￾index',
  /** `export *` declarations. */
  ExportStar = '￾export',
  /** The global scope's self-reference. */
  Global = '￾global',
  /** A missing name. */
  Missing = '￾missing',
  /** An anonymous type literal. */
  Type = '￾type',
  /** An anonymous object literal. */
  Object = '￾object',
  /** An anonymous JSX attributes object literal. */
  JSXAttributes = '￾jsxAttributes',
  /** An unnamed class expression. */
  Class = '￾class',
  /** An unnamed function expression. */
  Function = '￾function',
  /** A computed property name that isn't a literal. */
  Computed = '￾computed',
  /** Late-bound JavaScript assignment declarations. */
  AssignmentDeclaration = '￾assignment',
  InstantiationExpression = '￾instantiationExpression',
  ImportAttributes = '￾importAttributes',
  ExportEquals = 'export=',
  Default = 'default',
  This = 'this',
  ModuleExports = 'module.exports',
}

/** `name` with a leading internal prefix replaced by `__`. */
export function escapeInternalSymbolName(name: string): string {
  return name.startsWith(internalSymbolNamePrefix) ? '__' + name.substring(1) : name;
}

/** `name` with every internal prefix replaced by `__`. */
export function escapeAllInternalSymbolNames(name: string): string {
  return name.indexOf(internalSymbolNamePrefix) < 0 ? name : name.replaceAll(internalSymbolNamePrefix, '__');
}

/**
 * The escaped `__String` form of a symbol name: internal names get `__`, and names that
 * already start with `__` get one more `_`.
 */
export function escapeSymbolName(name: string): string {
  if (name.startsWith(internalSymbolNamePrefix)) return '__' + name.substring(1);
  if (name.startsWith('__')) return '_' + name;
  return name;
}
