// Whether a symbol can be named from a location, and the chain of symbols that names it:
// `getAccessibleSymbolChain` and `isSymbolAccessible`, as the node builder and declaration
// emit use them.
import {
  BinaryExpression,
  BindingElement,
  BindingPattern,
  ClassExpression,
  ExportDeclaration,
  ImportEqualsDeclaration,
  ModifierFlags,
  type Node,
  NodeFlags,
  type SourceFile,
  VariableDeclaration,
  getExpression,
  getInitializer,
  getLocals,
  getName,
  getNodeId,
  getText,
  getType,
} from './ast.js';
import { isAmbientModule, isInJSFile } from './ast-utilities.js';
import {
  getCombinedModifierFlags,
  getRootDeclaration,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isAccessExpression,
  isEntityNameExpression,
  isExportsIdentifier,
  isExternalModule,
  isExternalOrCommonJSModule,
  isGlobalSourceFile,
  isModuleExportsAccessExpression,
} from './binder-utilities.js';
import { type Checker, ExternalModuleContainerIndex, SymbolAccessibilityCaches, fileIndexScale } from './checker.js';
import { getEffectiveDeclarationFlags } from './checker-declarations.js';
import { getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { checkExpressionCached } from './checker-expressions.js';
import {
  getImportAttributesTypeForModuleSpecifier,
  resolveExternalModuleName,
  resolveExternalModuleSymbol,
} from './checker-modules.js';
import {
  getExportsOfSymbol,
  getMergedSymbol,
  getParentOfSymbol,
  getSymbolFlags,
  getSymbolOfDeclaration,
  resolveAlias,
  resolveSymbol,
} from './checker-symbols.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { compareSymbols } from './checker-type-factory.js';
import { TypeFlags } from './checker-types.js';
import { SyntaxKind } from './syntax-kind.js';
import { SymbolAccessibility, SymbolAccessibilityResult, accessible } from './transformers/declarations-resolver.js';
import {
  getAnyImportSyntax,
  getDeclarationContainer,
  isExternalModuleAugmentation,
  isLateVisibilityPaintedStatement,
} from './transformers/declarations-syntactic.js';
import { isImplicitlyExportedJSDocDeclaration } from './binder-utilities.js';
import { symbolToString } from './type-printer.js';
import {
  declarationCount,
  getDeclarations,
  getSymbolId,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
  type SymbolTable,
} from './symbol.js';

/** The kinds of symbol table, which with a node or symbol id name a table in a scope walk. */
const enum TableKind {
  Locals = 1,
  Exports = 2,
  Members = 3,
  Globals = 4,
  /** Exports from `getExportsOfSymbol`, which may differ from a symbol's own exports. */
  ResolvedExports = 5,
}

const tableKindScale = 2 ** 44;

function tableId(kind: TableKind, id: number): number {
  return kind * tableKindScale + id;
}

function tableKindOf(id: number): TableKind {
  return Math.floor(id / tableKindScale) as TableKind;
}

function caches(c: Checker): SymbolAccessibilityCaches {
  let result = c.symbolAccessibilityCaches;
  if (result === undefined) {
    result = new SymbolAccessibilityCaches();
    c.symbolAccessibilityCaches = result;
  }
  return result;
}

// ---- Accessibility

export function isTypeSymbolAccessible(c: Checker, symbol: Symbol, enclosingDeclaration: Node | undefined): boolean {
  return (
    isSymbolAccessibleWorker(c, symbol, enclosingDeclaration, SymbolFlags.Type, false, true).accessibility ===
    SymbolAccessibility.Accessible
  );
}

export function isValueSymbolAccessible(c: Checker, symbol: Symbol, enclosingDeclaration: Node | undefined): boolean {
  return (
    isSymbolAccessibleWorker(c, symbol, enclosingDeclaration, SymbolFlags.Value, false, true).accessibility ===
    SymbolAccessibility.Accessible
  );
}

export function isSymbolAccessibleByFlags(
  c: Checker,
  symbol: Symbol,
  enclosingDeclaration: Node | undefined,
  flags: SymbolFlags,
): boolean {
  return (
    isSymbolAccessibleWorker(c, symbol, enclosingDeclaration, flags, false, false).accessibility ===
    SymbolAccessibility.Accessible
  );
}

/**
 * Whether `symbol` can be named with `meaning` from `enclosingDeclaration`; with
 * `shouldComputeAliasesToMakeVisible`, the unexported imports and statements naming it are
 * marked visible and returned.
 */
export function isSymbolAccessible(
  c: Checker,
  symbol: Symbol | undefined,
  enclosingDeclaration: Node | undefined,
  meaning: SymbolFlags,
  shouldComputeAliasesToMakeVisible: boolean,
): SymbolAccessibilityResult {
  return isSymbolAccessibleWorker(c, symbol, enclosingDeclaration, meaning, shouldComputeAliasesToMakeVisible, true);
}

function isSymbolAccessibleWorker(
  c: Checker,
  symbol: Symbol | undefined,
  enclosingDeclaration: Node | undefined,
  meaning: SymbolFlags,
  shouldComputeAliasesToMakeVisible: boolean,
  allowModules: boolean,
): SymbolAccessibilityResult {
  if (symbol === undefined || enclosingDeclaration === undefined) return accessible([]);
  const result = isAnySymbolAccessible(
    c,
    [symbol],
    enclosingDeclaration,
    symbol,
    meaning,
    shouldComputeAliasesToMakeVisible,
    allowModules,
  );
  if (result !== undefined) return result;
  // A symbol not exported from its module, or from another module without an alias, can't be named.
  let symbolExternalModule: Symbol | undefined = undefined;
  for (const d of getDeclarations(symbol)) {
    symbolExternalModule = getExternalModuleContainer(c, d);
    if (symbolExternalModule !== undefined) break;
  }
  if (symbolExternalModule !== undefined) {
    const enclosingExternalModule = getExternalModuleContainer(c, enclosingDeclaration);
    if (symbolExternalModule !== enclosingExternalModule)
      return new SymbolAccessibilityResult(
        SymbolAccessibility.CannotBeNamed,
        [],
        symbolToString(c, symbol),
        isInJSFile(enclosingDeclaration) ? enclosingDeclaration : undefined,
        symbolToString(c, symbolExternalModule),
      );
  }
  return new SymbolAccessibilityResult(SymbolAccessibility.NotAccessible, [], symbolToString(c, symbol), undefined, '');
}

function isAnySymbolAccessible(
  c: Checker,
  symbols: Symbol[],
  enclosingDeclaration: Node,
  initialSymbol: Symbol,
  meaning: SymbolFlags,
  shouldComputeAliasesToMakeVisible: boolean,
  allowModules: boolean,
): SymbolAccessibilityResult | undefined {
  if (symbols.length === 0) return undefined;
  let hadAccessibleChain: Symbol | undefined = undefined;
  let earlyModuleBail = false;
  for (const symbol of symbols) {
    // Accessible by itself.
    const chain = getAccessibleSymbolChain(c, symbol, enclosingDeclaration, meaning, false);
    if (chain.length > 0) {
      hadAccessibleChain = symbol;
      const visible = hasVisibleDeclarations(c, chain[0]!, shouldComputeAliasesToMakeVisible);
      if (visible !== undefined) return visible;
    }
    if (allowModules && hasNonGlobalAugmentationExternalModuleDeclaration(symbol)) {
      if (shouldComputeAliasesToMakeVisible) {
        // Prefer existing aliases of the module, which declaration emit must keep.
        earlyModuleBail = true;
        continue;
      }
      // Any meaning of a module is accessible through an `import` type.
      return accessible([]);
    }
    // A qualified name is accessible when its container is: `m.c` with `m` in scope.
    const containers = getContainersOfSymbol(c, symbol, enclosingDeclaration, meaning);
    const parentResult = isAnySymbolAccessible(
      c,
      containers,
      enclosingDeclaration,
      initialSymbol,
      initialSymbol === symbol ? getQualifiedLeftMeaning(meaning) : meaning,
      shouldComputeAliasesToMakeVisible,
      allowModules,
    );
    if (parentResult !== undefined) return parentResult;
  }
  if (earlyModuleBail) return accessible([]);
  if (hadAccessibleChain !== undefined)
    return new SymbolAccessibilityResult(
      SymbolAccessibility.NotAccessible,
      [],
      symbolToString(c, initialSymbol),
      undefined,
      hadAccessibleChain !== initialSymbol ? symbolToString(c, hadAccessibleChain) : '',
    );
  return undefined;
}

export function hasNonGlobalAugmentationExternalModuleDeclaration(symbol: Symbol): boolean {
  for (const d of getDeclarations(symbol)) if (hasNonGlobalAugmentationExternalModuleSymbol(d)) return true;
  return false;
}

export function hasNonGlobalAugmentationExternalModuleSymbol(declaration: Node): boolean {
  return (
    isModuleWithStringLiteralName(declaration) ||
    (declaration.kind === SyntaxKind.SourceFile && isExternalOrCommonJSModule(declaration as SourceFile))
  );
}

function isModuleWithStringLiteralName(node: Node): boolean {
  if (node.kind !== SyntaxKind.ModuleDeclaration) return false;
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.StringLiteral;
}

/** In value space the left of a qualified name is a value; otherwise a namespace. */
export function getQualifiedLeftMeaning(rightMeaning: SymbolFlags): SymbolFlags {
  return rightMeaning === SymbolFlags.Value ? SymbolFlags.Value : SymbolFlags.Namespace;
}

/** The merged symbol `symbol` resolves to through aliases. */
function getResolvedTarget(c: Checker, symbol: Symbol): Symbol | undefined {
  const resolved = resolveSymbol(c, getMergedSymbol(c, symbol));
  return resolved !== undefined ? getMergedSymbol(c, resolved) : undefined;
}

/** `s1` if both symbols resolve to the same symbol, else undefined. */
export function getSymbolIfSameReference(c: Checker, s1: Symbol, s2: Symbol): Symbol | undefined {
  const r1 = getResolvedTarget(c, s1);
  if (r1 !== undefined && r1 === getResolvedTarget(c, s2)) return s1;
  return undefined;
}

// ---- Containers

function getWithAlternativeContainers(
  c: Checker,
  container: Symbol,
  symbol: Symbol,
  enclosingDeclaration: Node | undefined,
  meaning: SymbolFlags,
): Symbol[] {
  const additionalContainers: Symbol[] = [];
  for (const d of getDeclarations(container)) {
    const fileSymbol = getFileSymbolIfFileSymbolExportEqualsContainer(c, d, container);
    if (fileSymbol !== undefined) additionalContainers.push(fileSymbol);
  }
  const reexportContainers =
    enclosingDeclaration !== undefined ? getAlternativeContainingModules(c, symbol, enclosingDeclaration) : [];
  const objectLiteralContainer = getVariableDeclarationOfObjectLiteral(c, container, meaning);
  const leftMeaning = getQualifiedLeftMeaning(meaning);
  if (
    enclosingDeclaration !== undefined &&
    (container.flags & leftMeaning) !== 0 &&
    getAccessibleSymbolChain(c, container, enclosingDeclaration, SymbolFlags.Namespace, false).length > 0
  ) {
    // Prefer the real container when it's in scope.
    const result = [container];
    for (const s of additionalContainers) result.push(s);
    for (const s of reexportContainers) result.push(s);
    if (objectLiteralContainer !== undefined) result.push(objectLiteralContainer);
    return result;
  }
  // A member of an instance type may be reached through a variable of that type, as
  // `Symbol.toStringTag` through the `Symbol` variable.
  const variableMatches: Symbol[] = [];
  if (
    meaning === SymbolFlags.Value &&
    (container.flags & leftMeaning) === 0 &&
    (container.flags & SymbolFlags.Type) !== 0 &&
    (getDeclaredTypeOfSymbol(c, container).flags & TypeFlags.Object) !== 0
  ) {
    const declaredType = getDeclaredTypeOfSymbol(c, container);
    someSymbolTableInScope(c, enclosingDeclaration, (table) => {
      let found = false;
      for (const s of table.values()) {
        if ((s.flags & leftMeaning) !== 0 && getTypeOfSymbol(c, s) === declaredType) {
          variableMatches.push(s);
          found = true;
        }
      }
      return found;
    });
    variableMatches.sort((a, b) => compareSymbols(c, a, b));
  }
  const result: Symbol[] = variableMatches;
  for (const s of additionalContainers) result.push(s);
  result.push(container);
  if (objectLiteralContainer !== undefined) result.push(objectLiteralContainer);
  for (const s of reexportContainers) result.push(s);
  return result;
}

/** Modules other than its own that export `symbol`: first those `enclosingDeclaration`'s file imports. */
function getAlternativeContainingModules(c: Checker, symbol: Symbol, enclosingDeclaration: Node): Symbol[] {
  const containingFile = getSourceFileOfNode(enclosingDeclaration);
  const fileId = getNodeId(containingFile);
  const symbolId = getSymbolId(symbol);
  const cache = caches(c);
  let byFile = cache.containersByFile.get(symbolId);
  if (byFile === undefined) {
    byFile = new Map<number, Symbol[]>();
    cache.containersByFile.set(symbolId, byFile);
  }
  const existing = byFile.get(fileId);
  if (existing !== undefined && existing.length > 0) return existing;
  const results: Symbol[] = [];
  if (containingFile.imports.length > 0) {
    for (const importRef of containingFile.imports) {
      // Synthesized specifiers can't be resolved.
      if ((importRef.flags & NodeFlags.Synthesized) !== 0) continue;
      const resolvedModule = resolveExternalModuleName(
        c,
        enclosingDeclaration,
        importRef,
        true,
        getImportAttributesTypeForModuleSpecifier(c, importRef),
      );
      if (resolvedModule === undefined) continue;
      if (getAliasForSymbolInContainer(c, resolvedModule, symbol) === undefined) continue;
      results.push(resolvedModule);
    }
    if (results.length > 0) {
      byFile.set(fileId, results);
      return results;
    }
  }
  const cached = cache.containers.get(symbolId);
  if (cached !== undefined) return cached;
  // Search every module; independent of the location.
  const containers = getExternalModuleContainers(c, symbol);
  cache.containers.set(symbolId, containers);
  return containers;
}

/** The modules that export `symbol`, and its parent module, in program order. */
function getExternalModuleContainers(c: Checker, symbol: Symbol): Symbol[] {
  const cache = caches(c);
  if (cache.externalModuleContainers === undefined) buildExternalModuleContainerIndex(c);
  const index = cache.externalModuleContainers!;
  // Re-entered from an alias resolved while building the index, or too many files to index.
  if (!index.complete) return scanExternalModuleContainers(c, symbol);
  // The parent module contains the symbol even when the symbol is absent from its exports.
  const parent = getParentOfSymbol(c, symbol);
  let parentIndex = externalModuleFileIndex(c, parent);
  const result: Symbol[] = [];
  const target = getResolvedTarget(c, symbol);
  if (target !== undefined) {
    const keys = index.keys;
    const first = getSymbolId(target) * fileIndexScale;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (keys[mid]! < first) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < keys.length && keys[i]! < first + fileIndexScale; i++) {
      const fileIndex = keys[i]! - first;
      if (parentIndex >= 0 && parentIndex <= fileIndex) {
        if (parentIndex < fileIndex) result.push(parent!);
        parentIndex = -1;
      }
      // `as`: scriptc passes an element of a subclass array only as that class.
      result.push(getSymbolOfDeclaration(c, c.files[fileIndex]! as Node)!);
    }
  }
  if (parentIndex >= 0) result.push(parent!);
  return result;
}

