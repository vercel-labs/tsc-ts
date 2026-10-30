// Imports for exported symbols, collected and written as text edits, as tsgo's ls/autoimport ImportAdder writes them
// for the API's getImportAdderEdits: each symbol gets its best fix, fixes for one module share an import, and new
// imports go where the file's sort order puts them.
import {
  BindingElement,
  BindingPattern,
  CallExpression,
  ExternalModuleReference,
  type Identifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  NamedImports,
  NamespaceImport,
  type Node,
  NodeFlags,
  NodeList,
  type SourceFile,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
} from '../compiler/ast.js';
import { findChildOfKind, getStartOfNode } from '../compiler/astnav.js';
import { getSourceFileOfNode, isVariableDeclarationInitializedToRequire } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { getMergedSymbol } from '../compiler/checker-symbols.js';
import { Resolver } from '../compiler/module-resolution.js';
import { NewLineKind } from '../compiler/options.js';
import type { Program } from '../compiler/program.js';
import { getDeclarations, InternalSymbolName, type Symbol } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { TokenFlags } from '../compiler/types.js';
import {
  type Export,
  ExportExtractor,
  fileModuleId,
  tryGetModuleIdAndFileNameOfModuleSymbol,
} from './auto-import-exports.js';
import {
  AddAsTypeOnly,
  type AutoImportFix,
  AutoImportFixKind,
  type AutoImportView,
  ImportKind,
} from './auto-import-view.js';
import { skipAlias, tryGetMemberInModuleExportsAndProperties } from './completion-checker.js';
import { getQuotePreference, QuotePreference } from './completion-utilities.js';
import { tryGetImportFromModuleSpecifier } from './completions.js';
import {
  binarySearchInsertionIndex,
  compareImportsOrRequireStatements,
  detectModuleSpecifierOrder,
  getNamedImportSpecifierComparer,
  isTypeOnlyImportClause,
} from './organize-imports.js';
import { ChangeTracker, LeadingTriviaOption, NodeOptions, type TextEdit } from './text-changes.js';

class NewImportBinding {
  constructor(
    readonly kind: ImportKind,
    readonly name: string,
    readonly addAsTypeOnly: AddAsTypeOnly,
    readonly propertyName: string,
  ) {}
}

// What is added to one existing import clause or `require` binding pattern.
class AddToExisting {
  defaultImport: NewImportBinding | undefined = undefined;
  readonly namedImports = new Map<string, NewImportBinding>();
  constructor(readonly clauseOrPattern: Node) {}
}

// The new import of one module specifier, top-level type-only or not.
class NewImports {
  defaultImport: NewImportBinding | undefined = undefined;
  readonly namedImports = new Map<string, NewImportBinding>();
  namespaceLikeImport: NewImportBinding | undefined = undefined;
  constructor(readonly useRequire: boolean) {}
}

// `NotAllowed` over `Required` over `Allowed`.
function reduceAddAsTypeOnly(previous: AddAsTypeOnly | undefined, next: AddAsTypeOnly): AddAsTypeOnly {
  return previous === undefined || next > previous ? next : previous;
}

function needsTypeOnly(addAsTypeOnly: AddAsTypeOnly): boolean {
  return addAsTypeOnly === AddAsTypeOnly.Required;
}

// Without the preference for type-only auto-imports, only what must be type-only is.
function shouldUseTypeOnly(addAsTypeOnly: AddAsTypeOnly): boolean {
  return needsTypeOnly(addAsTypeOnly);
}

/** Collects the imports of exported symbols into a file and writes them as text edits. */
export class ImportAdder {
  private readonly addToExisting = new Map<Node, AddToExisting>();
  private readonly newImports = new Map<string, NewImports>();

  constructor(
    private readonly view: AutoImportView,
    private readonly program: Program,
    private readonly checker: Checker,
    private readonly file: SourceFile,
  ) {}

  hasFixes(): boolean {
    return this.addToExisting.size > 0 || this.newImports.size > 0;
  }

