// The exports auto-imports offer: each module's exports with what identifies them across files, and an index of their
// names, as tsgo's ls/autoimport package extracts them from bound files.
import {
  BinaryExpression,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  getName,
  getSymbol,
  Identifier,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  type SourceFile,
  StringLiteral,
} from '../compiler/ast.js';
import { isGlobalScopeAugmentation } from '../compiler/ast-utilities.js';
import {
  getAssignmentDeclarationKind,
  getCombinedModifierFlags,
  getDeclarationOfKind,
  getNameOfDeclaration,
  getSourceFileOfNode,
  JSDeclarationKind,
} from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { getTypeOnlyAliasDeclaration, isTypeOnlyImportOrExportDeclaration } from '../compiler/checker-modules.js';
import {
  emptySymbolTable,
  getMergedSymbol,
  getSymbolFlags,
  isNonLocalAlias,
  resolveAlias,
} from '../compiler/checker-symbols.js';
import { isIdentifierPart, isIdentifierStart } from '../compiler/character-codes.js';
import type { Resolver } from '../compiler/module-resolution.js';
import { NameResolver, getLocalSymbolForExportDefault } from '../compiler/name-resolver.js';
import { ModuleKind } from '../compiler/options.js';
import {
  getAnyExtensionFromPath,
  getBaseFileName,
  getDirectoryPath,
  isExternalModuleNameRelative,
  removeExtension,
  removeFileExtension,
  resolvePath,
} from '../compiler/path.js';
import { stringToToken } from '../compiler/scanner.js';
import { CheckFlags, getDeclarations, InternalSymbolName, type Symbol, SymbolFlags } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { skipOuterExpressions, OuterExpressionKinds } from '../compiler/transformers/utilities.js';
import { getSymbolKind, ScriptElementKind } from './symbol-kinds.js';
import { getExportsOfModuleAsArray, isExternalModuleSymbol } from './completion-checker.js';
import { isNonContextualKeyword } from './completion-utilities.js';

// Module ids: a file module by its path, or an ambient module by its name.

/** The id of a file module. */
export function fileModuleId(path: string): string {
  return 'f' + path;
}

/** The id of an ambient module. */
export function ambientModuleId(specifier: string): string {
  return 'a' + specifier;
}

export function isAmbientModuleId(id: string): boolean {
  return id.startsWith('a');
}

/** A file module's path, or `''` for an ambient module. */
export function modulePathOfId(id: string): string {
  return id.startsWith('f') ? id.slice(1) : '';
}

/** An ambient module's name, or `''` for a file module. */
export function moduleSpecifierOfId(id: string): string {
  return id.startsWith('a') ? id.slice(1) : '';
}

/** How a module exports a name. */
export const enum ExportSyntax {
  None,
  /** `export const x = {}` */
  Modifier,
  /** `export { x }` */
  Named,
  /** `export default function f() {}` */
  DefaultModifier,
  /** `export default f` */
  DefaultDeclaration,
  /** `export = x` */
  Equals,
  /** `export as namespace x` */
  UMD,
  /** `export * from "module"` */
  Star,
  /** `module.exports = {}` */
  CommonJSModuleExports,
  /** `exports.x = {}` */
  CommonJSExportsProperty,
}

/** An export a module offers, and the export it resolves to when it is an alias. */
export class Export {
  moduleId: string;
  exportName: string;
  moduleFileName: string;
  /** For an augmentation of a relative module name that does not resolve, the name as written. */
  unresolvedModuleSpecifier = '';
  syntax: ExportSyntax;
  flags: SymbolFlags;
  localName = '';
  /** The module symbol's export this export was found on: `export=`, the export star, or `''`. */
  through = '';
  /** The export an alias resolves to: its module id and name, or `''` for none. */
  targetModuleId = '';
  targetExportName = '';
  isTypeOnly = false;
  scriptElementKind: ScriptElementKind = ScriptElementKind.Unknown;
  /** The path of the file the export was found in. */
  path: string;
  packageName: string;

