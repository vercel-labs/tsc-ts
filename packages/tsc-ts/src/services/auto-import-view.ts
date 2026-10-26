// Auto-import candidates for a file: the exports a project offers, and the fix that imports each one, as tsgo's
// ls/autoimport Registry and View find them for completions.
import {
  getImportClause,
  getModuleSpecifier,
  getName,
  Identifier,
  ImportClause,
  ImportEqualsDeclaration,
  type Node,
  NamespaceImport,
  type SourceFile,
  StringLiteral,
  VariableDeclaration,
} from '../compiler/ast.js';
import { isVariableDeclarationInitializedToRequire } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { resolveExternalModuleName } from '../compiler/checker-modules.js';
import { getSymbolAtLocation } from '../compiler/checker-services.js';
import { isIdentifierText } from '../compiler/scanner.js';
import {
  getModuleSpecifiersForFileWithInfo,
  ModuleSpecifierPreferences,
  ModuleSpecifierResultKind,
} from '../compiler/module-specifiers.js';
import { Resolver } from '../compiler/module-resolution.js';
import {
  type CompilerOptions,
  getEmitModuleDetectionKind,
  getEmitModuleKind,
  ModuleDetectionKind,
  ModuleKind,
} from '../compiler/options.js';
import { getEmitModuleFormatOfFile, isSourceFileJS } from '../compiler/program-utilities.js';
import type { Program } from '../compiler/program.js';
import { ProgramModuleSpecifierHost } from '../compiler/program-checker.js';
import {
  ensurePathIsNonModuleName,
  getDirectoryPath,
  getRelativePathFromDirectory,
  hasJSFileExtension,
  pathIsRelative,
} from '../compiler/path.js';
import { isStringLiteralLike, nodeIsMissing } from '../compiler/ast-utilities.js';
import { exclusivelyPrefixedNodeCoreModules, unprefixedNodeCoreModules } from '../compiler/parser.js';
import { NodeFlags } from '../compiler/ast.js';
import { InternalSymbolName, SymbolFlags } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { LanguageVariant } from '../compiler/types.js';
import {
  Export,
  ExportExtractor,
  ExportIndex,
  ExportSyntax,
  modulePathOfId,
  moduleSpecifierOfId,
  tryGetModuleIdAndFileNameOfModuleSymbol,
} from './auto-import-exports.js';
import { tryGetImportFromModuleSpecifier } from './completions.js';

/** The exports of a project's files, for the auto-imports of files in it. */
export class AutoImportRegistry {
  constructor(
    readonly index: ExportIndex,
    /** Package names the program's files import. */
    readonly resolvedPackageNames: ReadonlySet<string>,
  ) {}
}

/**
 * The exports of the program's files: each file but default libraries and files in `node_modules`, extracted with
 * `checker`, a checker of its own.
 */
export function buildAutoImportRegistry(program: Program, checker: Checker): AutoImportRegistry {
  const resolver = new Resolver(program.host, {});
  const toPath = (fileName: string): string => program.toPath(fileName);
  const extractor = new ExportExtractor(checker, '', resolver, toPath);
  const index = new ExportIndex();
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file.path)) continue;
    if (containsLowercaseDirectorySequence(file.fileName, '/node_modules/')) continue;
    for (const exported of extractor.extractFromFile(file)) index.insertAsWords(exported);
  }
  return new AutoImportRegistry(index, new Set());
}

/** Whether a path has a directory sequence, compared in lowercase as tsgo's `ContainsLowercaseDirectorySequence`. */
function containsLowercaseDirectorySequence(path: string, sequence: string): boolean {
  return path.toLowerCase().includes(sequence);
}

/** How a fix imports an export. */
export const enum AutoImportFixKind {
  UseNamespace,
  JsdocTypeImport,
  AddToExisting,
  AddNew,
  PromoteTypeOnly,
}

export const enum ImportKind {
  Named,
  Default,
  Namespace,
  CommonJS,
}

export const enum AddAsTypeOnly {
  Allowed = 1,
  Required = 2,
  NotAllowed = 4,
}

/** A fix that imports an export into a file. */
export class AutoImportFix {
  importKind = ImportKind.Named;
  useRequire = false;
  addAsTypeOnly = AddAsTypeOnly.Allowed;
  importIndex = 0;
  namespacePrefix = '';
  moduleSpecifierKind = ModuleSpecifierResultKind.None;
  isReExport = false;
  moduleFileName = '';

