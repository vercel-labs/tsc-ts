// Naming symbols in built nodes: the chain of symbols reaching a symbol from the enclosing
// declaration, written as an entity name, `import("…")` type, indexed access or expression.
import {
  ComputedPropertyName,
  ElementAccessExpression,
  ExpressionWithTypeArguments,
  Identifier,
  ImportAttribute,
  ImportAttributes,
  ImportTypeNode,
  IndexedAccessTypeNode,
  LiteralTypeNode,
  type Node,
  type NodeList,
  NodeFlags,
  ParenthesizedTypeNode,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  QualifiedName,
  SourceFile,
  StringLiteral,
  TypeQueryNode,
  TypeReferenceNode,
  getArguments,
  getExpression,
  getInitializer,
  getModuleSpecifier,
  getName,
  getSymbol,
  getText,
} from './ast.js';
import {
  declarationNameToString,
  getDeclarationOfKind,
  getNameOfDeclaration,
  getSourceFileOfNode,
  isModuleAugmentationExternal,
} from './binder-utilities.js';
import {
  getExternalModuleName,
  isAmbientModule,
  isGlobalScopeAugmentation,
  isImportCall,
  isRequireCall,
} from './ast-utilities.js';
import { getSymbolAtLocation } from './checker-services.js';
import { checkExpression } from './checker-expressions.js';
import { getExportsOfSymbol, getMembersOfSymbol, getMergedSymbol, resolveAlias } from './checker-symbols.js';
import {
  getImportAttributesTypeForModuleSpecifier,
  getTypeOfModuleImportAttributes,
  resolveExternalModule,
} from './checker-modules.js';
import { getPropertiesOfType } from './checker-members.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { compareSymbols, isEmptyObjectType } from './checker-type-factory.js';
import { TypeFlags, type LiteralType, type Type } from './checker-types.js';
import { isLateBoundName } from './checker-utilities.js';
import { isExternalModuleNameRelative, pathIsRelative } from './path.js';
import type { Checker } from './checker.js';
import type { ResolvedModule } from './module-resolution-types.js';
import {
  ModuleSpecifierHost,
  ModuleSpecifierPreferences,
  countPathComponents,
  getModuleSpecifiersForFile,
} from './module-specifiers.js';
import { ModuleKind, ModuleResolutionKind, getModuleResolutionKind } from './options.js';
import type { OutputPathsHost } from './output-paths.js';
import type { PackageJsonInfo } from './package-json.js';
import type { KnownSymlinks } from './symlinks.js';
import { isExternalModuleAugmentation } from './transformers/declarations-syntactic.js';
import { EmitFlags } from './printer/emit-flags.js';
import { isIdentifierText } from './scanner.js';
import {
  getAccessibleSymbolChain,
  getAliasForSymbolInContainer,
  getContainersOfSymbol,
  getFileSymbolIfFileSymbolExportEqualsContainer,
  getQualifiedLeftMeaning,
  getSymbolIfSameReference,
  hasNonGlobalAugmentationExternalModuleDeclaration,
  isSymbolAccessibleByFlags,
  needsQualification,
} from './symbol-accessibility.js';
import { SyntaxKind } from './syntax-kind.js';
import { NodeBuilderFlags, NodeBuilderInternalFlags } from './transformers/declarations-resolver.js';
import { TokenFlags } from './types.js';
import { type NodeBuilder, classifyPropertyName, isNumericLiteralName } from './node-builder.js';
import {
  CheckFlags,
  declarationCount,
  escapeInternalSymbolName,
  getDeclarations,
  getSymbolId,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
  tryGetAmbientModuleNameFromSymbolName,
} from './symbol.js';

// ---- Symbol chains

/** The chain of symbols naming `symbol`, reported to the tracker. */
export function lookupSymbolChain(
  b: NodeBuilder,
  symbol: Symbol,
  meaning: SymbolFlags,
  yieldModuleSymbol: boolean,
): Symbol[] {
  b.trackSymbol(symbol, b.enclosingDeclaration, meaning);
  // Qualified only with somewhere to qualify from, and never for type parameters.
  if (
    (symbol.flags & SymbolFlags.TypeParameter) === 0 &&
    (b.enclosingDeclaration !== undefined || (b.flags & NodeBuilderFlags.UseFullyQualifiedType) !== 0) &&
    (b.internalFlags & NodeBuilderInternalFlags.DoNotIncludeSymbolChain) === 0
  )
    return getSymbolChain(b, symbol, meaning, true, yieldModuleSymbol)!;
  return [symbol];
}

/** `endOfChain` is false for parents, which may be omitted. */
function getSymbolChain(
  b: NodeBuilder,
  symbol: Symbol,
  meaning: SymbolFlags,
  endOfChain: boolean,
  yieldModuleSymbol: boolean,
): Symbol[] | undefined {
  const c = b.c;
  let chain = getAccessibleSymbolChain(
    c,
    symbol,
    b.enclosingDeclaration,
    meaning,
    (b.flags & NodeBuilderFlags.UseOnlyExternalAliasing) !== 0,
  );
  const qualifierMeaning = chain.length > 1 ? getQualifiedLeftMeaning(meaning) : meaning;
  if (chain.length === 0 || needsQualification(c, chain[0]!, b.enclosingDeclaration, qualifierMeaning)) {
    // Go up and add the parent.
    const root = chain.length > 0 ? chain[0]! : symbol;
    const parents = getContainersOfSymbol(c, root, b.enclosingDeclaration, meaning);
    if (parents.length > 0) {
      const specifiers: string[] = [];
      const order: number[] = [];
      for (const p of parents) {
        order.push(specifiers.length);
        specifiers.push(
          hasNonGlobalAugmentationExternalModuleDeclaration(p)
            ? getSpecifierForModuleSymbol(b, p, ModuleKind.None).specifier
            : '',
        );
      }
      order.sort((x, y) => compareByBestName(b, parents[x]!, specifiers[x]!, parents[y]!, specifiers[y]!) || x - y);
      for (const index of order) {
        const parent = parents[index]!;
        const parentChain = getSymbolChain(b, parent, getQualifiedLeftMeaning(meaning), false, yieldModuleSymbol);
        if (parentChain === undefined || parentChain.length === 0) continue;
        const exportEquals = parent.exports?.get(InternalSymbolName.ExportEquals);
        if (exportEquals !== undefined && getSymbolIfSameReference(c, exportEquals, symbol) !== undefined) {
          // The parent's `export =` is the symbol itself: no alias to look up.
          chain = parentChain;
          break;
        }
        const next = chain.length > 0 ? chain : [getAliasForSymbolInContainer(c, parent, symbol) ?? symbol];
        chain = parentChain.concat(next);
        break;
      }
    }
  }
  if (chain.length > 0) return chain;
  // The end of a chain is always written; an anonymous type parent never is.
  if (endOfChain || (symbol.flags & (SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral)) === 0) {
    // An external module parent isn't written: `x` rather than `"foo/bar".x`.
    if (!endOfChain && !yieldModuleSymbol && hasNonGlobalAugmentationExternalModuleDeclaration(symbol))
      return undefined;
    return [symbol];
  }
  return undefined;
}

