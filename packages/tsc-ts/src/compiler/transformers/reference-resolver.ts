// Name resolution for emit without a checker: which declaration an identifier refers to, the
// container exporting it, and constant values of enum members, from the binder's symbols with
// global declarations merged across script files and imports resolved between program files.
import {
  ElementAccessExpression,
  EnumDeclaration,
  EnumMember,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  ModuleDeclaration,
  NamespaceImport,
  type Node,
  NodeFlags,
  NumericLiteral,
  ParenthesizedExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  QualifiedName,
  SourceFile,
  BinaryExpression,
  NoSubstitutionTemplateLiteral,
  StringLiteral,
  TemplateExpression,
  TemplateMiddle,
  TemplateSpan,
  TemplateTail,
  VariableDeclaration,
  ExternalModuleReference,
  getInitializer,
  getIsTypeOnly,
  getModuleSpecifier,
  getLocals,
  getName,
  getSymbol,
  getType,
} from '../ast.js';
import { isFunctionLike } from '../ast-utilities.js';
import {
  getCombinedNodeFlags,
  getRootDeclaration,
  getSourceFileOfNode,
  isEnumConst,
  isExternalOrCommonJSModule,
} from '../binder-utilities.js';
import { IntLinkTable, LinkTable } from '../link-tables.js';
import { NameResolver } from '../name-resolver.js';
import { isSameNode } from './utilities.js';
import { pathIsRelative } from '../path.js';
import { type CompilerOptions, shouldPreserveConstEnums } from '../options.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  addDeclaration,
  declarationAt,
  declarationCount,
  getDeclarations,
  InternalSymbolName,
  setDeclarations,
  Symbol,
  SymbolFlags,
  type SymbolTable,
} from '../symbol.js';

export const enum ConstantKind {
  None,
  Number,
  String,
}

/** The result of evaluating a constant expression, as the checker's evaluator returns it. */
export class Evaluation {
  readonly kind: ConstantKind;
  readonly number: number;
  readonly string: string;
  readonly isSyntacticallyString: boolean;
  readonly resolvedOtherFiles: boolean;
  readonly hasExternalReferences: boolean;

  constructor(
    kind: ConstantKind,
    numberValue: number,
    stringValue: string,
    isSyntacticallyString: boolean,
    resolvedOtherFiles: boolean,
    hasExternalReferences: boolean,
  ) {
    this.kind = kind;
    this.number = numberValue;
    this.string = stringValue;
    this.isSyntacticallyString = isSyntacticallyString;
    this.resolvedOtherFiles = resolvedOtherFiles;
    this.hasExternalReferences = hasExternalReferences;
  }

  /** The value as a string, as `+` concatenates it. */
  text(): string {
    return this.kind === ConstantKind.String ? this.string : String(this.number);
  }

  withFlags(isSyntacticallyString: boolean, resolvedOtherFiles: boolean, hasExternalReferences: boolean): Evaluation {
    return new Evaluation(
      this.kind,
      this.number,
      this.string,
      isSyntacticallyString,
      resolvedOtherFiles,
      hasExternalReferences,
    );
  }
}

export function numberEvaluation(value: number): Evaluation {
  return new Evaluation(ConstantKind.Number, value, '', false, false, false);
}

export function stringEvaluation(value: string, isSyntacticallyString: boolean): Evaluation {
  return new Evaluation(ConstantKind.String, 0, value, isSyntacticallyString, false, false);
}

export const noEvaluation = new Evaluation(ConstantKind.None, 0, '', false, false, false);

function noValue(isSyntacticallyString: boolean, resolvedOtherFiles: boolean, hasExternalReferences: boolean) {
  return new Evaluation(ConstantKind.None, 0, '', isSyntacticallyString, resolvedOtherFiles, hasExternalReferences);
}

/** Finds the program file a module specifier names. */
export abstract class ModuleLookup {
  /** The file `specifier`, the module name at `location` in `file`, resolves to. */
  abstract resolveModule(location: Node, file: SourceFile, specifier: string): SourceFile | undefined;
}

class NoModules extends ModuleLookup {
  resolveModule(_location: Node, _file: SourceFile, _specifier: string): SourceFile | undefined {
    return undefined;
  }
}

/** The global symbol table, with declarations of script files merged as the checker merges them. */
export class MergedGlobals {
  readonly table: SymbolTable;
  private readonly merged: Map<Symbol, Symbol>;

  private aliases: ReferenceResolver | undefined;

  constructor() {
    this.table = new Map<string, Symbol>();
    this.merged = new Map<Symbol, Symbol>();
    this.aliases = undefined;
  }

  /** Merges the globals of `files`, resolving aliases they merge with through `aliases`. */
  merge(files: readonly SourceFile[], aliases: ReferenceResolver): boolean {
    this.aliases = aliases;
    this.mergeFiles(files);
    // Aliases are resolved only while merging: resolvers of other threads can share the tables.
    this.aliases = undefined;
    return true;
  }

  private mergeFiles(files: readonly SourceFile[]): boolean {
    for (const file of files) {
      if (isExternalOrCommonJSModule(file)) continue;
      const locals = getLocals(file);
      if (locals !== undefined) this.mergeTable(this.table, locals, undefined);
    }
    for (const file of files) {
      for (const augmentation of file.moduleAugmentations) {
        const declaration = augmentation.parent;
        if (!(declaration instanceof ModuleDeclaration) || declaration.keyword !== SyntaxKind.GlobalKeyword) continue;
        const symbol = getSymbol(declaration);
        if (symbol !== undefined && symbol.exports !== undefined)
          this.mergeTable(this.table, symbol.exports, undefined);
      }
    }
    return true;
  }

  getMergedSymbol(symbol: Symbol): Symbol {
    const merged = this.merged.get(symbol);
    return merged !== undefined ? merged : symbol;
  }

  private mergeTable(target: SymbolTable, source: SymbolTable, parent: Symbol | undefined): boolean {
    for (const [name, sourceSymbol] of source) {
      const targetSymbol = target.get(name);
      if (targetSymbol === undefined) {
        target.set(name, this.getMergedSymbol(sourceSymbol));
        continue;
      }
      const merged = this.mergeSymbol(targetSymbol, sourceSymbol);
      if (parent !== undefined && (merged.flags & SymbolFlags.Transient) !== 0) merged.parent = parent;
      target.set(name, merged);
    }
    return true;
  }