/** The position in `Checker.files` of the external module `symbol`, or -1 for any other symbol. */
function externalModuleFileIndex(c: Checker, symbol: Symbol | undefined): number {
  if (symbol === undefined || (symbol.flags & SymbolFlags.ValueModule) === 0) return -1;
  for (const declaration of getDeclarations(symbol)) {
    if (declaration.kind !== SyntaxKind.SourceFile) continue;
    const file = declaration as SourceFile;
    if (isExternalModule(file) && getSymbolOfDeclaration(c, declaration) === symbol) return c.fileIndex.get(file) ?? -1;
  }
  return -1;
}

function buildExternalModuleContainerIndex(c: Checker): void {
  const index = new ExternalModuleContainerIndex();
  caches(c).externalModuleContainers = index;
  if (c.files.length > fileIndexScale) return;
  const keys: number[] = [];
  for (let fileIndex = 0; fileIndex < c.files.length; fileIndex++) {
    const file = c.files[fileIndex]!;
    if (!isExternalModule(file)) continue;
    // `as`: scriptc passes an element of a subclass array only as that class.
    const container = getSymbolOfDeclaration(c, file as Node);
    if (container === undefined) continue;
    for (const exported of getExportsOfSymbol(c, container).values()) {
      const target = getResolvedTarget(c, exported);
      if (target !== undefined) keys.push(getSymbolId(target) * fileIndexScale + fileIndex);
    }
    const exportEquals = container.exports?.get(InternalSymbolName.ExportEquals);
    const target = exportEquals !== undefined ? getResolvedTarget(c, exportEquals) : undefined;
    if (target !== undefined) keys.push(getSymbolId(target) * fileIndexScale + fileIndex);
  }
  keys.sort((a, b) => a - b);
  // A module that exports a symbol under several names gives it one key.
  let kept = 0;
  for (let i = 0; i < keys.length; i++) if (kept === 0 || keys[i] !== keys[kept - 1]) keys[kept++] = keys[i]!;
  // An exact-size copy: each checker keeps its own index for the rest of the compilation.
  index.keys = keys.slice(0, kept);
  index.complete = true;
}

