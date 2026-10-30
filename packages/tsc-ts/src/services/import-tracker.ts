// Finds the imports and re-exports of an exported symbol, for find-all-references.
import {
  BinaryExpression,
  CallExpression,
  ExportAssignment,
  ExportDeclaration,
  ExternalModuleReference,
  getBody,
  getElements,
  getImportClause,
  getModuleSpecifier,
  getName,
  getPropertyName,
  getStatements,
  getSymbol,
  getText,
  ImportClause,
  ImportEqualsDeclaration,
  ImportTypeNode,
  LiteralTypeNode,
  ModifierFlags,
  type Node,
  PropertyAccessExpression,
  type SourceFile,
} from '../compiler/ast.js';
import { isImportCall, isInJSFile } from '../compiler/ast-utilities.js';
import {
  getAssignmentDeclarationKind,
  getNameOfDeclaration,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isImplicitlyExportedJSDocDeclaration,
  isModuleExportsAccessExpression,
  isVariableDeclarationInitializedToRequire,
  JSDeclarationKind,
  symbolName as symbolDisplayName,
} from '../compiler/binder-utilities.js';
import { type Checker } from '../compiler/checker.js';
import {
  getExportSpecifierLocalTargetSymbol,
  getImmediateAliasedSymbol,
  getSymbolAtLocation,
} from '../compiler/checker-services.js';
import { getFirstIdentifier, getMergedSymbol } from '../compiler/checker-symbols.js';
import { type Program } from '../compiler/program.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { isExternalModuleSymbol } from './checker-queries.js';
import {
  findAncestor,
  getPropertySymbolOfObjectBindingPatternWithoutPropertyName,
  isAmbientModuleDeclaration,
  isExternalModuleAugmentation,
  isExternalModuleImportEquals,
  isSourceFileWithGlobalExports,
  walkUpBindingElementsAndPatterns,
} from './utilities.js';
import { getDirectoryPath, resolvePath } from '../compiler/path.js';
import { getDeclarations, InternalSymbolName, type Symbol, SymbolFlags } from '../compiler/symbol.js';

export const enum ImpExpKind {
  Unknown,
  Import,
  Export,
}

export const enum ExportKind {
  Named,
  Default,
  ExportEquals,
  UMD,
  Module,
}

export interface ExportInfo {
  exportingModuleSymbol: Symbol;
  exportKind: ExportKind;
}

export interface ImportExportSymbol {
  kind: ImpExpKind;
  symbol: Symbol;
  exportInfo: ExportInfo | undefined;
}

export interface ImportSearch {
  importLocation: Node;
  importSymbol: Symbol;
}

export interface ImportsResult {
  importSearches: ImportSearch[];
  singleReferences: Node[];
  indirectUsers: SourceFile[];
}

export const enum ModuleReferenceKind {
  Import,
  Reference,
  Implicit,
}

export interface ModuleReference {
  kind: ModuleReferenceKind;
  /** The module specifier, for imports and implicit imports. */
  literal: Node | undefined;
  referencingFile: SourceFile | undefined;
}

export class ImportTracker {
  private readonly allDirectImports: Map<Symbol, Node[]>;

  constructor(
    readonly c: Checker,
    readonly program: Program,
    readonly sourceFiles: readonly SourceFile[],
    readonly sourceFileNames: Set<string>,
  ) {
    this.allDirectImports = getDirectImportsMap(c, program, sourceFiles);
  }

  imports(exportSymbol: Symbol, exportInfo: ExportInfo, isForRename: boolean): ImportsResult {
    const [directImports, indirectUsers] = this.getImportersForExport(exportInfo);
    const [importSearches, singleReferences] = getSearchesFromDirectImports(
      this.c,
      directImports,
      exportSymbol,
      exportInfo.exportKind,
      isForRename,
    );
    return { importSearches, singleReferences, indirectUsers };
  }