function compareByBestName(b: NodeBuilder, a: Symbol, specifierA: string, other: Symbol, specifierB: string): number {
  if (specifierA.length > 0 && specifierB.length > 0) {
    const isBRelative = pathIsRelative(specifierB);
    if (pathIsRelative(specifierA) === isBRelative)
      return countPathComponents(specifierA) - countPathComponents(specifierB);
    return isBRelative ? -1 : 1;
  }
  return compareSymbols(b.c, a, other);
}

// ---- Type nodes

/** A type node naming `symbol` with `mask`: a type reference, `typeof`, indexed access or `import("…")`. */
export function symbolToTypeNode(
  b: NodeBuilder,
  symbol: Symbol,
  mask: SymbolFlags,
  typeArguments: NodeList | undefined,
): Node | undefined {
  // Outside the current scope, the module isn't needed.
  const chain = lookupSymbolChain(
    b,
    symbol,
    mask,
    (b.flags & NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope) === 0,
  );
  if (chain.length === 0) return undefined;
  const isTypeOf = mask === SymbolFlags.Value;
  if (hasNonGlobalAugmentationExternalModuleDeclaration(chain[0]!)) {
    // A module root needs an `import` type.
    const nonRootParts =
      chain.length > 1 ? createAccessFromSymbolChain(b, chain, chain.length - 1, 1, typeArguments) : undefined;
    const typeParameterNodes = typeArguments ?? lookupTypeParameterNodes(b, chain, 0);
    let specifier = new ModuleSpecifierResult('', undefined);
    let importModeOverride = ModuleKind.None;
    const c = b.c;
    const resolution = getModuleResolutionKind(c.compilerOptions);
    const nodeNext = resolution === ModuleResolutionKind.Node16 || resolution === ModuleResolutionKind.NodeNext;
    const contextFile =
      b.enclosingDeclaration === undefined
        ? undefined
        : getSourceFileOfNode(b.context.mostOriginal(b.enclosingDeclaration));
    if (nodeNext) {
      // An `import` type of an ES module from a file of another format resolves only in ESM mode.
      const targetFile = getSourceFileOfModule(chain[0]!);
      if (targetFile !== undefined && contextFile !== undefined) {
        const targetFormat = c.host.getEmitModuleFormatOfFile(targetFile);
        if (targetFormat === ModuleKind.ESNext && targetFormat !== c.host.getEmitModuleFormatOfFile(contextFile)) {
          specifier = getSpecifierForModuleSymbol(b, chain[0]!, ModuleKind.ESNext);
          importModeOverride = ModuleKind.ESNext;
        }
      }
    }
    if (specifier.specifier === '') specifier = getSpecifierForModuleSymbol(b, chain[0]!, ModuleKind.None);
    if (
      (b.flags & NodeBuilderFlags.AllowNodeModulesRelativePaths) === 0 &&
      specifier.specifier.includes('/node_modules/')
    ) {
      const oldSpecifier = specifier;
      if (nodeNext && contextFile !== undefined) {
        // The other mode may reach the module portably.
        const swappedMode =
          c.host.getEmitModuleFormatOfFile(contextFile) === ModuleKind.ESNext ? ModuleKind.CommonJS : ModuleKind.ESNext;
        specifier = getSpecifierForModuleSymbol(b, chain[0]!, swappedMode);
        if (specifier.specifier.includes('/node_modules/')) specifier = oldSpecifier;
        else importModeOverride = swappedMode;
      }
      if (importModeOverride === ModuleKind.None) {
        // A reference into `node_modules` is likely to break when published.
        b.encounteredError = true;
        b.tracker.reportLikelyUnsafeImportRequiredError(oldSpecifier.specifier, symbol.name);
      }
    }
    const attributes = createImportAttributesForModuleSpecifier(b, specifier, importModeOverride);
    const literal = b.created(new LiteralTypeNode(b.stringLiteral(specifier.specifier, false)));
    b.approximateLength += specifier.specifier.length + 10;
    if (nonRootParts === undefined || isEntityName(nonRootParts))
      return b.created(new ImportTypeNode(isTypeOf, literal, attributes, nonRootParts, typeParameterNodes));
    const splitNode = getTopmostIndexedAccessType(nonRootParts as IndexedAccessTypeNode);
    const qualifier = (splitNode.objectType as TypeReferenceNode).typeName;
    return b.created(
      new IndexedAccessTypeNode(
        b.created(new ImportTypeNode(isTypeOf, literal, attributes, qualifier, typeParameterNodes)),
        splitNode.indexType,
      ),
    );
  }
  const entityName = createAccessFromSymbolChain(b, chain, chain.length - 1, 0, typeArguments);
  // Indexed accesses can't be `typeof`.
  if (entityName instanceof IndexedAccessTypeNode) return entityName;
  if (isEntityName(entityName))
    return isTypeOf
      ? b.created(new TypeQueryNode(entityName, undefined))
      : b.created(new TypeReferenceNode(entityName, typeArguments));
  if (isTypeOf && entityName instanceof ExpressionWithTypeArguments)
    return b.created(new TypeQueryNode(entityName.expression.deepClone(), entityName.typeArguments));
  return entityName;
}

function isEntityName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName;
}

/**
 * The attributes of an `import()` type: a `resolution-mode` for `importModeOverride`, then the
 * string literal properties of the specifier's import attributes type, by name.
 */