/** The modules that export `symbol`, found by checking every module. */
function scanExternalModuleContainers(c: Checker, symbol: Symbol): Symbol[] {
  const containers: Symbol[] = [];
  for (const file of c.host.getSourceFiles()) {
    if (!isExternalModule(file)) continue;
    // `as`: scriptc passes a for-of element of a subclass array only as that class.
    const container = getSymbolOfDeclaration(c, file as Node);
    if (container !== undefined && getAliasForSymbolInContainer(c, container, symbol) !== undefined)
      containers.push(container);
  }
  return containers;
}

/** The variable `var a = { x: 1 }` declares, for the anonymous `__object` symbol of its literal. */
function getVariableDeclarationOfObjectLiteral(c: Checker, symbol: Symbol, meaning: SymbolFlags): Symbol | undefined {
  if ((meaning & SymbolFlags.Value) === 0 || declarationCount(symbol) === 0) return undefined;
  const firstDecl = symbol.declaration!;
  const parent = firstDecl.parent;
  if (parent === undefined || !(parent instanceof VariableDeclaration)) return undefined;
  if (
    (firstDecl.kind === SyntaxKind.ObjectLiteralExpression && firstDecl === getInitializer(parent)) ||
    (firstDecl.kind === SyntaxKind.TypeLiteral && firstDecl === getType(parent))
  )
    return getSymbolOfDeclaration(c, parent);
  return undefined;
}

