// Checker queries about scopes for the language service, like tsgo's getSymbolsInScope and TryGetThisTypeAtEx.
import {
  getLocals,
  getName,
  getParameters,
  getSymbol,
  Identifier,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  type SourceFile,
} from '../compiler/ast.js';
import { isFunctionLike } from '../compiler/ast-utilities.js';
import {
  getDeclarationOfKind,
  getThisContainer,
  isClassLike,
  isExternalModule,
  isGlobalSourceFile,
  isStatic,
} from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { getDeclaredTypeOfSymbol } from '../compiler/checker-declared-types.js';
import { getContextualThisParameterType } from '../compiler/checker-expressions.js';
import { isInParameterInitializerBeforeContainingFunction } from '../compiler/checker-grammar.js';
import { getSignatureOfFullSignatureType } from '../compiler/checker-jsdoc.js';
import { getFlowTypeOfReference } from '../compiler/checker-narrowing.js';
import { getReparsedNodeForNode } from '../compiler/checker-services.js';
import { getSignatureFromDeclaration, getThisTypeOfSignature } from '../compiler/checker-signatures.js';
import { getTypeOfSymbol } from '../compiler/checker-symbol-types.js';
import { getMembersOfSymbol, getSymbolOfDeclaration, isReservedMemberName } from '../compiler/checker-symbols.js';
import type { InterfaceType, Type } from '../compiler/checker-types.js';
import { type Symbol, SymbolFlags, type SymbolTable } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';

/**
 * The symbols with `meaning` in scope at `location`, innermost first: each scope's locals, a module's or
 * namespace's exports, an enum's members, a class's or interface's type parameters (not in static members), a named
 * class or function expression's own name, `arguments` in functions, then the globals. A name is taken by the first
 * symbol found with it. Nothing is in scope inside a `with` statement.
 */
export function getSymbolsInScope(c: Checker, locationIn: Node, meaning: SymbolFlags): Symbol[] {
  if ((locationIn.flags & NodeFlags.InWithStatement) !== 0) return [];
  const symbols = new Map<string, Symbol>();
  const copySymbol = (symbol: Symbol, meaning: SymbolFlags): void => {
    if ((symbol.combinedLocalAndExportSymbolFlags() & meaning) !== 0 && !symbols.has(symbol.name)) {
      symbols.set(symbol.name, symbol);
    }
  };
  const copySymbols = (source: SymbolTable, meaning: SymbolFlags): void => {
    if (meaning !== 0) for (const symbol of source.values()) copySymbol(symbol, meaning);
  };
  const copyLocallyVisibleExportSymbols = (source: SymbolTable, meaning: SymbolFlags): void => {
    if (meaning === 0) return;
    for (const symbol of source.values()) {
      // As resolveName finds them.
      if (
        getDeclarationOfKind(symbol, SyntaxKind.ExportSpecifier) === undefined &&
        getDeclarationOfKind(symbol, SyntaxKind.NamespaceExport) === undefined &&
        symbol.name !== 'default'
      )
        copySymbol(symbol, meaning);
    }
  };

  let isStaticSymbol = false;
  let lastLocation: Node | undefined;
  let location: Node | undefined = locationIn;
  while (location !== undefined) {
    // A module declaration is not in scope inside its attributes.
    if (
      location instanceof ModuleDeclaration &&
      location.attributes !== undefined &&
      lastLocation === location.attributes
    ) {
      lastLocation = location;
      location = location.parent;
      continue;
    }
    const locals = getLocals(location);
    if (locals !== undefined && !isGlobalSourceFile(location)) copySymbols(locals, meaning);
    switch (location.kind) {
      case SyntaxKind.SourceFile:
        if (isExternalModule(location as SourceFile))
          copyModuleExports(c, location, meaning, copyLocallyVisibleExportSymbols);
        break;
      case SyntaxKind.ModuleDeclaration:
        copyModuleExports(c, location, meaning, copyLocallyVisibleExportSymbols);
        break;
      case SyntaxKind.EnumDeclaration: {
        const symbol = getSymbolOfDeclaration(c, location);
        if (symbol?.exports !== undefined) copySymbols(symbol.exports, meaning & SymbolFlags.EnumMember);
        break;
      }
      case SyntaxKind.ClassExpression:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration: {
        const symbol = getSymbolOfDeclaration(c, location);
        if (location.kind === SyntaxKind.ClassExpression && getName(location) !== undefined) {
          copySymbol(getSymbol(location)!, meaning);
        }
        // The type parameters, unless the previous location was a static member.
        if (!isStaticSymbol && symbol !== undefined)
          copySymbols(getMembersOfSymbol(c, symbol), meaning & SymbolFlags.Type);
        break;
      }
      case SyntaxKind.FunctionExpression:
        if (getName(location) !== undefined) copySymbol(getSymbol(location)!, meaning);
        break;
    }
    if (introducesArgumentsExoticObject(location)) copySymbol(c.argumentsSymbol, meaning);
    isStaticSymbol = isStatic(location);
    lastLocation = location;
    location = location.parent;
  }
  copySymbols(c.globals, meaning);
  // `this` is a keyword.
  symbols.delete('this');
  const result: Symbol[] = [];
  for (const [name, symbol] of symbols) if (!isReservedMemberName(name)) result.push(symbol);
  return result;
}