  constructor(
    exportName: string,
    moduleId: string,
    moduleFileName: string,
    syntax: ExportSyntax,
    flags: SymbolFlags,
    path: string,
    packageName: string,
  ) {
    this.exportName = exportName;
    this.moduleId = moduleId;
    this.moduleFileName = moduleFileName;
    this.syntax = syntax;
    this.flags = flags;
    this.path = path;
    this.packageName = packageName;
  }

  /** The name the export is imported by. */
  name(): string {
    if (this.localName !== '') return this.localName;
    if (this.exportName === InternalSymbolName.ExportEquals) return this.targetExportName;
    return this.exportName;
  }

  /** Whether the importing file names it: an `export =` or a default export. */
  isRenameable(): boolean {
    return this.exportName === InternalSymbolName.ExportEquals || this.exportName === InternalSymbolName.Default;
  }

  ambientModuleName(): string {
    return moduleSpecifierOfId(this.moduleId);
  }

  /** An alias the extraction did not resolve. */
  isUnresolvedAlias(): boolean {
    return this.flags === SymbolFlags.Alias;
  }

  /** The id of this export, its module id and name. */
  exportKey(): string {
    return this.moduleId + '\u0000' + this.exportName;
  }

  /** The id of the export an alias resolves to, or `''`. */
  targetKey(): string {
    return this.targetModuleId === '' && this.targetExportName === ''
      ? ''
      : this.targetModuleId + '\u0000' + this.targetExportName;
  }
}

// The name index.

/**
 * The starts of the words of an identifier: its first character, a character after `_` (not before another `_`), and
 * an uppercase character after a lowercase one or before a lowercase one (`CamelCase`, `ParseURL`, `snake_case`).
 */
export function wordIndices(s: string): number[] {
  const indices: number[] = [];
  const chars = [...s];
  let byteIndex = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (i === 0) indices.push(0);
    else if (ch === '_') {
      if (i + 1 < chars.length && chars[i + 1] !== '_') indices.push(byteIndex + ch.length);
    } else if (isUpper(ch) && (isLower(chars[i - 1]!) || (i + 1 < chars.length && isLower(chars[i + 1]!)))) {
      indices.push(byteIndex);
    }
    byteIndex += ch.length;
  }
  return indices;
}

function isUpper(ch: string): boolean {
  return /^\p{Lu}$/u.test(ch);
}

function isLower(ch: string): boolean {
  return /^\p{Ll}$/u.test(ch);
}

// The uppercase of one character, or the character where it has no one-character uppercase.
function toUpper(ch: string): string {
  const upper = ch.toUpperCase();
  return [...upper].length === 1 ? upper : ch;
}

function toLower(ch: string): string {
  const lower = ch.toLowerCase();
  return [...lower].length === 1 ? lower : ch;
}

function lowerCase(s: string): string {
  let result = '';
  for (const ch of s) result += toLower(ch);
  return result;
}

/** Whether `str` has the characters of `pattern` in order, ignoring case. */
function containsCharsInOrder(str: string, pattern: string): boolean {
  const target = [...lowerCase(pattern)];
  let at = 0;
  for (const ch of lowerCase(str)) if (at < target.length && ch === target[at]) at++;
  return at === target.length;
}

/**
 * Exports by name: the first letter of each name, uppercase, and the first letter of each later word, lowercase, lead
 * to the exports with such a word.
 */
export class ExportIndex {
  readonly entries: Export[] = [];
  private readonly index = new Map<string, number[]>();

  insertAsWords(value: Export): void {
    const name = value.name();
    const entryIndex = this.entries.length;
    this.entries.push(value);
    const seen = new Set<string>();
    const indices = wordIndices(name);
    for (let i = 0; i < indices.length; i++) {
      const codePoint = name.codePointAt(indices[i]!);
      if (codePoint === undefined) continue;
      const first = String.fromCodePoint(codePoint);
      if (i === 0) {
        const key = toUpper(first);
        this.add(key, entryIndex);
        seen.add(key);
      } else {
        const key = toLower(first);
        if (!seen.has(key)) {
          this.add(key, entryIndex);
          seen.add(key);
        }
      }
    }
  }

  private add(key: string, entryIndex: number): void {
    const list = this.index.get(key);
    if (list === undefined) this.index.set(key, [entryIndex]);
    else list.push(entryIndex);
  }