function createImportAttributesForModuleSpecifier(
  b: NodeBuilder,
  result: ModuleSpecifierResult,
  importModeOverride: ModuleKind,
): ImportAttributes | undefined {
  const c = b.c;
  const attributesType = result.importAttributesType;
  const isEmptyAttributesType = attributesType === undefined || isEmptyObjectType(c, attributesType);
  if (isEmptyAttributesType && importModeOverride === ModuleKind.None) return undefined;
  const attributes: Node[] = [];
  if (importModeOverride !== ModuleKind.None) {
    const mode = importModeOverride === ModuleKind.ESNext ? 'import' : 'require';
    attributes.push(
      b.created(new ImportAttribute(b.stringLiteral('resolution-mode', false), b.stringLiteral(mode, false))),
    );
    b.approximateLength += 'resolution-mode'.length + mode.length + 6;
  }
  if (!isEmptyAttributesType) {
    const properties = getPropertiesOfType(c, attributesType).slice();
    properties.sort((x: Symbol, y: Symbol) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const property of properties) {
      const name = property.name;
      const propertyType = getTypeOfSymbol(c, property);
      if ((propertyType.flags & TypeFlags.StringLiteral) === 0) continue;
      const value = (propertyType as LiteralType).stringValue;
      let nameNode: Node;
      if (isIdentifierText(name)) nameNode = b.factory.createIdentifier(name);
      else {
        nameNode = b.stringLiteral(name, false);
        b.approximateLength += 2;
      }
      attributes.push(b.created(new ImportAttribute(nameNode, b.stringLiteral(value, false))));
      b.approximateLength += name.length + value.length + 4;
    }
  }
  if (attributes.length === 0) return undefined;
  b.approximateLength += 16 + 2 * (attributes.length - 1);
  return b.created(new ImportAttributes(SyntaxKind.WithKeyword, b.list(attributes), false));
}

function getTopmostIndexedAccessType(node: IndexedAccessTypeNode): IndexedAccessTypeNode {
  const objectType = node.objectType;
  return objectType instanceof IndexedAccessTypeNode ? getTopmostIndexedAccessType(objectType) : node;
}

function createAccessFromSymbolChain(
  b: NodeBuilder,
  chain: Symbol[],
  index: number,
  stopper: number,
  overrideTypeArguments: NodeList | undefined,
): Node {
  const c = b.c;
  const typeParameterNodes =
    index !== chain.length - 1 ? lookupTypeParameterNodes(b, chain, index) : overrideTypeArguments;
  const symbol = chain[index]!;
  const parent = index > 0 ? chain[index - 1]! : undefined;
  let symbolName = '';
  if (index === 0) {
    b.flags |= NodeBuilderFlags.InInitialEntityName;
    symbolName = getNameOfSymbolAsWritten(b, symbol);
    b.approximateLength += symbolName.length + 1;
    b.flags ^= NodeBuilderFlags.InInitialEntityName;
  } else if (parent !== undefined) {
    // A reference to the symbol within its parent, for export aliases.
    const exports = getExportsOfSymbol(c, parent);
    const direct = exports.get(symbol.name);
    if (
      symbol.name !== InternalSymbolName.ExportEquals &&
      !isLateBoundName(symbol.name) &&
      direct !== undefined &&
      getSymbolIfSameReference(c, direct, symbol) !== undefined
    )
      symbolName = symbol.name;
    else {
      const candidates: Symbol[] = [];
      const names: string[] = [];
      for (const [name, exported] of exports)
        if (
          getSymbolIfSameReference(c, exported, symbol) !== undefined &&
          !isLateBoundName(name) &&
          name !== InternalSymbolName.ExportEquals
        ) {
          candidates.push(exported);
          names.push(name);
        }
      if (candidates.length > 0) {
        let best = 0;
        for (let i = 1; i < candidates.length; i++)
          if (compareSymbols(c, candidates[i]!, candidates[best]!) < 0) best = i;
        symbolName = names[best]!;
      }
    }
  }
  if (symbolName.length === 0) {
    let name: Node | undefined = undefined;
    for (const d of getDeclarations(symbol)) {
      name = getNameOfDeclaration(d);
      if (name !== undefined) break;
    }
    if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName && isEntityName(getExpression(name)!)) {
      const lhs = createAccessFromSymbolChain(b, chain, index - 1, stopper, overrideTypeArguments);
      if (isEntityName(lhs))
        return b.created(
          new IndexedAccessTypeNode(
            b.created(new ParenthesizedTypeNode(b.created(new TypeQueryNode(lhs, undefined)))),
            b.created(new TypeQueryNode(getExpression(name)!, undefined)),
          ),
        );
      return lhs;
    }
    symbolName = getNameOfSymbolAsWritten(b, symbol);
  }
  b.approximateLength += symbolName.length + 1;
  if ((b.flags & NodeBuilderFlags.ForbidIndexedAccessSymbolReferences) === 0 && parent !== undefined) {
    const member = getMembersOfSymbol(c, parent).get(symbol.name);
    if (member !== undefined && getSymbolIfSameReference(c, member, symbol) !== undefined) {
      // An indexed access.
      const lhs = createAccessFromSymbolChain(b, chain, index - 1, stopper, overrideTypeArguments);
      const literal = b.created(new LiteralTypeNode(b.stringLiteral(symbolName, false)));
      if (lhs instanceof IndexedAccessTypeNode) return b.created(new IndexedAccessTypeNode(lhs, literal));
      return b.created(new IndexedAccessTypeNode(b.created(new TypeReferenceNode(lhs, typeParameterNodes)), literal));
    }
  }
  const identifier = b.identifier(symbolName);
  b.context.addEmitFlags(identifier, EmitFlags.NoAsciiEscaping);
  if (index > stopper) {
    const lhs = createAccessFromSymbolChain(b, chain, index - 1, stopper, overrideTypeArguments);
    if (
      (b.flags & NodeBuilderFlags.UseInstantiationExpressions) === 0 ||
      (isEntityName(lhs) && (typeParameterNodes === undefined || typeParameterNodes.nodes.length === 0))
    )
      return b.created(new QualifiedName(lhs, identifier));
    return createExpressionWithTypeArguments(
      b,
      b.created(new PropertyAccessExpression(createAccessExpression(b, lhs), undefined, identifier, NodeFlags.None)),
      typeParameterNodes,
    );
  }
  return identifier;
}

/** `ref`'s names appended to the reference `root`, for an outer type parameter group. */
export function appendReferenceToType(b: NodeBuilder, root: Node, ref: Node): Node {
  if (root instanceof ImportTypeNode) return appendReferenceToImportType(b, root as ImportTypeNode, ref);
  if (root instanceof TypeReferenceNode) return appendReferenceToTypeReference(b, root as TypeReferenceNode, ref);
  let expr = createAccessExpression(b, root);
  for (const id of getAccessStack(ref))
    expr = b.created(new PropertyAccessExpression(expr, undefined, id, NodeFlags.None));
  return expr;
}

function appendReferenceToImportType(b: NodeBuilder, root: ImportTypeNode, ref: Node): Node {
  // Type arguments of the root are dropped, as tsgo does.
  let qualifier = root.qualifier;
  for (const id of getAccessStack(ref))
    qualifier = qualifier === undefined ? id : b.created(new QualifiedName(qualifier, id as Identifier));
  return b.factory.updateImportTypeNode(
    root,
    root.isTypeOf,
    root.argument,
    root.attributes,
    qualifier,
    referenceTypeArguments(ref),
  );
}