function hasExternalModuleSymbol(declaration: Node): boolean {
  return (
    isAmbientModule(declaration) ||
    (declaration.kind === SyntaxKind.SourceFile && isExternalOrCommonJSModule(declaration as SourceFile))
  );
}

function getExternalModuleContainer(c: Checker, declaration: Node): Symbol | undefined {
  for (let node: Node | undefined = declaration; node !== undefined; node = node.parent)
    if (hasExternalModuleSymbol(node)) return getSymbolOfDeclaration(c, node);
  return undefined;
}

/** The module of `d` if its `export =` names `container`. */
export function getFileSymbolIfFileSymbolExportEqualsContainer(
  c: Checker,
  d: Node,
  container: Symbol,
): Symbol | undefined {
  const fileSymbol = getExternalModuleContainer(c, d);
  if (fileSymbol === undefined || fileSymbol.exports === undefined) return undefined;
  const exported = fileSymbol.exports.get(InternalSymbolName.ExportEquals);
  if (exported === undefined) return undefined;
  return getSymbolIfSameReference(c, exported, container) !== undefined ? fileSymbol : undefined;
}

/** The symbols `symbol` can be reached through: usually its parent, else the modules exporting a local. */
export function getContainersOfSymbol(
  c: Checker,
  symbol: Symbol,
  enclosingDeclaration: Node | undefined,
  meaning: SymbolFlags,
): Symbol[] {
  const container = getParentOfSymbol(c, symbol);
  // Type parameters are in `members` but not visible outside.
  if (container !== undefined && (symbol.flags & SymbolFlags.TypeParameter) === 0)
    return getWithAlternativeContainers(c, container, symbol, enclosingDeclaration, meaning);
  const candidates: Symbol[] = [];
  const addCandidate = (s: Symbol | undefined): void => {
    if (s !== undefined && candidates.indexOf(s) < 0) candidates.push(s);
  };
  for (const d of getDeclarations(symbol)) {
    const parent = d.parent;
    if (!isAmbientModule(d) && parent !== undefined) {
      // A direct child of a module.
      if (hasNonGlobalAugmentationExternalModuleSymbol(parent)) {
        addCandidate(getSymbolOfDeclaration(c, parent));
        continue;
      }
      // The `export =` of an ambient module.
      if (
        parent.kind === SyntaxKind.ModuleBlock &&
        parent.parent !== undefined &&
        resolveExternalModuleSymbol(c, getSymbolOfDeclaration(c, parent.parent), false) === symbol
      ) {
        addCandidate(getSymbolOfDeclaration(c, parent.parent));
        continue;
      }
    }
    if (d instanceof ClassExpression && parent instanceof BinaryExpression) {
      const left = parent.left;
      if (parent.operatorToken.kind !== SyntaxKind.EqualsToken || !isAccessExpression(left)) continue;
      const target = getExpression(left)!;
      if (!isEntityNameExpression(target, false)) continue;
      if (isModuleExportsAccessExpression(left) || isExportsIdentifier(target)) {
        addCandidate(getSymbolOfDeclaration(c, getSourceFileOfNode(d)));
        continue;
      }
      checkExpressionCached(c, target);
      addCandidate(c.resolvedSymbols.get(target.id));
    }
  }
  if (candidates.length === 0) return [];
  const best: Symbol[] = [];
  const alternatives: Symbol[] = [];
  for (const candidate of candidates) {
    if (getAliasForSymbolInContainer(c, candidate, symbol) === undefined) continue;
    const all = getWithAlternativeContainers(c, candidate, symbol, enclosingDeclaration, meaning);
    if (all.length === 0) continue;
    best.push(all[0]!);
    for (let i = 1; i < all.length; i++) alternatives.push(all[i]!);
  }
  for (const s of alternatives) best.push(s);
  return best;
}

/** The export of `container` that names `symbol`, if any. */
export function getAliasForSymbolInContainer(c: Checker, container: Symbol, symbol: Symbol): Symbol | undefined {
  // The fast path: `symbol` is already the export.
  if (container === getParentOfSymbol(c, symbol)) return symbol;
  // A module whose `export =` is the symbol stands for it.
  if (container.exports !== undefined) {
    const exportEquals = container.exports.get(InternalSymbolName.ExportEquals);
    if (exportEquals !== undefined && getSymbolIfSameReference(c, exportEquals, symbol) !== undefined) return container;
  }
  const exports = getExportsOfSymbol(c, container);
  const quick = exports.get(symbol.name);
  if (quick !== undefined && getSymbolIfSameReference(c, quick, symbol) !== undefined) return quick;
  const candidates: Symbol[] = [];
  for (const exported of exports.values())
    if (getSymbolIfSameReference(c, exported, symbol) !== undefined) candidates.push(exported);
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareSymbols(c, a, b));
  return candidates[0]!;
}