  /** The exports named `name`, with case or without. */
  find(name: string, caseSensitive: boolean): Export[] {
    if (this.entries.length === 0 || name === '') return [];
    const candidates = this.index.get(toUpper([...name][0]!)) ?? [];
    const results: Export[] = [];
    for (const i of candidates) {
      const entry = this.entries[i]!;
      const entryName = entry.name();
      if (caseSensitive ? entryName === name : lowerCase(entryName) === lowerCase(name)) results.push(entry);
    }
    return results;
  }

  /**
   * The exports with a word starting with the first character of `prefix` whose names have the characters of
   * `prefix` in order, ignoring case; every export for an empty prefix. An export can be listed twice.
   */
  searchWordPrefix(prefixIn: string): Export[] {
    if (this.entries.length === 0) return [];
    if (prefixIn === '') return this.entries;
    const prefix = lowerCase(prefixIn);
    const first = [...prefix][0]!;
    const upper = toUpper(first);
    const lower = toLower(first);
    const nameStarts = this.index.get(upper) ?? [];
    const wordStarts = upper !== lower ? (this.index.get(lower) ?? []) : [];
    const results: Export[] = [];
    for (const starts of [nameStarts, wordStarts]) {
      for (const i of starts) {
        const entry = this.entries[i]!;
        if (containsCharsInOrder(entry.name(), prefix)) results.push(entry);
      }
    }
    return results;
  }
}

// Extraction.

/** The module id and file name of a module symbol: its file, or its ambient name and `''`. */
export function tryGetModuleIdAndFileNameOfModuleSymbol(
  symbol: Symbol,
): { moduleId: string; fileName: string } | undefined {
  if (!symbol.isExternalModule()) return undefined;
  const declaration = getNonAugmentationDeclaration(symbol);
  if (declaration === undefined) return undefined;
  if (declaration.kind === SyntaxKind.SourceFile) {
    const file = declaration as SourceFile;
    return { moduleId: fileModuleId(file.path), fileName: file.fileName };
  }
  if (isModuleWithStringLiteralName(declaration)) {
    return { moduleId: ambientModuleId((getName(declaration) as StringLiteral).text), fileName: '' };
  }
  return undefined;
}

/** The first declaration of a symbol that is not a module or global augmentation. */
export function getNonAugmentationDeclaration(symbol: Symbol): Node | undefined {
  for (const declaration of getDeclarations(symbol)) {
    if (!isExternalModuleAugmentation(declaration) && !isGlobalScopeAugmentation(declaration)) return declaration;
  }
  return undefined;
}

function isExternalModuleAugmentation(node: Node): boolean {
  return (
    isModuleWithStringLiteralName(node) &&
    node.parent !== undefined &&
    (node.parent.kind === SyntaxKind.SourceFile
      ? (node.parent as SourceFile).externalModuleIndicator !== undefined
      : node.parent.kind === SyntaxKind.ModuleBlock &&
        isModuleWithStringLiteralName(node.parent.parent!) &&
        node.parent.parent!.parent!.kind === SyntaxKind.SourceFile &&
        (node.parent.parent!.parent as SourceFile).externalModuleIndicator === undefined)
  );
}

export function isModuleWithStringLiteralName(node: Node): boolean {
  return node instanceof ModuleDeclaration && node.name.kind === SyntaxKind.StringLiteral;
}

/**
 * Extracts a file's exports with a checker only where binding does not tell: aliases that do not resolve to a local
 * declaration, and an export star's exports.
 */
export class ExportExtractor {
  private readonly localNameResolver = new NameResolver({});

  constructor(
    private readonly checker: Checker,
    private readonly packageName: string,
    private readonly moduleResolver: Resolver,
    private readonly toPath: (fileName: string) => string,
    // For a package's files, the real path of a file, which its module id is made from.
    private readonly realpath?: (fileName: string) => string,
  ) {}

  /** The module id of a file: of its real path for a package's files. */
  private getModuleId(file: SourceFile): string {
    return this.realpath === undefined
      ? fileModuleId(file.path)
      : fileModuleId(this.toPath(this.realpath(file.fileName)));
  }