  private mergeSymbol(target: Symbol, source: Symbol): Symbol {
    if (
      (target.flags & excludedSymbolFlags(source.flags)) !== 0 &&
      ((source.flags | target.flags) & SymbolFlags.Assignment) === 0
    )
      return target;
    if (source === target) return target;
    let result = target;
    if ((target.flags & SymbolFlags.Transient) === 0) {
      // Like the checker, an alias merges by its target: the merge clones what it resolves to.
      let resolved: Symbol | undefined = target;
      if ((target.flags & SymbolFlags.Alias) !== 0 && this.aliases !== undefined)
        resolved = this.aliases.resolveAlias(target);
      if (resolved === undefined) return source;
      // A conflict with what an alias resolves to replaces the alias.
      if (
        (resolved.flags & excludedSymbolFlags(source.flags)) !== 0 &&
        ((source.flags | resolved.flags) & SymbolFlags.Assignment) === 0
      )
        return source;
      result = new Symbol(resolved.flags | SymbolFlags.Transient, resolved.name);
      setDeclarations(result, getDeclarations(resolved).slice());
      result.parent = resolved.parent;
      result.valueDeclaration = resolved.valueDeclaration;
      result.members = resolved.members === undefined ? undefined : new Map<string, Symbol>(resolved.members);
      result.exports = resolved.exports === undefined ? undefined : new Map<string, Symbol>(resolved.exports);
      this.merged.set(resolved, result);
    }
    if (
      (source.flags & SymbolFlags.ValueModule) !== 0 &&
      (result.flags & SymbolFlags.ValueModule) !== 0 &&
      (result.flags & SymbolFlags.ConstEnumOnlyModule) !== 0 &&
      (source.flags & SymbolFlags.ConstEnumOnlyModule) === 0
    )
      result.flags &= ~SymbolFlags.ConstEnumOnlyModule;
    let sourceFlags = source.flags;
    if ((result.flags & SymbolFlags.ConstEnumOnlyModule) === 0) sourceFlags &= ~SymbolFlags.ConstEnumOnlyModule;
    result.flags |= sourceFlags;
    if (source.valueDeclaration !== undefined) setValueDeclaration(result, source.valueDeclaration);
    for (let i = 0; i < declarationCount(source); i++) addDeclaration(result, declarationAt(source, i));
    if (source.members !== undefined) {
      if (result.members === undefined) result.members = new Map<string, Symbol>();
      this.mergeTable(result.members, source.members, undefined);
    }
    if (source.exports !== undefined) {
      if (result.exports === undefined) result.exports = new Map<string, Symbol>();
      this.mergeTable(result.exports, source.exports, result);
    }
    this.merged.set(source, result);
    return result;
  }
}

function setValueDeclaration(symbol: Symbol, node: Node): boolean {
  const current = symbol.valueDeclaration;
  if (
    current === undefined ||
    (!((node.flags & NodeFlags.Ambient) !== 0 && (current.flags & NodeFlags.Ambient) === 0) &&
      current.kind !== node.kind &&
      current.kind === SyntaxKind.ModuleDeclaration)
  )
    symbol.valueDeclaration = node;
  return true;
}

function excludedSymbolFlags(flags: SymbolFlags): SymbolFlags {
  let result = SymbolFlags.None;
  if ((flags & SymbolFlags.BlockScopedVariable) !== 0) result |= SymbolFlags.BlockScopedVariableExcludes;
  if ((flags & SymbolFlags.FunctionScopedVariable) !== 0) result |= SymbolFlags.FunctionScopedVariableExcludes;
  if ((flags & SymbolFlags.Property) !== 0) result |= SymbolFlags.PropertyExcludes;
  if ((flags & SymbolFlags.EnumMember) !== 0) result |= SymbolFlags.EnumMemberExcludes;
  if ((flags & SymbolFlags.Function) !== 0) result |= SymbolFlags.FunctionExcludes;
  if ((flags & SymbolFlags.Class) !== 0) result |= SymbolFlags.ClassExcludes;
  if ((flags & SymbolFlags.Interface) !== 0) result |= SymbolFlags.InterfaceExcludes;
  if ((flags & SymbolFlags.RegularEnum) !== 0) result |= SymbolFlags.RegularEnumExcludes;
  if ((flags & SymbolFlags.ConstEnum) !== 0) result |= SymbolFlags.ConstEnumExcludes;
  if ((flags & SymbolFlags.ValueModule) !== 0) result |= SymbolFlags.ValueModuleExcludes;
  if ((flags & SymbolFlags.Method) !== 0) result |= SymbolFlags.MethodExcludes;
  if ((flags & SymbolFlags.GetAccessor) !== 0) result |= SymbolFlags.GetAccessorExcludes;
  if ((flags & SymbolFlags.SetAccessor) !== 0) result |= SymbolFlags.SetAccessorExcludes;
  if ((flags & SymbolFlags.TypeParameter) !== 0) result |= SymbolFlags.TypeParameterExcludes;
  if ((flags & SymbolFlags.TypeAlias) !== 0) result |= SymbolFlags.TypeAliasExcludes;
  if ((flags & SymbolFlags.Alias) !== 0) result |= SymbolFlags.AliasExcludes;
  return result;
}

/** Resolves names against merged symbols. */
class MergedNameResolver extends NameResolver {
  readonly merged: MergedGlobals;
  aliases: ReferenceResolver | undefined;

  constructor(options: CompilerOptions, merged: MergedGlobals) {
    super(options);
    this.merged = merged;
    this.globals = merged.table;
    this.aliases = undefined;
  }

  getSymbolOfDeclaration(node: Node): Symbol | undefined {
    const symbol = getSymbol(node);
    return symbol === undefined ? undefined : this.merged.getMergedSymbol(symbol);
  }

  /** As the checker: an alias has the meanings of what it resolves to. */
  lookup(symbols: SymbolTable, name: string, meaning: SymbolFlags): Symbol | undefined {
    if (meaning === SymbolFlags.None) return undefined;
    const symbol = symbols.get(name);
    if (symbol === undefined) return undefined;
    if ((symbol.flags & meaning) !== 0) return symbol;
    const aliases = this.aliases;
    if ((symbol.flags & SymbolFlags.Alias) !== 0 && aliases !== undefined)
      return (aliases.getSymbolFlags(symbol, false, false) & meaning) !== 0 ? symbol : undefined;
    return undefined;
  }
}

const valueMeaning = SymbolFlags.ExportValue | SymbolFlags.Value | SymbolFlags.Alias;
const maxAliasDepth = 64;

export class ReferenceResolver {
  readonly options: CompilerOptions;
  readonly merged: MergedGlobals;
  private readonly names: MergedNameResolver;
  private readonly modules: ModuleLookup;
  private readonly enumValues: Map<Node, Evaluation>;
  private readonly computedEnums: Set<Node>;
  private readonly aliasTargets: Map<Symbol, Symbol>;
  /** Value symbols of identifiers resolved as expressions, as the checker caches them, by node id. */
  private readonly resolvedSymbols: LinkTable<Symbol>;
  /** 1 for each identifier, by node id, that resolved to no value symbol. */
  private readonly unresolvedReferences: IntLinkTable;
  private readonly unresolvedAliases: Set<Symbol>;
  private readonly resolvingAliases: Set<Symbol>;
  /** The module each module specifier names (`null` for none), by specifier. */
  private readonly specifierModules: Map<Node, Symbol | null>;
  /** Results of `isTypeOnlyAliasChain`, for queries outside alias resolution. */
  private readonly typeOnlyChains: Map<Symbol, boolean>;