function appendReferenceToTypeReference(b: NodeBuilder, root: TypeReferenceNode, ref: Node): Node {
  if (
    (b.flags & NodeBuilderFlags.UseInstantiationExpressions) !== 0 &&
    root.typeArguments !== undefined &&
    root.typeArguments.nodes.length !== 0
  ) {
    let expr = createExpressionWithTypeArguments(b, createAccessExpression(b, root.typeName), root.typeArguments);
    for (const id of getAccessStack(ref))
      expr = b.created(new PropertyAccessExpression(expr, undefined, id, NodeFlags.None));
    return expr;
  }
  let typeName = root.typeName;
  for (const id of getAccessStack(ref)) typeName = b.created(new QualifiedName(typeName, id as Identifier));
  return b.factory.updateTypeReferenceNode(root, typeName, referenceTypeArguments(ref));
}

function referenceTypeArguments(ref: Node): NodeList | undefined {
  return ref instanceof TypeReferenceNode ? (ref as TypeReferenceNode).typeArguments : undefined;
}

function getAccessStack(ref: Node): Node[] {
  let state = (ref as TypeReferenceNode).typeName;
  const ids: Node[] = [];
  while (state instanceof QualifiedName) {
    ids.unshift(state.right);
    state = state.left;
  }
  ids.unshift(state);
  return ids;
}

function createAccessExpression(b: NodeBuilder, node: Node): Node {
  if (node instanceof QualifiedName)
    return b.created(
      new PropertyAccessExpression(
        createAccessExpression(b, node.left),
        undefined,
        node.right.deepClone(),
        NodeFlags.None,
      ),
    );
  return node.deepClone();
}

function createExpressionWithTypeArguments(b: NodeBuilder, expr: Node, typeArguments: NodeList | undefined): Node {
  if (typeArguments === undefined || typeArguments.nodes.length === 0) return expr;
  return b.created(new ExpressionWithTypeArguments(expr, typeArguments));
}

// ---- Entity names and expressions

/** An entity name for `symbol`; with `expectsIdentifier`, a qualified name is an error unless allowed. */
export function symbolToName(b: NodeBuilder, symbol: Symbol, meaning: SymbolFlags, expectsIdentifier: boolean): Node {
  const chain = lookupSymbolChain(b, symbol, meaning, false);
  if (
    expectsIdentifier &&
    chain.length !== 1 &&
    !b.encounteredError &&
    (b.flags & NodeBuilderFlags.AllowQualifiedNameInPlaceOfIdentifier) !== 0
  )
    b.encounteredError = true;
  return createEntityNameFromSymbolChain(b, chain, chain.length - 1);
}

function createEntityNameFromSymbolChain(b: NodeBuilder, chain: Symbol[], index: number): Node {
  const symbol = chain[index]!;
  if (index === 0) b.flags |= NodeBuilderFlags.InInitialEntityName;
  const symbolName = getNameOfSymbolAsWritten(b, symbol);
  if (index === 0) b.flags ^= NodeBuilderFlags.InInitialEntityName;
  const identifier = b.identifier(symbolName);
  b.context.addEmitFlags(identifier, EmitFlags.NoAsciiEscaping);
  if (index > 0) return b.created(new QualifiedName(createEntityNameFromSymbolChain(b, chain, index - 1), identifier));
  return identifier;
}

/** The symbol's name qualified by its parents' names, without looking up a chain. */
export function symbolToEntityNameNode(b: NodeBuilder, symbol: Symbol): Node {
  const identifier = b.identifier(symbol.name);
  if (symbol.parent !== undefined)
    return b.created(new QualifiedName(symbolToEntityNameNode(b, symbol.parent), identifier));
  return identifier;
}

export function symbolToExpression(b: NodeBuilder, symbol: Symbol, meaning: SymbolFlags): Node {
  const chain = lookupSymbolChain(b, symbol, meaning, false);
  return createExpressionFromSymbolChain(b, chain, chain.length - 1);
}

function createExpressionFromSymbolChain(b: NodeBuilder, chain: Symbol[], index: number): Node {
  const typeParameterNodes = lookupExpressionChainTypeArgumentNodes(b, chain, index);
  const symbol = chain[index]!;
  if (index === 0) b.flags |= NodeBuilderFlags.InInitialEntityName;
  let symbolName = getNameOfSymbolAsWritten(b, symbol);
  if (index === 0) b.flags ^= NodeBuilderFlags.InInitialEntityName;
  if (startsWithQuote(symbolName) && hasNonGlobalAugmentationExternalModuleDeclaration(symbol)) {
    const specifier = getSpecifierForModuleSymbol(b, symbol, ModuleKind.None).specifier;
    b.approximateLength += 2 + specifier.length;
    return b.stringLiteral(specifier, false);
  }
  if (index === 0 || canUsePropertyAccess(symbolName)) {
    const identifier = b.identifier(symbolName);
    b.context.addEmitFlags(identifier, EmitFlags.NoAsciiEscaping);
    b.approximateLength += 1 + symbolName.length;
    if (index > 0) {
      const result = b.created(
        new PropertyAccessExpression(
          createExpressionFromSymbolChain(b, chain, index - 1),
          undefined,
          identifier,
          NodeFlags.None,
        ),
      );
      b.context.addEmitFlags(result, EmitFlags.NoIndentation);
      return createExpressionWithTypeArguments(b, result, typeParameterNodes);
    }
    return createExpressionWithTypeArguments(b, identifier, typeParameterNodes);
  }
  if (symbolName.startsWith('[')) symbolName = symbolName.substring(1, symbolName.length - 1);
  let expression: Node | undefined = undefined;
  if (startsWithQuote(symbolName) && (symbol.flags & SymbolFlags.EnumMember) === 0) {
    const literalText = unquote(symbolName);
    b.approximateLength += literalText.length + 2;
    expression = b.stringLiteral(literalText, symbolName.charCodeAt(0) === 0x27);
  } else if (String(Number(symbolName)) === symbolName) {
    b.approximateLength += symbolName.length;
    expression = b.factory.createNumericLiteral(symbolName);
  }
  if (expression === undefined) {
    b.approximateLength += symbolName.length;
    expression = b.identifier(symbolName);
    b.context.addEmitFlags(expression, EmitFlags.NoAsciiEscaping);
  }
  b.approximateLength += 2;
  return createExpressionWithTypeArguments(
    b,
    b.created(
      new ElementAccessExpression(
        createExpressionFromSymbolChain(b, chain, index - 1),
        undefined,
        expression,
        NodeFlags.None,
      ),
    ),
    typeParameterNodes,
  );
}