  /** Adds an import of `exportedSymbol`, if any export of it is in reach, with the fix that ranks best. */
  addImportFromExportedSymbol(exportedSymbol: Symbol, isValidTypeOnlyUseSite: boolean): void {
    const symbol = getMergedSymbol(this.checker, skipAlias(this.checker, exportedSymbol));
    const exported = symbolToExport(symbol, this.checker, this.program);
    if (exported === undefined) return;
    const exports = this.view.searchByExportKey(exported.exportKey());
    if (exports.length === 0) return;
    const fixes: AutoImportFix[] = [];
    for (const e of exports) fixes.push(...this.view.getFixes(e, false, isValidTypeOnlyUseSite, false));
    if (fixes.length === 0) return;
    // The first of the best, as a stable sort leaves them.
    let best = fixes[0]!;
    for (const fix of fixes) if (this.view.compareFixesForRanking(fix, best) < 0) best = fix;
    this.addImportFix(best);
  }

  private addImportFix(fix: AutoImportFix): void {
    const name = fix.name;
    switch (fix.kind) {
      case AutoImportFixKind.AddToExisting: {
        const clauseOrPattern = getClauseOrBindingPattern(this.file, fix.importIndex);
        let entry = this.addToExisting.get(clauseOrPattern);
        if (entry === undefined) {
          entry = new AddToExisting(clauseOrPattern);
          this.addToExisting.set(clauseOrPattern, entry);
        }
        if (fix.importKind === ImportKind.Named) {
          const previous = entry.namedImports.get(name);
          entry.namedImports.set(
            name,
            new NewImportBinding(
              ImportKind.Named,
              name,
              reduceAddAsTypeOnly(previous?.addAsTypeOnly, fix.addAsTypeOnly),
              '',
            ),
          );
        } else {
          entry.defaultImport = new NewImportBinding(
            ImportKind.Default,
            name,
            reduceAddAsTypeOnly(entry.defaultImport?.addAsTypeOnly, fix.addAsTypeOnly),
            '',
          );
        }
        return;
      }
      case AutoImportFixKind.AddNew: {
        const entry = this.getNewImportEntry(fix.moduleSpecifier, fix.importKind, fix.useRequire, fix.addAsTypeOnly);
        switch (fix.importKind) {
          case ImportKind.Default:
            entry.defaultImport = new NewImportBinding(
              ImportKind.Default,
              name,
              reduceAddAsTypeOnly(entry.defaultImport?.addAsTypeOnly, fix.addAsTypeOnly),
              '',
            );
            return;
          case ImportKind.Named: {
            const previous = entry.namedImports.get(name);
            entry.namedImports.set(
              name,
              new NewImportBinding(
                ImportKind.Named,
                name,
                reduceAddAsTypeOnly(previous?.addAsTypeOnly, fix.addAsTypeOnly),
                '',
              ),
            );
            return;
          }
          case ImportKind.CommonJS:
            if (this.program.options.verbatimModuleSyntax === true) {
              const previous = entry.namedImports.get(name);
              entry.namedImports.set(
                name,
                new NewImportBinding(
                  ImportKind.CommonJS,
                  name,
                  reduceAddAsTypeOnly(previous?.addAsTypeOnly, fix.addAsTypeOnly),
                  '',
                ),
              );
            } else {
              entry.namespaceLikeImport = new NewImportBinding(ImportKind.CommonJS, name, fix.addAsTypeOnly, '');
            }
            return;
          case ImportKind.Namespace:
            entry.namespaceLikeImport = new NewImportBinding(ImportKind.Namespace, name, fix.addAsTypeOnly, '');
            return;
        }
      }
    }
    // Namespace qualifiers and JSDoc import types need a usage position, which the API does not give.
  }

  // A default import that must be type-only gets an import of its own, which a type-only default needs.
  private getNewImportEntry(
    moduleSpecifier: string,
    importKind: ImportKind,
    useRequire: boolean,
    addAsTypeOnly: AddAsTypeOnly,
  ): NewImports {
    const typeOnlyKey = '1|' + moduleSpecifier;
    const nonTypeOnlyKey = '0|' + moduleSpecifier;
    const typeOnlyEntry = this.newImports.get(typeOnlyKey);
    const nonTypeOnlyEntry = this.newImports.get(nonTypeOnlyKey);
    const newEntry = new NewImports(useRequire);
    if (importKind === ImportKind.Default && addAsTypeOnly === AddAsTypeOnly.Required) {
      if (typeOnlyEntry !== undefined) return typeOnlyEntry;
      this.newImports.set(typeOnlyKey, newEntry);
      return newEntry;
    }
    if (addAsTypeOnly === AddAsTypeOnly.Allowed && (typeOnlyEntry !== undefined || nonTypeOnlyEntry !== undefined)) {
      return typeOnlyEntry ?? nonTypeOnlyEntry!;
    }
    if (nonTypeOnlyEntry !== undefined) return nonTypeOnlyEntry;
    this.newImports.set(nonTypeOnlyKey, newEntry);
    return newEntry;
  }