  constructor(
    readonly kind: AutoImportFixKind,
    readonly moduleSpecifier: string,
    readonly name: string,
  ) {}
}

export interface FixAndExport {
  readonly fix: AutoImportFix;
  readonly exported: Export;
}

interface ExistingImport {
  readonly node: Node;
  readonly moduleSpecifier: string;
  readonly index: number;
}

/** The auto-imports a file can use from a registry. */
export class AutoImportView {
  private existingImports: Map<string, ExistingImport[]> | undefined;
  private shouldUseRequireForFixes: boolean | undefined;
  private readonly specifierCache = new Map<string, { specifier: string; kind: ModuleSpecifierResultKind }>();
  private readonly specifierHost: ProgramModuleSpecifierHost;
  private readonly shouldUseUriStyleNodeCoreModules: boolean | undefined;

  constructor(
    private readonly registry: AutoImportRegistry,
    private readonly importingFile: SourceFile,
    private readonly program: Program,
    private readonly checker: Checker,
    private readonly preferences: ModuleSpecifierPreferences,
  ) {
    this.specifierHost = new ProgramModuleSpecifierHost(program);
    this.shouldUseUriStyleNodeCoreModules = shouldUseUriStyleNodeCoreModules(importingFile);
  }

  private get options(): CompilerOptions {
    return this.program.options;
  }

  /** The exports with a word starting with `prefix`'s first character and `prefix`'s characters in order. */
  search(prefix: string): Export[] {
    const results: Export[] = [];
    for (const exported of this.registry.index.searchWordPrefix(prefix)) {
      // Nothing is imported from the importing file itself.
      if (modulePathOfId(exported.moduleId) === this.importingFile.path) continue;
      results.push(exported);
    }
    return results;
  }

  /**
   * The best fixes for the exports matching `prefix`: one group per export target, name and ambient module or
   * package, best first.
   */
  getCompletions(prefix: string, forJSX: boolean, isTypeOnlyLocation: boolean): FixAndExport[] {
    const results = this.search(prefix);
    const grouped = new Map<string, Export[]>();
    outer: for (const e of results) {
      const name = e.name();
      if (!isIdentifierText(name, LanguageVariant.Standard)) continue;
      if (forJSX && !(isUpperCaseStart(name) || e.isRenameable())) continue;
      const target = e.targetKey() !== '' ? e.targetKey() : e.exportKey();
      const key =
        target + '\u0001' + name + '\u0001' + (e.ambientModuleName() !== '' ? e.ambientModuleName() : e.packageName);
      const existing = grouped.get(key);
      if (existing !== undefined) {
        for (let i = 0; i < existing.length; i++) {
          const ex = existing[i]!;
          if (e.exportKey() === ex.exportKey()) {
            existing[i] = mergeExports(e, ex);
            continue outer;
          }
        }
        existing.push(e);
      } else grouped.set(key, [e]);
    }
    const fixes: FixAndExport[] = [];
    for (const exports of grouped.values()) {
      const group: FixAndExport[] = [];
      for (const e of exports) {
        for (const fix of this.getFixes(e, forJSX, isTypeOnlyLocation)) group.push({ fix, exported: e });
      }
      // Every fix as good as the best one.
      let best: FixAndExport[] = [];
      for (const candidate of group) {
        if (best.length === 0) best = [candidate];
        else {
          const order = this.compareFixesForRanking(candidate.fix, best[0]!.fix);
          if (order < 0) best = [candidate];
          else if (order === 0) best.push(candidate);
        }
      }
      fixes.push(...best);
    }
    fixes.sort((a, b) => this.compareFixesForSorting(a.fix, b.fix));
    return fixes;
  }

