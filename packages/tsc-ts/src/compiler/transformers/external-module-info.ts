// What a module imports and exports, collected for module transforms.
import {
  BindingPattern,
  BindingElement,
  ClassDeclaration,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExternalModuleReference,
  FunctionDeclaration,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  ModifierFlags,
  NamedExports,
  NamedImports,
  NamespaceExport,
  NamespaceImport,
  type Node,
  NotEmittedStatement,
  type SourceFile,
  StringLiteral,
  VariableDeclaration,
  VariableStatement,
  getImportClause,
} from '../ast.js';
import { type CompilerOptions, ModuleKind, getEmitModuleKind } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import type { EmitHelper } from '../printer/helpers.js';
import { isFileLevelUniqueName } from '../printer/name-generator.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import type { EmitResolver } from './emit-resolver.js';
import { hasSyntacticModifier, isExternalModule } from './utilities.js';

export class ExternalModuleInfo {
  /** Imports and re-exports of other modules. */
  readonly externalImports: Node[];
  /** Export specifiers by local name, excluding re-exports. */
  readonly exportSpecifiers: Map<string, ExportSpecifier[]>;
  /** The export names of each local declaration. */
  readonly exportedBindings: Map<Node, Node[]>;
  /** Every exported name, except those of exported function declarations. */
  readonly exportedNames: Node[];
  /** Exported function declarations, in order. */
  readonly exportedFunctions: FunctionDeclaration[];
  exportEquals: ExportAssignment | undefined;
  hasExportStarsToExportValues: boolean;

  constructor() {
    this.externalImports = [];
    this.exportSpecifiers = new Map<string, ExportSpecifier[]>();
    this.exportedBindings = new Map<Node, Node[]>();
    this.exportedNames = [];
    this.exportedFunctions = [];
    this.exportEquals = undefined;
    this.hasExportStarsToExportValues = false;
  }

  getExportedBindings(declaration: Node): Node[] | undefined {
    return this.exportedBindings.get(declaration);
  }
}

export function collectExternalModuleInfo(
  file: SourceFile,
  context: EmitContext,
  resolver: EmitResolver,
): ExternalModuleInfo {
  return new ExternalModuleInfoCollector(context, resolver).collect(file);
}

class ExternalModuleInfoCollector {
  readonly context: EmitContext;
  readonly resolver: EmitResolver;
  readonly output: ExternalModuleInfo;
  private readonly uniqueExports: Set<string>;
  private readonly exportedFunctionSet: Set<Node>;
  private hasExportDefault: boolean;

  constructor(context: EmitContext, resolver: EmitResolver) {
    this.context = context;
    this.resolver = resolver;
    this.output = new ExternalModuleInfo();
    this.uniqueExports = new Set<string>();
    this.exportedFunctionSet = new Set<Node>();
    this.hasExportDefault = false;
  }

  collect(file: SourceFile): ExternalModuleInfo {
    const output = this.output;
    const statements = file.statements.nodes;
    for (let i = 0; i < statements.length; i++) {
      const node = statements[i];
      if (node instanceof NotEmittedStatement) {
        // `declare export = x` is elided but still collected.
        const original = this.context.mostOriginal(node);
        if (original instanceof ExportAssignment && original.isExportEquals && output.exportEquals === undefined)
          output.exportEquals = original;
        continue;
      }
      if (node instanceof ImportDeclaration) output.externalImports.push(node);
      else if (node instanceof ImportEqualsDeclaration) {
        if (node.moduleReference.kind === SyntaxKind.ExternalModuleReference) output.externalImports.push(node);
      } else if (node instanceof ExportDeclaration) this.collectExportDeclaration(node as ExportDeclaration);
      else if (node instanceof ExportAssignment) {
        if (node.isExportEquals && output.exportEquals === undefined) output.exportEquals = node;
      } else if (node instanceof VariableStatement) {
        if (hasSyntacticModifier(node, ModifierFlags.Export)) {
          const declarations = node.declarationList.declarations.nodes;
          for (let j = 0; j < declarations.length; j++) this.collectExportedVariableInfo(declarations[j]);
        }
      } else if (node instanceof FunctionDeclaration) {
        if (hasSyntacticModifier(node, ModifierFlags.Export))
          this.addExportedFunctionDeclaration(
            node as FunctionDeclaration,
            undefined,
            hasSyntacticModifier(node, ModifierFlags.Default),
          );
      } else if (node instanceof ClassDeclaration) {
        if (hasSyntacticModifier(node, ModifierFlags.Export)) this.collectExportedClass(node as ClassDeclaration);
      }
    }
    return output;
  }