  /** The text edits that add the collected imports. */
  edits(): TextEdit[] {
    const file = this.file;
    const newLine = this.program.options.newLine === NewLineKind.CRLF ? '\r\n' : '\n';
    const tracker = new ChangeTracker(file, newLine, 4);
    const quotePreference = getQuotePreference(file);
    for (const entry of this.addToExisting.values()) {
      addToExistingImport(
        tracker,
        file,
        entry.clauseOrPattern,
        entry.defaultImport,
        sortedNamedImports(entry.namedImports),
      );
    }
    const newDeclarations: Node[] = [];
    for (const [key, entry] of this.newImports) {
      const moduleSpecifier = key.slice(2);
      const named = sortedNamedImports(entry.namedImports);
      newDeclarations.push(
        ...(entry.useRequire
          ? getNewRequires(
              tracker,
              moduleSpecifier,
              quotePreference,
              entry.defaultImport,
              named,
              entry.namespaceLikeImport,
            )
          : getNewImports(
              tracker,
              moduleSpecifier,
              quotePreference,
              entry.defaultImport,
              named,
              entry.namespaceLikeImport,
              this.program.options.verbatimModuleSyntax === true,
            )),
      );
    }
    if (newDeclarations.length > 0) insertImports(tracker, file, newDeclarations, true);
    return tracker.getChanges();
  }
}

function sortedNamedImports(map: ReadonlyMap<string, NewImportBinding>): NewImportBinding[] {
  return [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => map.get(key)!);
}

/**
 * The export of a symbol in its module: through its parent module, or else the default, `export =` or named export
 * of its declaring file that resolves to it.
 */
function symbolToExport(symbol: Symbol, checker: Checker, program: Program): Export | undefined {
  const toPath = (fileName: string): string => program.toPath(fileName);
  const first = (exported: Symbol, moduleId: string, moduleFileName: string, file: SourceFile): Export | undefined => {
    const exports: Export[] = [];
    new ExportExtractor(checker, '', new Resolver(program.host, {}), toPath).extractFromSymbol(
      exported.name,
      exported,
      moduleId,
      moduleFileName,
      file,
      exports,
    );
    return exports[0];
  };
  const parent = symbol.parent;
  if (parent !== undefined && parent.isExternalModule()) {
    const id = tryGetModuleIdAndFileNameOfModuleSymbol(parent);
    const declaration = parent.valueDeclaration ?? getDeclarations(parent)[0];
    if (id === undefined || declaration === undefined) return undefined;
    return first(symbol, id.moduleId, id.fileName, getSourceFileOfNode(declaration));
  }
  const declaration = getDeclarations(symbol)[0];
  if (declaration === undefined) return undefined;
  const file = getSourceFileOfNode(declaration);
  const fileSymbol = file.symbol;
  if (fileSymbol === undefined) return undefined;
  const moduleSymbol = getMergedSymbol(checker, fileSymbol);
  const moduleId = fileModuleId(file.path);
  const target = getMergedSymbol(checker, skipAlias(checker, symbol));
  for (const name of [InternalSymbolName.Default, InternalSymbolName.ExportEquals, symbol.name]) {
    const exported = tryGetMemberInModuleExportsAndProperties(checker, name, moduleSymbol);
    if (exported !== undefined && getMergedSymbol(checker, skipAlias(checker, exported)) === target) {
      return first(exported, moduleId, file.fileName, file);
    }
  }
  return undefined;
}