// ---- Accessible symbol chains

/** One search for the chain of names reaching a symbol. */
class ChainSearch {
  readonly c: Checker;
  readonly symbol: Symbol;
  readonly enclosingDeclaration: Node | undefined;
  readonly meaning: SymbolFlags;
  readonly useOnlyExternalAliasing: boolean;
  /** Tables being searched, by symbol id, to stop cycles through exports. */
  readonly visitedTables: Map<number, Set<number>>;

  constructor(
    c: Checker,
    symbol: Symbol,
    enclosingDeclaration: Node | undefined,
    meaning: SymbolFlags,
    useOnlyExternalAliasing: boolean,
    visitedTables: Map<number, Set<number>>,
  ) {
    this.c = c;
    this.symbol = symbol;
    this.enclosingDeclaration = enclosingDeclaration;
    this.meaning = meaning;
    this.useOnlyExternalAliasing = useOnlyExternalAliasing;
    this.visitedTables = visitedTables;
  }

  run(): Symbol[] {
    const c = this.c;
    if (isPropertyOrMethodDeclarationSymbol(this.symbol)) return [];
    // Key the cache by the first scope searched so it's shared more.
    let firstRelevantLocation: Node | undefined = undefined;
    someSymbolTableInScope(c, this.enclosingDeclaration, (_table, _id, _isLocal, node) => {
      firstRelevantLocation = node;
      return true;
    });
    const symbolId = getSymbolId(this.symbol);
    const cache = caches(c);
    let byKey = cache.accessibleChains.get(symbolId);
    if (byKey === undefined) {
      byKey = new Map<string, Symbol[]>();
      cache.accessibleChains.set(symbolId, byKey);
    }
    // `!`: scriptc keeps the callback's optional scope optional after narrowing.
    const location: Node | undefined = firstRelevantLocation;
    const key =
      (this.useOnlyExternalAliasing ? '1:' : '0:') +
      (location === undefined ? 0 : getNodeId(location!)) +
      ':' +
      this.meaning;
    const existing = byKey.get(key);
    if (existing !== undefined) return existing;
    let result: Symbol[] = [];
    someSymbolTableInScope(c, this.enclosingDeclaration, (table, id, isLocalNameLookup) => {
      const found = this.fromSymbolTable(table, id, false, isLocalNameLookup);
      if (found.length > 0) {
        result = found;
        return true;
      }
      return false;
    });
    byKey.set(key, result);
    return result;
  }

  /** `ignoreQualification`: looking through another symbol's exports, which qualify the name already. */
  fromSymbolTable(table: SymbolTable, id: number, ignoreQualification: boolean, isLocalNameLookup: boolean): Symbol[] {
    const symbolId = getSymbolId(this.symbol);
    let visited = this.visitedTables.get(symbolId);
    if (visited === undefined) {
      visited = new Set<number>();
      this.visitedTables.set(symbolId, visited);
    }
    if (visited.has(id)) return [];
    visited.add(id);
    const result = this.trySymbolTable(table, id, ignoreQualification, isLocalNameLookup);
    visited.delete(id);
    return result;
  }

  trySymbolTable(table: SymbolTable, id: number, ignoreQualification: boolean, isLocalNameLookup: boolean): Symbol[] {
    const c = this.c;
    const symbol = this.symbol;
    // Directly available by its name.
    const direct = table.get(symbol.name);
    if (direct !== undefined && this.isAccessible(direct, undefined, ignoreQualification)) return [symbol];
    const candidateChains: Symbol[][] = [];
    if (direct !== undefined && direct.exportSymbol !== undefined) {
      if (this.isAccessible(getMergedSymbol(c, direct.exportSymbol), undefined, ignoreQualification))
        candidateChains.push([symbol]);
    }
    for (const fromTable of getSymbolTableAliases(c, table, id)) {
      // Any non-default, non-`export =` alias in scope may name the symbol or chain to it.
      if (
        fromTable.name === InternalSymbolName.ExportEquals ||
        fromTable.name === InternalSymbolName.Default ||
        (isUMDExportSymbol(fromTable) &&
          this.enclosingDeclaration !== undefined &&
          isExternalModule(getSourceFileOfNode(this.enclosingDeclaration))) ||
        (this.useOnlyExternalAliasing && !hasExternalModuleImportEqualsDeclaration(fromTable)) ||
        (isLocalNameLookup && hasNamespaceReexportDeclaration(fromTable)) ||
        // Exports are in scope, but export specifiers aren't.
        (!ignoreQualification && getDeclarations(fromTable).some((d) => d.kind === SyntaxKind.ExportSpecifier))
      )
        continue;
      const resolved = resolveAlias(c, fromTable);
      const candidate = this.candidateListForSymbol(fromTable, resolved, ignoreQualification);
      if (candidate.length > 0) candidateChains.push(candidate);
    }
    if (candidateChains.length > 0) {
      // The first of the shortest.
      let best = candidateChains[0]!;
      for (let i = 1; i < candidateChains.length; i++)
        if (compareSymbolChains(c, candidateChains[i]!, best) < 0) best = candidateChains[i]!;
      return best;
    }
    // Treat `globalThis` like an alias in the global table.
    if (tableKindOf(id) === TableKind.Globals)
      return this.candidateListForSymbol(c.globalThisSymbol, c.globalThisSymbol, ignoreQualification);
    return [];
  }

  candidateListForSymbol(fromTable: Symbol, resolved: Symbol, ignoreQualification: boolean): Symbol[] {
    if (this.isAccessible(fromTable, resolved, ignoreQualification)) return [fromTable];
    // Reachable through the exports of `fromTable`, if `fromTable` can be qualified.
    const candidateTable = getExportsOfSymbol(this.c, resolved);
    const fromExports = this.fromSymbolTable(
      candidateTable,
      tableId(TableKind.ResolvedExports, getSymbolId(resolved)),
      true,
      false,
    );
    if (fromExports.length === 0) return [];
    if (!this.canQualifySymbol(fromTable, getQualifiedLeftMeaning(this.meaning))) return [];
    return [fromTable].concat(fromExports);
  }