  private collectExportDeclaration(node: ExportDeclaration): boolean {
    const output = this.output;
    if (node.moduleSpecifier === undefined) return this.addExportedNamesForExportDeclaration(node);
    output.externalImports.push(node);
    const clause = node.exportClause;
    if (clause === undefined) output.hasExportStarsToExportValues = true;
    else if (clause instanceof NamedExports) this.addExportedNamesForExportDeclaration(node);
    else if (clause instanceof NamespaceExport) {
      const name = clause.name;
      if (this.addUniqueExport(moduleExportNameText(name))) {
        this.addExportedBinding(node, name);
        output.exportedNames.push(name);
      }
    }
    return true;
  }

  private collectExportedClass(node: ClassDeclaration): boolean {
    if (hasSyntacticModifier(node, ModifierFlags.Default)) {
      if (!this.hasExportDefault) {
        const name: Node =
          node.name !== undefined ? node.name : this.context.factory.createGeneratedNameForNode(node, 0, '', '');
        this.addExportedBinding(node, name);
        this.hasExportDefault = true;
      }
    } else if (node.name !== undefined && this.addUniqueExport(node.name.text)) {
      this.addExportedBinding(node, node.name);
      this.output.exportedNames.push(node.name);
    }
    return true;
  }

  private addUniqueExport(name: string): boolean {
    if (this.uniqueExports.has(name)) return false;
    this.uniqueExports.add(name);
    return true;
  }

  private addExportedBinding(declaration: Node, name: Node): boolean {
    const key = this.context.mostOriginal(declaration);
    const names = this.output.exportedBindings.get(key);
    if (names === undefined) this.output.exportedBindings.set(key, [name]);
    else names.push(name);
    return true;
  }

  private addExportedNamesForExportDeclaration(node: ExportDeclaration): boolean {
    const clause = node.exportClause;
    if (!(clause instanceof NamedExports)) return false;
    const specifiers = clause.elements.nodes;
    for (let i = 0; i < specifiers.length; i++) {
      const specifier = specifiers[i];
      if (!(specifier instanceof ExportSpecifier)) continue;
      const exportName = moduleExportNameText(specifier.name);
      if (!this.addUniqueExport(exportName)) continue;
      const local = specifier.propertyName !== undefined ? specifier.propertyName : specifier.name;
      if (local instanceof Identifier) {
        if (node.moduleSpecifier === undefined) {
          const existing = this.output.exportSpecifiers.get(local.text);
          if (existing === undefined) this.output.exportSpecifiers.set(local.text, [specifier as ExportSpecifier]);
          else existing.push(specifier as ExportSpecifier);
        }
        const original = this.context.mostOriginal(local);
        let declaration: Node | undefined = undefined;
        if (original instanceof Identifier) {
          declaration = this.resolver.getReferencedImportDeclaration(original as Identifier);
          if (declaration === undefined)
            declaration = this.resolver.getReferencedValueDeclaration(original as Identifier);
        }
        if (declaration instanceof FunctionDeclaration) {
          this.uniqueExports.delete(exportName);
          this.addExportedFunctionDeclaration(declaration, specifier.name, exportName === 'default');
          continue;
        }
        if (declaration !== undefined) this.addExportedBinding(declaration, specifier.name);
      }
      this.output.exportedNames.push(specifier.name);
    }
    return true;
  }