  /** With `merged`, the globals of `files` as another resolver merged them (`EmitIndexes`), not merged again. */
  constructor(
    options: CompilerOptions,
    files: readonly SourceFile[],
    modules: ModuleLookup | undefined,
    merged: MergedGlobals | undefined = undefined,
  ) {
    this.options = options;
    this.merged = merged !== undefined ? merged : new MergedGlobals();
    this.names = new MergedNameResolver(options, this.merged);
    this.modules = modules !== undefined ? modules : new NoModules();
    this.enumValues = new Map<Node, Evaluation>();
    this.computedEnums = new Set<Node>();
    this.aliasTargets = new Map<Symbol, Symbol>();
    this.resolvedSymbols = new LinkTable<Symbol>();
    this.unresolvedReferences = new IntLinkTable();
    this.unresolvedAliases = new Set<Symbol>();
    this.resolvingAliases = new Set<Symbol>();
    this.specifierModules = new Map<Node, Symbol | null>();
    this.typeOnlyChains = new Map<Symbol, boolean>();
    this.names.aliases = this;
    if (merged === undefined) this.merged.merge(files, this);
  }

  getMergedSymbol(symbol: Symbol): Symbol {
    return this.merged.getMergedSymbol(symbol);
  }

  getSymbolOfDeclaration(node: Node): Symbol | undefined {
    return this.names.getSymbolOfDeclaration(node);
  }

  resolveName(location: Node, name: string, meaning: SymbolFlags): Symbol | undefined {
    return this.names.resolve(location, name, meaning, undefined, false, false);
  }

  /** The value an identifier in an expression refers to, cached for later queries of the identifier. */
  getResolvedSymbol(node: Identifier): Symbol | undefined {
    const cached = this.resolvedSymbols.get(node.id);
    if (cached !== undefined) return cached;
    if (this.unresolvedReferences.get(node.id) !== 0) return undefined;
    const symbol = this.resolveName(node, node.text, SymbolFlags.Value | SymbolFlags.ExportValue);
    if (symbol === undefined) this.unresolvedReferences.set(node.id, 1);
    else this.resolvedSymbols.set(node.id, symbol);
    return symbol;
  }

  private getReferencedValueSymbol(reference: Identifier, startInDeclarationContainer: boolean): Symbol | undefined {
    // An identifier resolved as an expression keeps that meaning, as with the checker's cache.
    const cached = this.resolvedSymbols.get(reference.id);
    if (cached !== undefined) return cached;
    if (this.unresolvedReferences.get(reference.id) !== 0) return undefined;
    let location: Node = reference;
    const parent = reference.parent;
    if (startInDeclarationContainer && parent !== undefined && isSameNode(getName(parent), reference)) {
      const container = getDeclarationContainer(parent);
      if (container !== undefined) location = container;
    }
    return this.resolveName(location, reference.text, valueMeaning);
  }

  private getParentOfSymbol(symbol: Symbol): Symbol | undefined {
    const parent = symbol.parent;
    return parent === undefined ? undefined : this.getMergedSymbol(parent);
  }

  getExportSymbolOfValueSymbolIfExported(symbol: Symbol): Symbol {
    const exportSymbol = symbol.exportSymbol;
    if ((symbol.flags & SymbolFlags.ExportValue) !== 0 && exportSymbol !== undefined)
      return this.getMergedSymbol(exportSymbol);
    return this.getMergedSymbol(symbol);
  }