  isAccessible(fromTable: Symbol, resolvedAlias: Symbol | undefined, ignoreQualification: boolean): boolean {
    const c = this.c;
    const symbol = getMergedSymbol(c, this.symbol);
    let likeSymbols =
      this.symbol === resolvedAlias ||
      this.symbol === fromTable ||
      (resolvedAlias !== undefined && symbol === getMergedSymbol(c, resolvedAlias)) ||
      symbol === getMergedSymbol(c, fromTable);
    // An alias of an alias, such as `export =` of a class that a top-level export also names, resolves further.
    if (!likeSymbols && resolvedAlias !== undefined && (resolvedAlias.flags & SymbolFlags.Alias) !== 0) {
      const seen = new Set<Symbol>();
      let alias = resolvedAlias;
      while ((alias.flags & SymbolFlags.Alias) !== 0 && !seen.has(alias)) {
        seen.add(alias);
        alias = getMergedSymbol(c, resolveAlias(c, alias));
        if (symbol === alias) {
          likeSymbols = true;
          break;
        }
      }
    }
    if (!likeSymbols) return false;
    // An external module in the global table isn't accessible by name; otherwise the name must be qualifiable.
    return (
      !hasNonGlobalAugmentationExternalModuleDeclaration(fromTable) &&
      (ignoreQualification || this.canQualifySymbol(getMergedSymbol(c, fromTable), this.meaning))
    );
  }

  canQualifySymbol(fromTable: Symbol, meaning: SymbolFlags): boolean {
    const c = this.c;
    if (!needsQualification(c, fromTable, this.enclosingDeclaration, meaning)) return true;
    // Qualified through its parent, if the parent is accessible.
    const parent = fromTable.parent;
    if (parent === undefined) return false;
    return (
      new ChainSearch(
        c,
        parent,
        this.enclosingDeclaration,
        getQualifiedLeftMeaning(meaning),
        this.useOnlyExternalAliasing,
        this.visitedTables,
      ).run().length > 0
    );
  }
}

/** The shortest chain of names reaching `symbol` from `enclosingDeclaration`, or empty if none. */
export function getAccessibleSymbolChain(
  c: Checker,
  symbol: Symbol | undefined,
  enclosingDeclaration: Node | undefined,
  meaning: SymbolFlags,
  useOnlyExternalAliasing: boolean,
): Symbol[] {
  if (symbol === undefined) return [];
  return new ChainSearch(
    c,
    symbol,
    enclosingDeclaration,
    meaning,
    useOnlyExternalAliasing,
    new Map<number, Set<number>>(),
  ).run();
}

/** The alias symbols of a table; cached for globals and exports, which are large and revisited. */
function getSymbolTableAliases(c: Checker, table: SymbolTable, id: number): Symbol[] {
  const kind = tableKindOf(id);
  // Members tables only hold types, never aliases.
  if (kind === TableKind.Members) return [];
  const cacheable = kind === TableKind.Globals || kind === TableKind.Exports || kind === TableKind.ResolvedExports;
  const cache = caches(c);
  if (cacheable) {
    const cached = cache.tableAliases.get(id);
    if (cached !== undefined) return cached;
  }
  const aliases: Symbol[] = [];
  for (const s of table.values()) if ((s.flags & SymbolFlags.Alias) !== 0) aliases.push(s);
  if (cacheable) cache.tableAliases.set(id, aliases);
  return aliases;
}