  private addExportedFunctionDeclaration(node: FunctionDeclaration, name: Node | undefined, isDefault: boolean) {
    const key = this.context.mostOriginal(node);
    if (!this.exportedFunctionSet.has(key)) {
      this.exportedFunctionSet.add(key);
      if (key instanceof FunctionDeclaration) this.output.exportedFunctions.push(key as FunctionDeclaration);
    }
    if (isDefault) {
      if (!this.hasExportDefault) {
        this.addExportedBinding(
          node,
          name !== undefined ? name : this.context.factory.createGeneratedNameForNode(node, 0, '', ''),
        );
        this.hasExportDefault = true;
      }
      return true;
    }
    const exportName = name !== undefined ? name : node.name;
    if (exportName !== undefined && this.addUniqueExport(moduleExportNameText(exportName)))
      this.addExportedBinding(node, exportName);
    return true;
  }

  private collectExportedVariableInfo(declaration: Node): boolean {
    const name = declaration instanceof VariableDeclaration ? declaration.name : bindingElementName(declaration);
    if (name instanceof BindingPattern) {
      const elements = name.elements.nodes;
      for (let i = 0; i < elements.length; i++)
        if (bindingElementName(elements[i]) !== undefined) this.collectExportedVariableInfo(elements[i]);
      return true;
    }
    if (!(name instanceof Identifier) || this.context.hasAutoGenerateInfo(name)) return false;
    if (this.addUniqueExport(name.text)) {
      this.output.exportedNames.push(name);
      if ((this.context.getEmitFlags(name) & EmitFlags.LocalName) !== 0) this.addExportedBinding(declaration, name);
    }
    return true;
  }
}

function bindingElementName(node: Node): Node | undefined {
  return node instanceof BindingElement ? node.name : undefined;
}

export function moduleExportNameText(name: Node): string {
  if (name instanceof Identifier) return name.text;
  if (name instanceof StringLiteral) return name.text;
  return '';
}

/** `import * as ns` (or `export * as ns`), else undefined. */
export function getNamespaceDeclarationNode(node: Node): Node | undefined {
  if (node instanceof ImportDeclaration) {
    const clause = node.importClause;
    return clause !== undefined && clause.namedBindings instanceof NamespaceImport ? clause.namedBindings : undefined;
  }
  if (node instanceof ImportEqualsDeclaration) return node;
  if (node instanceof ExportDeclaration)
    return node.exportClause instanceof NamespaceExport ? node.exportClause : undefined;
  return undefined;
}

export function isDefaultImport(node: Node): boolean {
  const clause = getImportClause(node);
  return clause instanceof ImportClause && clause.name !== undefined;
}

function isNamedDefaultReference(specifier: Node): boolean {
  if (specifier instanceof ImportSpecifier)
    return (
      moduleExportNameText(specifier.propertyName !== undefined ? specifier.propertyName : specifier.name) === 'default'
    );
  if (specifier instanceof ExportSpecifier)
    return (
      moduleExportNameText(specifier.propertyName !== undefined ? specifier.propertyName : specifier.name) === 'default'
    );
  return false;
}

export function containsDefaultReference(node: Node | undefined): boolean {
  let elements: Node[] = [];
  if (node instanceof NamedImports) elements = node.elements.nodes;
  else if (node instanceof NamedExports) elements = node.elements.nodes;
  for (let i = 0; i < elements.length; i++) if (isNamedDefaultReference(elements[i])) return true;
  return false;
}

export function getImportNeedsImportStarHelper(node: ImportDeclaration): boolean {
  if (getNamespaceDeclarationNode(node) !== undefined) return true;
  const clause = node.importClause;
  if (clause === undefined || !(clause.namedBindings instanceof NamedImports)) return false;
  const elements = clause.namedBindings.elements.nodes;
  let defaultReferences = 0;
  for (let i = 0; i < elements.length; i++) if (isNamedDefaultReference(elements[i])) defaultReferences++;
  // Default references mixed with other names, or other names with a default import.
  return (
    (defaultReferences > 0 && defaultReferences !== elements.length) ||
    (elements.length - defaultReferences !== 0 && isDefaultImport(node))
  );
}

