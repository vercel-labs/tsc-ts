// Find-all-references: the declarations and uses of the symbol at a node, across files.
import {
  BinaryExpression,
  BindingElement,
  ClassStaticBlockDeclaration,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  getArguments,
  getBody,
  getExpression,
  getMembers,
  getName,
  getPropertyName,
  getStatements,
  getSymbol,
  getText,
  HeritageClause,
  ImportTypeNode,
  LiteralTypeNode,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeVisitor,
  PropertyAccessExpression,
  type SourceFile,
} from '../compiler/ast.js';
import { isFunctionLike, isImportMeta, isInJSFile, isStringLiteralLike } from '../compiler/ast-utilities.js';
import {
  getModifierFlags,
  getNameOfDeclaration,
  getSourceFileOfNode,
  getThisContainer,
  hasStaticModifier,
  isBindableObjectDefinePropertyCall,
  isClassLike,
  isExternalModule,
  isExternalOrCommonJSModule,
  isObjectLiteralMethod,
  isParameterPropertyDeclaration,
  isPrivateIdentifierClassElementDeclaration,
  isStatic,
  isVariableDeclarationInitializedToRequire,
  moduleExportNameIsDefault,
  symbolName,
} from '../compiler/binder-utilities.js';
import { type Checker } from '../compiler/checker.js';
import { getContextualType } from '../compiler/checker-contextual.js';
import { getPropertyOfType } from '../compiler/checker-members.js';
import {
  getExportSpecifierLocalTargetSymbol,
  getShorthandAssignmentValueSymbol,
  getSymbolAtLocation,
  getTypeAtLocation,
} from '../compiler/checker-services.js';
import { getSuperContainer } from '../compiler/checker-super.js';
import { getMergedSymbol, resolveAlias } from '../compiler/checker-symbols.js';
import { getTypeFromTypeNode } from '../compiler/checker-type-nodes.js';
import { getLocalSymbolForExportDefault } from '../compiler/name-resolver.js';
import { type Program } from '../compiler/program.js';
import { computeLineOfPosition, tokenToString } from '../compiler/scanner.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import {
  getPropertySymbolOfDestructuringAssignment,
  getPropertySymbolsFromBaseTypes,
  getPropertySymbolsFromContextualType,
  getRootSymbols,
  getSymbolsOfParameterPropertyDeclaration,
  isExternalModuleSymbol,
} from './checker-queries.js';
import {
  type ExportInfo,
  ExportKind,
  findModuleReferences,
  getExportInfo,
  getImportOrExportSymbol,
  getSourceFileFromReference,
  ImpExpKind,
  ImportTracker,
  ModuleReferenceKind,
} from './import-tracker.js';
import { findChildTokenOfKind } from './tokens.js';
import {
  climbPastPropertyAccess,
  findAncestor,
  getAdjustedLocation,
  getContainerNode,
  getContainingObjectLiteralElement,
  getContextualTypeFromParentOrAncestorTypeNode,
  getDeclarationOfKind,
  getIntersectingMeaningFromDeclarations,
  getLocalSymbolForExportSpecifier,
  getMeaningFromLocation,
  getNameTable,
  getNonModuleSymbolOfMergedModuleSymbol,
  getPossibleSymbolReferenceNodes,
  getPossibleSymbolReferencePositions,
  getPropertySymbolFromBindingElement,
  getPropertySymbolOfObjectBindingPatternWithoutPropertyName,
  getTargetLabel,
  isCallExpressionTarget,
  isExpressionOfExternalModuleImportEqualsDeclaration,
  isJumpStatementTarget,
  isLabelOfLabeledStatement,
  isLiteralNameOfPropertyDeclarationOrIndexAccess,
  isModuleSpecifierLike,
  isNameOfModuleDeclaration,
  isNewExpressionTarget,
  isObjectBindingElementWithoutPropertyName,
  isReadonlyTypeOperator,
  isSourceFileWithGlobalExports,
  isStaticSymbol,
  isThis,
  isTypeKeyword,
  SemanticMeaning,
} from './utilities.js';
import { getTokenPosOfNode, getTouchingPropertyName, getTouchingToken } from '../compiler/astnav.js';
import { getDirectoryPath, isExternalModuleNameRelative, resolvePath } from '../compiler/path.js';
import {
  CheckFlags,
  declarationCount,
  getDeclarations,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
  tryGetAmbientModuleNameFromSymbolName,
} from '../compiler/symbol.js';

export const enum DefinitionKind {
  Symbol,
  Label,
  Keyword,
  This,
  String,
  TripleSlashReference,
}

/** What a group of references refers to. */
export interface Definition {
  kind: DefinitionKind;
  symbol: Symbol | undefined;
  node: Node | undefined;
}

/** A reference: a node, or for `/// <reference>` directives only a file. */
export interface ReferenceEntry {
  node: Node | undefined;
}

export class SymbolAndEntries {
  constructor(
    readonly definition: Definition,
    public references: ReferenceEntry[],
  ) {}

  /** The node defining the referenced symbol, if any. */
  definitionNode(): Node | undefined {
    if (this.definition.node !== undefined) return this.definition.node;
    const symbol = this.definition.symbol;
    return symbol !== undefined && declarationCount(symbol) > 0 ? symbol.declaration : undefined;
  }
}

function nodeEntry(node: Node): ReferenceEntry {
  return { node: getName(node) ?? node };
}

const enum SpecialSearchKind {
  None,
  Constructor,
  Class,
}

/** The references of the symbol at `node` in `sourceFiles`, grouped by definition. */
export function getReferencedSymbolsForNode(
  c: Checker,
  program: Program,
  position: number,
  nodeIn: Node,
  sourceFiles: readonly SourceFile[],
): SymbolAndEntries[] {
  const sourceFileNames = new Set<string>();
  for (const file of sourceFiles) sourceFileNames.add(file.fileName);
  const node = getAdjustedLocation(nodeIn, false, getSourceFileOfNode(nodeIn));

  if (node.kind === SyntaxKind.SourceFile) {
    const resolved = getReferenceAtPosition(node as SourceFile, position, program);
    if (resolved === undefined || resolved.file === undefined) return [];
    const fileSymbol = getSymbol(resolved.file);
    if (fileSymbol !== undefined) {
      const moduleSymbol = getMergedSymbol(c, fileSymbol);
      return getReferencedSymbolsForModule(c, program, moduleSymbol, false, sourceFiles, sourceFileNames);
    }
    return [
      new SymbolAndEntries({ kind: DefinitionKind.TripleSlashReference, symbol: undefined, node: undefined }, []),
    ];
  }

  const special = getReferencedSymbolsSpecial(node, sourceFiles);
  if (special !== undefined) return special;

  // Constructors use the class symbol.
  const parentName = node.kind === SyntaxKind.Constructor ? getName(node.parent!) : undefined;
  const symbol = getSymbolAtLocation(c, parentName ?? node);
  if (symbol === undefined) {
    // A string literal may be a property, so it is handled here rather than as special.
    if (isStringLiteralLike(node)) return getReferencesForStringLiteral(c, node, sourceFiles);
    return [];
  }

  if (symbol.name === InternalSymbolName.ExportEquals) {
    if (symbol.parent === undefined) return [];
    return getReferencedSymbolsForModule(c, program, symbol.parent, false, sourceFiles, sourceFileNames);
  }

  const moduleReferences = getReferencedSymbolsForModuleIfDeclaredBySourceFile(
    c,
    program,
    symbol,
    sourceFiles,
    sourceFileNames,
  );
  if (moduleReferences !== undefined && (symbol.flags & SymbolFlags.Transient) === 0) return moduleReferences;

  const aliasedSymbol = getMergedAliasedSymbolOfNamespaceExportDeclaration(c, node, symbol);
  const moduleReferencesOfExportTarget = getReferencedSymbolsForModuleIfDeclaredBySourceFile(
    c,
    program,
    aliasedSymbol,
    sourceFiles,
    sourceFileNames,
  );
  const references = getReferencedSymbolsForSymbol(c, program, symbol, node, sourceFiles, sourceFileNames);
  return mergeReferences(program, [moduleReferences, references, moduleReferencesOfExportTarget]);
}