  private getImportersForExport(exportInfo: ExportInfo): [Node[], SourceFile[]] {
    const c = this.c;
    const directImports: Node[] = [];
    const indirectUserDeclarations: Node[] = [];
    const seenDirectImports = new Set<Node>();
    const seenIndirectUsers = new Set<Node>();
    const isAvailableThroughGlobal = isSourceFileWithGlobalExports(exportInfo.exportingModuleSymbol.valueDeclaration);
    const getDirectImports = (moduleSymbol: Symbol): Node[] => this.allDirectImports.get(moduleSymbol) ?? [];

    const addIndirectUser = (sourceFileLike: Node, addTransitiveDependencies: boolean): void => {
      // With global exports, every file is an indirect user anyway.
      if (isAvailableThroughGlobal || seenIndirectUsers.has(sourceFileLike)) return;
      seenIndirectUsers.add(sourceFileLike);
      indirectUserDeclarations.push(sourceFileLike);
      if (!addTransitiveDependencies) return;
      const symbol = getSymbol(sourceFileLike);
      if (symbol === undefined) return;
      const moduleSymbol = getMergedSymbol(c, symbol);
      for (const directImport of getDirectImports(moduleSymbol))
        if (directImport.kind !== SyntaxKind.ImportType)
          addIndirectUser(getSourceFileLikeForImportDeclaration(directImport), true);
    };

    const isExported = (nodeIn: Node, stopAtAmbientModule: boolean): boolean => {
      for (
        let node: Node | undefined = nodeIn;
        node !== undefined && !(stopAtAmbientModule && isAmbientModuleDeclaration(node));
        node = node.parent
      )
        if (hasSyntacticModifier(node, ModifierFlags.Export)) return true;
      return false;
    };

    const handleImportCall = (importCall: Node): void => {
      const top = findAncestor(importCall, isAmbientModuleDeclaration) ?? (getSourceFileOfNode(importCall) as Node);
      addIndirectUser(top, isExported(importCall, true));
    };

    const handleNamespaceImport = (
      importDeclaration: Node,
      name: Node,
      isReExport: boolean,
      alreadyAddedDirect: boolean,
    ): void => {
      if (exportInfo.exportKind === ExportKind.ExportEquals) {
        // A direct import, not import-as-namespace.
        if (!alreadyAddedDirect) directImports.push(importDeclaration);
      } else if (!isAvailableThroughGlobal) {
        const sourceFileLike = getSourceFileLikeForImportDeclaration(importDeclaration);
        addIndirectUser(sourceFileLike, isReExport || findNamespaceReExports(c, sourceFileLike, name));
      }
    };

    const handleDirectImports = (exportingModuleSymbol: Symbol): void => {
      for (const direct of getDirectImports(exportingModuleSymbol)) {
        if (seenDirectImports.has(direct)) continue;
        seenDirectImports.add(direct);
        switch (direct.kind) {
          case SyntaxKind.CallExpression:
            if (isImportCall(direct)) handleImportCall(direct);
            else if (!isAvailableThroughGlobal) {
              const parent = direct.parent!;
              if (exportInfo.exportKind === ExportKind.ExportEquals && parent.kind === SyntaxKind.VariableDeclaration) {
                const name = getName(parent);
                if (name !== undefined && name.kind === SyntaxKind.Identifier) directImports.push(name);
              }
            }
            break;
          case SyntaxKind.Identifier:
            break;
          case SyntaxKind.ImportEqualsDeclaration:
            handleNamespaceImport(direct, getName(direct)!, hasSyntacticModifier(direct, ModifierFlags.Export), false);
            break;
          case SyntaxKind.ImportDeclaration:
          case SyntaxKind.JSImportDeclaration:
          case SyntaxKind.JSDocImportTag: {
            directImports.push(direct);
            const importClause = getImportClause(direct);
            if (importClause instanceof ImportClause) {
              const namedBindings = importClause.namedBindings;
              if (namedBindings !== undefined && namedBindings.kind === SyntaxKind.NamespaceImport) {
                handleNamespaceImport(direct, getName(namedBindings)!, false, true);
                break;
              }
              if (!isAvailableThroughGlobal && importClause.name !== undefined)
                addIndirectUser(getSourceFileLikeForImportDeclaration(direct), false);
            }
            break;
          }
          case SyntaxKind.ExportDeclaration: {
            const exportClause = (direct as ExportDeclaration).exportClause;
            // `export * from "foo"`: imports of this module may import the export too.
            if (exportClause === undefined) handleDirectImports(getContainingModuleSymbol(c, direct));
            else if (exportClause.kind === SyntaxKind.NamespaceExport)
              addIndirectUser(getSourceFileLikeForImportDeclaration(direct), true);
            else directImports.push(direct);
            break;
          }
          case SyntaxKind.ImportType: {
            const importType = direct as ImportTypeNode;
            if (
              !isAvailableThroughGlobal &&
              importType.isTypeOf &&
              importType.qualifier === undefined &&
              isExported(direct, false)
            )
              addIndirectUser(getSourceFileOfNode(direct) as Node, true);
            directImports.push(direct);
            break;
          }
          default:
            throw new Error('Unexpected import kind.');
        }
      }
    };

    const getIndirectUsers = (): SourceFile[] => {
      // With `export as namespace`, anything could use it.
      if (isAvailableThroughGlobal) return this.sourceFiles.slice();
      // Module augmentations may use the module's exports without importing it.
      for (const declaration of getDeclarations(exportInfo.exportingModuleSymbol))
        if (
          isExternalModuleAugmentation(declaration) &&
          this.sourceFileNames.has(getSourceFileOfNode(declaration).fileName)
        )
          addIndirectUser(declaration, false);
      return indirectUserDeclarations.map(getSourceFileOfNode);
    };

    handleDirectImports(exportInfo.exportingModuleSymbol);
    return [directImports, getIndirectUsers()];
  }
}