  /** The fixes that import `e`: through an existing namespace import, an existing import, or a new import. */
  getFixes(e: Export, forJSX: boolean, isValidTypeOnlyUseSite: boolean): AutoImportFix[] {
    const fixes: AutoImportFix[] = [];
    const namespaceFix = this.tryUseExistingNamespaceImport(e);
    if (namespaceFix !== undefined) fixes.push(namespaceFix);
    const existingFix = this.tryAddToExistingImport(e, isValidTypeOnlyUseSite);
    if (existingFix !== undefined) {
      fixes.push(existingFix);
      return fixes;
    }
    const { specifier, kind } = this.getModuleSpecifier(e);
    if (specifier === '') return fixes;
    const isReExport = e.targetModuleId !== e.moduleId;
    // A pure type in a JavaScript file is imported with a JSDoc import type.
    const importedSymbolHasValueMeaning = (e.flags & SymbolFlags.Value) !== 0 || e.isUnresolvedAlias();
    if (!importedSymbolHasValueMeaning && hasJSFileExtension(this.importingFile.fileName)) {
      const fix = new AutoImportFix(AutoImportFixKind.JsdocTypeImport, specifier, e.name());
      fix.moduleSpecifierKind = kind;
      fix.isReExport = isReExport;
      fix.moduleFileName = e.moduleFileName;
      return [fix];
    }
    const importKind = this.getImportKind(e, false);
    const addAsTypeOnly = getAddAsTypeOnly(isValidTypeOnlyUseSite, e, this.options);
    let name = e.name();
    if (forJSX && !isUpperCaseStart(name)) {
      if (!e.isRenameable()) return [];
      const [first, ...rest] = name;
      name = first!.toUpperCase() + rest.join('');
    }
    const fix = new AutoImportFix(AutoImportFixKind.AddNew, specifier, name);
    fix.importKind = importKind;
    fix.useRequire = this.shouldUseRequire();
    fix.addAsTypeOnly = addAsTypeOnly;
    fix.moduleSpecifierKind = kind;
    fix.isReExport = isReExport;
    fix.moduleFileName = e.moduleFileName;
    fixes.push(fix);
    return fixes;
  }

  private tryUseExistingNamespaceImport(e: Export): AutoImportFix | undefined {
    if (this.getImportKind(e, false) !== ImportKind.Named) return undefined;
    for (const existing of this.getExistingImports().get(e.moduleId) ?? []) {
      const namespacePrefix = getNamespaceLikeImportText(existing.node);
      if (namespacePrefix === '' || existing.moduleSpecifier === '') continue;
      const fix = new AutoImportFix(AutoImportFixKind.UseNamespace, existing.moduleSpecifier, e.name());
      fix.importKind = ImportKind.Namespace;
      fix.addAsTypeOnly = AddAsTypeOnly.Allowed;
      fix.importIndex = existing.index;
      fix.namespacePrefix = namespacePrefix;
      return fix;
    }
    return undefined;
  }

  private tryAddToExistingImport(e: Export, isValidTypeOnlyUseSite: boolean): AutoImportFix | undefined {
    const matching = this.getExistingImports().get(e.moduleId) ?? [];
    if (matching.length === 0) return undefined;
    // An ES import can't bring a type into JavaScript.
    if (
      isSourceFileJS(this.importingFile) &&
      (e.flags & SymbolFlags.Value) === 0 &&
      !matching.every((i) => i.node.kind === SyntaxKind.JSDocImportTag)
    )
      return undefined;
    const importKind = this.getImportKind(e, false);
    if (importKind === ImportKind.CommonJS || importKind === ImportKind.Namespace) return undefined;
    const addAsTypeOnly = getAddAsTypeOnly(isValidTypeOnlyUseSite, e, this.options);
    let best: AutoImportFix | undefined;
    const newFix = (existing: ExistingImport): AutoImportFix => {
      const fix = new AutoImportFix(AutoImportFixKind.AddToExisting, existing.moduleSpecifier, e.name());
      fix.importKind = importKind;
      fix.importIndex = existing.index;
      fix.addAsTypeOnly = addAsTypeOnly;
      return fix;
    };
    for (const existing of matching) {
      const node = existing.node;
      if (node.kind === SyntaxKind.ImportEqualsDeclaration) continue;
      if (node instanceof VariableDeclaration) {
        if (
          (importKind === ImportKind.Named || importKind === ImportKind.Default) &&
          node.name.kind === SyntaxKind.ObjectBindingPattern
        ) {
          const fix = newFix(existing);
          // Variable declarations are never type-only.
          if (addAsTypeOnly === AddAsTypeOnly.NotAllowed) return fix;
          best ??= fix;
        }
        continue;
      }
      const clause = getImportClause(node);
      const specifier = getModuleSpecifier(node);
      // A side effect import has nothing to add to.
      if (!(clause instanceof ImportClause) || specifier === undefined || !isStringLiteralLike(specifier)) continue;
      if (clause.phaseModifier === SyntaxKind.SourceKeyword) continue;
      const namedBindings = clause.namedBindings;
      // A type-only import can take only a named import, into its named bindings.
      if (isTypeOnlyClause(clause) && !(importKind === ImportKind.Named && namedBindings !== undefined)) continue;
      if (
        importKind === ImportKind.Default &&
        (clause.name !== undefined || (addAsTypeOnly === AddAsTypeOnly.Required && namedBindings !== undefined))
      )
        continue;
      // A named import can't go next to a namespace import.
      if (importKind === ImportKind.Named && namedBindings?.kind === SyntaxKind.NamespaceImport) continue;
      const fix = newFix(existing);
      // Types go in type-only imports, and values in other imports, rather than converting one.
      if (
        (addAsTypeOnly !== AddAsTypeOnly.NotAllowed && isTypeOnlyClause(clause)) ||
        (addAsTypeOnly === AddAsTypeOnly.NotAllowed && !isTypeOnlyClause(clause))
      )
        return fix;
      best ??= fix;
    }
    return best;
  }