function copyModuleExports(
  c: Checker,
  location: Node,
  meaning: SymbolFlags,
  copy: (source: SymbolTable, meaning: SymbolFlags) => void,
): void {
  const symbol = getSymbolOfDeclaration(c, location);
  if (symbol?.exports !== undefined) copy(symbol.exports, meaning & SymbolFlags.ModuleMember);
}

function introducesArgumentsExoticObject(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
      return true;
  }
  return false;
}

/**
 * The type of `this` at `node`: of its function's `this` parameter or context, of its class, `undefined` at the top
 * of a module, and with `includeGlobalThis`, `globalThis` at the top of a script. Undefined elsewhere, and for JSDoc
 * the binder did not reparse.
 */
export function tryGetThisTypeAtEx(
  c: Checker,
  nodeIn: Node,
  includeGlobalThis: boolean,
  containerIn: Node | undefined,
): Type | undefined {
  const node = getReparsedNodeForNode(nodeIn);
  if ((node.flags & NodeFlags.JSDoc) !== 0 && (node.flags & NodeFlags.Reparsed) === 0) return undefined;
  const container =
    containerIn === undefined ? getThisContainer(node, false, false) : getReparsedNodeForNode(containerIn);
  if (
    isFunctionLike(container) &&
    (!isInParameterInitializerBeforeContainingFunction(node) || getThisParameter(container) !== undefined)
  ) {
    const signature = getSignatureOfFullSignatureType(c, container) ?? getSignatureFromDeclaration(c, container);
    // A parameter initializer refers to the class's `this` unless the function's is annotated.
    const thisType = getThisTypeOfSignature(c, signature) ?? getContextualThisParameterType(c, container);
    if (thisType !== undefined) return getFlowTypeOfReference(c, node, thisType, thisType, undefined);
  }
  const parent = container.parent;
  if (parent !== undefined && isClassLike(parent)) {
    const symbol = getSymbolOfDeclaration(c, parent)!;
    const t = isStatic(container)
      ? getTypeOfSymbol(c, symbol)
      : (getDeclaredTypeOfSymbol(c, symbol) as InterfaceType).thisType!;
    return getFlowTypeOfReference(c, node, t, t, undefined);
  }
  if (container.kind === SyntaxKind.SourceFile) {
    if ((container as SourceFile).externalModuleIndicator !== undefined) return c.undefinedType;
    if (includeGlobalThis) return getTypeOfSymbol(c, c.globalThisSymbol);
  }
  return undefined;
}

function getThisParameter(signature: Node): Node | undefined {
  const parameters = getParameters(signature);
  if (parameters === undefined || parameters.nodes.length === 0) return undefined;
  const first = parameters.nodes[0]!;
  const name = getName(first);
  return name instanceof Identifier && name.text === 'this' ? first : undefined;
}

/** Whether `symbol` is the checker's `arguments` symbol. */
export function isArgumentsSymbol(c: Checker, symbol: Symbol): boolean {
  return symbol === c.argumentsSymbol;
}