/** The uses of a function-like declaration's name, with the calls they appear in. */
export interface SignatureUsage {
  name: Node;
  call: Node | undefined;
}

export function getSignatureUsages(c: Checker, program: Program, signatureDecl: Node): SignatureUsage[] {
  const name = getName(signatureDecl);
  if (name === undefined || name.kind !== SyntaxKind.Identifier) return [];
  const entries = getReferencedSymbolsForNode(c, program, name.pos, name, program.getSourceFiles());
  // Declarations are not usages.
  const declarationNames = new Set<Node>();
  for (const entry of entries) {
    const symbol = entry.definition.symbol;
    if (symbol === undefined) continue;
    for (const declaration of getDeclarations(symbol)) {
      const declarationName = getName(declaration);
      if (declarationName !== undefined) declarationNames.add(declarationName);
    }
  }
  const result: SignatureUsage[] = [];
  for (const entry of entries)
    for (const ref of entry.references) {
      const node = ref.node;
      if (node === undefined || declarationNames.has(node)) continue;
      const called = climbPastPropertyAccess(node);
      const parent = called.parent;
      const call =
        parent !== undefined && parent.kind === SyntaxKind.CallExpression && getExpression(parent) === called
          ? parent
          : undefined;
      result.push({ name: node, call });
    }
  return result;
}

/** The identifiers in `file` that reference `symbol`. */
export function getReferencesToSymbolInFile(c: Checker, file: SourceFile, symbol: Symbol): Node[] {
  const name = symbol.name;
  const result: Node[] = [];
  for (const token of getPossibleSymbolReferenceNodes(file, name, file)) {
    if (token.kind !== SyntaxKind.Identifier || getText(token) !== name) continue;
    const refSymbol = getSymbolAtLocation(c, token);
    if (refSymbol === symbol) {
      result.push(token);
      continue;
    }
    const parent = token.parent;
    if (parent !== undefined && parent.kind === SyntaxKind.ShorthandPropertyAssignment) {
      if (getShorthandAssignmentValueSymbol(c, parent) === symbol) {
        result.push(token);
        continue;
      }
    }
    if (parent !== undefined && parent.kind === SyntaxKind.ExportSpecifier && refSymbol !== undefined) {
      const specifier = parent as ExportSpecifier;
      if (getLocalSymbolForExportSpecifier(c, token, refSymbol, specifier) === symbol) result.push(token);
    }
  }
  return result;
}

// ---- Merging

function mergeReferences(program: Program, referencesToMerge: (SymbolAndEntries[] | undefined)[]): SymbolAndEntries[] {
  let result: SymbolAndEntries[] = [];
  const files = program.getSourceFiles();
  const fileIndex = (entry: ReferenceEntry): number =>
    entry.node === undefined ? -1 : files.indexOf(getSourceFileOfNode(entry.node));
  for (const references of referencesToMerge) {
    if (references === undefined || references.length === 0) continue;
    if (result.length === 0) {
      result = references;
      continue;
    }
    for (const entry of references) {
      if (entry.definition.kind !== DefinitionKind.Symbol) {
        result.push(entry);
        continue;
      }
      const symbol = entry.definition.symbol;
      const index = result.findIndex(
        (r) => r.definition.kind === DefinitionKind.Symbol && r.definition.symbol === symbol,
      );
      if (index === -1) {
        result.push(entry);
        continue;
      }
      const reference = result[index];
      const sorted = reference.references.concat(entry.references);
      sorted.sort((a, b) => {
        const fileA = fileIndex(a);
        const fileB = fileIndex(b);
        if (fileA !== fileB) return fileA - fileB;
        return compareRanges(a, b);
      });
      result[index] = new SymbolAndEntries(reference.definition, sorted);
    }
  }
  return result;
}

function compareRanges(a: ReferenceEntry, b: ReferenceEntry): number {
  if (a.node === undefined || b.node === undefined) return 0;
  const [startA, endA] = rangeOfNode(a.node);
  const [startB, endB] = rangeOfNode(b.node);
  return startA !== startB ? startA - startB : endA - endB;
}

function rangeOfNode(node: Node): [number, number] {
  let start = getTokenPosOfNode(node, getSourceFileOfNode(node), false);
  let end = node.end;
  if (isStringLiteralLike(node) && end - start > 2) {
    start++;
    end--;
  }
  return [start, end];
}

// ---- Special references

function getReferencedSymbolsSpecial(node: Node, sourceFiles: readonly SourceFile[]): SymbolAndEntries[] | undefined {
  if (isTypeKeyword(node.kind)) {
    // A void expression isn't special, but the void type is.
    if (node.kind === SyntaxKind.VoidKeyword && node.parent!.kind === SyntaxKind.VoidExpression) return undefined;
    // A readonly modifier isn't special, but the readonly type operator is.
    if (node.kind === SyntaxKind.ReadonlyKeyword && !isReadonlyTypeOperator(node)) return undefined;
    return getAllReferencesForKeyword(sourceFiles, node.kind, node.kind === SyntaxKind.ReadonlyKeyword);
  }
  const parent = node.parent;
  if (parent !== undefined && isImportMeta(parent) && getName(parent) === node)
    return getAllReferencesForImportMeta(sourceFiles);
  if (node.kind === SyntaxKind.StaticKeyword && parent instanceof ClassStaticBlockDeclaration)
    return [new SymbolAndEntries({ kind: DefinitionKind.Keyword, node, symbol: undefined }, [nodeEntry(node)])];
  if (isJumpStatementTarget(node)) {
    const labelDefinition = getTargetLabel(node.parent, getText(node));
    return labelDefinition === undefined ? [] : getLabelReferencesInNode(labelDefinition.parent!, labelDefinition);
  }
  if (isLabelOfLabeledStatement(node)) return getLabelReferencesInNode(node.parent!, node);
  if (isThis(node)) return getReferencesForThisKeyword(node, sourceFiles);
  if (node.kind === SyntaxKind.SuperKeyword) return getReferencesForSuperKeyword(node);
  return undefined;
}

function getLabelReferencesInNode(container: Node, targetLabel: Node): SymbolAndEntries[] {
  const file = getSourceFileOfNode(container);
  const labelName = getText(targetLabel);
  const references: ReferenceEntry[] = [];
  for (const node of getPossibleSymbolReferenceNodes(file, labelName, container))
    if (node === targetLabel || (isJumpStatementTarget(node) && getTargetLabel(node, labelName) === targetLabel))
      references.push(nodeEntry(node));
  return [new SymbolAndEntries({ kind: DefinitionKind.Label, node: targetLabel, symbol: undefined }, references)];
}