function canUsePropertyAccess(name: string): boolean {
  if (name.length === 0) return false;
  if (name.startsWith('#')) return name.length > 1 && isIdentifierText(name.substring(1));
  return isIdentifierText(name);
}

function startsWithQuote(s: string): boolean {
  return s.startsWith("'") || s.startsWith('"');
}

function unquote(s: string): string {
  if (
    s.length >= 2 &&
    (s.charCodeAt(0) === 0x22 || s.charCodeAt(0) === 0x27) &&
    s.charCodeAt(s.length - 1) === s.charCodeAt(0)
  )
    return s.substring(1, s.length - 1);
  return s;
}

// ---- Type arguments in qualified names

function shouldWriteTypeParametersInQualifiedName(b: NodeBuilder, chain: Symbol[], index: number): boolean {
  return (b.flags & NodeBuilderFlags.WriteTypeParametersInQualifiedName) !== 0 && index < chain.length - 1;
}

function lookupTypeParameterNodes(b: NodeBuilder, chain: Symbol[], index: number): NodeList | undefined {
  const symbolId = getSymbolId(chain[index]!);
  const symbolList = b.typeParameterSymbolList ?? new Set<number>();
  if (symbolList.has(symbolId)) return undefined;
  symbolList.add(symbolId);
  b.typeParameterSymbolList = symbolList;
  if (shouldWriteTypeParametersInQualifiedName(b, chain, index)) {
    const typeArgumentNodes = lookupInstantiatedTypeArgumentNodes(b, chain, index);
    if (typeArgumentNodes !== undefined) return typeArgumentNodes;
    const typeParameterNodes = b.typeParametersToTypeParameterDeclarations(chain[index]!);
    return typeParameterNodes.length > 0 ? b.list(typeParameterNodes) : undefined;
  }
  return undefined;
}

function lookupInstantiatedTypeArgumentNodes(b: NodeBuilder, chain: Symbol[], index: number): NodeList | undefined {
  if (!shouldWriteTypeParametersInQualifiedName(b, chain, index)) return undefined;
  const symbol = chain[index]!;
  const nextSymbol = chain[index + 1]!;
  if ((nextSymbol.checkFlags & CheckFlags.Instantiated) === 0) return undefined;
  const target = (symbol.flags & SymbolFlags.Alias) !== 0 ? resolveAlias(b.c, symbol) : symbol;
  let params = b.getTypeParametersOfClassOrInterface(target);
  const mapper = b.c.symbolMappers.get(getSymbolId(nextSymbol));
  if (mapper !== undefined) {
    const mapped: Type[] = [];
    for (const p of params) mapped.push(mapper.map(p));
    params = mapped;
  }
  return b.mapToTypeNodes(params, false);
}

function lookupExpressionChainTypeArgumentNodes(b: NodeBuilder, chain: Symbol[], index: number): NodeList | undefined {
  if (!shouldWriteTypeParametersInQualifiedName(b, chain, index)) return undefined;
  const symbolId = getSymbolId(chain[index]!);
  const symbolList = b.typeParameterSymbolList ?? new Set<number>();
  if (symbolList.has(symbolId)) return undefined;
  symbolList.add(symbolId);
  b.typeParameterSymbolList = symbolList;
  const typeArgumentNodes = lookupInstantiatedTypeArgumentNodes(b, chain, index);
  if (typeArgumentNodes !== undefined) return typeArgumentNodes;
  const typeParameterNodes = b.typeParametersToTypeParameterDeclarations(chain[index]!);
  return typeParameterNodes.length > 0 ? b.list(typeParameterNodes) : undefined;
}

// ---- Names as written

function isDefaultBindingContext(node: Node): boolean {
  return node.kind === SyntaxKind.SourceFile || isAmbientModule(node);
}

function findDefaultBindingContext(node: Node): Node | undefined {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (isDefaultBindingContext(current)) return current;
  return undefined;
}