/** Import statements by the module they import. */
function getDirectImportsMap(c: Checker, program: Program, sourceFiles: readonly SourceFile[]): Map<Symbol, Node[]> {
  const result = new Map<Symbol, Node[]>();
  for (const file of sourceFiles)
    forEachImport(program, file, (importDeclaration, moduleSpecifier) => {
      const moduleSymbol = getSymbolAtLocation(c, moduleSpecifier);
      if (moduleSymbol === undefined) return;
      let imports = result.get(moduleSymbol);
      if (imports === undefined) {
        imports = [];
        result.set(moduleSymbol, imports);
      }
      imports.push(importDeclaration);
    });
  return result;
}

/** Calls `action` for each import, re-export or `require` of a file, with its module specifier. */
export function forEachImport(
  program: Program,
  file: SourceFile,
  action: (importStatement: Node, imported: Node) => void,
): void {
  const implicitImports: Node[] = [];
  const jsxSpecifier = program.jsxRuntimeImportSpecifier(file.path);
  if (jsxSpecifier !== undefined) implicitImports.push(jsxSpecifier);
  const helpersSpecifier = program.importHelpersImportSpecifier(file.path);
  if (helpersSpecifier !== undefined) implicitImports.push(helpersSpecifier);
  if (file.externalModuleIndicator !== undefined || file.imports.length + implicitImports.length !== 0) {
    for (const specifier of file.imports) action(importFromModuleSpecifier(specifier), specifier);
    for (const specifier of implicitImports) action(importFromModuleSpecifier(specifier), specifier);
    return;
  }
  forEachPossibleImportOrExportStatement(file, (statement) => {
    switch (statement.kind) {
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration: {
        const specifier = getModuleSpecifier(statement);
        if (specifier !== undefined && specifier.kind === SyntaxKind.StringLiteral) action(statement, specifier);
        break;
      }
      case SyntaxKind.ImportEqualsDeclaration:
        if (isExternalModuleImportEquals(statement))
          action(
            statement,
            ((statement as ImportEqualsDeclaration).moduleReference as ExternalModuleReference).expression,
          );
        break;
    }
    return false;
  });
}

/** The import, export, `require` call or import type a module specifier belongs to. */
function importFromModuleSpecifier(node: Node): Node {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.JSDocImportTag:
      return parent;
    case SyntaxKind.ExternalModuleReference:
      return parent.parent!;
    case SyntaxKind.CallExpression:
      return parent;
    case SyntaxKind.LiteralType:
      return parent.parent!;
  }
  // A synthesized implicit import, or another node a specifier was attached to.
  return parent;
}

function forEachPossibleImportOrExportStatement(sourceFileLike: Node, action: (statement: Node) => boolean): boolean {
  for (const statement of getStatementsOfSourceFileLike(sourceFileLike))
    if (
      action(statement) ||
      (isAmbientModuleDeclaration(statement) && forEachPossibleImportOrExportStatement(statement, action))
    )
      return true;
  return false;
}