  /** The source file, namespace or enum whose export `node` refers to, if it refers to an export. */
  getReferencedExportContainer(node: Identifier, prefixLocals: boolean): Node | undefined {
    const parent = node.parent;
    const startInDeclarationContainer =
      parent !== undefined &&
      (parent.kind === SyntaxKind.ModuleDeclaration || parent.kind === SyntaxKind.EnumDeclaration) &&
      isSameNode(getName(parent), node);
    let symbol = this.getReferencedValueSymbol(node, startInDeclarationContainer);
    if (symbol === undefined) return undefined;
    if ((symbol.flags & SymbolFlags.ExportValue) !== 0) {
      const local = symbol.exportSymbol;
      if (local === undefined) return undefined;
      const exportSymbol = this.getMergedSymbol(local);
      if (
        !prefixLocals &&
        (exportSymbol.flags & SymbolFlags.ExportHasLocal) !== 0 &&
        (exportSymbol.flags & SymbolFlags.Variable) === 0
      )
        return undefined;
      symbol = exportSymbol;
    }
    const parentSymbol = this.getParentOfSymbol(symbol);
    if (parentSymbol === undefined) return undefined;
    const valueDeclaration = parentSymbol.valueDeclaration;
    if (
      (parentSymbol.flags & SymbolFlags.ValueModule) !== 0 &&
      valueDeclaration !== undefined &&
      valueDeclaration.kind === SyntaxKind.SourceFile
    )
      return (valueDeclaration as SourceFile) === getSourceFileOfNode(node) ? valueDeclaration : undefined;
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (
        (current.kind === SyntaxKind.ModuleDeclaration || current.kind === SyntaxKind.EnumDeclaration) &&
        this.getSymbolOfDeclaration(current) === parentSymbol
      )
        return current;
    }
    return undefined;
  }

  /** The import declaring the alias `node` refers to, unless a local value shadows it. */
  getReferencedImportDeclaration(node: Identifier): Node | undefined {
    // As the checker: an identifier that didn't resolve as a value may still name an alias.
    const reference: Node = node;
    let symbol = this.resolvedSymbols.get(reference.id);
    if (symbol === undefined) symbol = this.resolveName(node, node.text, valueMeaning);
    if (
      symbol === undefined ||
      !isNonLocalAlias(symbol, SymbolFlags.Value) ||
      this.getTypeOnlyAliasDeclarationFor(symbol, SymbolFlags.Value)
    )
      return undefined;
    return getDeclarationOfAliasSymbol(symbol);
  }

  /** Whether an alias reaches a type-only declaration before a symbol with `meaning`. */
  private getTypeOnlyAliasDeclarationFor(symbol: Symbol, meaning: SymbolFlags): boolean {
    let current = symbol;
    for (let depth = 0; depth < maxAliasDepth; depth++) {
      if ((current.flags & SymbolFlags.Alias) === 0 || (current.flags & meaning) !== 0) return false;
      const resolved = this.resolveAlias(current);
      if (this.isTypeOnlyAliasChain(current)) return true;
      if (resolved === undefined || resolved === current) return false;
      current = resolved;
    }
    return false;
  }

  getReferencedValueDeclaration(node: Identifier): Node | undefined {
    const symbol = this.getReferencedValueSymbol(node, false);
    return symbol === undefined ? undefined : this.getExportSymbolOfValueSymbolIfExported(symbol).valueDeclaration;
  }

  getReferencedValueDeclarations(node: Identifier): Node[] | undefined {
    const resolved = this.getReferencedValueSymbol(node, false);
    if (resolved === undefined) return undefined;
    const symbol = this.getExportSymbolOfValueSymbolIfExported(resolved);
    const declarations: Node[] = [];
    for (const declaration of getDeclarations(symbol))
      if (isValueDeclarationKind(declaration.kind)) declarations.push(declaration);
    return declarations;
  }

  // Aliases

  /** The export `name` of a namespace, enum or module. */
  getExportOfSymbol(symbol: Symbol, name: string): Symbol | undefined {
    const declaration = symbol.valueDeclaration;
    if (declaration instanceof SourceFile) return this.getExportOfModule(symbol, name);
    const exports = symbol.exports;
    const member = exports === undefined ? undefined : exports.get(name);
    return member === undefined ? undefined : this.getMergedSymbol(member);
  }

  isTypeOnlyAliasSymbol(symbol: Symbol): boolean {
    return this.isTypeOnlyAlias(symbol);
  }

  /** Whether an alias is declared type-only; as in the checker, a default import counts only if its module resolves. */
  private isTypeOnlyAlias(symbol: Symbol): boolean {
    const declaration = getDeclarationOfAliasSymbol(symbol);
    if (declaration instanceof ImportClause) {
      const importDeclaration = declaration.parent;
      if (
        importDeclaration === undefined ||
        this.resolveModuleSpecifier(declaration, getModuleSpecifierOf(importDeclaration)) === undefined
      )
        return false;
    }
    if (isTypeOnlyAlias(symbol)) return true;
    // An import found through `export type * from`.
    if (declaration === undefined) return false;
    const imported = importedNameOf(declaration);
    const moduleDeclaration = moduleDeclarationOfSpecifier(declaration);
    if (imported === undefined || moduleDeclaration === undefined) return false;
    const moduleSymbol = this.resolveModuleSpecifier(declaration, getModuleSpecifierOf(moduleDeclaration));
    return moduleSymbol !== undefined && this.isExportedThroughTypeOnlyStar(moduleSymbol, imported);
  }

  /**
   * Whether a module's export `name` comes from another module through an `export type *`, as tsgo's
   * getExportsOfModuleWorker decides: a module reached through a type-only `export *` has its exports marked, and a
   * module reached without one, even if already visited, clears the mark of its own exports.
   */
  private isExportedThroughTypeOnlyStar(moduleSymbol: Symbol, name: string): boolean {
    if (name === InternalSymbolName.Default) return false;
    const walk = new TypeOnlyStarWalk(name);
    this.visitExportStars(walk, moduleSymbol, false, false);
    return walk.typeOnly && !walk.nonTypeOnly;
  }

  /** Visits a module of an `export *` walk; returns whether it exports the walk's name. */
  private visitExportStars(
    walk: TypeOnlyStarWalk,
    symbol: Symbol | undefined,
    starIsTypeOnly: boolean,
    isTypeOnly: boolean,
  ): boolean {
    const exports = symbol === undefined ? undefined : symbol.exports;
    if (!isTypeOnly && exports !== undefined && exports.has(walk.name)) walk.nonTypeOnly = true;
    if (symbol === undefined || exports === undefined || walk.visited.has(symbol)) return false;
    walk.visited.add(symbol);
    let found = exports.has(walk.name);
    const star = exports.get(InternalSymbolName.ExportStar);
    if (star !== undefined)
      for (const declaration of getDeclarations(star)) {
        if (!(declaration instanceof ExportDeclaration)) continue;
        const target = this.resolveExternalModuleSymbol(
          this.resolveModuleSpecifier(declaration, declaration.moduleSpecifier),
        );
        if (this.visitExportStars(walk, target, declaration.isTypeOnly, isTypeOnly || declaration.isTypeOnly))
          found = true;
      }
    if (starIsTypeOnly && found) walk.typeOnly = true;
    return found;
  }

  /** Whether a symbol is declared in the global scope. */
  isGlobalSymbol(symbol: Symbol): boolean {
    if (declarationCount(symbol) === 0) return false;
    const container = getDeclarationContainer(symbol.declaration!);
    return container instanceof SourceFile && !isExternalOrCommonJSModule(container as SourceFile);
  }

  /** Whether a symbol is a value at runtime: const enums aren't unless preserved. */
  isValueSymbol(symbol: Symbol): boolean {
    return (
      (symbol.flags & SymbolFlags.Value) !== 0 &&
      (shouldPreserveConstEnums(this.options) ||
        ((symbol.flags & SymbolFlags.ConstEnum) === 0 && (symbol.flags & SymbolFlags.ConstEnumOnlyModule) === 0))
    );
  }

  /** Whether an alias refers to a value, counting unresolved aliases as values; `excludeTypeOnly` stops at type-only imports. */
  isAliasResolvedToValue(symbol: Symbol, excludeTypeOnly: boolean): boolean {
    const resolved = this.resolveAlias(symbol);
    if (resolved === undefined) return !excludeTypeOnly || !this.isTypeOnlyAliasChain(symbol);
    const target = this.getExportSymbolOfValueSymbolIfExported(resolved);
    return (
      (this.getSymbolFlags(symbol, excludeTypeOnly, true) & SymbolFlags.Value) !== 0 &&
      (shouldPreserveConstEnums(this.options) ||
        ((target.flags & SymbolFlags.ConstEnum) === 0 && (target.flags & SymbolFlags.ConstEnumOnlyModule) === 0))
    );
  }

  /**
   * Whether an alias is type-only, itself or through the aliases it directly names. Cached unless an
   * alias is being resolved, when the answer can depend on which.
   */
  isTypeOnlyAliasChain(symbol: Symbol): boolean {
    if (this.resolvingAliases.size > 0) return this.computeTypeOnlyAliasChain(symbol);
    let result = this.typeOnlyChains.get(symbol);
    if (result === undefined) {
      result = this.computeTypeOnlyAliasChain(symbol);
      this.typeOnlyChains.set(symbol, result);
    }
    return result;
  }

  private computeTypeOnlyAliasChain(symbol: Symbol): boolean {
    let current = symbol;
    for (let depth = 0; depth < maxAliasDepth && (current.flags & SymbolFlags.Alias) !== 0; depth++) {
      if (this.isTypeOnlyAlias(current)) return true;
      const declaration = getDeclarationOfAliasSymbol(current);
      const next = declaration === undefined ? undefined : this.getTargetOfAliasDeclaration(declaration);
      // Only a pure alias passes on its type-only-ness.
      if (next === undefined || !isPureAlias(next)) return false;
      current = next;
    }
    return false;
  }

  /** The symbol an alias ultimately refers to, or undefined if it can't be resolved. */
  resolveAlias(symbol: Symbol): Symbol | undefined {
    if ((symbol.flags & SymbolFlags.Alias) === 0) return symbol;
    const cached = this.aliasTargets.get(symbol);
    if (cached !== undefined) return cached;
    if (this.unresolvedAliases.has(symbol) || this.resolvingAliases.has(symbol)) return undefined;
    this.resolvingAliases.add(symbol);
    const declaration = getDeclarationOfAliasSymbol(symbol);
    const next = declaration === undefined ? undefined : this.getTargetOfAliasDeclaration(declaration);
    // Only a pure alias is followed; one merged with other meanings is the target itself.
    const target = next === undefined ? undefined : isPureAlias(next) ? this.resolveAlias(next) : next;
    this.resolvingAliases.delete(symbol);
    if (target === undefined) this.unresolvedAliases.add(symbol);
    else this.aliasTargets.set(symbol, target);
    return target;
  }

  /** The flags of a symbol and the aliases it resolves through; all flags for an unresolved alias. */
  getSymbolFlags(start: Symbol, excludeTypeOnly: boolean, excludeLocal: boolean): SymbolFlags {
    let symbol = start;
    let flags = excludeLocal ? SymbolFlags.None : symbol.flags;
    const seen = new Set<Symbol>();
    while ((symbol.flags & SymbolFlags.Alias) !== 0) {
      if (excludeTypeOnly && this.isTypeOnlyAliasChain(symbol)) break;
      const resolved = this.resolveAlias(symbol);
      if (resolved === undefined) return SymbolFlags.All;
      const target = this.getExportSymbolOfValueSymbolIfExported(resolved);
      if ((target.flags & SymbolFlags.Alias) !== 0) {
        if (target === symbol || seen.has(target)) break;
        seen.add(symbol);
        seen.add(target);
      }
      flags |= target.flags;
      symbol = target;
    }
    return flags;
  }

  private getTargetOfAliasDeclaration(node: Node): Symbol | undefined {
    if (node instanceof ImportEqualsDeclaration) {
      const reference = node.moduleReference;
      if (reference instanceof ExternalModuleReference)
        return this.resolveExternalModuleSymbol(this.resolveModuleSpecifier(node, reference.expression));
      // `import a = b` names a namespace; `import a = b.c` anything.
      const meaning =
        reference instanceof Identifier
          ? SymbolFlags.Namespace
          : SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace;
      return this.resolveEntityName(reference, meaning, true);
    }
    if (node instanceof ImportClause) {
      const declaration = node.parent;
      if (declaration === undefined) return undefined;
      const moduleSymbol = this.resolveModuleSpecifier(node, getModuleSpecifierOf(declaration));
      if (moduleSymbol === undefined) return undefined;
      const exported = this.getExportOfModule(moduleSymbol, InternalSymbolName.Default);
      return exported !== undefined ? exported : this.resolveExternalModuleSymbol(moduleSymbol);
    }
    if (node instanceof NamespaceImport) {
      const clause = node.parent;
      const declaration = clause === undefined ? undefined : clause.parent;
      if (declaration === undefined) return undefined;
      return this.resolveExternalModuleSymbol(this.resolveModuleSpecifier(node, getModuleSpecifierOf(declaration)));
    }
    if (node instanceof ImportSpecifier) {
      const declaration = node.parent === undefined ? undefined : node.parent.parent;
      const importDeclaration = declaration === undefined ? undefined : declaration.parent;
      if (importDeclaration === undefined) return undefined;
      const moduleSymbol = this.resolveModuleSpecifier(node, getModuleSpecifierOf(importDeclaration));
      if (moduleSymbol === undefined) return undefined;
      const name = node.propertyName !== undefined ? node.propertyName : node.name;
      return this.getExportOfModule(moduleSymbol, moduleExportNameText(name));
    }
    if (node instanceof ExportSpecifier) {
      const exportDeclaration = node.parent === undefined ? undefined : node.parent.parent;
      const local = node.propertyName !== undefined ? node.propertyName : node.name;
      if (exportDeclaration instanceof ExportDeclaration && exportDeclaration.moduleSpecifier !== undefined) {
        const moduleSymbol = this.resolveModuleSpecifier(node, exportDeclaration.moduleSpecifier);
        return moduleSymbol === undefined
          ? undefined
          : this.getExportOfModule(moduleSymbol, moduleExportNameText(local));
      }
      if (!(local instanceof Identifier)) return undefined;
      return this.resolveName(local, local.text, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace);
    }
    if (node instanceof ExportAssignment) {
      const expression = node.expression;
      if (expression.kind === SyntaxKind.Identifier || expression.kind === SyntaxKind.PropertyAccessExpression)
        return this.resolveEntityName(expression, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace, true);
      return getSymbol(node);
    }
    return undefined;
  }

  /** The module an implicit import of `file`, such as the JSX runtime, refers to. */
  resolveImplicitImport(file: SourceFile, name: string): Symbol | undefined {
    const specifier = new StringLiteral(name, TokenFlags.None);
    const declaration = new ImportDeclaration(SyntaxKind.ImportDeclaration, undefined, undefined, specifier, undefined);
    specifier.parent = declaration;
    declaration.parent = file;
    return this.resolveModuleSpecifier(specifier, specifier);
  }

  /** The module `specifier` names; `location` is in the same file. */
  private resolveModuleSpecifier(location: Node, specifier: Node | undefined): Symbol | undefined {
    if (specifier === undefined) return undefined;
    const cached = this.specifierModules.get(specifier);
    if (cached !== undefined) return cached === null ? undefined : cached;
    const result = this.computeModuleOfSpecifier(location, specifier);
    this.specifierModules.set(specifier, result === undefined ? null : result);
    return result;
  }

  private computeModuleOfSpecifier(location: Node, specifier: Node): Symbol | undefined {
    const name = stringLiteralText(specifier);
    if (name === undefined) return undefined;
    // Ambient modules, `declare module "m"`, come first for names that aren't relative.
    if (!pathIsRelative(name)) {
      const ambient = this.merged.table.get('"' + name + '"');
      if (ambient !== undefined && (ambient.flags & SymbolFlags.Module) !== 0) return ambient;
    }
    const file = this.modules.resolveModule(specifier, getSourceFileOfNode(location), name);
    if (file === undefined) return undefined;
    const symbol = getSymbol(file);
    return symbol === undefined ? undefined : this.getMergedSymbol(symbol);
  }

  /** The `export =` target of a module, or the module itself. */
  private resolveExternalModuleSymbol(moduleSymbol: Symbol | undefined): Symbol | undefined {
    if (moduleSymbol === undefined || moduleSymbol.exports === undefined) return moduleSymbol;
    const exportEquals = moduleSymbol.exports.get(InternalSymbolName.ExportEquals);
    if (exportEquals === undefined) return moduleSymbol;
    const resolved = this.resolveAlias(exportEquals);
    return resolved !== undefined ? resolved : exportEquals;
  }

  private getExportOfModule(moduleSymbol: Symbol, name: string): Symbol | undefined {
    const target = this.resolveExternalModuleSymbol(moduleSymbol);
    if (target === undefined) return undefined;
    const visited = new Set<Symbol>();
    return this.getExportFromTable(target, name, visited);
  }

  private getExportFromTable(moduleSymbol: Symbol, name: string, visited: Set<Symbol>): Symbol | undefined {
    if (visited.has(moduleSymbol)) return undefined;
    visited.add(moduleSymbol);
    const exports = moduleSymbol.exports;
    if (exports === undefined) return undefined;
    // The export itself, an alias the caller resolves, so type-only exports pass on.
    const direct = exports.get(name);
    if (direct !== undefined) return this.getMergedSymbol(direct);
    if (name === InternalSymbolName.Default) return undefined;
    const star = exports.get(InternalSymbolName.ExportStar);
    if (star === undefined) return undefined;
    for (const declaration of getDeclarations(star)) {
      if (!(declaration instanceof ExportDeclaration)) continue;
      const target = this.resolveExternalModuleSymbol(
        this.resolveModuleSpecifier(declaration, declaration.moduleSpecifier),
      );
      if (target === undefined) continue;
      const found = this.getExportFromTable(target, name, visited);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The symbol an identifier or dotted name refers to with `meaning`, through aliases unless `dontResolveAlias`. */
  resolveEntityName(name: Node, meaning: SymbolFlags, dontResolveAlias: boolean): Symbol | undefined {
    let symbol: Symbol | undefined;
    if (name instanceof Identifier) {
      const resolved = this.resolveName(name, name.text, meaning | SymbolFlags.Alias);
      symbol = resolved === undefined ? undefined : this.getMergedSymbol(resolved);
    } else if (name.kind === SyntaxKind.QualifiedName || name.kind === SyntaxKind.PropertyAccessExpression) {
      const left = entityNameLeft(name);
      const right = entityNameRight(name);
      if (left === undefined || !(right instanceof Identifier)) return undefined;
      const namespace = this.resolveEntityName(left, SymbolFlags.Namespace, false);
      if (namespace === undefined) return undefined;
      const exports = namespace.exports;
      let member = exports === undefined ? undefined : exports.get(right.text);
      // A namespace merged with an alias also has the members of what the alias names, as its type does.
      if (member === undefined && (namespace.flags & SymbolFlags.Alias) !== 0) {
        const target = this.resolveAlias(namespace);
        const targetExports = target === undefined ? undefined : target.exports;
        if (targetExports !== undefined) member = targetExports.get(right.text);
      }
      if (member === undefined || (member.flags & (meaning | SymbolFlags.Alias)) === 0) return undefined;
      symbol = this.getMergedSymbol(member);
    } else return undefined;
    if (symbol === undefined) return undefined;
    if (!dontResolveAlias && (symbol.flags & SymbolFlags.Alias) !== 0) {
      const target = this.resolveAlias(symbol);
      return target === undefined ? undefined : this.getMergedSymbol(target);
    }
    return symbol;
  }

  // Constant values

  /**
   * The symbol an entity name expression such as `E.A` refers to as an expression: tsgo takes the symbol its checker
   * resolves the expression to, where each name on the left is a value, so a local `let E` hides a const enum `E`.
   */
  private resolveValueEntityName(name: Node): Symbol | undefined {
    let symbol: Symbol | undefined;
    if (name instanceof Identifier) {
      const resolved = this.resolveName(name, name.text, SymbolFlags.Value | SymbolFlags.Alias);
      symbol = resolved === undefined ? undefined : this.getMergedSymbol(resolved);
    } else if (name instanceof PropertyAccessExpression) {
      const left = this.resolveValueEntityName(name.expression);
      const right = name.name;
      if (left === undefined || !(right instanceof Identifier)) return undefined;
      let member = left.exports === undefined ? undefined : left.exports.get(right.text);
      // A namespace merged with an alias also has the members of what the alias names, as its type does.
      if (member === undefined && (left.flags & SymbolFlags.Alias) !== 0) {
        const target = this.resolveAlias(left);
        const targetExports = target === undefined ? undefined : target.exports;
        if (targetExports !== undefined) member = targetExports.get(right.text);
      }
      if (member === undefined || (member.flags & (SymbolFlags.Value | SymbolFlags.Alias)) === 0) return undefined;
      symbol = this.getMergedSymbol(member);
    } else return undefined;
    if (symbol === undefined || (symbol.flags & SymbolFlags.Alias) === 0) return symbol;
    const target = this.resolveAlias(symbol);
    return target === undefined ? undefined : this.getMergedSymbol(target);
  }

  /** The value of an enum member, computing the values of its whole declaration. */
  getEnumMemberValue(member: Node): Evaluation {
    const declaration = member.parent;
    if (declaration instanceof EnumDeclaration) this.computeEnumMemberValues(declaration as EnumDeclaration);
    const value = this.enumValues.get(member);
    return value !== undefined ? value : noEvaluation;
  }

  /** The inlined value of a const enum member access such as `E.A` or `E["A"]`. */
  getConstantValue(node: Node): Evaluation {
    if (node instanceof EnumMember) return this.getEnumMemberValue(node);
    let symbol: Symbol | undefined;
    if (node instanceof PropertyAccessExpression) {
      if (isEntityNameExpressionNode(node)) symbol = this.resolveValueEntityName(node);
    } else if (node instanceof ElementAccessExpression) {
      const argument = stringLiteralText(node.argumentExpression);
      if (isEntityNameExpressionNode(node.expression) && argument !== undefined) {
        const root = this.resolveValueEntityName(node.expression);
        const exports = root === undefined ? undefined : root.exports;
        const member = exports === undefined ? undefined : exports.get(argument);
        if (member !== undefined) symbol = this.getMergedSymbol(member);
      }
    }
    if (symbol === undefined || (symbol.flags & SymbolFlags.EnumMember) === 0) return noEvaluation;
    const declaration = symbol.valueDeclaration;
    if (declaration === undefined || declaration.parent === undefined || !isEnumConst(declaration.parent))
      return noEvaluation;
    return this.getEnumMemberValue(declaration);
  }

  private computeEnumMemberValues(node: EnumDeclaration): boolean {
    if (this.computedEnums.has(node)) return false;
    this.computedEnums.add(node);
    const members = node.members.nodes;
    let hasAutoValue = true;
    let autoValue = 0;
    for (const member of members) {
      let result = noEvaluation;
      if (member instanceof EnumMember) {
        if (member.initializer !== undefined) result = this.evaluate(member.initializer, member);
        else if ((node.flags & NodeFlags.Ambient) !== 0 && !isEnumConst(node)) result = noEvaluation;
        else if (hasAutoValue) result = numberEvaluation(autoValue);
      }
      this.enumValues.set(member, result);
      hasAutoValue = result.kind === ConstantKind.Number;
      if (hasAutoValue) autoValue = result.number + 1;
    }
    return true;
  }

  /** Evaluates a constant expression at `location`, as the checker's evaluator does. */
  evaluate(node: Node, location: Node | undefined): Evaluation {
    const expression = skipEvaluationParentheses(node);
    if (expression instanceof PrefixUnaryExpression) {
      const operand = this.evaluate(expression.operand, location);
      if (operand.kind === ConstantKind.Number) {
        const value = operand.number;
        switch (expression.operator) {
          case SyntaxKind.PlusToken:
            return numberEvaluation(value).withFlags(false, operand.resolvedOtherFiles, operand.hasExternalReferences);
          case SyntaxKind.MinusToken:
            return numberEvaluation(-value).withFlags(false, operand.resolvedOtherFiles, operand.hasExternalReferences);
          case SyntaxKind.TildeToken:
            return numberEvaluation(~value).withFlags(false, operand.resolvedOtherFiles, operand.hasExternalReferences);
        }
      }
      return noValue(false, operand.resolvedOtherFiles, operand.hasExternalReferences);
    }
    if (expression instanceof BinaryExpression) return this.evaluateBinary(expression, location);
    if (expression instanceof StringLiteral) return stringEvaluation(expression.text, true);
    if (expression instanceof NoSubstitutionTemplateLiteral) return stringEvaluation(expression.text, true);
    if (expression instanceof TemplateExpression) return this.evaluateTemplate(expression, location);
    if (expression instanceof NumericLiteral) return numberEvaluation(Number(expression.text));
    if (expression instanceof Identifier) return this.evaluateEntity(expression, location);
    if (expression instanceof PropertyAccessExpression) {
      if (isEntityNameExpressionNode(expression.expression)) return this.evaluateEntity(expression, location);
    } else if (expression instanceof ElementAccessExpression) {
      if (isEntityNameExpressionNode(expression.expression)) return this.evaluateEntity(expression, location);
    }
    return noEvaluation;
  }

  private evaluateBinary(expression: BinaryExpression, location: Node | undefined): Evaluation {
    const left = this.evaluate(expression.left, location);
    const right = this.evaluate(expression.right, location);
    const operator = expression.operatorToken.kind;
    const isSyntacticallyString =
      (left.isSyntacticallyString || right.isSyntacticallyString) && operator === SyntaxKind.PlusToken;
    const resolvedOtherFiles = left.resolvedOtherFiles || right.resolvedOtherFiles;
    const hasExternalReferences = left.hasExternalReferences || right.hasExternalReferences;
    if (left.kind === ConstantKind.Number && right.kind === ConstantKind.Number) {
      const value = binaryNumber(operator, left.number, right.number);
      if (value.kind !== ConstantKind.None)
        return value.withFlags(isSyntacticallyString, resolvedOtherFiles, hasExternalReferences);
    }
    if (left.kind !== ConstantKind.None && right.kind !== ConstantKind.None && operator === SyntaxKind.PlusToken)
      return stringEvaluation(left.text() + right.text(), isSyntacticallyString).withFlags(
        isSyntacticallyString,
        resolvedOtherFiles,
        hasExternalReferences,
      );
    return noValue(isSyntacticallyString, resolvedOtherFiles, hasExternalReferences);
  }

  private evaluateTemplate(expression: TemplateExpression, location: Node | undefined): Evaluation {
    let text = expression.head.text;
    let resolvedOtherFiles = false;
    let hasExternalReferences = false;
    const spans = expression.templateSpans.nodes;
    for (const span of spans) {
      if (!(span instanceof TemplateSpan)) return noValue(true, false, false);
      const value = this.evaluate(span.expression, location);
      if (value.kind === ConstantKind.None) return noValue(true, false, false);
      text += value.text() + literalText(span.literal);
      resolvedOtherFiles = resolvedOtherFiles || value.resolvedOtherFiles;
      hasExternalReferences = hasExternalReferences || value.hasExternalReferences;
    }
    return stringEvaluation(text, true).withFlags(true, resolvedOtherFiles, hasExternalReferences);
  }

  private evaluateEntity(expression: Node, location: Node | undefined): Evaluation {
    if (expression instanceof ElementAccessExpression) {
      const argument = stringLiteralText(expression.argumentExpression);
      if (argument === undefined) return noEvaluation;
      const root = this.resolveEntityName(expression.expression, SymbolFlags.Value, false);
      if (root === undefined || (root.flags & SymbolFlags.Enum) === 0 || root.exports === undefined)
        return noEvaluation;
      const member = root.exports.get(argument);
      if (member === undefined) return noEvaluation;
      return this.evaluateEnumMemberSymbol(this.getMergedSymbol(member), location);
    }
    const symbol = this.resolveEntityName(expression, SymbolFlags.Value, false);
    if (symbol === undefined) return noEvaluation;
    if (expression instanceof Identifier && (expression.text === 'Infinity' || expression.text === 'NaN')) {
      // A global `Infinity` or `NaN`; without lib files these don't resolve at all.
      if (declarationCount(symbol) > 0 && isAmbientGlobal(symbol))
        return numberEvaluation(expression.text === 'NaN' ? NaN : Infinity);
    }
    if ((symbol.flags & SymbolFlags.EnumMember) !== 0) return this.evaluateEnumMemberSymbol(symbol, location);
    if (isConstantVariable(symbol)) {
      const declaration = symbol.valueDeclaration;
      if (
        declaration instanceof VariableDeclaration &&
        getType(declaration) === undefined &&
        declaration.initializer !== undefined &&
        (location === undefined || (declaration !== location && isDeclaredBeforeUse(declaration, location)))
      ) {
        const result = this.evaluate(declaration.initializer, declaration);
        if (location !== undefined && getSourceFileOfNode(location) !== getSourceFileOfNode(declaration))
          return result.withFlags(false, true, true);
        return result.withFlags(result.isSyntacticallyString, result.resolvedOtherFiles, true);
      }
    }
    return noEvaluation;
  }

  private evaluateEnumMemberSymbol(symbol: Symbol, location: Node | undefined): Evaluation {
    const declaration = symbol.valueDeclaration;
    if (location === undefined) return declaration === undefined ? noEvaluation : this.getEnumMemberValue(declaration);
    if (declaration === undefined || declaration === location) return noEvaluation;
    if (!isDeclaredBeforeUse(declaration, location)) return numberEvaluation(0);
    const value = this.getEnumMemberValue(declaration);
    if (location.parent !== declaration.parent)
      return value.withFlags(value.isSyntacticallyString, value.resolvedOtherFiles, true);
    return value;
  }
}

function binaryNumber(operator: SyntaxKind, left: number, right: number): Evaluation {
  switch (operator) {
    case SyntaxKind.BarToken:
      return numberEvaluation(left | right);
    case SyntaxKind.AmpersandToken:
      return numberEvaluation(left & right);
    case SyntaxKind.GreaterThanGreaterThanToken:
      return numberEvaluation(left >> right);
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return numberEvaluation(left >>> right);
    case SyntaxKind.LessThanLessThanToken:
      return numberEvaluation(left << right);
    case SyntaxKind.CaretToken:
      return numberEvaluation(left ^ right);
    case SyntaxKind.AsteriskToken:
      return numberEvaluation(left * right);
    case SyntaxKind.SlashToken:
      return numberEvaluation(left / right);
    case SyntaxKind.PlusToken:
      return numberEvaluation(left + right);
    case SyntaxKind.MinusToken:
      return numberEvaluation(left - right);
    case SyntaxKind.PercentToken:
      return numberEvaluation(left % right);
    case SyntaxKind.AsteriskAsteriskToken:
      return numberEvaluation(left ** right);
  }
  return noEvaluation;
}

function literalText(node: Node): string {
  if (node instanceof TemplateMiddle) return node.text;
  if (node instanceof TemplateTail) return node.text;
  return '';
}

/** Skips parentheses only: type assertions and `!` break evaluation, as in the checker. */
function skipEvaluationParentheses(node: Node): Node {
  let current = node;
  while (current instanceof ParenthesizedExpression) current = current.expression;
  return current;
}

/** The text of a string literal or no-substitution template literal. */
export function stringLiteralText(node: Node): string | undefined {
  if (node instanceof StringLiteral) return node.text;
  if (node instanceof NoSubstitutionTemplateLiteral) return node.text;
  return undefined;
}

function entityNameLeft(node: Node): Node | undefined {
  if (node instanceof QualifiedName) return node.left;
  if (node instanceof PropertyAccessExpression) return node.expression;
  return undefined;
}

function entityNameRight(node: Node): Node | undefined {
  if (node instanceof QualifiedName) return node.right;
  if (node instanceof PropertyAccessExpression) return node.name;
  return undefined;
}

export function isEntityNameExpressionNode(node: Node): boolean {
  if (node instanceof Identifier) return true;
  if (node instanceof PropertyAccessExpression)
    return node.name instanceof Identifier && isEntityNameExpressionNode(node.expression);
  return false;
}

function isAmbientGlobal(symbol: Symbol): boolean {
  for (let i = 0; i < declarationCount(symbol); i++)
    if ((declarationAt(symbol, i).flags & NodeFlags.Ambient) === 0) return false;
  return true;
}

function isConstantVariable(symbol: Symbol): boolean {
  if ((symbol.flags & SymbolFlags.Variable) === 0) return false;
  const declaration = symbol.valueDeclaration;
  return declaration !== undefined && (getCombinedNodeFlags(declaration) & NodeFlags.Constant) !== 0;
}

/** Whether `declaration` precedes `usage`, or `usage` runs later, as for the checker's block-scoped use check. */
function isDeclaredBeforeUse(declaration: Node, usage: Node): boolean {
  if (getSourceFileOfNode(declaration) !== getSourceFileOfNode(usage)) return true;
  if ((usage.flags & (NodeFlags.JSDoc | NodeFlags.Ambient)) !== 0) return true;
  if (declaration.pos <= usage.pos) {
    if (declaration.kind === SyntaxKind.BindingElement) {
      const root = getRootDeclaration(declaration);
      return root === declaration || isDeclaredBeforeUse(root, usage);
    }
    if (declaration instanceof VariableDeclaration) return !isInInitializerOf(declaration, usage);
    return true;
  }
  // A use inside a function or class body runs after the declaration.
  const container = declaration.parent;
  for (let current = usage.parent; current !== undefined && current !== container; current = current.parent)
    if (isFunctionLike(current)) return true;
  return false;
}

function isInInitializerOf(declaration: VariableDeclaration, usage: Node): boolean {
  const initializer = getInitializer(declaration);
  if (initializer === undefined) return false;
  for (let current: Node | undefined = usage; current !== undefined; current = current.parent) {
    if (current === initializer) return true;
    if (isSameNode(current, declaration) || isFunctionLike(current)) return false;
  }
  return false;
}

function getDeclarationContainer(node: Node): Node | undefined {
  for (let current: Node | undefined = getRootDeclaration(node); current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.VariableDeclarationList:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportClause:
        continue;
    }
    return current.parent;
  }
  return undefined;
}