function getNameOfSymbolFromNameType(b: NodeBuilder, symbol: Symbol): string {
  const nameType = b.c.symbolNameTypes.get(getSymbolId(symbol));
  if (nameType === undefined) return '';
  if ((nameType.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
    const literal = nameType as LiteralType;
    const name = (nameType.flags & TypeFlags.StringLiteral) !== 0 ? literal.stringValue : String(literal.numberValue);
    if (!isIdentifierText(name) && !isNumericLiteralName(name))
      return (nameType.flags & TypeFlags.StringLiteral) !== 0 ? quoteString(name) : name;
    if (isNumericLiteralName(name) && name.startsWith('-')) return '[' + name + ']';
    return name;
  }
  if ((nameType.flags & TypeFlags.UniqueESSymbol) !== 0)
    return '[' + getNameOfSymbolAsWritten(b, nameType.symbol!) + ']';
  return '';
}

/** A JSON-style double quoted string, as tsgo's `valueToString`. */
function quoteString(s: string): string {
  return JSON.stringify(s);
}

/**
 * A readable name for a symbol, not for the right of a `.`: quoted if from a string literal,
 * and a number as written (`0o11`, not `9`).
 */
export function getNameOfSymbolAsWritten(b: NodeBuilder, symbol: Symbol): string {
  const remapped = b.remappedSymbolReferences.get(getSymbolId(symbol));
  if (remapped !== undefined) symbol = remapped;
  if (
    symbol.name === InternalSymbolName.Default &&
    (b.flags & NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope) === 0 &&
    // Not the first part of an entity name, synthesized, or from another binding context.
    ((b.flags & NodeBuilderFlags.InInitialEntityName) === 0 ||
      declarationCount(symbol) === 0 ||
      (b.enclosingDeclaration !== undefined &&
        findDefaultBindingContext(symbol.declaration!) !== findDefaultBindingContext(b.enclosingDeclaration)))
  )
    return 'default';
  if (declarationCount(symbol) > 0) {
    let name: Node | undefined = undefined;
    for (const d of getDeclarations(symbol)) {
      name = getNameOfDeclaration(d);
      if (name !== undefined) break;
    }
    if (name !== undefined) {
      if (name.kind === SyntaxKind.ComputedPropertyName && (symbol.checkFlags & CheckFlags.Late) === 0) {
        const nameType = b.c.symbolNameTypes.get(getSymbolId(symbol));
        if (nameType !== undefined && (nameType.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
          const result = getNameOfSymbolFromNameType(b, symbol);
          if (result.length > 0) return result;
        }
      }
      return declarationNameToString(getSourceFileOfNode(name), name);
    }
    const declaration = symbol.declaration!;
    const parent = declaration.parent;
    if (parent !== undefined && parent.kind === SyntaxKind.VariableDeclaration) {
      const parentName = getName(parent)!;
      return declarationNameToString(getSourceFileOfNode(parentName), parentName);
    }
    switch (declaration.kind) {
      case SyntaxKind.ClassExpression:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
        if (!b.encounteredError && (b.flags & NodeBuilderFlags.AllowAnonymousIdentifier) === 0)
          b.encounteredError = true;
        return declaration.kind === SyntaxKind.ClassExpression ? '(Anonymous class)' : '(Anonymous function)';
    }
  }
  const name = getNameOfSymbolFromNameType(b, symbol);
  if (name.length > 0) return name;
  return escapeInternalSymbolName(symbol.name);
}

// ---- Property names

function isStringNamed(b: NodeBuilder, d: Node): boolean {
  const name = getNameOfDeclaration(d);
  if (name === undefined) return false;
  if (name instanceof ComputedPropertyName)
    return (checkExpression(b.c, name.expression).flags & TypeFlags.StringLike) !== 0;
  if (name instanceof ElementAccessExpression)
    return (checkExpression(b.c, name.argumentExpression).flags & TypeFlags.StringLike) !== 0;
  return name.kind === SyntaxKind.StringLiteral;
}

function isSingleQuotedStringNamed(d: Node): boolean {
  const name = getNameOfDeclaration(d);
  return name instanceof StringLiteral && (name.tokenFlags & TokenFlags.SingleQuote) !== 0;
}

/** The name node of a property. */
export function getPropertyNameNodeForSymbol(
  b: NodeBuilder,
  symbol: Symbol,
  enclosingDeclaration: Node | undefined,
): Node {
  // A private name is the declaration's.
  const valueDeclaration = symbol.valueDeclaration;
  if (valueDeclaration !== undefined) {
    const declarationName = getName(valueDeclaration);
    if (declarationName !== undefined && declarationName.kind === SyntaxKind.PrivateIdentifier)
      return b.cloneSynthesized(declarationName);
  }
  const declarations = getDeclarations(symbol);
  let stringNamed = declarations.length !== 0;
  for (const d of declarations)
    if (!isStringNamed(b, d)) {
      stringNamed = false;
      break;
    }
  let singleQuote = declarations.length !== 0;
  for (const d of declarations)
    if (!isSingleQuotedStringNamed(d)) {
      singleQuote = false;
      break;
    }
  const isMethod = (symbol.flags & SymbolFlags.Method) !== 0;
  const fromNameType = getPropertyNameNodeForSymbolFromNameType(
    b,
    symbol,
    enclosingDeclaration,
    singleQuote,
    stringNamed,
    isMethod,
  );
  if (fromNameType !== undefined) return fromNameType;
  let name = symbol.name;
  const privateNamePrefix = '￾#';
  if (name.startsWith(privateNamePrefix)) {
    // Symbol ids are unstable: `#123@#x` becomes `__#private@#x`.
    let rest = name.substring(privateNamePrefix.length);
    let i = 0;
    while (i < rest.length && rest.charCodeAt(i) >= 0x30 && rest.charCodeAt(i) <= 0x39) i++;
    rest = rest.substring(i);
    name = '__#private' + rest;
  }
  return createPropertyNameNodeForIdentifierOrLiteral(b, name, singleQuote, stringNamed, isMethod);
}

function createPropertyNameNodeForIdentifierOrLiteral(
  b: NodeBuilder,
  name: string,
  singleQuote: boolean,
  stringNamed: boolean,
  isMethod: boolean,
): Node {
  switch (classifyPropertyName(name, stringNamed, isMethod)) {
    case 0:
      return b.identifier(name);
    case 1:
      return b.factory.createNumericLiteral(name);
  }
  return b.factory.createStringLiteral(name, singleQuote ? TokenFlags.SingleQuote : TokenFlags.None);
}

function getPropertyNameNodeForSymbolFromNameType(
  b: NodeBuilder,
  symbol: Symbol,
  enclosingDeclaration: Node | undefined,
  singleQuote: boolean,
  stringNamed: boolean,
  isMethod: boolean,
): Node | undefined {
  const nameType = b.c.symbolNameTypes.get(getSymbolId(symbol));
  if (nameType === undefined) return undefined;
  // A name from an enum member stays a computed name, `[E.A]`, where the enum can be named.
  if ((nameType.flags & TypeFlags.EnumLiteral) !== 0) {
    const enumEnclosingDeclaration = enclosingDeclaration !== undefined ? enclosingDeclaration : b.enclosingFile;
    const enumSymbol = nameType.symbol!.parent !== undefined ? nameType.symbol!.parent : nameType.symbol!;
    if (
      enumEnclosingDeclaration !== undefined &&
      isSymbolAccessibleByFlags(b.c, enumSymbol, enumEnclosingDeclaration, SymbolFlags.Value)
    ) {
      const saveEnclosingDeclaration = b.enclosingDeclaration;
      b.enclosingDeclaration = enumEnclosingDeclaration;
      const result = b.created(new ComputedPropertyName(symbolToExpression(b, nameType.symbol!, SymbolFlags.Value)));
      b.enclosingDeclaration = saveEnclosingDeclaration;
      return result;
    }
  }
  if ((nameType.flags & TypeFlags.StringOrNumberLiteral) !== 0) {
    const literal = nameType as LiteralType;
    const name = (nameType.flags & TypeFlags.StringLiteral) !== 0 ? literal.stringValue : String(literal.numberValue);
    if (!isIdentifierText(name) && (stringNamed || !isNumericLiteralName(name)))
      return b.factory.createStringLiteral(name, singleQuote ? TokenFlags.SingleQuote : TokenFlags.None);
    if (isNumericLiteralName(name) && name.startsWith('-'))
      return b.created(
        new ComputedPropertyName(
          b.created(
            new PrefixUnaryExpression(SyntaxKind.MinusToken, b.factory.createNumericLiteral(name.substring(1))),
          ),
        ),
      );
    return createPropertyNameNodeForIdentifierOrLiteral(b, name, singleQuote, stringNamed, isMethod);
  }
  if ((nameType.flags & TypeFlags.UniqueESSymbol) !== 0)
    return b.created(new ComputedPropertyName(symbolToExpression(b, nameType.symbol!, SymbolFlags.Value)));
  return undefined;
}

// ---- Module specifiers

/** A module specifier, and the import attributes type an `import()` type with it needs. */
export class ModuleSpecifierResult {
  constructor(
    readonly specifier: string,
    readonly importAttributesType: Type | undefined,
  ) {}
}

/**
 * The specifier an `import("…")` type names a module with: an ambient module's name, the file
 * name without an enclosing file, else what module specifier generation gives for the enclosing
 * file. `overrideImportMode` is `None` for the mode of the enclosing import or file. A pattern
 * ambient module's specifier comes with the attributes type that resolves it.
 */
export function getSpecifierForModuleSymbol(
  b: NodeBuilder,
  symbol: Symbol,
  overrideImportMode: ModuleKind,
): ModuleSpecifierResult {
  const c = b.c;
  const enclosingDeclaration =
    b.enclosingDeclaration === undefined ? undefined : b.context.mostOriginal(b.enclosingDeclaration);
  const originalModuleSpecifier =
    enclosingDeclaration !== undefined && canHaveModuleSpecifier(enclosingDeclaration)
      ? tryGetModuleSpecifierFromDeclaration(enclosingDeclaration)
      : undefined;
  const originalImportAttributesType =
    originalModuleSpecifier !== undefined
      ? getImportAttributesTypeForModuleSpecifier(c, originalModuleSpecifier)
      : undefined;
  let file = asSourceFile(getDeclarationOfKind(symbol, SyntaxKind.SourceFile));
  if (file === undefined)
    for (const d of getDeclarations(symbol)) {
      const equivalent = getFileSymbolIfFileSymbolExportEqualsContainer(c, d, symbol);
      if (equivalent !== undefined) {
        file = asSourceFile(getDeclarationOfKind(equivalent, SyntaxKind.SourceFile));
        break;
      }
    }
  if (file === undefined) {
    for (const declaration of getDeclarations(symbol))
      if (isModuleWithStringLiteralName(declaration)) {
        const specifier = getText(getName(declaration)!);
        if (
          originalImportAttributesType !== undefined &&
          moduleSpecifierResolvesToSymbol(b, specifier, originalImportAttributesType, symbol)
        )
          return new ModuleSpecifierResult(specifier, originalImportAttributesType);
        return new ModuleSpecifierResult(specifier, getTypeOfModuleImportAttributes(c, symbol));
      }
    const ambientName = tryGetAmbientModuleNameFromSymbolName(symbol.name);
    if (ambientName !== undefined) return new ModuleSpecifierResult(ambientName, undefined);
  }
  const contextFile = b.enclosingFile;
  if (contextFile === undefined) {
    const ambientName = tryGetAmbientModuleNameFromSymbolName(symbol.name);
    if (ambientName !== undefined) return new ModuleSpecifierResult(ambientName, undefined);
    const moduleFile = getSourceFileOfModule(symbol);
    return new ModuleSpecifierResult(moduleFile === undefined ? '' : moduleFile.fileName, undefined);
  }
  let resolutionMode = overrideImportMode;
  if (resolutionMode === ModuleKind.None)
    resolutionMode =
      originalModuleSpecifier !== undefined
        ? c.host.getModeForUsageLocation(contextFile, originalModuleSpecifier)
        : c.host.getDefaultResolutionModeForFile(contextFile);
  const key = getSymbolId(symbol) + '|' + contextFile.path + '|' + resolutionMode;
  const cached = c.moduleSpecifiers.get(key);
  if (cached !== undefined) return moduleSpecifierResultForSymbol(b, cached, originalImportAttributesType, symbol);
  // Declaration emit prefers project-relative specifiers, with `.js` extensions in ES modules.
  const preferences = new ModuleSpecifierPreferences(
    'project-relative',
    resolutionMode === ModuleKind.ESNext ? 'js' : '',
  );
  const specifiers = getModuleSpecifiersWithAmbientModule(c, symbol, contextFile, preferences, overrideImportMode);
  const result = new ModuleSpecifierResult(
    specifiers.specifiers.length > 0 ? specifiers.specifiers[0]! : '',
    specifiers.ambientModuleSymbol !== undefined
      ? getTypeOfModuleImportAttributes(c, specifiers.ambientModuleSymbol)
      : undefined,
  );
  c.moduleSpecifiers.set(key, result);
  return moduleSpecifierResultForSymbol(b, result, originalImportAttributesType, symbol);
}

/** `result` with `importAttributesType`, if its specifier resolves to `symbol` with those attributes. */
function moduleSpecifierResultForSymbol(
  b: NodeBuilder,
  result: ModuleSpecifierResult,
  importAttributesType: Type | undefined,
  symbol: Symbol,
): ModuleSpecifierResult {
  if (
    importAttributesType !== undefined &&
    moduleSpecifierResolvesToSymbol(b, result.specifier, importAttributesType, symbol)
  )
    return new ModuleSpecifierResult(result.specifier, importAttributesType);
  return result;
}

function moduleSpecifierResolvesToSymbol(
  b: NodeBuilder,
  specifier: string,
  importAttributesType: Type,
  symbol: Symbol,
): boolean {
  const location = b.enclosingDeclaration ?? b.enclosingFile;
  if (location === undefined) return false;
  const c = b.c;
  const resolved = resolveExternalModule(c, location, specifier, undefined, undefined, false, importAttributesType);
  return resolved !== undefined && getMergedSymbol(c, resolved) === getMergedSymbol(c, symbol);
}

/** The specifiers of `getModuleSpecifiers`, and the ambient module symbol that gives an ambient module's name. */
class ModuleSpecifiers {
  constructor(
    readonly specifiers: string[],
    readonly ambientModuleSymbol: Symbol | undefined,
  ) {}
}

/** Specifiers `importingFile` can import the module `moduleSymbol` with, best first. */
export function getModuleSpecifiers(
  c: Checker,
  moduleSymbol: Symbol,
  importingFile: SourceFile,
  preferences: ModuleSpecifierPreferences,
  overrideImportMode: ModuleKind,
): string[] {
  return getModuleSpecifiersWithAmbientModule(c, moduleSymbol, importingFile, preferences, overrideImportMode)
    .specifiers;
}

function getModuleSpecifiersWithAmbientModule(
  c: Checker,
  moduleSymbol: Symbol,
  importingFile: SourceFile,
  preferences: ModuleSpecifierPreferences,
  overrideImportMode: ModuleKind,
): ModuleSpecifiers {
  const ambient = tryGetModuleNameFromAmbientModule(c, moduleSymbol);
  if (ambient !== undefined) return new ModuleSpecifiers([getText(getName(ambient)!)], getSymbol(ambient));
  const moduleFile = getSourceFileOfModule(moduleSymbol);
  if (moduleFile === undefined) return new ModuleSpecifiers([], undefined);
  const host = getModuleSpecifierHost(c);
  // A referenced project's declaration output is named by its source.
  const specifiers = getModuleSpecifiersForFile(
    importingFile,
    host.getSourceOfProjectReferenceIfOutputIncluded(moduleFile),
    c.compilerOptions,
    host,
    preferences,
    overrideImportMode,
    false,
  );
  return new ModuleSpecifiers(specifiers, undefined);
}

function getModuleSpecifierHost(c: Checker): ModuleSpecifierHost {
  let host = c.host.getModuleSpecifierHost();
  if (host === undefined) {
    host = c.fallbackModuleSpecifierHost;
    if (host === undefined) {
      host = new CheckerModuleSpecifierHost(c);
      c.fallbackModuleSpecifierHost = host;
    }
  }
  return host;
}

/** The ambient module declaring `moduleSymbol`, or the one whose `export =` it is. */
function tryGetModuleNameFromAmbientModule(c: Checker, moduleSymbol: Symbol): Node | undefined {
  for (const d of getDeclarations(moduleSymbol)) {
    const name = isModuleWithStringLiteralName(d) ? getName(d)! : undefined;
    if (name !== undefined && (!isModuleAugmentationExternal(d) || !isExternalModuleNameRelative(getText(name))))
      return d;
  }
  // A namespace exported with `export =` from an ambient module: `import { c } from "m"` names
  // `ns.c` for `declare module "m" { namespace ns { class c {} } export = ns; }`.
  for (const d of getDeclarations(moduleSymbol)) {
    if (d.kind !== SyntaxKind.ModuleDeclaration) continue;
    let container: Node | undefined = d;
    while (container !== undefined && !isModuleWithStringLiteralName(container)) container = container.parent;
    if (container === undefined || container.parent === undefined || container.parent.kind !== SyntaxKind.SourceFile)
      continue;
    const exportEquals = getSymbol(container)?.exports?.get(InternalSymbolName.ExportEquals);
    const assignment = exportEquals?.valueDeclaration;
    if (assignment === undefined || assignment.kind !== SyntaxKind.ExportAssignment) continue;
    let exported = getSymbolAtLocation(c, getExpression(assignment)!);
    if (exported === undefined) continue;
    if ((exported.flags & SymbolFlags.Alias) !== 0) exported = resolveAlias(c, exported);
    if (exported === getSymbol(d)) return container;
  }
  return undefined;
}

function isModuleWithStringLiteralName(node: Node): boolean {
  return node.kind === SyntaxKind.ModuleDeclaration && getName(node)?.kind === SyntaxKind.StringLiteral;
}

function canHaveModuleSpecifier(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.BindingElement:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceExport:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportType:
      return true;
  }
  return false;
}

/** The string literal module specifier of an import, export, `require` or `import("…")` type declaration. */
function tryGetModuleSpecifierFromDeclaration(node: Node): Node | undefined {
  let specifier: Node | undefined;
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.BindingElement: {
      let call = getInitializer(node);
      while (call !== undefined && !isRequireCall(call, true) && !isImportCall(call)) call = call.parent;
      specifier = call === undefined ? undefined : getArguments(call)!.nodes[0];
      break;
    }
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ExportDeclaration:
      specifier = getModuleSpecifier(node);
      break;
    case SyntaxKind.ImportEqualsDeclaration:
      specifier = getExternalModuleName(node);
      break;
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceExport:
      specifier = getModuleSpecifier(node.parent!);
      break;
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ExportSpecifier:
      specifier = getModuleSpecifier(node.parent!.parent!);
      break;
    case SyntaxKind.ImportSpecifier:
      specifier = getModuleSpecifier(node.parent!.parent!.parent!);
      break;
    case SyntaxKind.ImportType: {
      const argument = (node as ImportTypeNode).argument;
      specifier = argument instanceof LiteralTypeNode ? (argument as LiteralTypeNode).literal : undefined;
      break;
    }
  }
  return specifier !== undefined && specifier.kind === SyntaxKind.StringLiteral ? specifier : undefined;
}