// The import clause, or the binding pattern of a `require`, of the file's import at `importIndex`.
function getClauseOrBindingPattern(file: SourceFile, importIndex: number): Node {
  const importNode = tryGetImportFromModuleSpecifier(file.imports[importIndex]!)!;
  if (importNode instanceof ImportDeclaration) return importNode.importClause!;
  return (importNode.parent as VariableDeclaration).name;
}

function addToExistingImport(
  tracker: ChangeTracker,
  file: SourceFile,
  clauseOrPattern: Node,
  defaultImport: NewImportBinding | undefined,
  namedImports: readonly NewImportBinding[],
): void {
  const factory = tracker.factory;
  if (clauseOrPattern instanceof BindingPattern) {
    if (defaultImport !== undefined)
      addElementToBindingPattern(tracker, clauseOrPattern, defaultImport.name, 'default');
    for (const named of namedImports) addElementToBindingPattern(tracker, clauseOrPattern, named.name, '');
    return;
  }
  const clause = clauseOrPattern as ImportClause;
  const clauseIsTypeOnly = isTypeOnlyImportClause(clause);
  // The whole clause stops being type-only when an addition can't be.
  const promoteFromTypeOnly =
    clauseIsTypeOnly && [...namedImports, defaultImport].some((i) => i?.addAsTypeOnly === AddAsTypeOnly.NotAllowed);
  const bindings = clause.namedBindings;
  const existingSpecifiers =
    bindings !== undefined && bindings.kind === SyntaxKind.NamedImports
      ? (bindings as NamedImports).elements.nodes
      : [];

  if (defaultImport !== undefined) {
    const options = new NodeOptions();
    options.suffix = ', ';
    tracker.insertNodeAt(getStartOfNode(clause, file, false), factory.createIdentifier(defaultImport.name), options);
  }

  if (namedImports.length > 0) {
    const { comparer, isSorted } = getNamedImportSpecifierComparer(clause.parent!, file);
    const newSpecifiers = namedImports.map((named) =>
      factory.created(
        new ImportSpecifier(
          (!clauseIsTypeOnly || promoteFromTypeOnly) && shouldUseTypeOnly(named.addAsTypeOnly),
          named.propertyName !== '' ? factory.createIdentifier(named.propertyName) : undefined,
          factory.createIdentifier(named.name),
        ),
      ),
    );
    newSpecifiers.sort(comparer);
    if (existingSpecifiers.length > 0 && isSorted !== false) {
      // A promoted clause's specifiers compare as the type-only specifiers they become.
      const toCompare = promoteFromTypeOnly
        ? existingSpecifiers.map((e) => {
            const spec = e as ImportSpecifier;
            return factory.created(new ImportSpecifier(true, spec.propertyName, spec.name));
          })
        : existingSpecifiers;
      for (const spec of newSpecifiers) {
        const index = binarySearchInsertionIndex(toCompare, spec, comparer);
        tracker.insertImportSpecifierAtIndex(spec, bindings as NamedImports, index);
      }
    } else if (existingSpecifiers.length > 0) {
      for (const spec of newSpecifiers) {
        tracker.insertNodeInListAfter(
          existingSpecifiers[existingSpecifiers.length - 1]!,
          spec,
          (bindings as NamedImports).elements,
        );
      }
    } else {
      const namedImportsNode = factory.created(new NamedImports(new NodeList(-1, -1, newSpecifiers)));
      if (bindings !== undefined) tracker.replaceNode(bindings, namedImportsNode);
      else tracker.insertNodeAfter(clause.name!, namedImportsNode);
    }
  }

  if (promoteFromTypeOnly) {
    // `import type` loses `type`, and the existing specifiers keep their type-only meaning with `type` of their own.
    const typeKeyword = findChildOfKind(clause, SyntaxKind.TypeKeyword, file);
    if (typeKeyword !== undefined) tracker.delete(typeKeyword);
    for (const specifier of existingSpecifiers) {
      if (!(specifier as ImportSpecifier).isTypeOnly) tracker.insertModifierBefore(SyntaxKind.TypeKeyword, specifier);
    }
  }
}