  /** The module id of a module symbol, of its file's real path for a package's files. */
  private getModuleIdForSymbol(symbol: Symbol): string | undefined {
    const id = tryGetModuleIdAndFileNameOfModuleSymbol(symbol);
    if (id === undefined) return undefined;
    if (id.fileName !== '' && this.realpath !== undefined) {
      const declaration = getNonAugmentationDeclaration(symbol);
      if (declaration?.kind === SyntaxKind.SourceFile) return this.getModuleId(declaration as SourceFile);
    }
    return id.moduleId;
  }

  /** A module file's exports and its augmentations' exports, or a script's ambient modules' exports. */
  extractFromFile(file: SourceFile): Export[] {
    const symbol = getSymbol(file);
    if (symbol !== undefined) return this.extractFromModule(file, symbol);
    const exports: Export[] = [];
    if (file.ambientModuleNames.length > 0) {
      for (const statement of file.statements.nodes) {
        if (isModuleWithStringLiteralName(statement) && isNonPatternAmbientModuleDeclaration(file, statement)) {
          const name = (getName(statement) as StringLiteral).text;
          this.extractFromModuleDeclaration(statement, file, ambientModuleId(name), '', exports);
        }
      }
    }
    return exports;
  }

  private extractFromModule(file: SourceFile, symbol: Symbol): Export[] {
    const exports: Export[] = [];
    const moduleId = this.getModuleId(file);
    for (const [name, exported] of symbol.exports ?? emptySymbolTable) {
      this.extractFromSymbol(name, exported, moduleId, file.fileName, file, exports);
    }
    for (const name of file.moduleAugmentations) {
      const declaration = name.parent!;
      if (isGlobalScopeAugmentation(declaration)) continue;
      const augmented = (name as StringLiteral).text;
      let moduleId = ambientModuleId(augmented);
      let moduleFileName = '';
      let unresolvedModuleSpecifier = '';
      if (isExternalModuleNameRelative(augmented)) {
        const resolved = this.moduleResolver.resolveModuleName(augmented, file.fileName, ModuleKind.CommonJS);
        if (resolved.resolvedFileName !== '') {
          moduleFileName = resolved.resolvedFileName;
          moduleId = fileModuleId(this.toPath(moduleFileName));
        } else {
          moduleFileName = resolvePath(getDirectoryPath(file.fileName), augmented);
          moduleId = fileModuleId(this.toPath(moduleFileName));
          unresolvedModuleSpecifier = augmented;
        }
      }
      const start = exports.length;
      this.extractFromModuleDeclaration(declaration, file, moduleId, moduleFileName, exports);
      for (let i = start; i < exports.length; i++) exports[i]!.unresolvedModuleSpecifier = unresolvedModuleSpecifier;
    }
    return exports;
  }

  private extractFromModuleDeclaration(
    declaration: Node,
    file: SourceFile,
    moduleId: string,
    moduleFileName: string,
    exports: Export[],
  ): void {
    for (const [name, symbol] of getSymbol(declaration)?.exports ?? emptySymbolTable) {
      this.extractFromSymbol(name, symbol, moduleId, moduleFileName, file, exports);
    }
  }