/**
 * Specifier generation without a program, as the checker of single files uses: relative paths
 * between the checker's files.
 */
class CheckerModuleSpecifierHost extends ModuleSpecifierHost {
  constructor(readonly c: Checker) {
    super();
  }

  getCurrentDirectory(): string {
    return '';
  }

  useCaseSensitiveFileNames(): boolean {
    return true;
  }

  getSymlinkCache(): KnownSymlinks | undefined {
    return undefined;
  }

  getGlobalTypingsCacheLocation(): string {
    return '';
  }

  getProjectReferenceOutputDts(_path: string): string {
    return '';
  }

  getRedirectTargets(_path: string): readonly string[] {
    return [];
  }

  getSourceOfProjectReferenceIfOutputIncluded(file: SourceFile): string {
    return file.fileName;
  }

  fileExists(path: string): boolean {
    for (const file of this.c.files) if (file.fileName === path) return true;
    return false;
  }

  getNearestAncestorDirectoryWithPackageJson(_directory: string): string {
    return '';
  }

  getPackageJsonInfo(_packageJsonPath: string): PackageJsonInfo | undefined {
    return undefined;
  }

  getDefaultResolutionModeForFile(file: SourceFile): ModuleKind {
    return this.c.host.getDefaultResolutionModeForFile(file);
  }