  /** How the importing file imports `e`: as a named, default, namespace or CommonJS import. */
  getImportKind(e: Export, forceImportKeyword: boolean): ImportKind {
    const file = this.importingFile;
    if (
      this.options.verbatimModuleSyntax === true &&
      getEmitModuleFormatOfFile(file.fileName, this.options, this.program.sourceFileMetadata(file.path)) ===
        ModuleKind.CommonJS
    )
      return ImportKind.CommonJS;
    switch (e.syntax) {
      case ExportSyntax.DefaultModifier:
      case ExportSyntax.DefaultDeclaration:
        return ImportKind.Default;
      case ExportSyntax.Named:
        if (e.exportName === InternalSymbolName.Default) return ImportKind.Default;
        return ImportKind.Named;
      case ExportSyntax.Modifier:
      case ExportSyntax.Star:
      case ExportSyntax.CommonJSExportsProperty:
        return ImportKind.Named;
      case ExportSyntax.Equals:
      case ExportSyntax.CommonJSModuleExports:
      case ExportSyntax.UMD:
        // The named exports and properties of an `export =` target.
        if (e.exportName !== InternalSymbolName.ExportEquals) return ImportKind.Named;
        // `import foo` parses as an import equals declaration.
        for (const statement of file.statements.nodes) {
          if (statement instanceof ImportEqualsDeclaration && !nodeIsMissing(statement.moduleReference))
            return ImportKind.CommonJS;
        }
        if (file.externalModuleIndicator !== undefined || forceImportKeyword || !isSourceFileJS(file))
          return ImportKind.Default;
        return ImportKind.CommonJS;
    }
    throw new Error('unhandled export syntax kind: ' + e.syntax);
  }

  private getExistingImports(): Map<string, ExistingImport[]> {
    if (this.existingImports !== undefined) return this.existingImports;
    const result = new Map<string, ExistingImport[]>();
    const add = (moduleId: string, existing: ExistingImport): void => {
      const list = result.get(moduleId);
      if (list === undefined) result.set(moduleId, [existing]);
      else list.push(existing);
    };
    const imports = this.importingFile.imports;
    for (let i = 0; i < imports.length; i++) {
      const moduleSpecifier = imports[i]!;
      const node = tryGetImportFromModuleSpecifier(moduleSpecifier);
      if (node === undefined) throw new Error('error: did not expect node kind ' + moduleSpecifier.kind);
      const text = (moduleSpecifier as StringLiteral).text;
      if (node.parent !== undefined && isVariableDeclarationInitializedToRequire(node.parent)) {
        const moduleSymbol = resolveExternalModuleName(this.checker, moduleSpecifier, moduleSpecifier, true, undefined);
        const id = moduleSymbol === undefined ? undefined : tryGetModuleIdAndFileNameOfModuleSymbol(moduleSymbol);
        if (id !== undefined) add(id.moduleId, { node: node.parent, moduleSpecifier: text, index: i });
      } else if (
        node.kind === SyntaxKind.ImportDeclaration ||
        node.kind === SyntaxKind.ImportEqualsDeclaration ||
        node.kind === SyntaxKind.JSDocImportTag
      ) {
        const moduleSymbol = getSymbolAtLocation(this.checker, moduleSpecifier);
        const id = moduleSymbol === undefined ? undefined : tryGetModuleIdAndFileNameOfModuleSymbol(moduleSymbol);
        if (id !== undefined) add(id.moduleId, { node, moduleSpecifier: text, index: i });
      }
    }
    this.existingImports = result;
    return result;
  }