  extractFromSymbol(
    name: string,
    symbol: Symbol,
    moduleId: string,
    moduleFileName: string,
    file: SourceFile,
    exports: Export[],
  ): void {
    if (shouldIgnoreSymbol(symbol)) return;
    const lease = new CheckerLease(this.checker);
    if (name === InternalSymbolName.ExportStar) {
      const parent = symbol.parent!;
      const all = getExportsOfModuleAsArray(lease.getChecker(), parent);
      // The file's own named exports are extracted on their own; only those of the star are added here.
      for (const [otherName, named] of parent.exports ?? emptySymbolTable) {
        if (otherName === InternalSymbolName.ExportStar) continue;
        const i = all.indexOf(named);
        if (i >= 0) all.splice(i, 1);
      }
      for (const reexported of all) {
        const exported = this.createExport(
          reexported,
          moduleId,
          moduleFileName,
          ExportSyntax.Star,
          file,
          lease,
        )?.exported;
        if (exported === undefined) continue;
        const reexportParent =
          reexported.parent === undefined ? undefined : getMergedSymbol(lease.getChecker(), reexported.parent);
        if (reexportParent?.isExternalModule() === true) {
          const targetModuleId = this.getModuleIdForSymbol(reexportParent);
          if (targetModuleId !== undefined) {
            exported.targetExportName = reexported.name;
            exported.targetModuleId = targetModuleId;
          }
        }
        exported.through = InternalSymbolName.ExportStar;
        exports.push(exported);
      }
      return;
    }

    const syntax = getSyntax(symbol);
    const created = this.createExport(symbol, moduleId, moduleFileName, syntax, file, lease);
    if (created === undefined) return;
    exports.push(created.exported);
    const target = created.target;
    if (target !== undefined) {
      if (syntax === ExportSyntax.Equals && (target.flags & SymbolFlags.Namespace) !== 0) {
        for (const [innerName, named] of target.exports ?? emptySymbolTable) {
          if (innerName === InternalSymbolName.ExportStar) continue;
          const inner = this.createExport(named, moduleId, moduleFileName, syntax, file, lease)?.exported;
          if (inner === undefined) continue;
          inner.through = name;
          exports.push(inner);
        }
      }
    } else if (syntax === ExportSyntax.CommonJSModuleExports) {
      const expression = (getDeclarations(symbol)[0] as BinaryExpression).right;
      if (expression instanceof ObjectLiteralExpression) {
        // Shorthand properties and properties with identifier names are taken as exports.
        const members = getSymbol(expression)?.members;
        for (const property of expression.properties.nodes) {
          if (
            property.kind === SyntaxKind.ShorthandPropertyAssignment ||
            (property instanceof PropertyAssignment && property.name.kind === SyntaxKind.Identifier)
          ) {
            const member = members?.get((getName(property) as Identifier).text);
            if (member === undefined) continue;
            const inner = this.createExport(member, moduleId, moduleFileName, syntax, file, lease)?.exported;
            if (inner === undefined) continue;
            inner.through = name;
            exports.push(inner);
          }
        }
      }
    }
  }

  /** The export of a symbol, and the symbol an alias resolves to. */
  private createExport(
    symbol: Symbol,
    moduleId: string,
    moduleFileName: string,
    syntax: ExportSyntax,
    file: SourceFile,
    lease: CheckerLease,
  ): { exported: Export; target: Symbol | undefined } | undefined {
    if (shouldIgnoreSymbol(symbol)) return undefined;
    const exported = new Export(
      symbol.name,
      moduleId,
      moduleFileName,
      syntax,
      symbol.combinedLocalAndExportSymbolFlags(),
      file.path,
      this.packageName,
    );
    if (syntax === ExportSyntax.UMD) {
      exported.exportName = InternalSymbolName.ExportEquals;
      exported.localName = symbol.name;
    }

    let target: Symbol | undefined;
    if ((symbol.flags & SymbolFlags.Alias) !== 0) {
      target = this.tryResolveSymbol(symbol, syntax, lease);
      if (target !== undefined) {
        const targetDeclarations = getDeclarations(target);
        let declaration: Node | undefined = targetDeclarations[0];
        if (declaration === undefined && (target.checkFlags & CheckFlags.Mapped) !== 0) {
          const mapped = lease.getChecker().symbolContainingTypes.get(target.id)?.symbol;
          if (mapped !== undefined) declaration = getDeclarations(mapped)[0];
        }
        declaration ??= getDeclarations(symbol)[0]!;
        let parent = target.parent;
        const checker = lease.tryChecker();
        if (checker !== undefined) {
          exported.flags = getSymbolFlags(checker, target);
          exported.isTypeOnly = getTypeOnlyAliasDeclaration(checker, symbol) !== undefined;
          parent = parent === undefined ? undefined : getMergedSymbol(checker, parent);
        } else {
          exported.flags = target.flags;
          exported.isTypeOnly = getDeclarations(symbol).some(isPartOfTypeOnlyImportOrExportDeclaration);
        }
        exported.scriptElementKind = getSymbolKind(lease.tryChecker(), target, declaration);
        let targetModuleId = fileModuleId(getSourceFileOfNode(declaration).path);
        if (parent?.isExternalModule() === true) {
          const id = this.getModuleIdForSymbol(parent);
          if (id !== undefined) targetModuleId = id;
        }
        exported.targetExportName = target.name;
        exported.targetModuleId = targetModuleId;
      }
    } else {
      exported.scriptElementKind = getSymbolKind(lease.tryChecker(), symbol, getDeclarations(symbol)[0]!);
    }

    if (symbol.name === InternalSymbolName.Default || symbol.name === InternalSymbolName.ExportEquals) {
      let named = getLocalSymbolForExportDefault(symbol) ?? symbol;
      exported.localName = getDefaultLikeExportNameFromDeclaration(named);
      if (isUnusableName(exported.localName)) exported.localName = exported.targetExportName;
      if (isUnusableName(exported.localName) && target !== undefined) {
        named = getLocalSymbolForExportDefault(target) ?? target;
        exported.localName = getDefaultLikeExportNameFromDeclaration(named);
      }
      if (isUnusableName(exported.localName)) {
        // From the file name, as written.
        exported.localName = moduleSpecifierToValidIdentifier(
          fileNameForDefaultExportName(target, moduleFileName, moduleId),
          false,
        );
      }
    }
    if (isUnusableName(exported.name())) return undefined;
    return { exported, target };
  }