  getResolvedModuleFromModuleSpecifier(_file: SourceFile, _specifier: Node): ResolvedModule | undefined {
    return undefined;
  }

  getModeForUsageLocation(file: SourceFile, specifier: Node): ModuleKind {
    return this.c.host.getModeForUsageLocation(file, specifier);
  }

  getOutputPathsHost(): OutputPathsHost {
    return new FallbackOutputPathsHost();
  }
}

class FallbackOutputPathsHost implements OutputPathsHost {
  readonly currentDirectory = '';
  readonly useCaseSensitiveFileNames = true;

  commonSourceDirectory(): string {
    return '';
  }
}

function asSourceFile(node: Node | undefined): SourceFile | undefined {
  if (node === undefined) return undefined;
  if (node instanceof SourceFile) return node as SourceFile;
  return undefined;
}

/** The file of a module: its value declaration's, else that of a declaration that isn't an augmentation. */
function getSourceFileOfModule(symbol: Symbol): SourceFile | undefined {
  let d = symbol.valueDeclaration;
  if (d === undefined)
    for (const declaration of getDeclarations(symbol))
      if (!isExternalModuleAugmentation(declaration) && !isGlobalScopeAugmentation(declaration)) {
        d = declaration;
        break;
      }
  return d === undefined ? undefined : getSourceFileOfNode(d);
}