  private shouldUseRequire(): boolean {
    this.shouldUseRequireForFixes ??= this.computeShouldUseRequire();
    return this.shouldUseRequireForFixes;
  }

  private computeShouldUseRequire(): boolean {
    const file = this.importingFile;
    // TypeScript files use imports.
    if (!hasJSFileExtension(file.fileName)) return false;
    // An unambiguously CommonJS or ES module file.
    switch (detectSyntax(file, this.options)) {
      case FileSyntaxKind.CJS:
        return true;
      case FileSyntaxKind.ESM:
        return false;
    }
    switch (this.program.getImpliedNodeFormatForEmit(file)) {
      case ModuleKind.CommonJS:
        return true;
      case ModuleKind.ESNext:
        return false;
    }
    if (this.options.configFilePath !== undefined && this.options.configFilePath !== '')
      return getEmitModuleKind(this.options) < ModuleKind.ES2015;
    // The first other JavaScript file of the program that is unambiguously one or the other.
    for (const other of this.program.getSourceFiles()) {
      if (other === file || !isSourceFileJS(other) || this.program.isSourceFileFromExternalLibrary(other)) continue;
      switch (detectSyntax(other, this.options)) {
        case FileSyntaxKind.CJS:
          return true;
        case FileSyntaxKind.ESM:
          return false;
      }
    }
    return true;
  }

  /** The specifier that imports `e`, and where it came from; `''` for none. */
  getModuleSpecifier(e: Export): { specifier: string; kind: ModuleSpecifierResultKind } {
    if (e.unresolvedModuleSpecifier !== '') {
      let specifier = e.unresolvedModuleSpecifier;
      if (pathIsRelative(specifier)) {
        specifier = relativeModuleSpecifier(getDirectoryPath(this.importingFile.fileName), e.moduleFileName);
      }
      return { specifier, kind: ModuleSpecifierResultKind.Relative };
    }
    const ambient = moduleSpecifierOfId(e.moduleId);
    if (ambient !== '') return { specifier: ambient, kind: ModuleSpecifierResultKind.Ambient };
    // By the file the export was found in and the module's file: a file's relative module augmentation exports from
    // another module than the file itself.
    const cacheKey = e.path + '\u0000' + e.moduleFileName;
    const cached = this.specifierCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const result = getModuleSpecifiersForFileWithInfo(
      this.importingFile,
      e.moduleFileName,
      this.options,
      this.specifierHost,
      this.preferences,
      ModuleKind.None,
      true,
    );
    for (const specifier of result.specifiers) {
      if (specifier.includes('/node_modules/')) continue;
      const found = { specifier, kind: result.kind };
      this.specifierCache.set(cacheKey, found);
      return found;
    }
    const none = { specifier: '', kind: ModuleSpecifierResultKind.None };
    this.specifierCache.set(cacheKey, none);
    return none;
  }

  /** Negative when `a` is better; fixes of equal kind and specifier quality compare equal. */
  compareFixesForRanking(a: AutoImportFix, b: AutoImportFix): number {
    const kinds = a.kind - b.kind;
    if (kinds !== 0) return kinds;
    return this.compareModuleSpecifiersForRanking(a, b);
  }

  /** The ranking, then shorter, `./`, alphabetically earlier specifiers and import kinds first. */
  compareFixesForSorting(a: AutoImportFix, b: AutoImportFix): number {
    const ranking = this.compareFixesForRanking(a, b);
    if (ranking !== 0) return ranking;
    return this.compareModuleSpecifiersForSorting(a, b);
  }