function isParameterName(node: Node): boolean {
  return (
    node.kind === SyntaxKind.Identifier && node.parent!.kind === SyntaxKind.Parameter && getName(node.parent!) === node
  );
}

function getReferencesForThisKeyword(thisOrSuperKeyword: Node, sourceFiles: readonly SourceFile[]): SymbolAndEntries[] {
  let searchSpaceNode = getThisContainer(thisOrSuperKeyword, false, false)!;
  // Whether `this` is in a static context of a class.
  let staticFlag = ModifierFlags.Static;
  switch (searchSpaceNode.kind) {
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      staticFlag &= getModifierFlags(searchSpaceNode);
      // The owning class or object literal.
      searchSpaceNode = searchSpaceNode.parent!;
      break;
    case SyntaxKind.SourceFile:
      if (isExternalModule(searchSpaceNode as SourceFile) || isParameterName(thisOrSuperKeyword)) return [];
      break;
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
      break;
    default:
      return [];
  }
  const filesToSearch =
    searchSpaceNode.kind === SyntaxKind.SourceFile ? sourceFiles : [getSourceFileOfNode(searchSpaceNode)];
  const references: ReferenceEntry[] = [];
  for (const file of filesToSearch)
    for (const node of getPossibleSymbolReferenceNodes(
      file,
      'this',
      searchSpaceNode.kind === SyntaxKind.SourceFile ? file : searchSpaceNode,
    )) {
      if (!isThis(node)) continue;
      const container = getThisContainer(node, false, false)!;
      if (!canHaveSymbol(container)) continue;
      let matches = false;
      switch (searchSpaceNode.kind) {
        case SyntaxKind.FunctionExpression:
        case SyntaxKind.FunctionDeclaration:
          matches = getSymbol(searchSpaceNode) === getSymbol(container);
          break;
        case SyntaxKind.MethodDeclaration:
        case SyntaxKind.MethodSignature:
          matches = isObjectLiteralMethod(searchSpaceNode) && getSymbol(searchSpaceNode) === getSymbol(container);
          break;
        case SyntaxKind.ClassExpression:
        case SyntaxKind.ClassDeclaration:
        case SyntaxKind.ObjectLiteralExpression:
          // The same class or object literal, with the same static modifier as the original container.
          matches =
            container.parent !== undefined &&
            canHaveSymbol(container.parent) &&
            getSymbol(searchSpaceNode) === getSymbol(container.parent) &&
            isStatic(container) === (staticFlag !== ModifierFlags.None);
          break;
        case SyntaxKind.SourceFile:
          matches =
            container.kind === SyntaxKind.SourceFile &&
            !isExternalModule(container as SourceFile) &&
            !isParameterName(node);
          break;
      }
      if (matches) references.push(nodeEntry(node));
    }
  const thisParameter =
    references.find((r) => r.node!.parent!.kind === SyntaxKind.Parameter)?.node ?? thisOrSuperKeyword;
  return [
    new SymbolAndEntries(
      { kind: DefinitionKind.This, node: thisParameter, symbol: getSymbol(searchSpaceNode) },
      references,
    ),
  ];
}

function getReferencesForSuperKeyword(superKeyword: Node): SymbolAndEntries[] {
  let searchSpaceNode = getSuperContainer(superKeyword, false);
  if (searchSpaceNode === undefined) return [];
  // Whether `super` is in a static context of a class.
  let staticFlag = ModifierFlags.Static;
  switch (searchSpaceNode.kind) {
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      staticFlag &= getModifierFlags(searchSpaceNode);
      searchSpaceNode = searchSpaceNode.parent!;
      break;
    default:
      return [];
  }
  const file = getSourceFileOfNode(searchSpaceNode);
  const references: ReferenceEntry[] = [];
  for (const node of getPossibleSymbolReferenceNodes(file, 'super', searchSpaceNode)) {
    if (node.kind !== SyntaxKind.SuperKeyword) continue;
    const container = getSuperContainer(node, false);
    // The same class, with the same static modifier as the original `super`.
    if (
      container !== undefined &&
      isStatic(container) === (staticFlag !== ModifierFlags.None) &&
      getSymbol(container.parent!) === getSymbol(searchSpaceNode)
    )
      references.push(nodeEntry(node));
  }
  return [
    new SymbolAndEntries(
      { kind: DefinitionKind.Symbol, node: undefined, symbol: getSymbol(searchSpaceNode) },
      references,
    ),
  ];
}

function getAllReferencesForImportMeta(sourceFiles: readonly SourceFile[]): SymbolAndEntries[] | undefined {
  const references: ReferenceEntry[] = [];
  for (const file of sourceFiles)
    for (const node of getPossibleSymbolReferenceNodes(file, 'meta', file))
      if (node.parent !== undefined && isImportMeta(node.parent)) references.push(nodeEntry(node.parent));
  if (references.length === 0) return undefined;
  return [
    new SymbolAndEntries({ kind: DefinitionKind.Keyword, node: references[0].node, symbol: undefined }, references),
  ];
}

function getAllReferencesForKeyword(
  sourceFiles: readonly SourceFile[],
  keywordKind: SyntaxKind,
  filterReadOnlyTypeOperator: boolean,
): SymbolAndEntries[] | undefined {
  const references: ReferenceEntry[] = [];
  for (const file of sourceFiles)
    for (const location of getPossibleSymbolReferenceNodes(file, tokenToString(keywordKind), file))
      if (location.kind === keywordKind && (!filterReadOnlyTypeOperator || isReadonlyTypeOperator(location)))
        references.push(nodeEntry(location));
  if (references.length === 0) return undefined;
  return [
    new SymbolAndEntries({ kind: DefinitionKind.Keyword, node: references[0].node, symbol: undefined }, references),
  ];
}

function canHaveSymbol(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.BindingElement:
    case SyntaxKind.CallExpression:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.ConstructorType:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.EnumMember:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.FunctionType:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.ImportClause:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxAttributes:
    case SyntaxKind.JsxSpreadAttribute:
    case SyntaxKind.MappedType:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.NamedTupleMember:
    case SyntaxKind.NamespaceExport:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.NewExpression:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.SourceFile:
    case SyntaxKind.SpreadAssignment:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.TypeParameter:
    case SyntaxKind.VariableDeclaration:
      return true;
  }
  return false;
}

// ---- String literals

function getReferencesForStringLiteral(c: Checker, node: Node, sourceFiles: readonly SourceFile[]): SymbolAndEntries[] {
  const type = getContextualTypeFromParentOrAncestorTypeNode(c, node);
  const text = getText(node);
  const references: ReferenceEntry[] = [];
  for (const file of sourceFiles)
    for (const ref of getPossibleSymbolReferenceNodes(file, text, undefined)) {
      if (!isStringLiteralLike(ref) || getText(ref) !== text) continue;
      if (type !== undefined) {
        const refType = getContextualTypeFromParentOrAncestorTypeNode(c, ref);
        if (type !== c.stringType && (type === refType || isStringLiteralPropertyReference(c, ref)))
          references.push(nodeEntry(ref));
      } else {
        if (ref.kind === SyntaxKind.NoSubstitutionTemplateLiteral && !rangeIsOnSingleLine(ref, file)) continue;
        references.push(nodeEntry(ref));
      }
    }
  return [new SymbolAndEntries({ kind: DefinitionKind.String, node, symbol: undefined }, references)];
}