function getStatementsOfSourceFileLike(node: Node): readonly Node[] {
  if (node.kind === SyntaxKind.SourceFile) return getStatements(node)!.nodes;
  const body = getBody(node);
  return body === undefined ? [] : (getStatements(body)?.nodes ?? []);
}

function getSourceFileLikeForImportDeclaration(node: Node): Node {
  if (node instanceof CallExpression || node.kind === SyntaxKind.JSDocImportTag) return getSourceFileOfNode(node);
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.SourceFile) return parent;
  return parent.parent!;
}

function getContainingModuleSymbol(c: Checker, importer: Node): Symbol {
  return getMergedSymbol(c, getSymbol(getSourceFileLikeForImportDeclaration(importer))!);
}

/** Whether the namespace import `name` is re-exported from its module. */
function findNamespaceReExports(c: Checker, sourceFileLike: Node, name: Node): boolean {
  const namespaceImportSymbol = getSymbolAtLocation(c, name);
  return forEachPossibleImportOrExportStatement(sourceFileLike, (statement) => {
    if (!(statement instanceof ExportDeclaration)) return false;
    const exportClause = statement.exportClause;
    return (
      statement.moduleSpecifier === undefined &&
      exportClause !== undefined &&
      exportClause.kind === SyntaxKind.NamedExports &&
      getElements(exportClause)!.nodes.some(
        (element) => getExportSpecifierLocalTargetSymbol(c, element) === namespaceImportSymbol,
      )
    );
  });
}

function getSearchesFromDirectImports(
  c: Checker,
  directImports: Node[],
  exportSymbol: Symbol,
  exportKind: ExportKind,
  isForRename: boolean,
): [ImportSearch[], Node[]] {
  const importSearches: ImportSearch[] = [];
  const singleReferences: Node[] = [];
  const addSearch = (location: Node, symbol: Symbol | undefined): void => {
    // tsgo adds the search even without a symbol; such searches find nothing.
    importSearches.push({ importLocation: location, importSymbol: symbol! });
  };
  // `default` also matches `export =`, which allowSyntheticDefaultImports may import as a default.
  const isNameMatch = (name: string): boolean =>
    name === exportSymbol.name || (exportKind !== ExportKind.Named && name === InternalSymbolName.Default);

  // `import x = require("./x")` or `import * as x from "./x"` import an `export =` directly.
  const handleNamespaceImportLike = (importName: Node): void => {
    if (exportKind === ExportKind.ExportEquals && (!isForRename || isNameMatch(textOf(importName))))
      addSearch(importName, getSymbolAtLocation(c, importName));
  };

  const searchForNamedImport = (namedBindings: Node | undefined): void => {
    if (namedBindings === undefined) return;
    for (const element of getElements(namedBindings)!.nodes) {
      const name = getName(element)!;
      const propertyName = getPropertyName(element);
      if (!isNameMatch(textOf(propertyName ?? name))) continue;
      if (propertyName !== undefined) {
        // `foo` in `import { foo as bar }` isn't a local of the file.
        singleReferences.push(propertyName);
        if (!isForRename || textOf(name) === exportSymbol.name) addSearch(name, getSymbolAtLocation(c, name));
      } else {
        const localSymbol =
          element.kind === SyntaxKind.ExportSpecifier && getPropertyName(element) !== undefined
            ? getExportSpecifierLocalTargetSymbol(c, element)
            : getSymbolAtLocation(c, name);
        addSearch(name, localSymbol);
      }
    }
  };

  const handleImport = (declaration: Node): void => {
    if (declaration instanceof ImportEqualsDeclaration) {
      if (isExternalModuleImportEquals(declaration)) handleNamespaceImportLike(declaration.name);
      return;
    }
    if (declaration.kind === SyntaxKind.Identifier) {
      handleNamespaceImportLike(declaration);
      return;
    }
    if (declaration instanceof ImportTypeNode) {
      const qualifier = declaration.qualifier;
      if (qualifier !== undefined) {
        const firstIdentifier = getFirstIdentifier(qualifier);
        if (firstIdentifier.text === symbolDisplayName(exportSymbol)) singleReferences.push(firstIdentifier);
      } else if (exportKind === ExportKind.ExportEquals) {
        const argument = declaration.argument;
        if (argument instanceof LiteralTypeNode) singleReferences.push(argument.literal);
      }
      return;
    }
    const moduleSpecifier = getModuleSpecifier(declaration);
    if (moduleSpecifier === undefined || moduleSpecifier.kind !== SyntaxKind.StringLiteral) return;
    if (declaration instanceof ExportDeclaration) {
      const exportClause = declaration.exportClause;
      if (exportClause !== undefined && exportClause.kind === SyntaxKind.NamedExports)
        searchForNamedImport(exportClause);
      return;
    }
    const importClause = getImportClause(declaration);
    if (!(importClause instanceof ImportClause)) return;
    const namedBindings = importClause.namedBindings;
    if (namedBindings !== undefined) {
      if (namedBindings.kind === SyntaxKind.NamespaceImport) handleNamespaceImportLike(getName(namedBindings)!);
      else if (
        namedBindings.kind === SyntaxKind.NamedImports &&
        (exportKind === ExportKind.Named || exportKind === ExportKind.Default)
      )
        searchForNamedImport(namedBindings);
    }
    // A default import may import a default export or an `export =`.
    const name = importClause.name;
    if (
      name !== undefined &&
      (exportKind === ExportKind.Default || exportKind === ExportKind.ExportEquals) &&
      (!isForRename || name.text === symbolNameNoDefault(exportSymbol))
    )
      addSearch(name, getSymbolAtLocation(c, name));
  };

  for (const declaration of directImports) handleImport(declaration);
  return [importSearches, singleReferences];
}