  private tryResolveSymbol(symbol: Symbol, syntax: ExportSyntax, lease: CheckerLease): Symbol | undefined {
    if (!isNonLocalAlias(symbol, SymbolFlags.None)) return symbol;
    let location: Node | undefined;
    let name = '';
    switch (syntax) {
      case ExportSyntax.Named: {
        const declaration = getDeclarationOfKind(symbol, SyntaxKind.ExportSpecifier) as ExportSpecifier;
        if ((declaration.parent!.parent as ExportDeclaration).moduleSpecifier === undefined) {
          const n = declaration.name;
          if (n.kind === SyntaxKind.Identifier) {
            location = n;
            name = (n as Identifier).text;
          }
        }
        break;
      }
      case ExportSyntax.Equals:
      case ExportSyntax.DefaultDeclaration: {
        if (syntax === ExportSyntax.Equals && symbol.name !== InternalSymbolName.ExportEquals) break;
        const declaration = getDeclarationOfKind(symbol, SyntaxKind.ExportAssignment) as ExportAssignment;
        if (declaration.expression.kind === SyntaxKind.Identifier) {
          location = declaration.expression;
          name = (location as Identifier).text;
        }
        break;
      }
    }
    if (location !== undefined) {
      const local = this.localNameResolver.resolve(location, name, SymbolFlags.All, undefined, false, false);
      if (local !== undefined && !isNonLocalAlias(local, SymbolFlags.None)) return local;
    }
    const checker = lease.getChecker();
    const resolved = resolveAlias(checker, symbol);
    return resolved !== checker.unknownSymbol ? resolved : undefined;
  }
}

/** A checker that an export's extraction may need; whether it used it decides how the export is described. */
class CheckerLease {
  private used = false;

  constructor(private readonly checker: Checker) {}

  getChecker(): Checker {
    this.used = true;
    return this.checker;
  }

  tryChecker(): Checker | undefined {
    return this.used ? this.checker : undefined;
  }
}

// Whether a node is in a type-only import or export declaration.
function isPartOfTypeOnlyImportOrExportDeclaration(node: Node): boolean {
  for (let n: Node | undefined = node; n !== undefined; n = n.parent)
    if (isTypeOnlyImportOrExportDeclaration(n)) return true;
  return false;
}

function isNonPatternAmbientModuleDeclaration(file: SourceFile, declaration: Node): boolean {
  const symbol = getSymbol(declaration);
  for (const module of file.patternAmbientModules) if (module.symbol === symbol) return false;
  return true;
}

function shouldIgnoreSymbol(symbol: Symbol): boolean {
  return (symbol.flags & SymbolFlags.Prototype) !== 0;
}