export function getImportNeedsImportDefaultHelper(node: ImportDeclaration): boolean {
  if (getImportNeedsImportStarHelper(node)) return false;
  if (isDefaultImport(node)) return true;
  const clause = node.importClause;
  return clause !== undefined && containsDefaultReference(clause.namedBindings);
}

const externalHelpersModuleNameText = 'tslib';

/**
 * With `importHelpers`, the import of the helpers a module uses: `import tslib = require("tslib")`
 * for CommonJS output, `import { __helper } from "tslib"` for ES modules.
 */
export function createExternalHelpersImportDeclarationIfNeeded(
  context: EmitContext,
  file: SourceFile,
  options: CompilerOptions,
  fileModuleKind: ModuleKind,
): Node | undefined {
  if (options.importHelpers !== true || !isEffectiveExternalModule(file, options)) return undefined;
  const factory = context.factory;
  const helpers = getImportedHelpers(context, file);
  const moduleKind = getEmitModuleKind(options);
  if (
    fileModuleKind === ModuleKind.CommonJS ||
    (fileModuleKind === ModuleKind.None && moduleKind === ModuleKind.CommonJS)
  ) {
    let moduleName = context.getExternalHelpersModuleName(file);
    if (moduleName === undefined) {
      if (helpers.length === 0) return undefined;
      moduleName = factory.createUniqueName(externalHelpersModuleNameText, GeneratedIdentifierFlags.None);
      context.setExternalHelpersModuleName(file, moduleName);
    }
    const declaration = factory.created(
      new ImportEqualsDeclaration(
        undefined,
        false,
        moduleName,
        factory.created(
          new ExternalModuleReference(factory.createStringLiteral(externalHelpersModuleNameText, TokenFlags.None)),
        ),
      ),
    );
    context.addEmitFlags(declaration, EmitFlags.CustomPrologue);
    return declaration;
  }
  const names: string[] = [];
  for (let i = 0; i < helpers.length; i++) {
    const importName = helpers[i].importName;
    if (importName.length > 0 && names.indexOf(importName) < 0) names.push(importName);
  }
  if (names.length === 0) return undefined;
  names.sort(compareStringsCaseSensitive);
  const specifiers: Node[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    // Aliased when the name is used in the file.
    specifiers.push(
      isFileLevelUniqueName(context.mostOriginal(file) as SourceFile, name)
        ? factory.created(new ImportSpecifier(false, undefined, factory.createIdentifier(name)))
        : factory.created(
            new ImportSpecifier(false, factory.createIdentifier(name), factory.createUnscopedHelperName(name)),
          ),
    );
  }
  context.addEmitFlags(context.mostOriginal(file), EmitFlags.ExternalHelpers);
  const declaration = factory.created(
    new ImportDeclaration(
      SyntaxKind.ImportDeclaration,
      undefined,
      factory.created(
        new ImportClause(undefined, undefined, factory.created(new NamedImports(factory.createNodeList(specifiers)))),
      ),
      factory.createStringLiteral(externalHelpersModuleNameText, TokenFlags.None),
      undefined,
    ),
  );
  context.addEmitFlags(declaration, EmitFlags.CustomPrologue);
  return declaration;
}

function getImportedHelpers(context: EmitContext, file: SourceFile): EmitHelper[] {
  const all = context.getEmitHelpers(file);
  const helpers: EmitHelper[] = [];
  if (all === undefined) return helpers;
  for (let i = 0; i < all.length; i++) if (!all[i].scoped) helpers.push(all[i]);
  return helpers;
}

function compareStringsCaseSensitive(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An ES module, or a CommonJS module emitted to a CommonJS-family module kind. */
export function isEffectiveExternalModule(file: SourceFile, options: CompilerOptions): boolean {
  if (isExternalModule(file)) return true;
  const kind = getEmitModuleKind(options);
  return (
    (kind === ModuleKind.CommonJS || (kind >= ModuleKind.Node16 && kind <= ModuleKind.NodeNext)) &&
    file.commonJSModuleIndicator !== undefined
  );
}