/** An alias without other meanings. */
function isPureAlias(symbol: Symbol): boolean {
  return isNonLocalAlias(symbol, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace);
}

function isNonLocalAlias(symbol: Symbol, excludes: SymbolFlags): boolean {
  return (symbol.flags & (SymbolFlags.Alias | excludes)) === SymbolFlags.Alias;
}

function isAliasSymbolDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.NamespaceExport:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier:
      return true;
    case SyntaxKind.ImportClause:
      return node instanceof ImportClause && node.name !== undefined;
    case SyntaxKind.ExportAssignment:
      return true;
  }
  return false;
}

export function getDeclarationOfAliasSymbol(symbol: Symbol): Node | undefined {
  for (let i = declarationCount(symbol) - 1; i >= 0; i--) {
    const declaration = declarationAt(symbol, i);
    if (isAliasSymbolDeclaration(declaration)) return declaration;
  }
  return undefined;
}

/** The state of `isExportedThroughTypeOnlyStar`'s walk over the `export *` declarations of modules for one name. */
class TypeOnlyStarWalk {
  readonly name: string;
  readonly visited: Set<Symbol>;
  /** Whether a module reached through a type-only `export *` exports the name. */
  typeOnly: boolean;
  /** Whether a module reached without one exports the name itself. */
  nonTypeOnly: boolean;