function getSyntax(symbol: Symbol): ExportSyntax {
  for (const declaration of getDeclarations(symbol)) {
    switch (declaration.kind) {
      case SyntaxKind.ExportSpecifier:
        return ExportSyntax.Named;
      case SyntaxKind.ExportAssignment:
        return (declaration as ExportAssignment).isExportEquals ? ExportSyntax.Equals : ExportSyntax.DefaultDeclaration;
      case SyntaxKind.NamespaceExportDeclaration:
        return ExportSyntax.UMD;
      case SyntaxKind.BinaryExpression:
        switch (getAssignmentDeclarationKind(declaration)) {
          case JSDeclarationKind.ModuleExports:
            return ExportSyntax.CommonJSModuleExports;
          case JSDeclarationKind.ExportsProperty:
            return ExportSyntax.CommonJSExportsProperty;
        }
        break;
      default:
        return (getCombinedModifierFlags(declaration) & ModifierFlags.Default) !== 0
          ? ExportSyntax.DefaultModifier
          : ExportSyntax.Modifier;
    }
  }
  return ExportSyntax.None;
}

function isUnusableName(name: string): boolean {
  return (
    name === '' ||
    name === '_default' ||
    name === InternalSymbolName.ExportStar ||
    name === InternalSymbolName.Default ||
    name === InternalSymbolName.ExportEquals
  );
}

/** The name a default-like export is imported by, from its declarations; `''` for none. */
export function getDefaultLikeExportNameFromDeclaration(symbol: Symbol): string {
  for (const declaration of getDeclarations(symbol)) {
    // `export default x`
    if (declaration instanceof ExportAssignment) {
      const inner = skipOuterExpressions(declaration.expression, OuterExpressionKinds.All);
      if (inner instanceof Identifier) return inner.text;
      continue;
    }
    // `export { x as default }`
    if (declaration instanceof ExportSpecifier && getSymbol(declaration)?.flags === SymbolFlags.Alias) {
      if (declaration.propertyName !== undefined) {
        if (declaration.propertyName instanceof Identifier) return declaration.propertyName.text;
        continue;
      }
    }
    const name = getNameOfDeclaration(declaration);
    if (name instanceof Identifier) return name.text;
    if (symbol.parent !== undefined && !isExternalModuleSymbol(symbol.parent)) return symbol.parent.name;
  }
  return '';
}

// The file name a default export's fallback name is made from: the target's file, the module's file, or for an
// ambient module, its id.
function fileNameForDefaultExportName(target: Symbol | undefined, moduleFileName: string, moduleId: string): string {
  if (target !== undefined) {
    const declaration = getDeclarations(target)[0];
    if (declaration !== undefined) {
      const fileName = getSourceFileOfNode(declaration).fileName;
      if (fileName !== '') return fileName;
    }
  }
  if (moduleFileName !== '') return moduleFileName;
  return moduleId.slice(1);
}

/**
 * An identifier from a module specifier's base name without its extension and `/index`: its identifier characters,
 * each after a run of others uppercased, and `_` before it when it would be empty or a keyword.
 */
export function moduleSpecifierToValidIdentifier(moduleSpecifier: string, forceCapitalize: boolean): string {
  let specifier = removeAnyFileExtension(moduleSpecifier);
  if (specifier.endsWith('/index')) specifier = specifier.slice(0, -'/index'.length);
  const chars = [...getBaseFileName(specifier)];
  let result = '';
  let lastCharWasValid = true;
  if (chars.length > 0 && isIdentifierStart(chars[0]!.codePointAt(0)!)) {
    result += forceCapitalize ? toUpper(chars[0]!) : chars[0]!;
  } else lastCharWasValid = false;
  for (let i = 1; i < chars.length; i++) {
    const ch = chars[i]!;
    const isValid = isIdentifierPart(ch.codePointAt(0)!);
    if (isValid) result += lastCharWasValid ? ch : toUpper(ch);
    lastCharWasValid = isValid;
  }
  if (result !== '' && !isNonContextualKeyword(stringToToken(result))) return result;
  return '_' + result;
}

// The path without its extension: a known one, or else what follows the last `.` of its base name.
function removeAnyFileExtension(path: string): string {
  const withoutExtension = removeFileExtension(path);
  if (withoutExtension !== path) return withoutExtension;
  const extension = getAnyExtensionFromPath(path);
  return extension !== '' ? removeExtension(path, extension) : path;
}