function rangeIsOnSingleLine(node: Node, file: SourceFile): boolean {
  const lineStarts = file.lineStarts();
  const start = getTokenPosOfNode(node, file, false);
  return computeLineOfPosition(lineStarts, start) === computeLineOfPosition(lineStarts, node.end);
}

function isStringLiteralPropertyReference(c: Checker, node: Node): boolean {
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.PropertySignature)
    return getPropertyOfType(c, getTypeAtLocation(c, parent.parent!), getText(node)) !== undefined;
  return false;
}

// ---- Modules

function getReferencedSymbolsForModuleIfDeclaredBySourceFile(
  c: Checker,
  program: Program,
  symbol: Symbol | undefined,
  sourceFiles: readonly SourceFile[],
  sourceFileNames: Set<string>,
): SymbolAndEntries[] | undefined {
  if (symbol === undefined || (symbol.flags & SymbolFlags.Module) === 0 || declarationCount(symbol) === 0)
    return undefined;
  const moduleSourceFile = getDeclarations(symbol).find((d) => d.kind === SyntaxKind.SourceFile);
  if (moduleSourceFile === undefined) return undefined;
  const exportEquals = symbol.exports?.get(InternalSymbolName.ExportEquals);
  // `import("mod")` references are added for the `export =` anyway.
  const moduleReferences = getReferencedSymbolsForModule(
    c,
    program,
    symbol,
    exportEquals !== undefined,
    sourceFiles,
    sourceFileNames,
  );
  if (
    exportEquals === undefined ||
    (exportEquals.flags & SymbolFlags.Alias) === 0 ||
    !sourceFileNames.has((moduleSourceFile as SourceFile).fileName)
  )
    return moduleReferences;
  const target = resolveAlias(c, exportEquals);
  return mergeReferences(program, [
    moduleReferences,
    getReferencedSymbolsForSymbol(c, program, target, undefined, sourceFiles, sourceFileNames),
  ]);
}

function getMergedAliasedSymbolOfNamespaceExportDeclaration(
  c: Checker,
  node: Node,
  symbol: Symbol,
): Symbol | undefined {
  if (node.parent === undefined || node.parent.kind !== SyntaxKind.NamespaceExportDeclaration) return undefined;
  const aliasedSymbol = resolveAlias(c, symbol);
  if (aliasedSymbol === c.unknownSymbol) return undefined;
  const targetSymbol = getMergedSymbol(c, aliasedSymbol);
  return aliasedSymbol !== targetSymbol ? targetSymbol : undefined;
}

function getReferencedSymbolsForModule(
  c: Checker,
  program: Program,
  symbol: Symbol,
  excludeImportTypeOfExportEquals: boolean,
  sourceFiles: readonly SourceFile[],
  sourceFileNames: Set<string>,
): SymbolAndEntries[] {
  const references: ReferenceEntry[] = [];
  for (const reference of findModuleReferences(c, program, sourceFiles, symbol)) {
    switch (reference.kind) {
      case ModuleReferenceKind.Import: {
        const literal = reference.literal!;
        const parent = literal.parent!;
        // `import("foo")` with no qualifier references the `export =`, which may be referenced anyway.
        if (
          parent instanceof LiteralTypeNode &&
          parent.parent instanceof ImportTypeNode &&
          excludeImportTypeOfExportEquals &&
          parent.parent.qualifier === undefined
        )
          continue;
        references.push(nodeEntry(literal));
        break;
      }
      case ModuleReferenceKind.Implicit: {
        // The first JSX node, the first statement, or the whole file.
        const file = reference.referencingFile!;
        let rangeNode = getText(reference.literal!) !== 'tslib' ? findFirstJsxNode(file) : undefined;
        if (rangeNode === undefined) {
          const statements = getStatements(file)!.nodes;
          rangeNode = statements.length > 0 ? statements[0] : file;
        }
        references.push(nodeEntry(rangeNode));
        break;
      }
      case ModuleReferenceKind.Reference:
        references.push({ node: undefined });
        break;
    }
  }
  // The module declarations themselves.
  for (const declaration of getDeclarations(symbol))
    if (declaration instanceof ModuleDeclaration && sourceFileNames.has(getSourceFileOfNode(declaration).fileName))
      references.push(nodeEntry(declaration.name));
  const exported = symbol.exports?.get(InternalSymbolName.ExportEquals);
  if (exported !== undefined)
    for (const declaration of getDeclarations(exported)) {
      const file = getSourceFileOfNode(declaration);
      if (!sourceFileNames.has(file.fileName)) continue;
      let node: Node | undefined;
      // At `module.exports = ...`, the reference is `module`.
      if (declaration instanceof BinaryExpression && declaration.left instanceof PropertyAccessExpression)
        node = declaration.left.expression;
      else if (declaration instanceof ExportAssignment)
        node = findChildTokenOfKind(declaration, SyntaxKind.ExportKeyword, file);
      else node = getNameOfDeclaration(declaration) ?? declaration;
      references.push(nodeEntry(node!));
    }
  if (references.length === 0) return [];
  return [new SymbolAndEntries({ kind: DefinitionKind.Symbol, symbol, node: undefined }, references)];
}

class JsxFinder extends NodeVisitor {
  found: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.JsxElement:
      case SyntaxKind.JsxSelfClosingElement:
      case SyntaxKind.JsxFragment:
        this.found = node;
        return true;
    }
    return node.forEachChild(this);
  }
}

function findFirstJsxNode(root: Node): Node | undefined {
  const finder = new JsxFinder();
  root.forEachChild(finder);
  return finder.found;
}

// ---- The search for a symbol

function getSpecialSearchKind(node: Node | undefined): SpecialSearchKind {
  if (node === undefined) return SpecialSearchKind.None;
  switch (node.kind) {
    case SyntaxKind.Constructor:
    case SyntaxKind.ConstructorKeyword:
      return SpecialSearchKind.Constructor;
    case SyntaxKind.Identifier:
      return isClassLike(node.parent!) ? SpecialSearchKind.Class : SpecialSearchKind.None;
  }
  return SpecialSearchKind.None;
}

function getReferencedSymbolsForSymbol(
  c: Checker,
  program: Program,
  originalSymbol: Symbol,
  node: Node | undefined,
  sourceFiles: readonly SourceFile[],
  sourceFileNames: Set<string>,
): SymbolAndEntries[] {
  const symbol = skipPastExportOrImportSpecifierOrUnion(c, originalSymbol, node) ?? originalSymbol;
  const searchMeaning = getIntersectingMeaningFromDeclarations(node, symbol, SemanticMeaning.All);
  const state = new SearchState(c, program, sourceFiles, sourceFileNames, node, searchMeaning);
  if (
    node !== undefined &&
    node.kind === SyntaxKind.DefaultKeyword &&
    symbol.name === InternalSymbolName.Default &&
    symbol.parent !== undefined
  ) {
    state.addReference(node, symbol);
    state.searchForImportsOfExport(node, symbol, {
      exportingModuleSymbol: symbol.parent,
      exportKind: ExportKind.Default,
    });
  } else {
    const search = state.createSearch(
      node,
      symbol,
      ImpExpKind.Unknown,
      undefined,
      state.populateSearchSymbolSet(symbol, node),
    );
    state.getReferencesInContainerOrFiles(symbol, search);
  }
  return state.result;
}