function textOf(node: Node): string {
  return getText(node);
}

/** Whether a reference is an import or export of its symbol, and of which. */
export function getImportOrExportSymbol(
  c: Checker,
  node: Node,
  symbol: Symbol,
  comingFromExport: boolean,
): ImportExportSymbol | undefined {
  const exportInfoFor = (symbol: Symbol, kind: ExportKind): ImportExportSymbol | undefined => {
    const exportInfo = getExportInfo(c, symbol, kind);
    return exportInfo === undefined ? undefined : { kind: ImpExpKind.Export, symbol, exportInfo };
  };

  const getExport = (): ImportExportSymbol | undefined => {
    const exportAssignmentExport = (ex: ExportAssignment): ImportExportSymbol | undefined => {
      // The `export =` symbol's parent is the module it exports from.
      const parent = getSymbol(ex)?.parent;
      if (parent === undefined) return undefined;
      const exportKind = ex.isExportEquals ? ExportKind.ExportEquals : ExportKind.Default;
      return { kind: ImpExpKind.Export, symbol, exportInfo: { exportingModuleSymbol: parent, exportKind } };
    };
    const exportKindForDeclaration = (node: Node): ExportKind =>
      hasSyntacticModifier(node, ModifierFlags.Default) ? ExportKind.Default : ExportKind.Named;
    const specialPropertyExport = (node: Node, useLhsSymbol: boolean): ImportExportSymbol | undefined => {
      let kind: ExportKind;
      switch (getAssignmentDeclarationKind(node)) {
        case JSDeclarationKind.ExportsProperty:
          kind = ExportKind.Named;
          break;
        case JSDeclarationKind.ModuleExports:
          kind = ExportKind.ExportEquals;
          break;
        default:
          return undefined;
      }
      const sym = useLhsSymbol ? getSymbol(node) : symbol;
      return sym === undefined ? undefined : exportInfoFor(sym, kind);
    };

    const parent = node.parent!;
    const grandparent = parent.parent;
    if (symbol.exportSymbol !== undefined) {
      if (parent instanceof PropertyAccessExpression) {
        // A use of a JS module export is flagged as an export too; only its declaration exports it.
        if (grandparent instanceof BinaryExpression && getDeclarations(symbol).includes(parent))
          return specialPropertyExport(grandparent, false);
        return undefined;
      }
      return exportInfoFor(symbol.exportSymbol, exportKindForDeclaration(parent));
    }
    const exportNode = getExportNode(parent, node);
    if (
      exportNode !== undefined &&
      (hasSyntacticModifier(exportNode, ModifierFlags.Export) || isImplicitlyExportedJSDocDeclaration(exportNode))
    ) {
      if (exportNode instanceof ImportEqualsDeclaration && exportNode.moduleReference === node) {
        // At `Y` in `export import X = Y`: the exported symbol is the left-hand side.
        if (comingFromExport) return undefined;
        const lhsSymbol = getSymbolAtLocation(c, exportNode.name);
        return lhsSymbol === undefined
          ? undefined
          : { kind: ImpExpKind.Import, symbol: lhsSymbol, exportInfo: undefined };
      }
      return exportInfoFor(symbol, exportKindForDeclaration(exportNode));
    }
    if (parent.kind === SyntaxKind.NamespaceExport) return exportInfoFor(symbol, ExportKind.Named);
    if (parent instanceof ExportAssignment) return exportAssignmentExport(parent);
    if (grandparent !== undefined && grandparent.kind === SyntaxKind.ExportAssignment)
      return exportAssignmentExport(grandparent as ExportAssignment);
    if (parent instanceof BinaryExpression) return specialPropertyExport(parent, true);
    if (grandparent instanceof BinaryExpression) return specialPropertyExport(grandparent, true);
    if (parent.kind === SyntaxKind.JSDocTypedefTag || parent.kind === SyntaxKind.JSDocCallbackTag)
      return exportInfoFor(symbol, ExportKind.Named);
    return undefined;
  };

  const getImport = (): ImportExportSymbol | undefined => {
    if (!isNodeImport(node)) return undefined;
    // Destructuring a `require` imports, though the binding is a local variable.
    let importedSymbol =
      (symbol.flags & SymbolFlags.Alias) !== 0
        ? getImmediateAliasedSymbol(c, symbol)
        : getPropertySymbolOfObjectBindingPatternWithoutPropertyName(c, symbol);
    if (importedSymbol === undefined) return undefined;
    // Search the local symbol in the exporting module, not the export.
    importedSymbol = skipExportSpecifierSymbol(c, importedSymbol);
    if (importedSymbol === undefined) return undefined;
    if (importedSymbol.name === InternalSymbolName.ExportEquals) {
      importedSymbol = getExportEqualsLocalSymbol(c, importedSymbol);
      if (importedSymbol === undefined) return undefined;
    }
    // An import under another name than the export stops the search, unless the export is anonymous.
    const importedName = symbolNameNoDefault(importedSymbol);
    if (importedName === '' || importedName === InternalSymbolName.Default || importedName === symbol.name)
      return { kind: ImpExpKind.Import, symbol: importedSymbol, exportInfo: undefined };
    return undefined;
  };

  const result = getExport();
  return result === undefined && !comingFromExport ? getImport() : result;
}