function addElementToBindingPattern(
  tracker: ChangeTracker,
  pattern: BindingPattern,
  name: string,
  propertyName: string,
): void {
  const factory = tracker.factory;
  // tsc passes the property name where the initializer goes, so `default` is written as `Def = default`.
  const element = factory.created(
    new BindingElement(
      undefined,
      undefined,
      factory.createIdentifier(name),
      propertyName === '' ? undefined : factory.createIdentifier(propertyName),
    ),
  );
  const elements = pattern.elements.nodes;
  if (elements.length > 0) tracker.insertNodeInListAfter(elements[elements.length - 1]!, element, pattern.elements);
  else {
    tracker.replaceNode(
      pattern,
      factory.created(new BindingPattern(SyntaxKind.ObjectBindingPattern, new NodeList(-1, -1, [element]))),
    );
  }
}

function moduleSpecifierLiteral(
  tracker: ChangeTracker,
  moduleSpecifier: string,
  quotePreference: QuotePreference,
): Node {
  return tracker.factory.createStringLiteral(
    moduleSpecifier,
    quotePreference === QuotePreference.Single ? TokenFlags.SingleQuote : TokenFlags.None,
  );
}

function getNewImports(
  tracker: ChangeTracker,
  moduleSpecifier: string,
  quotePreference: QuotePreference,
  defaultImport: NewImportBinding | undefined,
  namedImports: readonly NewImportBinding[],
  namespaceLikeImport: NewImportBinding | undefined,
  verbatimModuleSyntax: boolean,
): Node[] {
  const factory = tracker.factory;
  const specifier = moduleSpecifierLiteral(tracker, moduleSpecifier, quotePreference);
  const statements: Node[] = [];
  if (defaultImport !== undefined || namedImports.length > 0) {
    // `verbatimModuleSyntax` prefers a top-level `import type`, which has no runtime emit.
    const topLevelTypeOnly =
      ((defaultImport === undefined || needsTypeOnly(defaultImport.addAsTypeOnly)) &&
        namedImports.every((i) => needsTypeOnly(i.addAsTypeOnly))) ||
      (verbatimModuleSyntax &&
        (defaultImport === undefined || defaultImport.addAsTypeOnly !== AddAsTypeOnly.NotAllowed) &&
        !namedImports.some((i) => i.addAsTypeOnly === AddAsTypeOnly.NotAllowed));
    statements.push(
      makeImport(
        tracker,
        defaultImport === undefined ? undefined : factory.createIdentifier(defaultImport.name),
        namedImports.map((named) =>
          factory.created(
            new ImportSpecifier(
              !topLevelTypeOnly && shouldUseTypeOnly(named.addAsTypeOnly),
              named.propertyName !== '' ? factory.createIdentifier(named.propertyName) : undefined,
              factory.createIdentifier(named.name),
            ),
          ),
        ),
        specifier,
        topLevelTypeOnly,
      ),
    );
  }
  if (namespaceLikeImport !== undefined) {
    const typeOnly = shouldUseTypeOnly(namespaceLikeImport.addAsTypeOnly);
    if (namespaceLikeImport.kind === ImportKind.CommonJS) {
      statements.push(
        factory.created(
          new ImportEqualsDeclaration(
            undefined,
            typeOnly,
            factory.createIdentifier(namespaceLikeImport.name),
            factory.created(new ExternalModuleReference(specifier)),
          ),
        ),
      );
    } else {
      statements.push(
        factory.created(
          new ImportDeclaration(
            SyntaxKind.ImportDeclaration,
            undefined,
            factory.created(
              new ImportClause(
                typeOnly ? SyntaxKind.TypeKeyword : undefined,
                undefined,
                factory.created(new NamespaceImport(factory.createIdentifier(namespaceLikeImport.name))),
              ),
            ),
            specifier,
            undefined,
          ),
        ),
      );
    }
  }
  return statements;
}