function skipPastExportOrImportSpecifierOrUnion(
  c: Checker,
  symbol: Symbol,
  node: Node | undefined,
): Symbol | undefined {
  if (node === undefined) return undefined;
  const parent = node.parent!;
  if (parent instanceof ExportSpecifier) return getLocalSymbolForExportSpecifier(c, node, symbol, parent);
  // A property declared in `{ type: "a" } | { type: "b" }` uses the union's property.
  for (const declaration of getDeclarations(symbol)) {
    if (declaration.parent === undefined) {
      // UMD module and global merges, and CommonJS module exports.
      if ((symbol.flags & (SymbolFlags.Transient | SymbolFlags.ModuleExports)) !== 0) continue;
      throw new Error(`Unexpected symbol at ${node.kind}: ${symbol.name}`);
    }
    if (
      declaration.parent.kind === SyntaxKind.TypeLiteral &&
      declaration.parent.parent!.kind === SyntaxKind.UnionType
    ) {
      const prop = getPropertyOfType(c, getTypeFromTypeNode(c, declaration.parent.parent!), symbol.name);
      if (prop !== undefined) return prop;
    }
  }
  return undefined;
}

/** The smallest node references to `symbol` can be in, or undefined if they can be anywhere. */
function getSymbolScope(symbol: Symbol): Node | undefined {
  // A named function or class expression is only visible inside itself.
  const valueDeclaration = symbol.valueDeclaration;
  if (
    valueDeclaration !== undefined &&
    (valueDeclaration.kind === SyntaxKind.FunctionExpression || valueDeclaration.kind === SyntaxKind.ClassExpression)
  )
    return valueDeclaration;
  const declarations = getDeclarations(symbol);
  if (declarations.length === 0) return undefined;
  // A private member is only visible in its class.
  if ((symbol.flags & (SymbolFlags.Property | SymbolFlags.Method)) !== 0) {
    const privateDeclaration = declarations.find(
      (d) => (getModifierFlags(d) & ModifierFlags.Private) !== 0 || isPrivateIdentifierClassElementDeclaration(d),
    );
    if (privateDeclaration !== undefined)
      return findAncestor(privateDeclaration, (n) => n.kind === SyntaxKind.ClassDeclaration);
    return undefined;
  }
  // A shorthand binding element is also a property, which could be anywhere.
  if (declarations.some(isObjectBindingElementWithoutPropertyName)) return undefined;
  // A symbol with a parent is visible everywhere, unless it is a type parameter or an export
  // of a module without `export as namespace`.
  const exposedByParent = symbol.parent !== undefined && (symbol.flags & SymbolFlags.TypeParameter) === 0;
  if (
    exposedByParent &&
    !(isExternalModuleSymbol(symbol.parent!) && !isSourceFileWithGlobalExports(symbol.parent!.valueDeclaration))
  )
    return undefined;
  let scope: Node | undefined;
  for (const declaration of declarations) {
    const container = getContainerNode(declaration);
    // Declarations in different containers.
    if (scope !== undefined && scope !== container) return undefined;
    // A global of a script is visible in other files.
    if (
      container === undefined ||
      (container.kind === SyntaxKind.SourceFile && !isExternalOrCommonJSModule(container as SourceFile))
    )
      return undefined;
    scope = container;
  }
  // An export of a module may be used anywhere in its file, also by other module declarations.
  return exposedByParent ? getSourceFileOfNode(scope!) : scope;
}

interface Search {
  comingFrom: ImpExpKind;
  symbol: Symbol;
  text: string;
  allSearchSymbols: Symbol[];
}

function searchIncludes(search: Search, symbol: Symbol | undefined): boolean {
  return symbol !== undefined && search.allSearchSymbols.includes(symbol);
}

class SearchState {
  readonly specialSearchKind: SpecialSearchKind;
  readonly result: SymbolAndEntries[] = [];
  private readonly seenReExportRHS = new Set<Node>();
  private importTracker: ImportTracker | undefined = undefined;
  private readonly symbolToReferences = new Map<Symbol, SymbolAndEntries>();
  private readonly sourceFileToSeenSymbols = new Map<SourceFile, Set<Symbol>>();

  constructor(
    readonly c: Checker,
    readonly program: Program,
    readonly sourceFiles: readonly SourceFile[],
    readonly sourceFileNames: Set<string>,
    node: Node | undefined,
    readonly searchMeaning: SemanticMeaning,
  ) {
    this.specialSearchKind = getSpecialSearchKind(node);
  }

  includesSourceFile(file: SourceFile): boolean {
    return this.sourceFileNames.has(file.fileName);
  }

  createSearch(
    location: Node | undefined,
    symbol: Symbol,
    comingFrom: ImpExpKind,
    text: string | undefined,
    allSearchSymbols: Symbol[] | undefined,
  ): Search {
    let searchText = text;
    if (searchText === undefined) {
      // An external module's name doesn't include its quotes.
      const s = getLocalSymbolForExportDefault(symbol) ?? getNonModuleSymbolOfMergedModuleSymbol(symbol) ?? symbol;
      const name = symbolName(s);
      searchText = tryGetAmbientModuleNameFromSymbolName(name) ?? name;
    }
    void location;
    return {
      symbol,
      comingFrom,
      text: searchText,
      allSearchSymbols: allSearchSymbols !== undefined && allSearchSymbols.length > 0 ? allSearchSymbols : [symbol],
    };
  }

  referenceAdder(searchSymbol: Symbol): (node: Node) => void {
    let entries = this.symbolToReferences.get(searchSymbol);
    if (entries === undefined) {
      entries = new SymbolAndEntries({ kind: DefinitionKind.Symbol, node: undefined, symbol: searchSymbol }, []);
      this.symbolToReferences.set(searchSymbol, entries);
      this.result.push(entries);
    }
    const target = entries;
    return (node) => target.references.push(nodeEntry(node));
  }

  addReference(referenceLocation: Node, symbol: Symbol): void {
    this.referenceAdder(symbol)(referenceLocation);
  }

  getReferencesInContainerOrFiles(symbol: Symbol, search: Search): void {
    // Search the smallest scope possible, or else every file.
    const scope = getSymbolScope(symbol);
    if (scope !== undefined) {
      const addReferencesHere = scope.kind !== SyntaxKind.SourceFile || this.sourceFiles.includes(scope as SourceFile);
      this.getReferencesInContainer(scope, getSourceFileOfNode(scope), search, addReferencesHere);
    } else {
      for (const file of this.sourceFiles) this.searchForName(file, search);
    }
  }

  getReferencesInSourceFile(file: SourceFile, search: Search, addReferencesHere: boolean): void {
    this.getReferencesInContainer(file, file, search, addReferencesHere);
  }

  getReferencesInContainer(container: Node, file: SourceFile, search: Search, addReferencesHere: boolean): void {
    if (!this.markSearchedSymbols(file, search.allSearchSymbols)) return;
    for (const position of getPossibleSymbolReferencePositions(file, search.text, container))
      this.getReferencesAtLocation(file, position, search, addReferencesHere);
  }