  private compareModuleSpecifiersForRanking(a: AutoImportFix, b: AutoImportFix): number {
    const relativity = compareModuleSpecifierRelativity(a, b, this.preferences);
    if (relativity !== 0) return relativity;
    if (
      a.moduleSpecifierKind === ModuleSpecifierResultKind.Ambient &&
      b.moduleSpecifierKind === ModuleSpecifierResultKind.Ambient
    ) {
      const core = this.compareNodeCoreModuleSpecifiers(a.moduleSpecifier, b.moduleSpecifier);
      if (core !== 0) return core;
    }
    if (
      a.moduleSpecifierKind === ModuleSpecifierResultKind.Relative &&
      b.moduleSpecifierKind === ModuleSpecifierResultKind.Relative
    ) {
      const file = this.importingFile.fileName;
      const cycles = compareBooleans(
        this.isFixPossiblyReExportingImportingFile(a, file),
        this.isFixPossiblyReExportingImportingFile(b, file),
      );
      if (cycles !== 0) return cycles;
    }
    return countDirectorySeparators(a.moduleSpecifier) - countDirectorySeparators(b.moduleSpecifier);
  }

  private compareModuleSpecifiersForSorting(a: AutoImportFix, b: AutoImportFix): number {
    const ranking = this.compareModuleSpecifiersForRanking(a, b);
    if (ranking !== 0) return ranking;
    // `./foo` before `../foo` of equal length.
    const aDot = a.moduleSpecifier.startsWith('./');
    const bDot = b.moduleSpecifier.startsWith('./');
    if (aDot && !bDot) return -1;
    if (bDot && !aDot) return 1;
    if (a.moduleSpecifier !== b.moduleSpecifier) return a.moduleSpecifier < b.moduleSpecifier ? -1 : 1;
    return a.importKind - b.importKind;
  }

  private compareNodeCoreModuleSpecifiers(a: string, b: string): number {
    const preferUri = this.shouldUseUriStyleNodeCoreModules;
    if (a.startsWith('node:') && !b.startsWith('node:')) return preferUri === true ? -1 : preferUri === false ? 1 : 0;
    if (b.startsWith('node:') && !a.startsWith('node:')) return preferUri === true ? 1 : preferUri === false ? -1 : 0;
    return 0;
  }

  // A heuristic against import cycles through a barrel re-export: `..` re-exporting from the importing file's
  // directory is worse than the file it re-exports.
  private isFixPossiblyReExportingImportingFile(fix: AutoImportFix, importingFileName: string): boolean {
    if (!fix.isReExport || !isIndexFileName(fix.moduleFileName)) return false;
    return startsWithDirectory(
      importingFileName,
      getDirectoryPath(fix.moduleFileName),
      this.program.useCaseSensitiveFileNames,
    );
  }
}

function mergeExports(e: Export, ex: Export): Export {
  const merged = new Export(
    e.exportName,
    e.moduleId,
    e.moduleFileName,
    Math.min(e.syntax, ex.syntax),
    e.flags | ex.flags,
    e.path,
    e.packageName,
  );
  merged.unresolvedModuleSpecifier = e.unresolvedModuleSpecifier;
  merged.isTypeOnly = e.isTypeOnly || ex.isTypeOnly;
  merged.scriptElementKind = Math.min(e.scriptElementKind, ex.scriptElementKind);
  merged.localName = e.localName;
  merged.targetModuleId = e.targetModuleId;
  merged.targetExportName = e.targetExportName;
  return merged;
}