function compareSymbolChains(c: Checker, a: Symbol[], b: Symbol[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const comparison = compareSymbols(c, a[i]!, b[i]!);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function isUMDExportSymbol(symbol: Symbol): boolean {
  return declarationCount(symbol) > 0 && symbol.declaration!.kind === SyntaxKind.NamespaceExportDeclaration;
}

function hasNamespaceReexportDeclaration(symbol: Symbol): boolean {
  for (const d of getDeclarations(symbol)) if (isNamespaceReexportDeclaration(d)) return true;
  return false;
}

function isNamespaceReexportDeclaration(node: Node): boolean {
  return (
    node.kind === SyntaxKind.NamespaceExport &&
    node.parent instanceof ExportDeclaration &&
    node.parent.moduleSpecifier !== undefined
  );
}

function hasExternalModuleImportEqualsDeclaration(symbol: Symbol): boolean {
  for (const d of getDeclarations(symbol)) if (isExternalModuleImportEqualsDeclaration(d)) return true;
  return false;
}

function isExternalModuleImportEqualsDeclaration(node: Node): boolean {
  return node instanceof ImportEqualsDeclaration && node.moduleReference.kind === SyntaxKind.ExternalModuleReference;
}

/** Whether another symbol of the same name and meaning shadows `symbol` at `enclosingDeclaration`. */
export function needsQualification(
  c: Checker,
  symbol: Symbol,
  enclosingDeclaration: Node | undefined,
  meaning: SymbolFlags,
): boolean {
  let qualify = false;
  someSymbolTableInScope(c, enclosingDeclaration, (table) => {
    const found = table.get(symbol.name);
    if (found === undefined) return false;
    let fromTable = getMergedSymbol(c, found);
    if (fromTable === symbol) return true;
    // Qualify if the symbol of this name has the meaning sought.
    const shouldResolveAlias =
      (fromTable.flags & SymbolFlags.Alias) !== 0 &&
      !getDeclarations(fromTable).some((d) => d.kind === SyntaxKind.ExportSpecifier);
    if (shouldResolveAlias) fromTable = resolveAlias(c, fromTable);
    const flags = shouldResolveAlias ? getSymbolFlags(c, fromTable) : fromTable.flags;
    if ((flags & meaning) !== 0) {
      qualify = true;
      return true;
    }
    return false;
  });
  return qualify;
}

function isPropertyOrMethodDeclarationSymbol(symbol: Symbol): boolean {
  if (declarationCount(symbol) === 0) return false;
  for (const declaration of getDeclarations(symbol)) {
    switch (declaration.kind) {
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        continue;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Calls `callback` with each symbol table in scope at `enclosingDeclaration`, innermost first and
 * the globals last, until it returns true.
 */
export function someSymbolTableInScope(
  c: Checker,
  enclosingDeclaration: Node | undefined,
  callback: (table: SymbolTable, id: number, isLocalNameLookup: boolean, scope: Node | undefined) => boolean,
): boolean {
  for (let location = enclosingDeclaration; location !== undefined; location = location.parent) {
    // Locals of a script are merged into the globals.
    const locals = getLocals(location);
    if (locals !== undefined && !isGlobalSourceFile(location)) {
      if (callback(locals, tableId(TableKind.Locals, getNodeId(location)), true, location)) return true;
    }
    switch (location.kind) {
      case SyntaxKind.SourceFile:
      case SyntaxKind.ModuleDeclaration: {
        if (location.kind === SyntaxKind.SourceFile && !isExternalOrCommonJSModule(location as SourceFile)) break;
        const symbol = getSymbolOfDeclaration(c, location);
        if (symbol === undefined) break;
        const exports = symbol.exports ?? emptyTable;
        if (callback(exports, tableId(TableKind.Exports, getSymbolId(symbol)), true, location)) return true;
        break;
      }
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.InterfaceDeclaration: {
        // Type parameters are bound in `members` so they merge across declarations, but act like
        // locals. Raw members suffice: they're never late bound.
        const symbol = getSymbolOfDeclaration(c, location);
        if (symbol === undefined) break;
        let table: SymbolTable | undefined = undefined;
        if (symbol.members !== undefined)
          for (const [key, member] of symbol.members) {
            if ((member.flags & (SymbolFlags.Type & ~SymbolFlags.Assignment)) === 0) continue;
            if (table === undefined) table = new Map<string, Symbol>();
            table.set(key, member);
          }
        if (table !== undefined && callback(table, tableId(TableKind.Members, getSymbolId(symbol)), false, location))
          return true;
        // A class expression's own name is in no scope table.
        if (location instanceof ClassExpression && location.name !== undefined) {
          const nameTable = getClassExpressionNameTable(c, location);
          if (
            nameTable !== undefined &&
            callback(nameTable, tableId(TableKind.Locals, getNodeId(location)), true, location)
          )
            return true;
        }
        break;
      }
    }
  }
  return callback(c.globals, tableId(TableKind.Globals, 0), true, undefined);
}

const emptyTable: SymbolTable = new Map<string, Symbol>();

function getClassExpressionNameTable(c: Checker, location: ClassExpression): SymbolTable | undefined {
  const id = getNodeId(location);
  const cache = caches(c);
  const cached = cache.classExpressionNames.get(id);
  if (cached !== undefined) return cached;
  const classSymbol = getSymbolOfDeclaration(c, location);
  const nameText = location.name === undefined ? '' : getText(location.name);
  if (nameText.length === 0 || classSymbol === undefined) return undefined;
  const table = new Map<string, Symbol>();
  table.set(nameText, classSymbol);
  cache.classExpressionNames.set(id, table);
  return table;
}

// ---- Declaration visibility

/**
 * Whether a declaration is visible outside its file: exported, global, or part of a visible declaration.
 *
 * tsgo caches this per checker and lets declaration emit mark declarations visible. Only marks made
 * while emitting files of the current checker slot count (see beginDeclarationEmitVisibility), and
 * leaving a slot forgets the cached visibility of the declarations it marked. Rather than undoing and
 * redoing those marks at every file, a node keeps the slots it was marked in, and a cached result is
 * stale if one of those slots was left after it was computed.
 */
export function isDeclarationVisible(c: Checker, node: Node): boolean {
  if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
  const cache = caches(c);
  const id = getNodeId(node);
  const marks = cache.markedSlots.get(id);
  if ((marks & slotBit(cache.markedSlot)) !== 0) return true;
  const cached = cache.declarationVisibility.get(id);
  if (cached !== 0 && (marks === 0 || !leftSince(cache.slotsLeftAt, marks, cached >> 2))) return (cached & 1) !== 0;
  const visible = determineIfDeclarationIsVisible(c, node);
  // Bit 0 is the result, bit 1 marks the entry computed, the rest is the epoch it was computed in.
  cache.declarationVisibility.set(id, (cache.visibilityEpoch << 2) | 2 | (visible ? 1 : 0));
  return visible;
}

/** The bit of a checker slot (-1 before declaration emit) in `markedSlots`. */
function slotBit(slot: number): number {
  return 1 << (slot + 1);
}

/** Whether one of the slots in `marks` was left after `epoch`. */
function leftSince(slotsLeftAt: number[], marks: number, epoch: number): boolean {
  for (let index = 0; index < slotsLeftAt.length; index++)
    if ((marks & (1 << index)) !== 0 && slotsLeftAt[index]! > epoch) return true;
  return false;
}

export function markDeclarationVisible(c: Checker, node: Node): void {
  const cache = caches(c);
  const id = getNodeId(node);
  cache.markedSlots.set(id, cache.markedSlots.get(id) | slotBit(cache.markedSlot));
}

/** Checkers tsgo spreads a program's files over, round robin. */
const checkerCount = 4;

/** The number of checkers tsgo spreads the program's files over: file `i` goes to checker `i % n`. */
export function tsgoCheckerSlots(c: Checker): number {
  return Math.max(1, Math.min(checkerCount, c.files.length));
}

/**
 * Starts the declaration emit of `file`. tsgo emits each file with one of its checkers, so only
 * declarations marked visible while emitting files of the same checker stay marked.
 */
export function beginDeclarationEmitVisibility(c: Checker, file: SourceFile): void {
  const cache = caches(c);
  const index = c.fileIndex.get(file);
  const slot = index === undefined ? -1 : index % tsgoCheckerSlots(c);
  if (slot === cache.markedSlot) return;
  cache.visibilityEpoch++;
  cache.slotsLeftAt[cache.markedSlot + 1] = cache.visibilityEpoch;
  cache.markedSlot = slot;
}

function determineIfDeclarationIsVisible(c: Checker, node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.JSDocCallbackTag:
    case SyntaxKind.JSDocTypedefTag: {
      // Top-level JSDoc type aliases are exported.
      const host = node.parent?.parent?.parent;
      return host !== undefined && host.kind === SyntaxKind.SourceFile;
    }
    case SyntaxKind.BindingElement:
      return isDeclarationVisible(c, node.parent!.parent!);
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ImportEqualsDeclaration: {
      if (node instanceof VariableDeclaration) {
        const name = node.name;
        if (name instanceof BindingPattern && name.elements.nodes.length === 0) return false;
      }
      if (isExternalModuleAugmentation(node) || isImplicitlyExportedJSDocDeclaration(node)) return true;
      const parent = getDeclarationContainer(node);
      // Unexported declarations are visible only in global files; ambient module members are exported.
      if (
        (getCombinedModifierFlags(node) & ModifierFlags.Export) === 0 &&
        !(
          node.kind !== SyntaxKind.ImportEqualsDeclaration &&
          parent.kind !== SyntaxKind.SourceFile &&
          (parent.flags & NodeFlags.Ambient) !== 0
        )
      )
        return isGlobalSourceFile(parent);
      return isDeclarationVisible(c, parent);
    }
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      if (getEffectiveDeclarationFlags(node, ModifierFlags.Private | ModifierFlags.Protected) !== 0) return false;
      return isDeclarationVisible(c, node.parent!);
    case SyntaxKind.Constructor:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.Parameter:
    case SyntaxKind.ModuleBlock:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.TypeReference:
    case SyntaxKind.ArrayType:
    case SyntaxKind.TupleType:
    case SyntaxKind.UnionType:
    case SyntaxKind.IntersectionType:
    case SyntaxKind.ParenthesizedType:
    case SyntaxKind.NamedTupleMember:
      return isDeclarationVisible(c, node.parent!);
    // Imports are visible only once something refers to them.
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ImportSpecifier:
      return false;
    case SyntaxKind.TypeParameter:
    case SyntaxKind.SourceFile:
    case SyntaxKind.NamespaceExportDeclaration:
      return true;
    case SyntaxKind.ExportAssignment:
      return false;
    // `export { x }` without a module specifier re-exports `x` visibly.
    case SyntaxKind.ExportSpecifier: {
      const exportDeclaration = node.parent!.parent!;
      if (exportDeclaration instanceof ExportDeclaration && exportDeclaration.moduleSpecifier === undefined)
        return isDeclarationVisible(c, exportDeclaration.parent!);
      return false;
    }
  }
  return false;
}

/**
 * Accessible if every declaration of `symbol` is visible, or can be made so by keeping an
 * unexported import or statement; those are marked visible with `shouldComputeAliasesToMakeVisible`.
 */
export function hasVisibleDeclarations(
  c: Checker,
  symbol: Symbol,
  shouldComputeAliasesToMakeVisible: boolean,
): SymbolAccessibilityResult | undefined {
  const aliases: Node[] = [];
  const addVisibleAlias = (declaration: Node, statement: Node): void => {
    if (!shouldComputeAliasesToMakeVisible) return;
    markDeclarationVisible(c, declaration);
    if (aliases.indexOf(statement) < 0) aliases.push(statement);
  };
  for (const declaration of getDeclarations(symbol)) {
    if (declaration.kind === SyntaxKind.Identifier || isDeclarationVisible(c, declaration)) continue;
    // Unexported imports can name types if their parent is visible.
    const anyImport = getAnyImportSyntax(declaration);
    if (
      anyImport !== undefined &&
      !hasSyntacticModifier(anyImport, ModifierFlags.Export) &&
      isDeclarationVisible(c, anyImport.parent!)
    ) {
      addVisibleAlias(declaration, anyImport);
      continue;
    }
    if (
      declaration instanceof VariableDeclaration &&
      declaration.parent!.parent!.kind === SyntaxKind.VariableStatement &&
      !hasSyntacticModifier(declaration.parent!.parent!, ModifierFlags.Export) &&
      isDeclarationVisible(c, declaration.parent!.parent!.parent!)
    ) {
      addVisibleAlias(declaration, declaration.parent!.parent!);
      continue;
    }
    if (
      isLateVisibilityPaintedStatement(declaration) &&
      !hasSyntacticModifier(declaration, ModifierFlags.Export) &&
      isDeclarationVisible(c, declaration.parent!)
    ) {
      addVisibleAlias(declaration, declaration);
      continue;
    }
    if (declaration instanceof BindingElement) {
      if ((symbol.flags & SymbolFlags.Alias) !== 0 && isInJSFile(declaration)) {
        // An unexported top-level `const { x } = require('y')`.
        const statement = declaration.parent?.parent?.parent?.parent;
        if (
          declaration.parent?.parent instanceof VariableDeclaration &&
          statement !== undefined &&
          statement.kind === SyntaxKind.VariableStatement &&
          !hasSyntacticModifier(statement, ModifierFlags.Export) &&
          statement.parent !== undefined &&
          isDeclarationVisible(c, statement.parent)
        ) {
          addVisibleAlias(declaration, statement);
          continue;
        }
      }
      if ((symbol.flags & SymbolFlags.BlockScopedVariable) !== 0) {
        const root = getRootDeclaration(declaration);
        if (root.kind === SyntaxKind.Parameter) return undefined;
        const variableStatement = root.parent?.parent;
        if (variableStatement === undefined || variableStatement.kind !== SyntaxKind.VariableStatement)
          return undefined;
        // Already exported: nothing to keep.
        if (hasSyntacticModifier(variableStatement, ModifierFlags.Export)) continue;
        if (!isDeclarationVisible(c, variableStatement.parent!)) return undefined;
        addVisibleAlias(declaration, variableStatement);
        continue;
      }
    }
    return undefined;
  }
  return accessible(aliases);
}