  markSearchedSymbols(file: SourceFile, symbols: Symbol[]): boolean {
    let seen = this.sourceFileToSeenSymbols.get(file);
    if (seen === undefined) {
      seen = new Set();
      this.sourceFileToSeenSymbols.set(file, seen);
    }
    let anyNew = false;
    for (const symbol of symbols)
      if (!seen.has(symbol)) {
        seen.add(symbol);
        anyNew = true;
      }
    return anyNew;
  }

  getReferencesAtLocation(file: SourceFile, position: number, search: Search, addReferencesHere: boolean): void {
    const referenceLocation = getTouchingPropertyName(file, position);
    if (referenceLocation === undefined || !isValidReferencePosition(referenceLocation, search.text)) return;
    if ((getMeaningFromLocation(referenceLocation) & this.searchMeaning) === 0) return;
    let referenceSymbol = getSymbolAtLocation(this.c, referenceLocation);
    if (referenceSymbol === undefined) return;
    const parent = referenceLocation.parent!;
    // Added through the single references of import searches.
    if (parent.kind === SyntaxKind.ImportSpecifier && getPropertyName(parent) === referenceLocation) return;
    if (parent instanceof ExportSpecifier) {
      this.getReferencesAtExportSpecifier(referenceLocation, referenceSymbol, parent, search, addReferencesHere);
      return;
    }
    const relatedSymbol = this.getRelatedSymbol(search, referenceSymbol, referenceLocation);
    if (relatedSymbol === undefined) {
      this.getReferenceForShorthandProperty(referenceSymbol, search);
      return;
    }
    switch (this.specialSearchKind) {
      case SpecialSearchKind.None:
        if (addReferencesHere) this.addReference(referenceLocation, relatedSymbol);
        break;
      case SpecialSearchKind.Constructor:
        this.addConstructorReferences(referenceLocation, relatedSymbol, search, addReferencesHere);
        break;
      case SpecialSearchKind.Class:
        this.addClassStaticThisReferences(referenceLocation, relatedSymbol, search, addReferencesHere);
        break;
    }
    // A destructured `require` in JavaScript imports through the binding element's symbol.
    if (
      isInJSFile(referenceLocation) &&
      parent instanceof BindingElement &&
      isVariableDeclarationInitializedToRequire(parent)
    ) {
      referenceSymbol = getSymbol(parent);
      // An object binding pattern has no symbol and isn't an alias of the import.
      if (referenceSymbol === undefined) return;
    }
    this.getImportOrExportReferences(referenceLocation, referenceSymbol, search);
  }

  addConstructorReferences(referenceLocation: Node, symbol: Symbol, search: Search, addReferencesHere: boolean): void {
    if (isNewExpressionTarget(referenceLocation) && addReferencesHere) this.addReference(referenceLocation, symbol);
    const file = getSourceFileOfNode(referenceLocation);
    if (isClassLike(referenceLocation.parent!)) {
      // The class declaration containing the constructor.
      findOwnConstructorReferences(search.symbol, file, (n) => this.referenceAdder(search.symbol)(n));
    } else {
      // Super calls of classes that extend this one are references.
      const classExtending = tryGetClassByExtendingIdentifier(referenceLocation);
      if (classExtending !== undefined) {
        findSuperConstructorAccesses(classExtending, (n) => this.referenceAdder(search.symbol)(n));
        this.findInheritedConstructorReferences(classExtending);
      }
    }
  }

  addClassStaticThisReferences(
    referenceLocation: Node,
    symbol: Symbol,
    search: Search,
    addReferencesHere: boolean,
  ): void {
    if (addReferencesHere) this.addReference(referenceLocation, symbol);
    const classLike = referenceLocation.parent!;
    if (!isClassLike(classLike)) return;
    const addRef = this.referenceAdder(search.symbol);
    const members = getMembers(classLike);
    if (members === undefined) return;
    for (const member of members.nodes) {
      if (!(isMethodOrAccessor(member) && hasStaticModifier(member))) continue;
      const body = getBody(member);
      if (body !== undefined) forEachThisInBody(body, addRef);
    }
  }

  findInheritedConstructorReferences(classDeclaration: Node): void {
    if (hasOwnConstructor(classDeclaration)) return;
    const classSymbol = getSymbol(classDeclaration)!;
    const search = this.createSearch(undefined, classSymbol, ImpExpKind.Unknown, undefined, undefined);
    this.getReferencesInContainerOrFiles(classSymbol, search);
  }

  getImportOrExportReferences(referenceLocation: Node, referenceSymbol: Symbol, search: Search): void {
    const importOrExport = getImportOrExportSymbol(
      this.c,
      referenceLocation,
      referenceSymbol,
      search.comingFrom === ImpExpKind.Export,
    );
    if (importOrExport === undefined) return;
    if (importOrExport.kind === ImpExpKind.Import) this.searchForImportedSymbol(importOrExport.symbol);
    else this.searchForImportsOfExport(referenceLocation, importOrExport.symbol, importOrExport.exportInfo!);
  }

  getReferencesAtExportSpecifier(
    referenceLocation: Node,
    referenceSymbol: Symbol,
    exportSpecifier: ExportSpecifier,
    search: Search,
    addReferencesHere: boolean,
  ): void {
    const exportDeclaration = exportSpecifier.parent!.parent as ExportDeclaration;
    const propertyName = exportSpecifier.propertyName;
    const name = exportSpecifier.name;
    const localSymbol = getLocalSymbolForExportSpecifier(this.c, referenceLocation, referenceSymbol, exportSpecifier);
    if (!searchIncludes(search, localSymbol)) return;
    const addRef = (): void => {
      if (addReferencesHere) this.addReference(referenceLocation, localSymbol);
    };
    if (propertyName === undefined) addRef();
    else if (referenceLocation === propertyName) {
      // At `foo` in `export { foo as bar } from "baz"`, `foo` comes from the import searches;
      // in `export { foo as bar }` it is a local.
      if (exportDeclaration.moduleSpecifier === undefined) addRef();
      if (addReferencesHere && !this.seenReExportRHS.has(name)) {
        this.seenReExportRHS.add(name);
        this.addReference(name, getSymbol(exportSpecifier)!);
      }
    } else if (!this.seenReExportRHS.has(referenceLocation)) {
      this.seenReExportRHS.add(referenceLocation);
      addRef();
    }
    const isDefaultExport = moduleExportNameIsDefault(referenceLocation) || moduleExportNameIsDefault(name);
    const exportSymbol = getSymbol(exportSpecifier)!;
    const exportInfo = getExportInfo(this.c, exportSymbol, isDefaultExport ? ExportKind.Default : ExportKind.Named);
    if (exportInfo !== undefined) this.searchForImportsOfExport(referenceLocation, exportSymbol, exportInfo);
    // At `export { x } from "foo"`, also search for `"foo".x`.
    if (
      search.comingFrom !== ImpExpKind.Export &&
      exportDeclaration.moduleSpecifier !== undefined &&
      propertyName === undefined
    ) {
      const imported = getExportSpecifierLocalTargetSymbol(this.c, exportSpecifier);
      if (imported !== undefined) this.searchForImportedSymbol(imported);
    }
  }

  /** Searches the files declaring an imported symbol, which may export it. */
  searchForImportedSymbol(symbol: Symbol): void {
    for (const declaration of getDeclarations(symbol)) {
      const exportingFile = getSourceFileOfNode(declaration);
      this.getReferencesInSourceFile(
        exportingFile,
        this.createSearch(declaration, symbol, ImpExpKind.Import, undefined, undefined),
        this.includesSourceFile(exportingFile),
      );
    }
  }