function isUpperCaseStart(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

/** Whether an import must be, may be, or may not be type-only at the use site. */
function getAddAsTypeOnly(isValidTypeOnlyUseSite: boolean, e: Export, options: CompilerOptions): AddAsTypeOnly {
  // An emitting position can't use a type-only import.
  if (!isValidTypeOnlyUseSite) return AddAsTypeOnly.NotAllowed;
  if (
    (options.verbatimModuleSyntax === true && (e.isTypeOnly || (e.flags & SymbolFlags.Value) === 0)) ||
    (e.isTypeOnly && (e.flags & SymbolFlags.Value) !== 0)
  )
    return AddAsTypeOnly.Required;
  return AddAsTypeOnly.Allowed;
}

function getNamespaceLikeImportText(declaration: Node): string {
  switch (declaration.kind) {
    case SyntaxKind.VariableDeclaration: {
      const name = getName(declaration);
      return name !== undefined && name.kind === SyntaxKind.Identifier ? identifierText(name) : '';
    }
    case SyntaxKind.ImportEqualsDeclaration:
      return identifierText(getName(declaration)!);
    case SyntaxKind.JSDocImportTag:
    case SyntaxKind.ImportDeclaration: {
      const clause = getImportClause(declaration);
      if (clause instanceof ImportClause && clause.namedBindings instanceof NamespaceImport)
        return identifierText(clause.namedBindings.name);
      return '';
    }
  }
  return '';
}

const enum FileSyntaxKind {
  Ambiguous,
  ESM,
  CJS,
}

// Whether a file has unambiguous ES module or CommonJS syntax. Under `moduleDetection: force` the external module
// indicator can be the file itself, so the file's imports are looked at instead.
function detectSyntax(file: SourceFile, options: CompilerOptions): FileSyntaxKind {
  const hasCJS = file.commonJSModuleIndicator !== undefined;
  let hasESM = false;
  if (getEmitModuleDetectionKind(options) !== ModuleDetectionKind.Force)
    hasESM = file.externalModuleIndicator !== undefined;
  else if (file.externalModuleIndicator !== undefined && file.externalModuleIndicator !== file) hasESM = true;
  else {
    for (const specifier of file.imports) {
      if ((specifier.flags & NodeFlags.Synthesized) !== 0) continue;
      const parent = specifier.parent;
      if (parent === undefined) continue;
      if (
        parent.kind === SyntaxKind.ImportDeclaration ||
        parent.kind === SyntaxKind.JSImportDeclaration ||
        parent.kind === SyntaxKind.ExportDeclaration ||
        parent.kind === SyntaxKind.ExternalModuleReference
      ) {
        hasESM = true;
        break;
      }
    }
  }
  if (hasCJS && !hasESM) return FileSyntaxKind.CJS;
  if (hasESM && !hasCJS) return FileSyntaxKind.ESM;
  return FileSyntaxKind.Ambiguous;
}

function compareModuleSpecifierRelativity(
  a: AutoImportFix,
  b: AutoImportFix,
  preferences: ModuleSpecifierPreferences,
): number {
  switch (preferences.importModuleSpecifierPreference) {
    case 'non-relative':
    case 'project-relative':
      return compareBooleans(
        a.moduleSpecifierKind === ModuleSpecifierResultKind.Relative,
        b.moduleSpecifierKind === ModuleSpecifierResultKind.Relative,
      );
  }
  return 0;
}

function compareBooleans(a: boolean, b: boolean): number {
  return a === b ? 0 : a ? 1 : -1;
}

function countDirectorySeparators(path: string): number {
  let count = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 0x2f) count++;
  return count;
}

function isIndexFileName(fileName: string): boolean {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  return (
    base === 'index.js' || base === 'index.jsx' || base === 'index.d.ts' || base === 'index.ts' || base === 'index.tsx'
  );
}

function startsWithDirectory(fileName: string, directory: string, useCaseSensitiveFileNames: boolean): boolean {
  const f = useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
  const d = useCaseSensitiveFileNames ? directory : directory.toLowerCase();
  return f.startsWith(d.endsWith('/') ? d : d + '/');
}

/** Whether the file's imports of Node core modules use `node:`; undefined when it imports none. */
function shouldUseUriStyleNodeCoreModules(file: SourceFile): boolean | undefined {
  for (const specifier of file.imports) {
    const text = (specifier as StringLiteral).text;
    if (isNodeCoreModule(text) && !exclusivelyPrefixedNodeCoreModules.has(text)) return text.startsWith('node:');
  }
  return undefined;
}

function isNodeCoreModule(name: string): boolean {
  return (
    unprefixedNodeCoreModules.has(name) ||
    (name.startsWith('node:') && unprefixedNodeCoreModules.has(name.slice(5))) ||
    exclusivelyPrefixedNodeCoreModules.has(name)
  );
}

function identifierText(node: Node): string {
  return node instanceof Identifier ? node.text : '';
}

// The relative path from a directory to a file, starting with `./` or `../`.
function relativeModuleSpecifier(directory: string, fileName: string): string {
  return ensurePathIsNonModuleName(getRelativePathFromDirectory(directory, fileName, false));
}

function isTypeOnlyClause(clause: ImportClause): boolean {
  return clause.phaseModifier === SyntaxKind.TypeKeyword;
}