export function getExportInfo(c: Checker, exportSymbol: Symbol, exportKind: ExportKind): ExportInfo | undefined {
  // An `export` that isn't at the top level has no parent.
  if (exportSymbol.parent === undefined) return undefined;
  const exportingModuleSymbol = getMergedSymbol(c, exportSymbol.parent);
  // An `export` in a namespace relies on the global search.
  return isExternalModuleSymbol(exportingModuleSymbol) ? { exportingModuleSymbol, exportKind } : undefined;
}

/** The statement exporting a declaration: the variable statement of a variable, or the declaration itself. */
function getExportNode(parent: Node, node: Node): Node | undefined {
  let declaration: Node | undefined;
  if (parent.kind === SyntaxKind.VariableDeclaration) declaration = parent;
  else if (parent.kind === SyntaxKind.BindingElement) declaration = walkUpBindingElementsAndPatterns(parent);
  if (declaration !== undefined) {
    if (
      getName(parent) === node &&
      declaration.parent!.kind !== SyntaxKind.CatchClause &&
      declaration.parent!.parent!.kind === SyntaxKind.VariableStatement
    )
      return declaration.parent!.parent;
    return undefined;
  }
  return parent;
}

function isNodeImport(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.ImportEqualsDeclaration:
      return getName(parent) === node && isExternalModuleImportEquals(parent);
    case SyntaxKind.ImportSpecifier:
      // At `bar` in `{ foo as bar }`, only local uses of `bar` are searched.
      return getPropertyName(parent) === undefined;
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceImport:
      return true;
    case SyntaxKind.BindingElement:
      return isInJSFile(node) && isVariableDeclarationInitializedToBareOrAccessedRequire(parent.parent!.parent!);
  }
  return false;
}