  searchForImportsOfExport(exportLocation: Node, exportSymbol: Symbol, exportInfo: ExportInfo): void {
    if (this.importTracker === undefined)
      this.importTracker = new ImportTracker(this.c, this.program, this.sourceFiles, this.sourceFileNames);
    const imports = this.importTracker.imports(exportSymbol, exportInfo, false);
    // `foo` of `import { foo as bar }` is a reference, without a search in its file.
    if (imports.singleReferences.length !== 0) {
      const addRef = this.referenceAdder(exportSymbol);
      for (const singleRef of imports.singleReferences) if (this.hasMatchingMeaning(singleRef)) addRef(singleRef);
    }
    // The references to each import in its file.
    for (const { importLocation, importSymbol } of imports.importSearches)
      this.getReferencesInSourceFile(
        getSourceFileOfNode(importLocation),
        this.createSearch(importLocation, importSymbol, ImpExpKind.Export, undefined, undefined),
        true,
      );
    if (imports.indirectUsers.length !== 0) {
      let indirectSearch: Search | undefined;
      switch (exportInfo.exportKind) {
        case ExportKind.Named:
          indirectSearch = this.createSearch(exportLocation, exportSymbol, ImpExpKind.Export, undefined, undefined);
          break;
        case ExportKind.Default:
          // Property accesses of `.default`.
          indirectSearch = this.createSearch(exportLocation, exportSymbol, ImpExpKind.Export, 'default', undefined);
          break;
      }
      if (indirectSearch !== undefined)
        for (const user of imports.indirectUsers) this.searchForName(user, indirectSearch);
    }
  }

  hasMatchingMeaning(referenceLocation: Node): boolean {
    return (getMeaningFromLocation(referenceLocation) & this.searchMeaning) !== 0;
  }

  getReferenceForShorthandProperty(referenceSymbol: Symbol, search: Search): void {
    if ((referenceSymbol.flags & SymbolFlags.Transient) !== 0 || referenceSymbol.valueDeclaration === undefined) return;
    const shorthandValueSymbol = getShorthandAssignmentValueSymbol(this.c, referenceSymbol.valueDeclaration);
    const name = getNameOfDeclaration(referenceSymbol.valueDeclaration);
    // A shorthand property's name is also a reference to the value it names.
    if (name !== undefined && shorthandValueSymbol !== undefined && searchIncludes(search, shorthandValueSymbol))
      this.addReference(name, shorthandValueSymbol);
  }

  populateSearchSymbolSet(symbol: Symbol, location: Node | undefined): Symbol[] {
    if (location === undefined) return [symbol];
    const result: Symbol[] = [];
    this.forEachRelatedSymbol(symbol, location, false, true, (sym, root, base) => {
      // Static and instance members of the same name are different.
      const b = base !== undefined && isStaticSymbol(symbol) !== isStaticSymbol(base) ? undefined : base;
      result.push(b ?? root ?? sym);
      return undefined;
    });
    return result;
  }

  getRelatedSymbol(search: Search, referenceSymbol: Symbol, referenceLocation: Node): Symbol | undefined {
    return this.forEachRelatedSymbol(referenceSymbol, referenceLocation, false, true, (sym, rootSymbol, baseSymbol) => {
      // Static and instance members of the same name are different.
      const base =
        baseSymbol !== undefined && isStaticSymbol(referenceSymbol) !== isStaticSymbol(baseSymbol)
          ? undefined
          : baseSymbol;
      const searchSymbol = base ?? rootSymbol ?? sym;
      if (searchIncludes(search, searchSymbol)) {
        // For a base type, use the derived type's symbol; for a union property, the union symbol.
        if (rootSymbol !== undefined && (sym.checkFlags & CheckFlags.Synthetic) === 0) return rootSymbol;
        return sym;
      }
      return undefined;
    });
  }