function getNewRequires(
  tracker: ChangeTracker,
  moduleSpecifier: string,
  quotePreference: QuotePreference,
  defaultImport: NewImportBinding | undefined,
  namedImports: readonly NewImportBinding[],
  namespaceLikeImport: NewImportBinding | undefined,
): Node[] {
  const factory = tracker.factory;
  const specifier = moduleSpecifierLiteral(tracker, moduleSpecifier, quotePreference);
  const statements: Node[] = [];
  // `const { default: foo, bar } = require('./mod');`
  if (defaultImport !== undefined || namedImports.length > 0) {
    const elements: Node[] = namedImports.map((named) =>
      factory.created(
        new BindingElement(
          undefined,
          named.propertyName !== '' ? factory.createIdentifier(named.propertyName) : undefined,
          factory.createIdentifier(named.name),
          undefined,
        ),
      ),
    );
    if (defaultImport !== undefined) {
      elements.unshift(
        factory.created(
          new BindingElement(
            undefined,
            factory.createIdentifier('default'),
            factory.createIdentifier(defaultImport.name),
            undefined,
          ),
        ),
      );
    }
    statements.push(
      constRequire(
        tracker,
        factory.created(new BindingPattern(SyntaxKind.ObjectBindingPattern, new NodeList(-1, -1, elements))),
        specifier,
      ),
    );
  }
  // `const foo = require('./mod');`
  if (namespaceLikeImport !== undefined) {
    statements.push(constRequire(tracker, factory.createIdentifier(namespaceLikeImport.name), specifier));
  }
  return statements;
}

function constRequire(tracker: ChangeTracker, name: Node, specifier: Node): Node {
  const factory = tracker.factory;
  const call = factory.created(
    new CallExpression(factory.createIdentifier('require'), new NodeList(-1, -1, [specifier]), NodeFlags.None),
  );
  const declaration = factory.created(new VariableDeclaration(name, undefined, undefined, call));
  return factory.created(
    new VariableStatement(
      undefined,
      factory.created(new VariableDeclarationList(new NodeList(-1, -1, [declaration]), NodeFlags.Const)),
    ),
  );
}

function makeImport(
  tracker: ChangeTracker,
  defaultImport: Identifier | undefined,
  namedImports: readonly Node[],
  moduleSpecifier: Node,
  isTypeOnly: boolean,
): Node {
  const factory = tracker.factory;
  const named =
    namedImports.length > 0 ? factory.created(new NamedImports(new NodeList(-1, -1, [...namedImports]))) : undefined;
  const clause =
    defaultImport !== undefined || named !== undefined
      ? factory.created(new ImportClause(isTypeOnly ? SyntaxKind.TypeKeyword : undefined, defaultImport, named))
      : undefined;
  return factory.created(
    new ImportDeclaration(SyntaxKind.ImportDeclaration, undefined, clause, moduleSpecifier, undefined),
  );
}

function isRequireVariableStatement(node: Node): boolean {
  if (!(node instanceof VariableStatement)) return false;
  const declarations = node.declarationList.declarations.nodes;
  return declarations.length > 0 && declarations.every(isVariableDeclarationInitializedToRequire);
}

function isAnyImportSyntax(node: Node): boolean {
  return node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.ImportEqualsDeclaration;
}

// After the imports already there: in sorted position when they are sorted, else after the last one; at the top of
// the file when there are none.
function insertImports(tracker: ChangeTracker, file: SourceFile, imports: Node[], blankLineBetween: boolean): void {
  const existing = file.statements.nodes.filter(
    imports[0]!.kind === SyntaxKind.VariableStatement ? isRequireVariableStatement : isAnyImportSyntax,
  );
  const { comparer, isSorted } = detectModuleSpecifierOrder(existing);
  const compare = (a: Node, b: Node): number => compareImportsOrRequireStatements(a, b, comparer);
  const sortedNewImports = [...imports].sort(compare);
  if (existing.length > 0 && isSorted) {
    for (const newImport of sortedNewImports) {
      const index = binarySearchInsertionIndex(existing, newImport, compare);
      if (index === 0) {
        // Before the first import, after a header comment when that import starts the file.
        const leading =
          existing[0] === file.statements.nodes[0] ? LeadingTriviaOption.Exclude : LeadingTriviaOption.None;
        tracker.insertNodeBefore(existing[0]!, newImport, false, leading);
      } else {
        tracker.insertNodeAfter(existing[index - 1]!, newImport);
      }
    }
  } else if (existing.length > 0) {
    tracker.insertNodesAfter(existing[existing.length - 1]!, sortedNewImports);
  } else {
    tracker.insertAtTopOfFile(sortedNewImports, blankLineBetween);
  }
}