function isVariableDeclarationInitializedToBareOrAccessedRequire(node: Node): boolean {
  return isVariableDeclarationInitializedToRequire(node);
}

/** At an export specifier, the symbol it exports. */
function skipExportSpecifierSymbol(c: Checker, symbol: Symbol): Symbol | undefined {
  // `export { foo } from "./bar"` creates no alias, but `export { foo }` does.
  for (const declaration of getDeclarations(symbol)) {
    if (
      declaration.kind === SyntaxKind.ExportSpecifier &&
      getPropertyName(declaration) === undefined &&
      getModuleSpecifier(declaration.parent!.parent!) === undefined
    )
      return getExportSpecifierLocalTargetSymbol(c, declaration) ?? symbol;
    if (
      declaration instanceof PropertyAccessExpression &&
      isModuleExportsAccessExpression(declaration.expression) &&
      declaration.name.kind !== SyntaxKind.PrivateIdentifier
    )
      // `module.exports.propName = expr`
      return getSymbolAtLocation(c, declaration);
    if (
      declaration.kind === SyntaxKind.ShorthandPropertyAssignment &&
      declaration.parent!.parent instanceof BinaryExpression &&
      getAssignmentDeclarationKind(declaration.parent!.parent) === JSDeclarationKind.ModuleExports
    )
      return getExportSpecifierLocalTargetSymbol(c, getName(declaration)!);
  }
  return symbol;
}

function getExportEqualsLocalSymbol(c: Checker, importedSymbol: Symbol): Symbol | undefined {
  if ((importedSymbol.flags & SymbolFlags.Alias) !== 0) return getImmediateAliasedSymbol(c, importedSymbol);
  const declaration = importedSymbol.valueDeclaration!;
  if (declaration instanceof ExportAssignment) return getSymbol(declaration.expression);
  if (declaration instanceof BinaryExpression) return getSymbol(declaration.right);
  if (declaration.kind === SyntaxKind.SourceFile) return getSymbol(declaration);
  return undefined;
}

export function symbolNameNoDefault(symbol: Symbol): string {
  if (symbol.name !== InternalSymbolName.Default) return symbol.name;
  for (const declaration of getDeclarations(symbol)) {
    const name = getNameOfDeclaration(declaration);
    if (name !== undefined && name.kind === SyntaxKind.Identifier) return textOf(name);
  }
  return '';
}

/** The imports, references and implicit imports of a module in the given files. */
export function findModuleReferences(
  c: Checker,
  program: Program,
  sourceFiles: readonly SourceFile[],
  searchModuleSymbol: Symbol,
): ModuleReference[] {
  const refs: ModuleReference[] = [];
  for (const referencingFile of sourceFiles) {
    const searchSourceFile = searchModuleSymbol.valueDeclaration;
    if (searchSourceFile !== undefined && searchSourceFile.kind === SyntaxKind.SourceFile) {
      for (const ref of referencingFile.referencedFiles)
        if (getSourceFileFromReference(program, referencingFile, ref.fileName) === (searchSourceFile as SourceFile))
          refs.push({ kind: ModuleReferenceKind.Reference, literal: undefined, referencingFile });
    }
    forEachImport(program, referencingFile, (importDeclaration, moduleSpecifier) => {
      if (getSymbolAtLocation(c, moduleSpecifier) !== searchModuleSymbol) return;
      if (importDeclaration.pos < 0)
        refs.push({ kind: ModuleReferenceKind.Implicit, literal: moduleSpecifier, referencingFile });
      else refs.push({ kind: ModuleReferenceKind.Import, literal: moduleSpecifier, referencingFile: undefined });
    });
  }
  return refs;
}

/** The file a `/// <reference path>` names: as written, or with a supported extension added. */
export function getSourceFileFromReference(program: Program, origin: SourceFile, path: string): SourceFile | undefined {
  const fileName = resolvePath(getDirectoryPath(origin.fileName), path);
  const file = program.getSourceFile(fileName);
  if (file !== undefined) return file;
  for (const extension of ['.ts', '.tsx', '.d.ts', '.js', '.jsx']) {
    const withExtension = program.getSourceFile(fileName + extension);
    if (withExtension !== undefined) return withExtension;
  }
  return undefined;
}