  forEachRelatedSymbol(
    symbol: Symbol,
    location: Node,
    isForRenamePopulateSearchSymbolSet: boolean,
    onlyIncludeBindingElementAtReferenceLocation: boolean,
    cbSymbol: (sym: Symbol, root: Symbol | undefined, base: Symbol | undefined) => Symbol | undefined,
  ): Symbol | undefined {
    const c = this.c;
    const fromRoot = (sym: Symbol): Symbol | undefined => {
      // A union property searches the properties of its types; an instantiated symbol its source.
      for (const rootSymbol of getRootSymbols(c, sym)) {
        const result = cbSymbol(sym, rootSymbol, undefined);
        if (result !== undefined) return result;
        // Properties of the same name in base classes and interfaces.
        const parent = rootSymbol.parent;
        if (parent !== undefined && (parent.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0) {
          const baseResult = getPropertySymbolsFromBaseTypes(c, parent, rootSymbol.name, (base) =>
            cbSymbol(sym, rootSymbol, base),
          );
          if (baseResult !== undefined) return baseResult;
        }
      }
      return undefined;
    };

    const containingObjectLiteralElement = getContainingObjectLiteralElement(location);
    if (containingObjectLiteralElement !== undefined) {
      // A shorthand property is both a property name and a value.
      const shorthandValueSymbol = getShorthandAssignmentValueSymbol(c, location.parent);
      if (shorthandValueSymbol !== undefined && isForRenamePopulateSearchSymbolSet)
        return cbSymbol(shorthandValueSymbol, undefined, undefined);
      // The property of the contextual type.
      const contextualType = getContextualType(c, containingObjectLiteralElement.parent!);
      if (contextualType !== undefined)
        for (const sym of getPropertySymbolsFromContextualType(
          c,
          containingObjectLiteralElement,
          contextualType,
          true,
        )) {
          const result = fromRoot(sym);
          if (result !== undefined) return result;
        }
      // A property name in a destructuring assignment.
      const propertySymbol = getPropertySymbolOfDestructuringAssignment(c, location);
      if (propertySymbol !== undefined) {
        const result = cbSymbol(propertySymbol, undefined, undefined);
        if (result !== undefined) return result;
      }
      if (shorthandValueSymbol !== undefined) {
        const result = cbSymbol(shorthandValueSymbol, undefined, undefined);
        if (result !== undefined) return result;
      }
    }

    const aliasedSymbol = getMergedAliasedSymbolOfNamespaceExportDeclaration(c, location, symbol);
    if (aliasedSymbol !== undefined) {
      // A UMD global merges with the module.
      const result = cbSymbol(aliasedSymbol, undefined, undefined);
      if (result !== undefined) return result;
    }

    const result = fromRoot(symbol);
    if (result !== undefined) return result;

    const valueDeclaration = symbol.valueDeclaration;
    const valueDeclarationParent = valueDeclaration?.parent;
    if (
      valueDeclaration !== undefined &&
      valueDeclarationParent !== undefined &&
      isParameterPropertyDeclaration(valueDeclaration, valueDeclarationParent)
    ) {
      const [parameter, property] = getSymbolsOfParameterPropertyDeclaration(c, valueDeclaration, symbol.name);
      return fromRoot((symbol.flags & SymbolFlags.FunctionScopedVariable) !== 0 ? property : parameter);
    }

    const exportSpecifier = getDeclarationOfKind(symbol, SyntaxKind.ExportSpecifier);
    if (
      exportSpecifier !== undefined &&
      (!isForRenamePopulateSearchSymbolSet || getPropertyName(exportSpecifier) === undefined)
    ) {
      const localSymbol = getExportSpecifierLocalTargetSymbol(c, exportSpecifier);
      if (localSymbol !== undefined) {
        const result = cbSymbol(localSymbol, undefined, undefined);
        if (result !== undefined) return result;
      }
    }

    // The symbol of a binding element is the local; the search may be for the property.
    let bindingElementPropertySymbol: Symbol | undefined;
    if (onlyIncludeBindingElementAtReferenceLocation) {
      if (!isObjectBindingElementWithoutPropertyName(location.parent!)) return undefined;
      bindingElementPropertySymbol = getPropertySymbolFromBindingElement(c, location.parent!);
    } else bindingElementPropertySymbol = getPropertySymbolOfObjectBindingPatternWithoutPropertyName(c, symbol);
    return bindingElementPropertySymbol === undefined ? undefined : fromRoot(bindingElementPropertySymbol);
  }

  /** Searches a file for a name, if it has the name at all. */
  searchForName(file: SourceFile, search: Search): void {
    if (getNameTable(file).has(search.text)) this.getReferencesInSourceFile(file, search, true);
  }
}

function isValidReferencePosition(node: Node, searchSymbolName: string): boolean {
  switch (node.kind) {
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.Identifier:
      return getText(node).length === searchSymbolName.length;
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.StringLiteral: {
      const parent = node.parent!;
      return (
        getText(node).length === searchSymbolName.length &&
        (isLiteralNameOfPropertyDeclarationOrIndexAccess(node) ||
          isNameOfModuleDeclaration(node) ||
          isExpressionOfExternalModuleImportEqualsDeclaration(node) ||
          (parent.kind === SyntaxKind.CallExpression &&
            isBindableObjectDefinePropertyCall(parent) &&
            getArguments(parent)!.nodes[1] === node) ||
          parent.kind === SyntaxKind.ImportSpecifier ||
          parent.kind === SyntaxKind.ExportSpecifier)
      );
    }
    case SyntaxKind.NumericLiteral:
      return isLiteralNameOfPropertyDeclarationOrIndexAccess(node) && getText(node).length === searchSymbolName.length;
    case SyntaxKind.DefaultKeyword:
      return 'default'.length === searchSymbolName.length;
  }
  return false;
}

function isMethodOrAccessor(node: Node): boolean {
  return (
    node.kind === SyntaxKind.MethodDeclaration ||
    node.kind === SyntaxKind.GetAccessor ||
    node.kind === SyntaxKind.SetAccessor
  );
}

function tryGetClassByExtendingIdentifier(node: Node): Node | undefined {
  const expression = climbPastPropertyAccess(node).parent!;
  if (expression.kind !== SyntaxKind.ExpressionWithTypeArguments) return undefined;
  const clause = expression.parent!;
  if (clause.kind !== SyntaxKind.HeritageClause || !isClassLike(clause.parent!)) return undefined;
  return clause instanceof HeritageClause && clause.token === SyntaxKind.ImplementsKeyword ? undefined : clause.parent;
}

function getClassConstructorSymbol(classSymbol: Symbol): Symbol | undefined {
  return classSymbol.members?.get(InternalSymbolName.Constructor);
}

function hasOwnConstructor(classDeclaration: Node): boolean {
  return getClassConstructorSymbol(getSymbol(classDeclaration)!) !== undefined;
}

function findOwnConstructorReferences(classSymbol: Symbol, file: SourceFile, addNode: (node: Node) => void): void {
  const constructorSymbol = getClassConstructorSymbol(classSymbol);
  if (constructorSymbol !== undefined)
    for (const declaration of getDeclarations(constructorSymbol))
      if (declaration.kind === SyntaxKind.Constructor) {
        const keyword = findChildTokenOfKind(declaration, SyntaxKind.ConstructorKeyword, file);
        if (keyword !== undefined) addNode(keyword);
      }
  for (const member of classSymbol.exports?.values() ?? []) {
    const declaration = member.valueDeclaration;
    if (declaration === undefined || declaration.kind !== SyntaxKind.MethodDeclaration) continue;
    const body = getBody(declaration);
    if (body !== undefined)
      forEachDescendantOfKind(body, SyntaxKind.ThisKeyword, (thisKeyword) => {
        if (isNewExpressionTarget(thisKeyword)) addNode(thisKeyword);
      });
  }
}

function findSuperConstructorAccesses(classDeclaration: Node, addNode: (node: Node) => void): void {
  const constructorSymbol = getClassConstructorSymbol(getSymbol(classDeclaration)!);
  if (constructorSymbol === undefined) return;
  for (const declaration of getDeclarations(constructorSymbol)) {
    if (declaration.kind !== SyntaxKind.Constructor) continue;
    const body = getBody(declaration);
    if (body !== undefined)
      forEachDescendantOfKind(body, SyntaxKind.SuperKeyword, (node) => {
        if (isCallExpressionTarget(node)) addNode(node);
      });
  }
}

class DescendantVisitor extends NodeVisitor {
  constructor(
    readonly kind: SyntaxKind,
    readonly action: (node: Node) => void,
  ) {
    super();
  }

  visitNode(node: Node): boolean {
    if (node.kind === this.kind) this.action(node);
    node.forEachChild(this);
    return false;
  }
}

function forEachDescendantOfKind(node: Node, kind: SyntaxKind, action: (node: Node) => void): void {
  node.forEachChild(new DescendantVisitor(kind, action));
}

class ThisVisitor extends NodeVisitor {
  constructor(readonly action: (node: Node) => void) {
    super();
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.ThisKeyword) this.action(node);
    else if (!isFunctionLike(node) && !isClassLike(node)) node.forEachChild(this);
    return false;
  }
}

function forEachThisInBody(body: Node, action: (node: Node) => void): void {
  new ThisVisitor(action).visitNode(body);
}

// ---- Triple-slash references and module specifiers

interface ReferenceInfo {
  file: SourceFile | undefined;
}

function getReferenceAtPosition(file: SourceFile, position: number, program: Program): ReferenceInfo | undefined {
  const inReference = (r: { pos: number; end: number }): boolean => r.pos <= position && position <= r.end;
  const referencePath = file.referencedFiles.find(inReference);
  if (referencePath !== undefined) {
    const target = getSourceFileFromReference(program, file, referencePath.fileName);
    return target === undefined ? undefined : { file: target };
  }
  if (file.typeReferenceDirectives.find(inReference) !== undefined) return undefined;
  if (file.libReferenceDirectives.find(inReference) !== undefined) return undefined;
  if (file.imports.length === 0 && file.moduleAugmentations.length === 0) return undefined;
  const node = getTouchingToken(file, position);
  if (node === undefined || !isModuleSpecifierLike(node) || !isExternalModuleNameRelative(getText(node)))
    return undefined;
  const resolution = program.getResolvedModuleFromModuleSpecifier(file, node);
  if (resolution === undefined) return undefined;
  const fileName =
    resolution.resolvedFileName !== ''
      ? resolution.resolvedFileName
      : resolvePath(getDirectoryPath(file.fileName), getText(node));
  return { file: program.getSourceFile(fileName) };
}