  constructor(name: string) {
    this.name = name;
    this.visited = new Set<Symbol>();
    this.typeOnly = false;
    this.nonTypeOnly = false;
  }
}

function isTypeOnlyAlias(symbol: Symbol): boolean {
  let node = getDeclarationOfAliasSymbol(symbol);
  while (node !== undefined) {
    switch (node.kind) {
      case SyntaxKind.ImportEqualsDeclaration:
      case SyntaxKind.ExportDeclaration:
        return getIsTypeOnly(node);
      case SyntaxKind.ImportClause:
        if (node instanceof ImportClause && node.phaseModifier === SyntaxKind.TypeKeyword) return true;
        node = node.parent;
        continue;
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.ExportSpecifier:
        if (getIsTypeOnly(node)) return true;
        node = node.parent;
        continue;
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.NamespaceExport:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamedExports:
        node = node.parent;
        continue;
    }
    return false;
  }
  return false;
}

function isValueDeclarationKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.BindingElement:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.EnumMember:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.ModuleDeclaration:
      return true;
  }
  return false;
}

/** The name an import or export specifier takes from its module. */
function importedNameOf(node: Node): string | undefined {
  if (node instanceof ImportSpecifier)
    return moduleExportNameText(node.propertyName !== undefined ? node.propertyName : node.name);
  if (node instanceof ExportSpecifier)
    return moduleExportNameText(node.propertyName !== undefined ? node.propertyName : node.name);
  return undefined;
}

/** The import or export declaration of a specifier. */
function moduleDeclarationOfSpecifier(node: Node): Node | undefined {
  const list = node.parent;
  const clauseOrDeclaration = list === undefined ? undefined : list.parent;
  if (node instanceof ImportSpecifier)
    return clauseOrDeclaration === undefined ? undefined : clauseOrDeclaration.parent;
  return clauseOrDeclaration;
}

function getModuleSpecifierOf(declaration: Node): Node | undefined {
  return getModuleSpecifier(declaration);
}

function moduleExportNameText(name: Node): string {
  if (name instanceof Identifier) return name.text;
  if (name instanceof StringLiteral) return name.text;
  return '';
}
