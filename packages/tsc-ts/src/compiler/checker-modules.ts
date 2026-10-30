// External modules: resolving module specifiers, alias targets of imports and exports, module
// exports, import types, dynamic imports, and the semantic checks of import and export declarations.
//
// Module-not-found errors are reported on every resolution with an error node, as tsgo does: an
// unresolved `import { a } from "m"` reports once for the declaration and again for each use of `a`.
import { checkCollisionsForDeclarationName } from './checker-generated-code.js';
import { checkDeprecatedImportSpecifier } from './checker-deprecation.js';
import {
  type BinaryExpression,
  type CallExpression,
  type ExportAssignment,
  type ExportDeclaration,
  type HeritageClause,
  type ImportAttribute,
  type ImportAttributes,
  type ImportClause,
  type ImportDeclaration,
  type ImportEqualsDeclaration,
  type ImportTypeNode,
  type LiteralTypeNode,
  type MetaProperty,
  type ModuleDeclaration,
  type PatternAmbientModule,
  type NamedExports,
  type NamedImports,
  type Node,
  NodeFlags,
  type ObjectLiteralExpression,
  type QualifiedName,
  type SourceFile,
  type VariableDeclaration,
  ModifierFlags,
  getExpression,
  getInitializer,
  getIsTypeOnly,
  getLocals,
  getModuleSpecifier,
  getName,
  getPropertyName,
  getSymbol,
  getText,
  getType,
} from './ast.js';
import {
  getExternalModuleName,
  isAmbientModule,
  isImportCall,
  isFunctionLike,
  isGlobalScopeAugmentation,
  isInJSFile,
  isLiteralImportTypeNode,
  isRequireCall,
  isStringLiteralLike,
  isTypeOnly,
  nodeIsMissing,
  isImportPhaseMetaProperty,
  isSourcePhaseImport,
  isSourcePhaseImportCall,
} from './ast-utilities.js';
import {
  declarationNameToString,
  getDeclarationOfKind,
  getModifierFlags,
  isAccessExpression,
  getRootDeclaration,
  getSourceTextOfNode,
  getThisContainer,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isGlobalSourceFile,
  isJsonSourceFile,
  isModuleAugmentationExternal,
  isPartOfTypeQuery,
  isVariableDeclarationInitializedToRequire,
  moduleExportNameIsDefault,
} from './binder-utilities.js';
import {
  type Diagnostic,
  type DiagnosticMessage,
  Diagnostics,
  chainDiagnostic,
  RepopulateInfo,
  RepopulateKind,
} from './diagnostics.js';
import {
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  getAllowImportingTsExtensions,
  getEmitModuleKind,
  getModuleResolutionKind,
  getResolveJsonModule,
} from './options.js';
import {
  type ResolvedModule,
  getResolutionDiagnostic,
  getTypesPackageName,
  mangleScopedPackageName,
} from './module-resolution-types.js';
import { getResolutionModeOverride, moduleKindName } from './program-utilities.js';
import { hasExtension } from './vfs-match.js';
import { isNodeCoreModule } from './parser.js';
import {
  combinePaths,
  extensionIsTs,
  fileExtensionIsOneOf,
  getDeclarationFileExtension,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  isDeclarationFileName,
  isExternalModuleNameRelative,
  pathIsRelative,
  removeExtension,
  supportedTSExtensionsFlat,
  tryExtractTSExtension,
  tryGetExtensionFromPath,
} from './path.js';
import { ContainerFlags, getContainerFlags } from './binder.js';
import { SyntaxKind } from './syntax-kind.js';
import { isExpressionNode } from './transformers/alias-references.js';
import { type Checker, type CheckerHost, createDiagnosticForNode } from './checker.js';
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import { ObjectFlags, type Type, TypeFlags, SignatureKind } from './checker-types.js';
import {
  createAnonymousType,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  isEmptyObjectType,
  isErrorType,
} from './checker-type-factory.js';
import {
  getFullyQualifiedName,
  getMergedSymbol,
  getSpellingSuggestionForName,
  getSymbolFlags,
  getSymbolOfDeclaration,
  getSymbolOfMeaning,
  getDeclarationOfAliasSymbol,
  getExportSymbolOfValueSymbolIfExported,
  getExportsOfModule,
  getExportsOfSymbol,
  resolveAlias,
  resolveEntityName,
  resolveName,
  resolveSymbol,
  resolveSymbolEx,
  isNonLocalAlias,
  getCachedGlobalType,
} from './checker-symbols.js';
import { getTypeOfSymbol, getNullableType } from './checker-symbol-types.js';
import {
  getPropertyOfType,
  getPropertyOfTypeEx,
  getTypeOfPropertyOfType,
  getSignaturesOfStructuredType,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import { getTypeFromTypeNode, getTypeReferenceType } from './checker-type-nodes.js';
import { checkExpressionCached, getResolvedSymbol } from './checker-expressions.js';
import { isTypeAssignableTo, isTypeIdenticalTo, isTypeStrictSubtypeOf, checkTypeAssignableTo } from './relations.js';
import { getSpreadType } from './checker-object-literals.js';
import { checkExternalModuleExports, shouldCheckErasableSyntax } from './checker-declarations.js';
import { checkTypeNameIsReserved } from './checker-classes.js';
import { getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { isValidSpreadType } from './checker-destructuring.js';
import { createPromiseType } from './checker-iteration.js';
import { getInstantiationExpressionType } from './checker-calls.js';
import { symbolToString, typeToString } from './type-printer.js';
import { checkTypeAssignableToAndOptionallyElaborate } from './checker-expressions.js';
import { grammarErrorOnNode } from './checker-operators.js';
import {
  declarationAt,
  declarationCount,
  getDeclarations,
  getSymbolId,
  InternalSymbolName,
  setDeclarations,
  type Symbol,
  SymbolFlags,
  type SymbolTable,
  copyDeclarations,
} from './symbol.js';

// ---- Resolution

/** The module symbol `moduleReference` names, reporting it when it isn't found unless `ignoreErrors`. */
export function resolveExternalModuleName(
  c: Checker,
  location: Node,
  moduleReference: Node | undefined,
  ignoreErrors: boolean,
  importAttributesType: Type | undefined,
): Symbol | undefined {
  return resolveExternalModuleNameWorker(
    c,
    location,
    moduleReference,
    ignoreErrors ? undefined : getCannotResolveModuleNameError(c, moduleReference),
    ignoreErrors,
    false,
    importAttributesType,
  );
}

/** Node core modules suggest installing `@types/node`. */
function getCannotResolveModuleNameError(c: Checker, moduleReference: Node | undefined): DiagnosticMessage {
  if (
    moduleReference !== undefined &&
    moduleReference.kind === SyntaxKind.StringLiteral &&
    isNodeCoreModule(getText(moduleReference))
  ) {
    const types = c.compilerOptions.types;
    return types !== undefined && types.includes('*')
      ? Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_node_Try_npm_i_save_dev_types_Slashnode
      : Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_node_Try_npm_i_save_dev_types_Slashnode_and_then_add_node_to_the_types_field_in_your_tsconfig;
  }
  return Diagnostics.Cannot_find_module_0_or_its_corresponding_type_declarations;
}

export function resolveExternalModuleNameWorker(
  c: Checker,
  location: Node,
  moduleReference: Node | undefined,
  moduleNotFoundError: DiagnosticMessage | undefined,
  ignoreErrors: boolean,
  isForAugmentation: boolean,
  importAttributesType: Type | undefined,
): Symbol | undefined {
  if (moduleReference === undefined || !isStringLiteralLike(moduleReference)) return undefined;
  // A source phase import loads no module declarations.
  if (isSourcePhaseImport(moduleReference.parent!)) return undefined;
  return resolveExternalModule(
    c,
    location,
    getText(moduleReference),
    moduleNotFoundError,
    ignoreErrors ? undefined : moduleReference,
    isForAugmentation,
    importAttributesType,
  );
}

/** A `resolveExternalModule` result that reported nothing, and the arguments it was computed for. */
export class ModuleResolution {
  constructor(
    readonly moduleReference: string,
    readonly moduleNotFoundError: DiagnosticMessage | undefined,
    readonly isForAugmentation: boolean,
    readonly importAttributesType: Type | undefined,
    readonly symbol: Symbol | undefined,
  ) {}
}

/**
 * The module symbol `moduleReference` resolves to from `location`, reporting resolution errors at
 * `errorNode`. Each name an import or export declaration lists resolves its module specifier again,
 * with the same result and the same diagnostics: a result that reported nothing is kept for the
 * specifier and returned to later calls from the same declaration (`sharesSpecifierContext`).
 */
export function resolveExternalModule(
  c: Checker,
  location: Node,
  moduleReference: string,
  moduleNotFoundError: DiagnosticMessage | undefined,
  errorNode: Node | undefined,
  isForAugmentation: boolean,
  importAttributesType: Type | undefined,
): Symbol | undefined {
  // An augmentation merged later can give the resolved module a new merged symbol, so results are
  // kept only once every augmentation is merged.
  const shared = c.modulesMerged && errorNode !== undefined && sharesSpecifierContext(location, errorNode);
  if (shared) {
    const known = c.moduleResolutions.get(errorNode);
    if (
      known !== undefined &&
      known.moduleReference === moduleReference &&
      known.moduleNotFoundError === moduleNotFoundError &&
      known.isForAugmentation === isForAugmentation &&
      known.importAttributesType === importAttributesType
    )
      return known.symbol;
  }
  const reports = c.reports;
  const symbol = resolveExternalModuleWorker(
    c,
    location,
    moduleReference,
    moduleNotFoundError,
    errorNode,
    isForAugmentation,
    importAttributesType ?? c.emptyObjectType,
  );
  if (shared && c.reports === reports)
    c.moduleResolutions.set(
      errorNode,
      new ModuleResolution(moduleReference, moduleNotFoundError, isForAugmentation, importAttributesType, symbol),
    );
  return symbol;
}

/**
 * Whether a resolution from `location` with errors at `errorNode` depends on `location` only through
 * the declaration that `errorNode` is the module specifier of: `location` is that declaration, a
 * clause or specifier inside it, or the specifier itself. The resolution mode, the emittability of
 * the import and its resolution-mode attributes then all come from that declaration.
 */
function sharesSpecifierContext(location: Node, errorNode: Node): boolean {
  const declaration = errorNode.parent;
  if (
    declaration === undefined ||
    (declaration.kind !== SyntaxKind.ImportDeclaration &&
      declaration.kind !== SyntaxKind.JSImportDeclaration &&
      declaration.kind !== SyntaxKind.ExportDeclaration) ||
    getModuleSpecifier(declaration) !== errorNode
  )
    return false;
  for (let current: Node | undefined = location; current !== undefined; current = current.parent)
    switch (current.kind) {
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
      case SyntaxKind.ExportDeclaration:
        return current === declaration;
      case SyntaxKind.ImportClause:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.NamedExports:
      case SyntaxKind.NamespaceExport:
      case SyntaxKind.ExportSpecifier:
        break;
      default:
        if (current !== errorNode) return false;
    }
  return false;
}

function resolveExternalModuleWorker(
  c: Checker,
  location: Node,
  moduleReference: string,
  moduleNotFoundError: DiagnosticMessage | undefined,
  errorNode: Node | undefined,
  isForAugmentation: boolean,
  importAttributesType: Type,
): Symbol | undefined {
  if (errorNode !== undefined && moduleReference.startsWith('@types/'))
    c.error(
      errorNode,
      Diagnostics.Cannot_import_type_declaration_files_Consider_importing_0_instead_of_1,
      moduleReference.substring(7),
      moduleReference,
    );
  const ambient = tryFindAmbientModule(c, moduleReference, true);
  if (ambient !== undefined) return tryResolvePatternAmbientModule(c, ambient, moduleReference, importAttributesType);
  const importingFile = getSourceFileOfNode(location);
  const contextSpecifier = getContextSpecifier(location);
  const mode =
    contextSpecifier !== undefined && isStringLiteralLike(contextSpecifier)
      ? c.host.getModeForUsageLocation(importingFile, contextSpecifier)
      : c.host.getDefaultResolutionModeForFile(importingFile);
  const resolved = c.host.getResolvedModule(importingFile, moduleReference, mode);
  const isResolved = resolved !== undefined && resolved.resolvedFileName !== '';
  const resolutionDiagnostic =
    errorNode !== undefined && isResolved
      ? getResolutionDiagnostic(c.compilerOptions, resolved, importingFile.isDeclarationFile)
      : undefined;
  const file =
    isResolved &&
    (resolutionDiagnostic === undefined ||
      resolutionDiagnostic === Diagnostics.Module_0_was_resolved_to_1_but_jsx_is_not_set)
      ? c.host.getSourceFileForResolvedModule(resolved.resolvedFileName)
      : undefined;
  if (file !== undefined) {
    if (errorNode !== undefined) {
      // A resolution error is reported even though the file was found.
      if (resolutionDiagnostic !== undefined)
        c.error(errorNode, resolutionDiagnostic, moduleReference, resolved!.resolvedFileName);
      checkResolvedModuleExtension(c, location, moduleReference, resolved!, importingFile, mode, errorNode);
    }
    if (file.symbol !== undefined) {
      if (errorNode !== undefined) {
        if (resolved!.isExternalLibraryImport && !resolutionExtensionIsTSOrJson(resolved!.extension))
          errorOnImplicitAnyModule(c, false, errorNode, mode, resolved!, moduleReference);
        checkSyncImportOfESModule(c, location, moduleReference, importingFile, file, errorNode);
      }
      return tryResolvePatternAmbientModule(c, getMergedSymbol(c, file.symbol), moduleReference, importAttributesType);
    }
    const patternModule = tryResolvePatternAmbientModule(c, undefined, moduleReference, importAttributesType);
    if (patternModule !== undefined) return patternModule;
    if (errorNode !== undefined && moduleNotFoundError !== undefined && !isSideEffectImport(errorNode))
      c.error(errorNode, Diagnostics.File_0_is_not_a_module, resolved!.resolvedFileName);
    return undefined;
  }
  const patternModule = tryResolvePatternAmbientModule(c, undefined, moduleReference, importAttributesType);
  if (patternModule !== undefined) return patternModule;
  if (errorNode === undefined) return undefined;
  // A module that resolved to JavaScript is untyped.
  if (
    (isResolved && !resolutionExtensionIsTSOrJson(resolved.extension) && resolutionDiagnostic === undefined) ||
    resolutionDiagnostic === Diagnostics.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type
  ) {
    if (isForAugmentation)
      c.error(
        errorNode,
        Diagnostics.Invalid_module_name_in_augmentation_Module_0_resolves_to_an_untyped_module_at_1_which_cannot_be_augmented,
        moduleReference,
        resolved!.resolvedFileName,
      );
    else
      errorOnImplicitAnyModule(
        c,
        c.noImplicitAny && moduleNotFoundError !== undefined,
        errorNode,
        mode,
        resolved!,
        moduleReference,
      );
    return undefined;
  }
  if (moduleNotFoundError === undefined) return undefined;
  if (isResolved) {
    // A source file of a referenced project whose output hasn't been built.
    const outputDts = c.host.getProjectReferenceOutputDts(resolved.resolvedFileName);
    if (outputDts !== '') {
      c.error(
        errorNode,
        Diagnostics.Output_file_0_has_not_been_built_from_source_file_1,
        outputDts,
        resolved.resolvedFileName,
      );
      return undefined;
    }
  }
  if (resolutionDiagnostic !== undefined) {
    c.error(errorNode, resolutionDiagnostic, moduleReference, resolved!.resolvedFileName);
    return undefined;
  }
  const resolution = getModuleResolutionKind(c.compilerOptions);
  if (!getResolveJsonModule(c.compilerOptions) && moduleReference.endsWith('.json'))
    c.error(
      errorNode,
      Diagnostics.Cannot_find_module_0_Consider_using_resolveJsonModule_to_import_module_with_json_extension,
      moduleReference,
    );
  else if (
    mode === ModuleKind.ESNext &&
    (resolution === ModuleResolutionKind.Node16 || resolution === ModuleResolutionKind.NodeNext) &&
    pathIsRelative(moduleReference) &&
    !hasExtension(moduleReference)
  ) {
    const absolute = getNormalizedAbsolutePath(moduleReference, getDirectoryPath(importingFile.fileName));
    const extension = getSuggestedImportExtension(c, absolute);
    if (extension !== '')
      c.error(
        errorNode,
        Diagnostics.Relative_import_paths_need_explicit_file_extensions_in_ECMAScript_imports_when_moduleResolution_is_node16_or_nodenext_Did_you_mean_0,
        moduleReference + extension,
      );
    else
      c.error(
        errorNode,
        Diagnostics.Relative_import_paths_need_explicit_file_extensions_in_ECMAScript_imports_when_moduleResolution_is_node16_or_nodenext_Consider_adding_an_extension_to_the_import_path,
      );
  } else if (resolved !== undefined && resolved.alternateResult !== '')
    c.addDiagnostic(
      chainDiagnostic(
        createModuleNotFoundChain(c, errorNode, moduleReference, mode, moduleReference),
        moduleNotFoundError,
        moduleReference,
      ),
    );
  else c.error(errorNode, moduleNotFoundError, moduleReference);
  return undefined;
}

/**
 * The pattern ambient module `moduleReference` resolves to under `importAttributesType`, or
 * `resolvedSymbol`. Without import attributes a module found by name or resolution wins. Among the
 * patterns that match and accept the attributes, the one with the most specific attributes type wins,
 * then the one with the longest prefix.
 */
function tryResolvePatternAmbientModule(
  c: Checker,
  resolvedSymbol: Symbol | undefined,
  moduleReference: string,
  importAttributesType: Type,
): Symbol | undefined {
  if (resolvedSymbol !== undefined && isEmptyObjectType(c, importAttributesType)) return resolvedSymbol;
  if (c.patternAmbientModules.length === 0) return resolvedSymbol;
  const candidates: PatternAmbientModule[] = [];
  for (const pattern of c.patternAmbientModules)
    if (
      pattern.matches(moduleReference) &&
      isTypeAssignableTo(c, importAttributesType, getTypeOfModuleImportAttributes(c, pattern.symbol))
    )
      candidates.push(pattern);
  if (candidates.length === 0) return resolvedSymbol;
  let best = candidates[0]!;
  if (candidates.length > 1) {
    const bestTypeCandidates: PatternAmbientModule[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidateType = getTypeOfModuleImportAttributes(c, candidates[i]!.symbol);
      let isBest = true;
      for (let j = 0; j < candidates.length && isBest; j++) {
        const otherType = getTypeOfModuleImportAttributes(c, candidates[j]!.symbol);
        if (
          i !== j &&
          isTypeStrictSubtypeOf(c, otherType, candidateType) &&
          !isTypeIdenticalTo(c, otherType, candidateType)
        )
          isBest = false;
      }
      if (isBest) bestTypeCandidates.push(candidates[i]!);
    }
    // The pattern with the longest prefix wins.
    best = bestTypeCandidates[0]!;
    for (const pattern of bestTypeCandidates) if (pattern.starIndex > best.starIndex) best = pattern;
  }
  const merged = getMergedSymbol(c, best.symbol);
  const augmentation = c.patternAmbientModuleAugmentations.get(moduleReference);
  if (augmentation !== undefined && c.patternAmbientModuleAugmentationTargets.get(moduleReference) === merged)
    return getMergedSymbol(c, augmentation);
  return merged;
}

/** The import attributes type an ambient module declares, or the empty object type. */
export function getTypeOfModuleImportAttributes(c: Checker, symbol: Symbol): Type {
  let result = c.moduleImportAttributesTypes.get(symbol);
  if (result === undefined) {
    result = c.emptyObjectType;
    for (const declaration of getDeclarations(symbol))
      if (
        declaration.kind === SyntaxKind.ModuleDeclaration &&
        getName(declaration)!.kind === SyntaxKind.StringLiteral
      ) {
        const attributes = (declaration as ModuleDeclaration).attributes;
        if (attributes !== undefined) result = getTypeFromTypeNode(c, attributes);
        break;
      }
    c.moduleImportAttributesTypes.set(symbol, result);
  }
  return result;
}

/** The module specifier that decides the resolution mode of a module reference at `location`. */
function getContextSpecifier(location: Node): Node | undefined {
  const parent = location.parent;
  if (
    isStringLiteralLike(location) ||
    (parent !== undefined && parent.kind === SyntaxKind.ModuleDeclaration && getName(parent) === location)
  )
    return location;
  if (location.kind === SyntaxKind.ModuleDeclaration) return getName(location);
  if (isLiteralImportTypeNode(location)) return ((location as ImportTypeNode).argument as LiteralTypeNode).literal;
  const requireSpecifier = getModuleSpecifierOfBareOrAccessedRequire(location);
  if (requireSpecifier !== undefined) return requireSpecifier;
  for (let current: Node | undefined = location; current !== undefined; current = current.parent)
    if (isImportCall(current)) return (current as CallExpression).arguments.nodes[0];
  for (let current: Node | undefined = location; current !== undefined; current = current.parent)
    if (current.kind === SyntaxKind.ImportDeclaration || current.kind === SyntaxKind.JSImportDeclaration)
      return getModuleSpecifier(current);
  for (let current: Node | undefined = location; current !== undefined; current = current.parent)
    if (current.kind === SyntaxKind.ExportDeclaration) return getModuleSpecifier(current);
  for (let current: Node | undefined = location; current !== undefined; current = current.parent)
    if (current.kind === SyntaxKind.ImportEqualsDeclaration) {
      const reference = (current as ImportEqualsDeclaration).moduleReference;
      return reference.kind === SyntaxKind.ExternalModuleReference ? getExpression(reference) : undefined;
    }
  return undefined;
}

/** The specifier of `const x = require("m")` or `const x = require("m").a.b` in JavaScript. */
function getModuleSpecifierOfBareOrAccessedRequire(node: Node): Node | undefined {
  if (node.kind !== SyntaxKind.VariableDeclaration || !isInJSFile(node)) return undefined;
  const declaration = node as VariableDeclaration;
  let initializer = declaration.initializer;
  if (initializer === undefined || declaration.type !== undefined) return undefined;
  if ((getModifierFlags(declaration.parent!.parent!) & ModifierFlags.Export) !== 0) return undefined;
  while (isAccessExpression(initializer)) initializer = getExpression(initializer)!;
  return isRequireCall(initializer, true) ? (initializer as CallExpression).arguments.nodes[0] : undefined;
}

function resolutionExtensionIsTSOrJson(extension: string): boolean {
  return extensionIsTs(extension) || extension === '.json';
}

/** Imports that name a `.ts` file need `allowImportingTsExtensions`, and declaration files can't be imported. */
function checkResolvedModuleExtension(
  c: Checker,
  location: Node,
  moduleReference: string,
  resolved: ResolvedModule,
  importingFile: SourceFile,
  mode: ModuleKind,
  errorNode: Node,
): void {
  if (!resolved.resolvedUsingTsExtension) return;
  if (isDeclarationFileName(moduleReference)) {
    if (isInEmittableImport(location))
      c.error(
        errorNode,
        Diagnostics.A_declaration_file_cannot_be_imported_without_import_type_Did_you_mean_to_import_an_implementation_file_0_instead,
        getSuggestedImportSource(c, moduleReference, tryExtractTSExtension(moduleReference), mode),
      );
  } else if (
    !getAllowImportingTsExtensions(c.compilerOptions) &&
    !isDeclarationFileName(importingFile.fileName) &&
    isInEmittableImport(location)
  ) {
    let extension = tryExtractTSExtension(moduleReference);
    // A wildcard pattern can match a `.ts` extension that doesn't end the specifier.
    if (extension === '')
      for (const candidate of supportedTSExtensionsFlat)
        if (moduleReference.includes(candidate)) {
          extension = candidate;
          break;
        }
    c.error(
      errorNode,
      Diagnostics.An_import_path_can_only_end_with_a_0_extension_when_allowImportingTsExtensions_is_enabled,
      extension,
    );
  }
}

function isInEmittableImport(location: Node): boolean {
  for (let current: Node | undefined = location; current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.ImportDeclaration: {
        const clause = (current as ImportDeclaration).importClause;
        if (clause !== undefined && !isTypeOnly(clause)) return true;
        break;
      }
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
        if (!getIsTypeOnly(current)) return true;
        break;
      case SyntaxKind.CallExpression:
        if (isImportCall(current)) return true;
        break;
    }
  }
  return false;
}

/** The specifier to import instead of a declaration file: its `.js` counterpart when emitting ES modules. */
function getSuggestedImportSource(c: Checker, moduleReference: string, tsExtension: string, mode: ModuleKind): string {
  const withoutExtension = removeExtension(moduleReference, tsExtension);
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  if ((ModuleKind.ES2015 <= moduleKind && moduleKind <= ModuleKind.ESNext) || mode === ModuleKind.ESNext) {
    const preferTs = isDeclarationFileName(moduleReference) && getAllowImportingTsExtensions(c.compilerOptions);
    if (tsExtension === '.mts' || tsExtension === '.d.mts') return withoutExtension + (preferTs ? '.mts' : '.mjs');
    if (tsExtension === '.cts' || tsExtension === '.d.cts') return withoutExtension + (preferTs ? '.cts' : '.cjs');
    return withoutExtension + (preferTs ? '.ts' : '.js');
  }
  return withoutExtension;
}

function getSuggestedImportExtension(c: Checker, extensionlessPath: string): string {
  const host = c.host;
  if (host.fileExists(extensionlessPath + '.mts')) return '.mjs';
  if (host.fileExists(extensionlessPath + '.ts')) return '.js';
  if (host.fileExists(extensionlessPath + '.cts')) return '.cjs';
  if (host.fileExists(extensionlessPath + '.mjs')) return '.mjs';
  if (host.fileExists(extensionlessPath + '.js')) return '.js';
  if (host.fileExists(extensionlessPath + '.cjs')) return '.cjs';
  if (host.fileExists(extensionlessPath + '.tsx')) return c.compilerOptions.jsx === JsxEmit.Preserve ? '.jsx' : '.js';
  if (host.fileExists(extensionlessPath + '.jsx')) return '.jsx';
  if (host.fileExists(extensionlessPath + '.json')) return '.json';
  return '';
}

/** Under node16 and node18, a synchronous import of an ES module from a CommonJS file fails at run time. */
function checkSyncImportOfESModule(
  c: Checker,
  location: Node,
  moduleReference: string,
  importingFile: SourceFile,
  file: SourceFile,
  errorNode: Node,
): void {
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  if (moduleKind !== ModuleKind.Node16 && moduleKind !== ModuleKind.Node18) return;
  const importEquals = findAncestorOfKind(location, SyntaxKind.ImportEqualsDeclaration);
  const isSyncImport =
    (c.host.getDefaultResolutionModeForFile(importingFile) === ModuleKind.CommonJS && !isInImportCall(location)) ||
    importEquals !== undefined;
  if (!isSyncImport || c.host.getDefaultResolutionModeForFile(file) !== ModuleKind.ESNext) return;
  const overrideHost = findResolutionModeOverrideHost(location);
  if (overrideHost !== undefined && hasResolutionModeOverride(overrideHost)) return;
  if (importEquals !== undefined) {
    c.error(
      errorNode,
      Diagnostics.Module_0_cannot_be_imported_using_this_construct_The_specifier_only_resolves_to_an_ES_module_which_cannot_be_imported_with_require_Use_an_ECMAScript_import_instead,
      moduleReference,
    );
    return;
  }
  let details: Diagnostic | undefined;
  const extension = tryGetExtensionFromPath(importingFile.fileName);
  if (extension === '.ts' || extension === '.js' || extension === '.tsx' || extension === '.jsx') {
    details = detailsAt(errorNode, modeMismatchDetails(c.host, importingFile));
    details.repopulateInfo = new RepopulateInfo(RepopulateKind.ModeMismatch);
  }
  let message =
    Diagnostics.The_current_file_is_a_CommonJS_module_whose_imports_will_produce_require_calls_however_the_referenced_file_is_an_ECMAScript_module_and_cannot_be_imported_with_require_Consider_writing_a_dynamic_import_0_call_instead;
  if (overrideHost !== undefined && overrideHost.kind === SyntaxKind.ImportDeclaration) {
    const clause = (overrideHost as ImportDeclaration).importClause;
    if (clause !== undefined && isTypeOnly(clause))
      message =
        Diagnostics.Type_only_import_of_an_ECMAScript_module_from_a_CommonJS_module_must_have_a_resolution_mode_attribute;
  } else if (overrideHost !== undefined && overrideHost.kind === SyntaxKind.ImportType)
    message =
      Diagnostics.Type_import_of_an_ECMAScript_module_from_a_CommonJS_module_must_have_a_resolution_mode_attribute;
  c.addDiagnostic(
    details !== undefined
      ? chainDiagnostic(details, message, moduleReference)
      : createDiagnosticForNode(errorNode, message, [moduleReference]),
  );
}

function findAncestorOfKind(node: Node, kind: SyntaxKind): Node | undefined {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current.kind === kind) return current;
  return undefined;
}

function isInImportCall(node: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (isImportCall(current)) return true;
  return false;
}

function findResolutionModeOverrideHost(node: Node): Node | undefined {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    switch (current.kind) {
      case SyntaxKind.ImportType:
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
        return current;
    }
  return undefined;
}

function hasResolutionModeOverride(node: Node): boolean {
  let attributes: Node | undefined;
  if (node.kind === SyntaxKind.ImportType) attributes = (node as ImportTypeNode).attributes;
  else if (node.kind === SyntaxKind.ExportDeclaration) attributes = (node as ExportDeclaration).attributes;
  else attributes = (node as ImportDeclaration).attributes;
  return attributes !== undefined && getResolutionModeOverride(attributes as ImportAttributes) !== ModuleKind.None;
}

/** A message with its arguments, the elaboration of a diagnostic before it has a location. */
export class DiagnosticDetails {
  constructor(
    readonly message: DiagnosticMessage,
    readonly args: string[],
  ) {}
}

function detailsAt(node: Node, details: DiagnosticDetails): Diagnostic {
  return createDiagnosticForNode(node, details.message, details.args);
}

/**
 * How to make the CommonJS file `file` an ES module, elaborating an error about importing one from
 * it; also what an incremental build recomputes for a stored diagnostic (`RepopulateKind.ModeMismatch`).
 */
export function modeMismatchDetails(host: CheckerHost, file: SourceFile): DiagnosticDetails {
  const extension = tryGetExtensionFromPath(file.fileName);
  const targetExtension = extension === '.ts' ? '.mts' : extension === '.js' ? '.mjs' : '';
  const metadata = host.getSourceFileMetadata(file);
  const packageJsonDirectory = metadata !== undefined ? metadata.packageJsonDirectory : '';
  if (packageJsonDirectory !== '' && metadata!.packageJsonType === '') {
    const packageJson = combinePaths(packageJsonDirectory, 'package.json');
    return targetExtension !== ''
      ? new DiagnosticDetails(
          Diagnostics.To_convert_this_file_to_an_ECMAScript_module_change_its_file_extension_to_0_or_add_the_field_type_Colon_module_to_1,
          [targetExtension, packageJson],
        )
      : new DiagnosticDetails(
          Diagnostics.To_convert_this_file_to_an_ECMAScript_module_add_the_field_type_Colon_module_to_0,
          [packageJson],
        );
  }
  return targetExtension !== ''
    ? new DiagnosticDetails(
        Diagnostics.To_convert_this_file_to_an_ECMAScript_module_change_its_file_extension_to_0_or_create_a_local_package_json_file_with_type_Colon_module,
        [targetExtension],
      )
    : new DiagnosticDetails(
        Diagnostics.To_convert_this_file_to_an_ECMAScript_module_create_a_local_package_json_file_with_type_Colon_module,
        [],
      );
}

/** Reports a module without types: an error under `noImplicitAny`, otherwise a suggestion. */
function errorOnImplicitAnyModule(
  c: Checker,
  isError: boolean,
  errorNode: Node,
  mode: ModuleKind,
  resolved: ResolvedModule,
  moduleReference: string,
): void {
  if (isSideEffectImport(errorNode)) return;
  const packageName = resolved.packageId !== undefined ? resolved.packageId.name : '';
  const chain =
    !isExternalModuleNameRelative(moduleReference) && packageName !== ''
      ? createModuleNotFoundChain(c, errorNode, moduleReference, mode, packageName)
      : undefined;
  const message = Diagnostics.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type;
  c.addErrorOrSuggestion(
    isError,
    chain !== undefined
      ? chainDiagnostic(chain, message, moduleReference, resolved.resolvedFileName)
      : createDiagnosticForNode(errorNode, message, [moduleReference, resolved.resolvedFileName]),
  );
}

/** Where types for a module might come from, elaborating an error about a module without them. */
function createModuleNotFoundChain(
  c: Checker,
  errorNode: Node,
  moduleReference: string,
  mode: ModuleKind,
  packageName: string,
): Diagnostic {
  const file = getSourceFileOfNode(errorNode);
  const result = detailsAt(errorNode, moduleNotFoundDetails(c.host, file, moduleReference, mode, packageName));
  result.repopulateInfo = new RepopulateInfo(
    RepopulateKind.ModuleNotFound,
    moduleReference,
    mode,
    packageName === moduleReference ? '' : packageName,
  );
  return result;
}

/**
 * Where types for `moduleReference`, imported by `file`, might come from; also what an incremental
 * build recomputes for a stored diagnostic (`RepopulateKind.ModuleNotFound`).
 */
export function moduleNotFoundDetails(
  host: CheckerHost,
  file: SourceFile,
  moduleReference: string,
  mode: ModuleKind,
  packageNameIn: string,
): DiagnosticDetails {
  let packageName = packageNameIn;
  const resolved = host.getResolvedModule(file, moduleReference, mode);
  if (resolved !== undefined && resolved.alternateResult !== '') {
    if (resolved.alternateResult.includes('/node_modules/@types/'))
      packageName = '@types/' + mangleScopedPackageName(packageName);
    return new DiagnosticDetails(
      Diagnostics.There_are_types_at_0_but_this_result_could_not_be_resolved_when_respecting_package_json_exports_The_1_library_may_need_to_update_its_package_json_or_typings,
      [resolved.alternateResult, packageName],
    );
  }
  const packages = host.getPackagesMap();
  if (packages.has(getTypesPackageName(packageName)))
    return new DiagnosticDetails(
      Diagnostics.If_the_0_package_actually_exposes_this_module_consider_sending_a_pull_request_to_amend_https_Colon_Slash_Slashgithub_com_SlashDefinitelyTyped_SlashDefinitelyTyped_Slashtree_Slashmaster_Slashtypes_Slash_1,
      [packageName, mangleScopedPackageName(packageName)],
    );
  if (packages.get(packageName) === true)
    return new DiagnosticDetails(
      Diagnostics.If_the_0_package_actually_exposes_this_module_try_adding_a_new_declaration_d_ts_file_containing_declare_module_1,
      [packageName, moduleReference],
    );
  return new DiagnosticDetails(
    Diagnostics.Try_npm_i_save_dev_types_Slash_1_if_it_exists_or_add_a_new_declaration_d_ts_file_containing_declare_module_0,
    [moduleReference, mangleScopedPackageName(packageName)],
  );
}

function isSideEffectImport(node: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined && current.kind !== SyntaxKind.ImportDeclaration) current = current.parent;
  return current !== undefined && (current as ImportDeclaration).importClause === undefined;
}

export function tryFindAmbientModule(c: Checker, moduleName: string, withAugmentations: boolean): Symbol | undefined {
  if (isExternalModuleNameRelative(moduleName)) return undefined;
  const symbol = getSymbolOfMeaning(c, c.globals, '"' + moduleName + '"', SymbolFlags.ValueModule);
  return symbol !== undefined && withAugmentations ? getMergedSymbol(c, symbol) : symbol;
}

/** The `export =` target of a module, or the module itself. */
export function resolveExternalModuleSymbol(
  c: Checker,
  moduleSymbol: Symbol | undefined,
  dontResolveAlias: boolean,
): Symbol | undefined {
  if (moduleSymbol === undefined) return undefined;
  const exportEquals = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  if (exportEquals === undefined) return moduleSymbol;
  return getMergedSymbol(c, resolveSymbolEx(c, exportEquals, dontResolveAlias));
}

/** The module as a namespace: removes call and construct signatures, or wraps it with a synthetic default. */
export function resolveESModuleSymbol(
  c: Checker,
  moduleSymbol: Symbol | undefined,
  node: Node,
  moduleSpecifier: Node,
): Symbol | undefined {
  let symbol = resolveExternalModuleSymbol(c, moduleSymbol, true);
  if (symbol !== undefined && isNonLocalAlias(symbol, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace)) {
    const source = getSymbolOfDeclaration(c, node);
    symbol = getMergedSymbol(
      c,
      source !== undefined ? resolveIndirectionAlias(c, source, symbol) : resolveAlias(c, symbol),
    );
  }
  if (symbol === undefined || moduleSymbol === undefined) return symbol;
  const referenceParent = moduleSpecifier.parent!;
  const namespaceImport =
    referenceParent.kind === SyntaxKind.ImportDeclaration ? getNamespaceImport(referenceParent) : undefined;
  if (namespaceImport === undefined && !isImportCall(referenceParent)) return symbol;
  const reference = isImportCall(referenceParent)
    ? (referenceParent as CallExpression).arguments.nodes[0]!
    : getModuleSpecifier(referenceParent)!;
  const type = getTypeOfSymbol(c, symbol);
  const defaultOnlyType = getTypeWithSyntheticDefaultOnly(
    c,
    type,
    symbol,
    moduleSymbol,
    reference,
    getImportAttributesTypeForModuleSpecifier(c, reference),
  );
  if (defaultOnlyType !== undefined) return cloneTypeAsModuleType(c, symbol, defaultOnlyType);
  if (hasSignatures(c, type) || getPropertyOfTypeEx(c, type, InternalSymbolName.Default, true, false) !== undefined) {
    const moduleType =
      (type.flags & TypeFlags.StructuredType) !== 0
        ? getTypeWithSyntheticDefaultImportType(c, type, symbol, moduleSymbol, reference)
        : createDefaultPropertyWrapperForModule(c, symbol, symbol.parent, undefined);
    return cloneTypeAsModuleType(c, symbol, moduleType);
  }
  return symbol;
}

function getNamespaceImport(declaration: Node): Node | undefined {
  const clause = (declaration as ImportDeclaration).importClause;
  const bindings = clause?.namedBindings;
  return bindings !== undefined && bindings.kind === SyntaxKind.NamespaceImport ? bindings : undefined;
}

function hasSignatures(c: Checker, type: Type): boolean {
  return (
    getSignaturesOfStructuredType(c, type, SignatureKind.Call).length > 0 ||
    getSignaturesOfStructuredType(c, type, SignatureKind.Construct).length > 0
  );
}

/**
 * Whether the module `usage` names is a JSON module imported into an ES module under `--module node16` to
 * `nodenext`, which Node.js gives only a default export.
 */
function isOnlyImportableAsDefault(
  c: Checker,
  usage: Node,
  resolvedModule: Symbol | undefined,
  importAttributesType: Type | undefined,
): boolean {
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  if (moduleKind < ModuleKind.Node16 || moduleKind > ModuleKind.NodeNext) return false;
  if (getEmitSyntaxForModuleSpecifierExpression(c, usage) !== ModuleKind.ESNext) return false;
  const moduleSymbol = resolvedModule ?? resolveExternalModuleName(c, usage, usage, true, importAttributesType);
  const targetFile = moduleSymbol !== undefined ? getSourceFileOfModuleSymbol(moduleSymbol) : undefined;
  return (
    targetFile !== undefined &&
    (isJsonSourceFile(targetFile) ||
      (targetFile.fileName.endsWith('.d.json.ts') && getDeclarationFileExtension(targetFile.fileName) === '.d.json.ts'))
  );
}

/** The source file that declares a module: its value declaration, or its first declaration that is not an augmentation. */
function getSourceFileOfModuleSymbol(symbol: Symbol): SourceFile | undefined {
  let declaration = symbol.valueDeclaration;
  if (declaration === undefined)
    for (const d of getDeclarations(symbol))
      if (!(isAmbientModule(d) && isModuleAugmentationExternal(d)) && !isGlobalScopeAugmentation(d)) {
        declaration = d;
        break;
      }
  return declaration !== undefined ? getSourceFileOfNode(declaration) : undefined;
}

/** For a module only importable as default, the type of its namespace: an object with only `default`. */
function getTypeWithSyntheticDefaultOnly(
  c: Checker,
  type: Type,
  symbol: Symbol,
  originalSymbol: Symbol,
  moduleSpecifier: Node,
  importAttributesType: Type | undefined,
): Type | undefined {
  if (!isOnlyImportableAsDefault(c, moduleSpecifier, undefined, importAttributesType) || isErrorType(c, type))
    return undefined;
  const key = 'defaultOnly:' + type.id;
  const cached = c.moduleTypeCache.get(key);
  if (cached !== undefined) return cached;
  const result = createDefaultPropertyWrapperForModule(c, symbol, originalSymbol, undefined);
  c.moduleTypeCache.set(key, result);
  return result;
}

/** `type` with a `default` member for the module, when the module may not have a real one. */
function getTypeWithSyntheticDefaultImportType(
  c: Checker,
  type: Type,
  symbol: Symbol,
  originalSymbol: Symbol,
  moduleSpecifier: Node,
): Type {
  if (isErrorType(c, type)) return type;
  const key = 'synthetic:' + type.id;
  const cached = c.moduleTypeCache.get(key);
  if (cached !== undefined) return cached;
  const file = getSourceFileDeclaration(originalSymbol);
  let result = type;
  if (canHaveSyntheticDefault(c, file, originalSymbol, false, moduleSpecifier)) {
    const anonymousSymbol = c.newSymbol(SymbolFlags.TypeLiteral, InternalSymbolName.Type);
    copyDeclarations(anonymousSymbol, originalSymbol);
    const defaultContainingObject = createDefaultPropertyWrapperForModule(c, symbol, originalSymbol, anonymousSymbol);
    c.symbolTypes.set(getSymbolId(anonymousSymbol), defaultContainingObject);
    result = isValidSpreadType(c, type)
      ? getSpreadType(c, type, defaultContainingObject, anonymousSymbol, ObjectFlags.None, false)
      : defaultContainingObject;
  }
  c.moduleTypeCache.set(key, result);
  return result;
}

function createDefaultPropertyWrapperForModule(
  c: Checker,
  symbol: Symbol,
  originalSymbol: Symbol | undefined,
  anonymousSymbol: Symbol | undefined,
): Type {
  const defaultSymbol = c.newSymbol(SymbolFlags.Alias, InternalSymbolName.Default);
  defaultSymbol.parent = originalSymbol;
  const links = c.symbolLinks(defaultSymbol);
  const id = defaultSymbol.id;
  c.symbolNameTypes.set(id, getStringLiteralType(c, 'default'));
  links.aliasTarget = resolveSymbol(c, symbol);
  const members: SymbolTable = new Map<string, Symbol>();
  members.set(InternalSymbolName.Default, defaultSymbol);
  if (anonymousSymbol === undefined && originalSymbol !== undefined) {
    anonymousSymbol = c.newSymbol(SymbolFlags.ObjectLiteral, InternalSymbolName.Object);
    copyDeclarations(anonymousSymbol, originalSymbol);
  }
  return createAnonymousType(c, anonymousSymbol, members, [], [], []);
}

function cloneTypeAsModuleType(c: Checker, symbol: Symbol, moduleType: Type): Symbol {
  const result = c.newSymbol(symbol.flags, symbol.name);
  setDeclarations(result, getDeclarations(symbol).slice());
  result.valueDeclaration = symbol.valueDeclaration;
  if (symbol.members !== undefined) result.members = new Map(symbol.members);
  if (symbol.exports !== undefined) result.exports = new Map(symbol.exports);
  result.parent = symbol.parent;
  const resolved = resolveStructuredTypeMembers(c, moduleType);
  c.symbolTypes.set(getSymbolId(result), createAnonymousType(c, result, resolved.members, [], [], resolved.indexInfos));
  return result;
}

function getSourceFileDeclaration(symbol: Symbol | undefined): SourceFile | undefined {
  if (symbol === undefined) return undefined;
  for (const d of getDeclarations(symbol)) if (d.kind === SyntaxKind.SourceFile) return d as SourceFile;
  return undefined;
}

/** The module syntax of the import or export containing `usage`, or `None` for non-literals. */
export function getEmitSyntaxForModuleSpecifierExpression(c: Checker, usage: Node): ModuleKind {
  return isStringLiteralLike(usage)
    ? c.host.getEmitSyntaxForUsageLocation(getSourceFileOfNode(usage), usage)
    : ModuleKind.None;
}

/** Whether a default import of the module gets the module itself, as interop helpers make it. */
function canHaveSyntheticDefault(
  c: Checker,
  file: SourceFile | undefined,
  moduleSymbol: Symbol,
  dontResolveAlias: boolean,
  usage: Node,
): boolean {
  const usageMode = file !== undefined ? getEmitSyntaxForModuleSpecifierExpression(c, usage) : ModuleKind.None;
  if (file !== undefined && usageMode !== ModuleKind.None) {
    const targetMode = c.host.getImpliedNodeFormatForEmit(file);
    const moduleKind = getEmitModuleKind(c.compilerOptions);
    // In Node.js, CommonJS modules always have a synthetic default when imported into ESM.
    if (
      usageMode === ModuleKind.ESNext &&
      targetMode === ModuleKind.CommonJS &&
      moduleKind >= ModuleKind.Node16 &&
      moduleKind <= ModuleKind.NodeNext
    )
      return true;
    // Two ES modules never have a synthetic default.
    if (usageMode === ModuleKind.ESNext && targetMode === ModuleKind.ESNext) return false;
  }
  if (file === undefined || file.isDeclarationFile) {
    // A syntactic default export or an `__esModule` marker rules it out.
    const defaultExport = resolveExportByName(c, moduleSymbol, InternalSymbolName.Default, undefined, true);
    if (defaultExport !== undefined && hasSyntacticDefault(defaultExport)) return false;
    return resolveExportByName(c, moduleSymbol, '__esModule', undefined, dontResolveAlias) === undefined;
  }
  // TypeScript files are emitted with `__esModule` unless they use `export =`.
  if (!isInJSFile(file)) return hasExportAssignmentSymbol(moduleSymbol);
  // JavaScript files without ES module syntax or an `__esModule` marker have one.
  return (
    (file.externalModuleIndicator === undefined || file.externalModuleIndicator === file) &&
    resolveExportByName(c, moduleSymbol, '__esModule', undefined, dontResolveAlias) === undefined
  );
}

function hasSyntacticDefault(symbol: Symbol): boolean {
  for (const d of getDeclarations(symbol)) if (isSyntacticDefault(d)) return true;
  return false;
}

function isSyntacticDefault(node: Node): boolean {
  return (
    (node.kind === SyntaxKind.ExportAssignment && !(node as ExportAssignment).isExportEquals) ||
    hasSyntacticModifier(node, ModifierFlags.Default) ||
    node.kind === SyntaxKind.ExportSpecifier ||
    node.kind === SyntaxKind.NamespaceExport
  );
}

function hasExportAssignmentSymbol(moduleSymbol: Symbol): boolean {
  return moduleSymbol.exports?.get(InternalSymbolName.ExportEquals) !== undefined;
}

function isShorthandAmbientModuleSymbol(symbol: Symbol | undefined): boolean {
  const d = symbol?.valueDeclaration;
  return d !== undefined && d.kind === SyntaxKind.ModuleDeclaration && (d as ModuleDeclaration).body === undefined;
}

// ---- Alias targets

/** The symbol an alias declaration refers to, without resolving further aliases. */
export function getTargetOfAliasDeclaration(c: Checker, node: Node | undefined): Symbol | undefined {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.VariableDeclaration:
      return getTargetOfImportEqualsDeclaration(c, node);
    case SyntaxKind.ImportClause:
      return getTargetOfImportClause(c, node);
    case SyntaxKind.NamespaceImport:
      return getTargetOfNamespaceImport(c, node);
    case SyntaxKind.NamespaceExport:
      return getTargetOfNamespaceExport(c, node);
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.BindingElement:
      return getTargetOfImportSpecifier(c, node);
    case SyntaxKind.ExportSpecifier:
      return getTargetOfExportSpecifier(c, node, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace, true);
    case SyntaxKind.ExportAssignment:
      // An export assignment in a namespace is an error, and its expression is not resolved.
      if (isContainedByNamespace(node)) return undefined;
      return withTypeOnlyMark(c, node, getTargetOfAliasLikeExpression(c, getExpression(node)!));
    case SyntaxKind.BinaryExpression:
      return withTypeOnlyMark(c, node, getTargetOfAliasLikeExpression(c, (node as BinaryExpression).right));
    case SyntaxKind.NamespaceExportDeclaration: {
      const resolved = resolveExternalModuleSymbol(c, getSymbol(node.parent!), true);
      markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
      return resolved;
    }
    case SyntaxKind.ShorthandPropertyAssignment:
      return resolveEntityName(
        c,
        getName(node)!,
        SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
        true,
        true,
        undefined,
      );
    case SyntaxKind.PropertyAssignment:
      return getTargetOfAliasLikeExpression(c, getInitializer(node)!);
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.PropertyAccessExpression: {
      const parent = node.parent;
      if (
        parent !== undefined &&
        parent.kind === SyntaxKind.BinaryExpression &&
        (parent as BinaryExpression).left === node &&
        (parent as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken
      )
        return getTargetOfAliasLikeExpression(c, (parent as BinaryExpression).right);
      return undefined;
    }
  }
  return undefined;
}

function withTypeOnlyMark(c: Checker, node: Node, resolved: Symbol | undefined): Symbol | undefined {
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfImportEqualsDeclaration(c: Checker, node: Node): Symbol | undefined {
  if (node.kind === SyntaxKind.VariableDeclaration || isExternalModuleImportEquals(node)) {
    const moduleReference = isVariableDeclarationInitializedToRequire(node)
      ? (getInitializer(node) as CallExpression).arguments.nodes[0]!
      : getExpression((node as ImportEqualsDeclaration).moduleReference);
    const immediate = resolveExternalModuleName(c, node, moduleReference, false, undefined);
    const resolved = resolveExternalModuleSymbol(c, immediate, true);
    const moduleKind = getEmitModuleKind(c.compilerOptions);
    if (resolved !== undefined && moduleKind >= ModuleKind.Node20 && moduleKind <= ModuleKind.NodeNext) {
      const moduleExports = getExportOfModule(c, resolved, InternalSymbolName.ModuleExports, node, true);
      if (moduleExports !== undefined) return moduleExports;
    }
    markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
    return resolved;
  }
  const resolved = getSymbolOfPartOfRightHandSideOfImportEquals(c, (node as ImportEqualsDeclaration).moduleReference);
  checkAndReportErrorForResolvingImportAliasToTypeOnlySymbol(c, node as ImportEqualsDeclaration);
  return resolved;
}

function isExternalModuleImportEquals(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ImportEqualsDeclaration &&
    (node as ImportEqualsDeclaration).moduleReference.kind === SyntaxKind.ExternalModuleReference
  );
}

/**
 * Resolves the entity name of `import a = b.c`: `b` alone or the left part of a longer name is a
 * namespace, the whole name any meaning.
 */
export function getSymbolOfPartOfRightHandSideOfImportEquals(c: Checker, entityName: Node): Symbol | undefined {
  if (
    entityName.kind === SyntaxKind.Identifier &&
    entityName.parent !== undefined &&
    entityName.parent.kind === SyntaxKind.QualifiedName &&
    (entityName.parent as QualifiedName).right === entityName
  )
    entityName = entityName.parent;
  if (entityName.kind === SyntaxKind.Identifier || entityName.parent!.kind === SyntaxKind.QualifiedName)
    return resolveEntityName(c, entityName, SymbolFlags.Namespace, false, true, undefined);
  return resolveEntityName(
    c,
    entityName,
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
    false,
    true,
    undefined,
  );
}

function checkAndReportErrorForResolvingImportAliasToTypeOnlySymbol(c: Checker, node: ImportEqualsDeclaration): void {
  let name: Node = node.moduleReference;
  for (;;) {
    const typeOnlyDeclaration = getTypeOnlyDeclarationOfEntityName(c, name);
    if (typeOnlyDeclaration !== undefined) {
      const isExport =
        typeOnlyDeclaration.kind === SyntaxKind.ExportSpecifier ||
        typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration;
      const diagnostic = c.error(
        node.moduleReference,
        isExport
          ? Diagnostics.An_import_alias_cannot_reference_a_declaration_that_was_exported_using_export_type
          : Diagnostics.An_import_alias_cannot_reference_a_declaration_that_was_imported_using_import_type,
      );
      const typeOnlyName =
        typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration ? '*' : getText(getName(typeOnlyDeclaration)!);
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(
          typeOnlyDeclaration,
          isExport ? Diagnostics.X_0_was_exported_here : Diagnostics.X_0_was_imported_here,
          [typeOnlyName],
        ),
      );
      return;
    }
    if (name.kind !== SyntaxKind.QualifiedName) return;
    name = (name as QualifiedName).left;
  }
}

function getTypeOnlyDeclarationOfEntityName(c: Checker, name: Node): Node | undefined {
  if (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.QualifiedName) return undefined;
  const symbol = resolveEntityName(
    c,
    name,
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
    true,
    true,
    undefined,
  );
  return symbol !== undefined ? getTypeOnlyAliasDeclaration(c, symbol) : undefined;
}

function getTargetOfImportClause(c: Checker, node: Node): Symbol | undefined {
  // `import source x from "m"` binds a module source object, not the module's default export.
  if ((node as ImportClause).phaseModifier === SyntaxKind.SourceKeyword) {
    const alias = getSymbolOfDeclaration(c, node)!;
    const links = c.symbolLinks(alias);
    if (links.immediateTarget === undefined) {
      const symbol = c.newSymbol(SymbolFlags.FunctionScopedVariable, getText((node as ImportClause).name!));
      setDeclarations(symbol, getDeclarations(alias).slice());
      c.symbolTypes.set(getSymbolId(symbol), getGlobalAbstractModuleSourceType(c));
      links.immediateTarget = symbol;
    }
    return links.immediateTarget;
  }
  const moduleSymbol = resolveExternalModuleName(
    c,
    node,
    getModuleSpecifier(node.parent!),
    false,
    getTypeFromImportAttributes(c, getImportAttributes(node.parent!)),
  );
  return moduleSymbol !== undefined ? getTargetOfModuleDefault(c, moduleSymbol, node, true) : undefined;
}

function getTargetOfModuleDefault(
  c: Checker,
  moduleSymbol: Symbol,
  node: Node,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const file = getSourceFileDeclaration(moduleSymbol);
  const specifier = getModuleSpecifierForImportOrExport(node);
  const exportDefaultSymbol = isShorthandAmbientModuleSymbol(moduleSymbol)
    ? undefined
    : resolveExportByName(c, moduleSymbol, InternalSymbolName.Default, node, dontResolveAlias);
  if (specifier === undefined) return exportDefaultSymbol;
  let attributes: ImportAttributes | undefined;
  if (node.kind === SyntaxKind.ImportClause) attributes = getImportAttributes(node.parent!);
  else if (node.kind === SyntaxKind.ImportSpecifier) attributes = getImportAttributes(node.parent!.parent!.parent!);
  else if (node.kind === SyntaxKind.ExportSpecifier) attributes = getImportAttributes(node.parent!.parent!);
  const hasDefaultOnly = isOnlyImportableAsDefault(
    c,
    specifier,
    moduleSymbol,
    getTypeFromImportAttributes(c, attributes),
  );
  const hasSyntheticDefault = canHaveSyntheticDefault(c, file, moduleSymbol, dontResolveAlias, specifier);
  if (exportDefaultSymbol === undefined && !hasSyntheticDefault && !hasDefaultOnly) {
    if (node.kind === SyntaxKind.ImportClause) reportNonDefaultExport(c, moduleSymbol, node);
    else {
      const name =
        node.kind === SyntaxKind.ImportSpecifier || node.kind === SyntaxKind.ExportSpecifier
          ? getPropertyNameOrName(node)
          : getName(node)!;
      errorNoModuleMemberSymbol(c, moduleSymbol, moduleSymbol, node, name);
    }
  } else if (hasSyntheticDefault || hasDefaultOnly) {
    // A synthetic default overrides a real `default` member without an `__esModule` marker.
    const resolved =
      resolveExternalModuleSymbol(c, moduleSymbol, dontResolveAlias) ??
      resolveSymbolEx(c, moduleSymbol, dontResolveAlias);
    markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
    return resolved;
  }
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return exportDefaultSymbol;
}

function reportNonDefaultExport(c: Checker, moduleSymbol: Symbol, node: Node): void {
  const local = getSymbol(node)!;
  if (moduleSymbol.exports?.get(local.name) !== undefined) {
    c.error(
      node,
      Diagnostics.Module_0_has_no_default_export_Did_you_mean_to_use_import_1_from_0_instead,
      symbolToString(c, moduleSymbol),
      symbolToString(c, local),
    );
    return;
  }
  const diagnostic = c.error(
    getName(node),
    Diagnostics.Module_0_has_no_default_export,
    symbolToString(c, moduleSymbol),
  );
  const exportStar = moduleSymbol.exports?.get(InternalSymbolName.ExportStar);
  if (exportStar === undefined) return;
  for (const d of getDeclarations(exportStar)) {
    const specifier = getModuleSpecifier(d);
    if (d.kind !== SyntaxKind.ExportDeclaration || specifier === undefined) continue;
    const resolved = resolveExternalModuleName(
      c,
      d,
      specifier,
      false,
      getTypeFromImportAttributes(c, getImportAttributes(d)),
    );
    if (resolved !== undefined && resolved.exports?.get(InternalSymbolName.Default) !== undefined) {
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(d, Diagnostics.X_export_Asterisk_does_not_re_export_a_default, []),
      );
      return;
    }
  }
}

function resolveExportByName(
  c: Checker,
  moduleSymbol: Symbol,
  name: string,
  sourceNode: Node | undefined,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const exportValue = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  const exportSymbol =
    exportValue !== undefined
      ? getPropertyOfTypeEx(c, getTypeOfSymbol(c, exportValue), name, true, false)
      : moduleSymbol.exports?.get(name);
  const resolved = exportSymbol !== undefined ? resolveSymbolEx(c, exportSymbol, dontResolveAlias) : undefined;
  markSymbolOfAliasDeclarationIfTypeOnly(c, sourceNode, undefined);
  return resolved;
}

function getTargetOfNamespaceImport(c: Checker, node: Node): Symbol | undefined {
  const moduleSpecifier = getModuleSpecifierForImportOrExport(node)!;
  const immediate = resolveExternalModuleName(
    c,
    node,
    moduleSpecifier,
    false,
    getTypeFromImportAttributes(c, getImportAttributes(node.parent!.parent!)),
  );
  const resolved = resolveESModuleSymbol(c, immediate, node, moduleSpecifier);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfNamespaceExport(c: Checker, node: Node): Symbol | undefined {
  const moduleSpecifier = getModuleSpecifierForImportOrExport(node);
  if (moduleSpecifier === undefined) return undefined;
  const immediate = resolveExternalModuleName(
    c,
    node,
    moduleSpecifier,
    false,
    getTypeFromImportAttributes(c, getImportAttributes(node.parent!)),
  );
  const resolved = resolveESModuleSymbol(c, immediate, node, moduleSpecifier);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfImportSpecifier(c: Checker, node: Node): Symbol | undefined {
  const name = getPropertyNameOrName(node);
  if (node.kind === SyntaxKind.ImportSpecifier && moduleExportNameIsDefault(name)) {
    const specifier = getModuleSpecifierForImportOrExport(node);
    if (specifier !== undefined) {
      const moduleSymbol = resolveExternalModuleName(
        c,
        node,
        specifier,
        false,
        getTypeFromImportAttributes(c, getImportAttributes(node.parent!.parent!.parent!)),
      );
      if (moduleSymbol !== undefined) return getTargetOfModuleDefault(c, moduleSymbol, node, true);
    }
  }
  const root = node.kind === SyntaxKind.BindingElement ? getRootDeclaration(node) : node.parent!.parent!.parent!;
  const resolved = getExternalModuleMember(c, root, node, true);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

/** The export `specifier` names from the module of the import or export declaration `node`. */
export function getExternalModuleMember(
  c: Checker,
  node: Node,
  specifier: Node,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const moduleSpecifier = isVariableDeclarationInitializedToRequire(node)
    ? (getInitializer(node) as CallExpression).arguments.nodes[0]!
    : getExternalModuleName(node);
  const importAttributesType = getTypeFromImportAttributes(c, getImportAttributes(node));
  const moduleSymbol = resolveExternalModuleName(c, node, moduleSpecifier, false, importAttributesType);
  const name =
    specifier.kind === SyntaxKind.PropertyAccessExpression ? getName(specifier)! : getPropertyNameOrName(specifier);
  if (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.StringLiteral) return undefined;
  const nameText = getText(name);
  const targetSymbol =
    moduleSpecifier !== undefined ? resolveESModuleSymbol(c, moduleSymbol, specifier, moduleSpecifier) : undefined;
  // The empty string is a valid module export name.
  if (
    targetSymbol === undefined ||
    moduleSymbol === undefined ||
    (nameText === '' && name.kind !== SyntaxKind.StringLiteral)
  )
    return undefined;
  if (isShorthandAmbientModuleSymbol(moduleSymbol)) return moduleSymbol;
  // An `export =` module exports the members of its target's type.
  const exportEquals = hasExportAssignmentSymbol(moduleSymbol);
  let symbolFromVariable = exportEquals
    ? getPropertyOfTypeEx(c, getTypeOfSymbol(c, targetSymbol), nameText, true, false)
    : getPropertyOfVariable(c, targetSymbol, nameText);
  if (symbolFromVariable !== undefined) symbolFromVariable = resolveSymbolEx(c, symbolFromVariable, dontResolveAlias);
  // Types and namespaces of an `export =` module live on the module symbol.
  let symbolFromModule = getExportOfModule(
    c,
    exportEquals ? moduleSymbol : targetSymbol,
    nameText,
    specifier,
    dontResolveAlias,
  );
  if (
    symbolFromModule === undefined &&
    nameText === InternalSymbolName.Default &&
    (isOnlyImportableAsDefault(c, moduleSpecifier!, moduleSymbol, importAttributesType) ||
      canHaveSyntheticDefault(
        c,
        getSourceFileDeclaration(moduleSymbol),
        moduleSymbol,
        dontResolveAlias,
        moduleSpecifier!,
      ))
  )
    symbolFromModule =
      resolveExternalModuleSymbol(c, moduleSymbol, dontResolveAlias) ??
      resolveSymbolEx(c, moduleSymbol, dontResolveAlias);
  const symbol =
    symbolFromModule === undefined
      ? symbolFromVariable
      : symbolFromVariable === undefined
        ? symbolFromModule
        : combineValueAndTypeSymbols(c, symbolFromVariable, symbolFromModule);
  if (
    (specifier.kind === SyntaxKind.ImportSpecifier || specifier.kind === SyntaxKind.ExportSpecifier) &&
    nameText !== InternalSymbolName.Default &&
    isOnlyImportableAsDefault(c, moduleSpecifier!, moduleSymbol, importAttributesType)
  )
    c.error(
      name,
      Diagnostics.Named_imports_from_a_JSON_file_into_an_ECMAScript_module_are_not_allowed_when_module_is_set_to_0,
      moduleKindName(getEmitModuleKind(c.compilerOptions)),
    );
  else if (symbol === undefined) errorNoModuleMemberSymbol(c, moduleSymbol, targetSymbol, node, name);
  return symbol;
}

function getPropertyOfVariable(c: Checker, symbol: Symbol, name: string): Symbol | undefined {
  if ((symbol.flags & SymbolFlags.Variable) === 0) return undefined;
  const declaration = symbol.valueDeclaration;
  const typeAnnotation = declaration !== undefined ? getType(declaration) : undefined;
  if (typeAnnotation === undefined) return undefined;
  return resolveSymbol(c, getPropertyOfType(c, getTypeFromTypeNode(c, typeAnnotation), name));
}

/** A symbol with the value side of `valueSymbol` and the type and namespace sides of `typeSymbol`. */
function combineValueAndTypeSymbols(c: Checker, valueSymbol: Symbol, typeSymbol: Symbol): Symbol {
  if (valueSymbol === c.unknownSymbol && typeSymbol === c.unknownSymbol) return c.unknownSymbol;
  if ((typeSymbol.flags & SymbolFlags.Value) !== 0) return typeSymbol;
  if ((valueSymbol.flags & (SymbolFlags.Type | SymbolFlags.Namespace)) !== 0) return valueSymbol;
  const result = c.newSymbol(valueSymbol.flags | typeSymbol.flags, valueSymbol.name);
  const declarations = getDeclarations(valueSymbol).slice();
  for (const d of getDeclarations(typeSymbol)) if (!declarations.includes(d)) declarations.push(d);
  setDeclarations(result, declarations);
  result.parent = valueSymbol.parent ?? typeSymbol.parent;
  result.valueDeclaration = valueSymbol.valueDeclaration;
  if (typeSymbol.members !== undefined) result.members = new Map(typeSymbol.members);
  if (valueSymbol.exports !== undefined) result.exports = new Map(valueSymbol.exports);
  return result;
}

function getExportOfModule(
  c: Checker,
  symbol: Symbol,
  nameText: string,
  specifier: Node,
  dontResolveAlias: boolean,
): Symbol | undefined {
  if ((symbol.flags & SymbolFlags.Module) === 0) return undefined;
  const exportSymbol = getExportsOfSymbol(c, symbol).get(nameText);
  const resolved = exportSymbol !== undefined ? resolveSymbolEx(c, exportSymbol, dontResolveAlias) : undefined;
  const exportStarDeclaration = c.symbolLinks(symbol).typeOnlyExportStarMap?.get(nameText);
  markSymbolOfAliasDeclarationIfTypeOnly(c, specifier, exportStarDeclaration);
  return resolved;
}

function errorNoModuleMemberSymbol(
  c: Checker,
  moduleSymbol: Symbol,
  targetSymbol: Symbol,
  node: Node,
  name: Node,
): void {
  const moduleName = getFullyQualifiedName(c, moduleSymbol, node);
  const declarationName = declarationNameToString(getSourceFileOfNode(name), name);
  const suggestion =
    name.kind === SyntaxKind.Identifier
      ? getSpellingSuggestionForName(
          c,
          getText(name),
          Array.from(getExportsOfModule(c, targetSymbol).values()),
          SymbolFlags.ModuleMember,
        )
      : undefined;
  if (suggestion !== undefined) {
    const suggestionName = symbolToString(c, suggestion);
    const diagnostic = c.error(
      name,
      Diagnostics.X_0_has_no_exported_member_named_1_Did_you_mean_2,
      moduleName,
      declarationName,
      suggestionName,
    );
    if (suggestion.valueDeclaration !== undefined)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(suggestion.valueDeclaration, Diagnostics.X_0_is_declared_here, [suggestionName]),
      );
    return;
  }
  if (moduleSymbol.exports?.get(InternalSymbolName.Default) !== undefined) {
    c.error(
      name,
      Diagnostics.Module_0_has_no_exported_member_1_Did_you_mean_to_use_import_1_from_0_instead,
      moduleName,
      declarationName,
    );
    return;
  }
  reportNonExportedMember(c, name, declarationName, moduleSymbol, moduleName);
}

function reportNonExportedMember(
  c: Checker,
  name: Node,
  declarationName: string,
  moduleSymbol: Symbol,
  moduleName: string,
): void {
  const locals = moduleSymbol.valueDeclaration !== undefined ? getLocals(moduleSymbol.valueDeclaration) : undefined;
  const localSymbol = locals?.get(getText(name));
  if (localSymbol === undefined) {
    c.error(name, Diagnostics.Module_0_has_no_exported_member_1, moduleName, declarationName);
    return;
  }
  const exports = moduleSymbol.exports;
  const exportEquals = exports?.get(InternalSymbolName.ExportEquals);
  if (exportEquals !== undefined) {
    if (isSameReference(c, exportEquals, localSymbol))
      reportInvalidImportEqualsExportMember(c, name, declarationName, moduleName);
    else c.error(name, Diagnostics.Module_0_has_no_exported_member_1, moduleName, declarationName);
    return;
  }
  let exportedSymbol: Symbol | undefined;
  if (exports !== undefined)
    for (const s of exports.values())
      if (isSameReference(c, s, localSymbol)) {
        exportedSymbol = s;
        break;
      }
  const diagnostic =
    exportedSymbol !== undefined
      ? c.error(
          name,
          Diagnostics.Module_0_declares_1_locally_but_it_is_exported_as_2,
          moduleName,
          declarationName,
          symbolToString(c, exportedSymbol),
        )
      : c.error(name, Diagnostics.Module_0_declares_1_locally_but_it_is_not_exported, moduleName, declarationName);
  for (let i = 0; i < declarationCount(localSymbol); i++)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(
        declarationAt(localSymbol, i),
        i === 0 ? Diagnostics.X_0_is_declared_here : Diagnostics.X_and_here,
        [declarationName],
      ),
    );
}

function isSameReference(c: Checker, s1: Symbol, s2: Symbol): boolean {
  return (
    getMergedSymbol(c, resolveSymbol(c, getMergedSymbol(c, s1))!) ===
    getMergedSymbol(c, resolveSymbol(c, getMergedSymbol(c, s2))!)
  );
}

function reportInvalidImportEqualsExportMember(
  c: Checker,
  name: Node,
  declarationName: string,
  moduleName: string,
): void {
  if (getEmitModuleKind(c.compilerOptions) >= ModuleKind.ES2015)
    c.error(name, Diagnostics.X_0_can_only_be_imported_by_using_a_default_import, declarationName);
  else if (isInJSFile(name))
    c.error(
      name,
      Diagnostics.X_0_can_only_be_imported_by_using_a_require_call_or_by_using_a_default_import,
      declarationName,
    );
  else
    c.error(
      name,
      Diagnostics.X_0_can_only_be_imported_by_using_import_1_require_2_or_a_default_import,
      declarationName,
      declarationName,
      moduleName,
    );
}

export function getTargetOfExportSpecifier(
  c: Checker,
  node: Node,
  meaning: SymbolFlags,
  dontResolveAlias: boolean,
): Symbol | undefined {
  const name = getPropertyNameOrName(node);
  if (moduleExportNameIsDefault(name)) {
    const specifier = getModuleSpecifierForImportOrExport(node);
    if (specifier !== undefined) {
      const moduleSymbol = resolveExternalModuleName(
        c,
        node,
        specifier,
        false,
        getTypeFromImportAttributes(c, getImportAttributes(node.parent!.parent!)),
      );
      if (moduleSymbol !== undefined) return getTargetOfModuleDefault(c, moduleSymbol, node, dontResolveAlias);
    }
  }
  const exportDeclaration = node.parent!.parent!;
  let resolved: Symbol | undefined;
  if ((exportDeclaration as ExportDeclaration).moduleSpecifier !== undefined)
    resolved = getExternalModuleMember(c, exportDeclaration, node, dontResolveAlias);
  else if (name.kind !== SyntaxKind.StringLiteral)
    resolved = resolveEntityName(c, name, meaning, false, dontResolveAlias, undefined);
  markSymbolOfAliasDeclarationIfTypeOnly(c, node, undefined);
  return resolved;
}

function getTargetOfAliasLikeExpression(c: Checker, expression: Node): Symbol | undefined {
  if (expression.kind === SyntaxKind.ClassExpression) return checkExpressionCached(c, expression).symbol;
  if (!isEntityNameOrEntityNameExpression(expression)) return undefined;
  const aliasLike = resolveEntityName(
    c,
    expression,
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace,
    true,
    true,
    undefined,
  );
  if (aliasLike !== undefined) return aliasLike;
  checkExpressionCached(c, expression);
  return c.resolvedSymbols.get(expression.id);
}

function isEntityNameOrEntityNameExpression(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.QualifiedName) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const name = getName(node);
    return (
      name !== undefined &&
      name.kind === SyntaxKind.Identifier &&
      isEntityNameOrEntityNameExpression(getExpression(node)!)
    );
  }
  return false;
}

function getPropertyNameOrName(node: Node): Node {
  return getPropertyName(node) ?? getName(node)!;
}

function getModuleSpecifierForImportOrExport(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ImportClause:
      return getModuleSpecifierOfDeclaration(node.parent!);
    case SyntaxKind.ImportEqualsDeclaration: {
      const reference = (node as ImportEqualsDeclaration).moduleReference;
      return reference.kind === SyntaxKind.ExternalModuleReference ? getExpression(reference) : undefined;
    }
    case SyntaxKind.NamespaceImport:
      return getModuleSpecifierOfDeclaration(node.parent!.parent!);
    case SyntaxKind.ImportSpecifier:
      return getModuleSpecifierOfDeclaration(node.parent!.parent!.parent!);
    case SyntaxKind.NamespaceExport:
      return getModuleSpecifierOfDeclaration(node.parent!);
    case SyntaxKind.ExportSpecifier:
      return getModuleSpecifierOfDeclaration(node.parent!.parent!);
  }
  return undefined;
}

function getModuleSpecifierOfDeclaration(node: Node): Node | undefined {
  if (node.kind === SyntaxKind.ExportDeclaration) return (node as ExportDeclaration).moduleSpecifier;
  return getModuleSpecifier(node);
}

// ---- Type-only aliases

/** Whether the declaration itself is written `import type` or `export type`. */
export function isTypeOnlyImportOrExportDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportSpecifier:
      return getIsTypeOnly(node) || isTypeOnlyImportClause(node.parent!.parent!);
    case SyntaxKind.NamespaceImport:
      return isTypeOnlyImportClause(node.parent!);
    case SyntaxKind.ImportClause:
      return isTypeOnlyImportClause(node);
    case SyntaxKind.ImportEqualsDeclaration:
      return getIsTypeOnly(node);
    case SyntaxKind.ExportSpecifier:
      return getIsTypeOnly(node) || getIsTypeOnly(node.parent!.parent!);
    case SyntaxKind.ExportDeclaration: {
      const declaration = node as ExportDeclaration;
      return (
        declaration.isTypeOnly && declaration.moduleSpecifier !== undefined && declaration.exportClause === undefined
      );
    }
    case SyntaxKind.NamespaceExport:
      return getIsTypeOnly(node.parent!);
  }
  return false;
}

function isTypeOnlyImportClause(node: Node): boolean {
  return node.kind === SyntaxKind.ImportClause && (node as ImportClause).phaseModifier === SyntaxKind.TypeKeyword;
}

/**
 * Marks an alias declared `import type`/`export type`, or reached through a type-only `export *`,
 * as type-only; returns whether it is.
 */
function markSymbolOfAliasDeclarationIfTypeOnly(
  c: Checker,
  aliasDeclaration: Node | undefined,
  exportStarDeclaration: Node | undefined,
): boolean {
  if (aliasDeclaration === undefined) return false;
  const sourceSymbol = getSymbol(aliasDeclaration);
  if (sourceSymbol === undefined) return false;
  const links = c.symbolLinks(getMergedSymbol(c, sourceSymbol));
  if (links.typeOnlyDeclaration === undefined && isTypeOnlyImportOrExportDeclaration(aliasDeclaration)) {
    links.typeOnlyDeclaration = aliasDeclaration;
    return true;
  }
  if (links.typeOnlyDeclaration === undefined && exportStarDeclaration !== undefined) {
    links.typeOnlyDeclaration = exportStarDeclaration;
    return true;
  }
  return links.typeOnlyDeclaration !== undefined;
}

/** Marks the alias declaration an entity name is part of, if it is type-only. */
export function markAliasDeclarationOfNameIfTypeOnly(c: Checker, name: Node): void {
  let current = name;
  while (current.parent !== undefined && current.parent.kind === SyntaxKind.QualifiedName) current = current.parent;
  const parent = current.parent;
  if (parent === undefined) return;
  switch (parent.kind) {
    case SyntaxKind.ImportClause:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.NamespaceExport:
      markSymbolOfAliasDeclarationIfTypeOnly(c, parent, undefined);
  }
}

/** Resolves an alias whose target is an alias, carrying over the target's type-only declaration. */
export function resolveIndirectionAlias(c: Checker, source: Symbol, target: Symbol): Symbol {
  const result = getMergedSymbol(c, resolveAlias(c, target));
  const targetDeclaration = c.symbolLinks(target).typeOnlyDeclaration;
  if (targetDeclaration !== undefined) {
    const sourceLinks = c.symbolLinks(source);
    if (sourceLinks.typeOnlyDeclaration === undefined) sourceLinks.typeOnlyDeclaration = targetDeclaration;
  }
  return result;
}

export function getTypeOnlyAliasDeclaration(c: Checker, symbol: Symbol): Node | undefined {
  if ((symbol.flags & SymbolFlags.Alias) === 0) return undefined;
  resolveAlias(c, symbol);
  return c.symbolLinks(symbol).typeOnlyDeclaration;
}

/** The first type-only declaration along the alias chain of `symbol` before one with `meaning`. */
export function getTypeOnlyAliasDeclarationOfMeaning(
  c: Checker,
  symbol: Symbol,
  meaning: SymbolFlags,
): Node | undefined {
  while ((symbol.flags & SymbolFlags.Alias) !== 0 && (symbol.flags & meaning) === 0) {
    const resolved = resolveAlias(c, symbol);
    const declaration = c.symbolLinks(symbol).typeOnlyDeclaration;
    if (declaration !== undefined) return declaration;
    symbol = resolved;
  }
  return undefined;
}

function addTypeOnlyDeclarationRelatedInfo(
  diagnostic: Diagnostic,
  typeOnlyDeclaration: Node | undefined,
  name: string,
): void {
  if (typeOnlyDeclaration === undefined) return;
  const isExport =
    typeOnlyDeclaration.kind === SyntaxKind.ExportSpecifier ||
    typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration ||
    typeOnlyDeclaration.kind === SyntaxKind.NamespaceExport;
  diagnostic.addRelatedInfo(
    createDiagnosticForNode(
      typeOnlyDeclaration,
      isExport ? Diagnostics.X_0_was_exported_here : Diagnostics.X_0_was_imported_here,
      [name],
    ),
  );
}

/** Reports a value use of a name that only resolves to a value through a type-only import or export. */
export function checkTypeOnlyAliasUse(c: Checker, location: Node, result: Symbol, name: string): void {
  if (
    (result.flags & SymbolFlags.Alias) === 0 ||
    (result.flags & SymbolFlags.Value) !== 0 ||
    isValidTypeOnlyAliasUseSite(location)
  )
    return;
  const typeOnlyDeclaration = getTypeOnlyAliasDeclarationOfMeaning(c, result, SymbolFlags.Value);
  if (typeOnlyDeclaration === undefined) return;
  const isExport =
    typeOnlyDeclaration.kind === SyntaxKind.ExportSpecifier ||
    typeOnlyDeclaration.kind === SyntaxKind.ExportDeclaration ||
    typeOnlyDeclaration.kind === SyntaxKind.NamespaceExport;
  const diagnostic = c.error(
    location,
    isExport
      ? Diagnostics.X_0_cannot_be_used_as_a_value_because_it_was_exported_using_export_type
      : Diagnostics.X_0_cannot_be_used_as_a_value_because_it_was_imported_using_import_type,
    name,
  );
  addTypeOnlyDeclarationRelatedInfo(diagnostic, typeOnlyDeclaration, name);
}

export function isValidTypeOnlyAliasUseSite(useSite: Node): boolean {
  return (
    (useSite.flags & (NodeFlags.Ambient | NodeFlags.JSDoc)) !== 0 ||
    isPartOfTypeQuery(useSite) ||
    isIdentifierInNonEmittingHeritageClause(useSite) ||
    isPartOfPossiblyValidTypeOrAbstractComputedPropertyName(useSite) ||
    !(isExpressionNode(useSite) || isShorthandPropertyNameUseSite(useSite))
  );
}

function isIdentifierInNonEmittingHeritageClause(node: Node): boolean {
  if (node.kind !== SyntaxKind.Identifier) return false;
  let parent = node.parent!;
  while (parent.kind === SyntaxKind.PropertyAccessExpression || parent.kind === SyntaxKind.ExpressionWithTypeArguments)
    parent = parent.parent!;
  return (
    parent.kind === SyntaxKind.HeritageClause &&
    ((parent as HeritageClause).token === SyntaxKind.ImplementsKeyword ||
      parent.parent!.kind === SyntaxKind.InterfaceDeclaration)
  );
}

function isPartOfPossiblyValidTypeOrAbstractComputedPropertyName(node: Node): boolean {
  let current = node;
  while (current.kind === SyntaxKind.Identifier || current.kind === SyntaxKind.PropertyAccessExpression)
    current = current.parent!;
  if (current.kind !== SyntaxKind.ComputedPropertyName) return false;
  if (hasSyntacticModifier(current.parent!, ModifierFlags.Abstract)) return true;
  const container = current.parent!.parent!.kind;
  return container === SyntaxKind.InterfaceDeclaration || container === SyntaxKind.TypeLiteral;
}

function isShorthandPropertyNameUseSite(useSite: Node): boolean {
  return (
    useSite.kind === SyntaxKind.Identifier &&
    useSite.parent!.kind === SyntaxKind.ShorthandPropertyAssignment &&
    getName(useSite.parent!) === useSite
  );
}

// ---- Referenced aliases

/**
 * Whether aliases are marked as referenced, which decides the imports emit keeps. Under
 * verbatimModuleSyntax, emit keeps every import that isn't type-only, so they aren't.
 */
function marksReferencedAliases(c: Checker): boolean {
  return c.compilerOptions.verbatimModuleSyntax !== true;
}

/** Marks the aliases an identifier in an expression uses as referenced. */
export function markIdentifierAliasReferencedInExpression(c: Checker, node: Node): void {
  if (!marksReferencedAliases(c)) return;
  if ((node.flags & NodeFlags.Ambient) !== 0 || !shouldMarkIdentifierAliasReferenced(node)) return;
  markIdentifierAliasReferenced(c, node);
}

/** Resolves the alias side of a referenced symbol, which may also be a local variable. */
export function resolveAliasOfReference(c: Checker, symbol: Symbol): void {
  if ((symbol.flags & SymbolFlags.Alias) !== 0 && getDeclarationOfAliasSymbol(symbol) !== undefined)
    resolveAlias(c, symbol);
}

function shouldMarkIdentifierAliasReferenced(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return true;
  // The left of a property access is marked with the property.
  if (parent.kind === SyntaxKind.PropertyAccessExpression && getExpression(parent) === node) return false;
  // Names of type-only exports aren't emitted.
  if (parent.kind === SyntaxKind.ExportSpecifier && getIsTypeOnly(parent)) return false;
  const greatGrandparent = parent.parent?.parent;
  return !(
    greatGrandparent !== undefined &&
    greatGrandparent.kind === SyntaxKind.ExportDeclaration &&
    getIsTypeOnly(greatGrandparent)
  );
}

/**
 * Marks the alias on the left of a property access as referenced, unless the access reads a const
 * enum (or a module of only const enums) that is inlined.
 */
export function markPropertyAliasReferenced(
  c: Checker,
  location: Node,
  prop: Symbol | undefined,
  leftType: Type,
): void {
  if (!marksReferencedAliases(c)) return;
  if ((location.flags & NodeFlags.Ambient) !== 0 || isPartOfImportEqualsModuleReference(location)) return;
  const left =
    location.kind === SyntaxKind.PropertyAccessExpression ? getExpression(location)! : (location as QualifiedName).left;
  if (left.kind !== SyntaxKind.Identifier || getText(left) === 'this') return;
  const parentSymbol = getResolvedSymbol(c, left);
  if (parentSymbol === c.unknownSymbol) return;
  if (
    c.isolatedModules ||
    (c.preserveConstEnums && isExportOrExportExpression(location)) ||
    (leftType.flags & TypeFlags.Any) !== 0 ||
    leftType === c.silentNeverType
  ) {
    markAliasReferenced(c, parentSymbol, location);
    return;
  }
  if (
    prop !== undefined &&
    (isConstEnumOrConstEnumOnlyModule(prop) ||
      ((prop.flags & SymbolFlags.EnumMember) !== 0 && location.parent!.kind === SyntaxKind.EnumMember))
  )
    return;
  markAliasReferenced(c, parentSymbol, location);
}

function isPartOfImportEqualsModuleReference(location: Node): boolean {
  let importEquals: Node | undefined = location;
  while (importEquals !== undefined && importEquals.kind !== SyntaxKind.ImportEqualsDeclaration)
    importEquals = importEquals.parent;
  if (importEquals === undefined) return false;
  const reference = (importEquals as ImportEqualsDeclaration).moduleReference;
  for (let node: Node | undefined = location; node !== undefined && node !== importEquals; node = node.parent)
    if (node === reference) return true;
  return false;
}

function markIdentifierAliasReferenced(c: Checker, location: Node): void {
  const symbol = getResolvedSymbol(c, location);
  if (symbol !== c.argumentsSymbol && symbol !== c.unknownSymbol) markAliasReferenced(c, symbol, location);
}

function markAliasReferenced(c: Checker, symbol: Symbol, location: Node): void {
  if (!marksReferencedAliases(c)) return;
  if (!isNonLocalAlias(symbol, SymbolFlags.Value) || isPartOfTypeQuery(location)) return;
  const target = resolveAlias(c, symbol);
  if ((getSymbolFlagsExcludingTypeOnly(c, symbol) & (SymbolFlags.Value | SymbolFlags.ExportValue)) === 0) return;
  // An alias of a const enum can be elided unless the enum is kept.
  if (
    c.isolatedModules ||
    (c.preserveConstEnums && isExportOrExportExpression(location)) ||
    !isConstEnumOrConstEnumOnlyModule(getExportSymbolOfValueSymbolIfExported(c, target))
  )
    markAliasSymbolAsReferenced(c, symbol);
}

/**
 * Marks an alias as referenced; an `import a = b.c` whose target is a value then references `b`,
 * resolving it as a value.
 */
function markAliasSymbolAsReferenced(c: Checker, symbol: Symbol): void {
  const links = c.symbolLinks(symbol);
  if (links.aliasReferenced) return;
  links.aliasReferenced = true;
  const node = getDeclarationOfAliasSymbol(symbol);
  if (
    node !== undefined &&
    node.kind === SyntaxKind.ImportEqualsDeclaration &&
    (node as ImportEqualsDeclaration).moduleReference.kind !== SyntaxKind.ExternalModuleReference &&
    (getSymbolFlags(c, resolveSymbol(c, symbol)!) & SymbolFlags.Value) !== 0
  )
    markIdentifierAliasReferenced(c, getFirstIdentifierOfEntityName((node as ImportEqualsDeclaration).moduleReference));
}

function markExportAsReferenced(c: Checker, node: Node): void {
  if (!marksReferencedAliases(c)) return;
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const target = resolveAlias(c, symbol);
  if (
    target === c.unknownSymbol ||
    ((getSymbolFlagsExcludingTypeOnly(c, symbol) & SymbolFlags.Value) !== 0 &&
      !isConstEnumOrConstEnumOnlyModule(target))
  )
    markAliasSymbolAsReferenced(c, symbol);
}

function markExportSpecifierAliasReferenced(
  c: Checker,
  node: Node,
  symbol: Symbol | undefined,
  exportedName: Node,
): void {
  if (!marksReferencedAliases(c)) return;
  if ((node.flags & NodeFlags.Ambient) !== 0 || getIsTypeOnly(node) || getIsTypeOnly(node.parent!.parent!)) return;
  let target = symbol;
  if (target !== undefined && (target.flags & SymbolFlags.Alias) !== 0) target = resolveAlias(c, target);
  if (target === undefined || (getSymbolFlags(c, target) & SymbolFlags.Value) !== 0) {
    markExportAsReferenced(c, node);
    markIdentifierAliasReferenced(c, exportedName);
  }
}

function isConstEnumOrConstEnumOnlyModule(symbol: Symbol): boolean {
  return (symbol.flags & (SymbolFlags.ConstEnum | SymbolFlags.ConstEnumOnlyModule)) !== 0;
}

function isExportOrExportExpression(location: Node): boolean {
  for (let n: Node | undefined = location; n !== undefined; n = n.parent) {
    const parent = n.parent;
    if (parent === undefined) return false;
    if (parent.kind === SyntaxKind.ExportAssignment)
      return (
        getExpression(parent) === n && isEntityNameOrEntityNameExpression(n) && n.kind !== SyntaxKind.QualifiedName
      );
    if (parent.kind === SyntaxKind.ExportSpecifier) {
      if (getName(parent) === n || getPropertyName(parent) === n) return true;
    }
  }
  return false;
}

/** `getSymbolFlags`, stopping at the first type-only alias along the chain. */
function getSymbolFlagsExcludingTypeOnly(c: Checker, symbol: Symbol): SymbolFlags {
  return getSymbolFlagsEx(c, symbol, true, false);
}

/** `getSymbolFlags`, optionally stopping at type-only aliases or leaving out the symbol's own flags. */
function getSymbolFlagsEx(
  c: Checker,
  symbol: Symbol,
  excludeTypeOnlyMeanings: boolean,
  excludeLocalMeanings: boolean,
): SymbolFlags {
  const seen = new Set<Symbol>();
  let flags = excludeLocalMeanings ? SymbolFlags.None : symbol.flags;
  while ((symbol.flags & SymbolFlags.Alias) !== 0) {
    if (excludeTypeOnlyMeanings && getTypeOnlyAliasDeclaration(c, symbol) !== undefined) break;
    const target = getExportSymbolOfValueSymbolIfExported(c, resolveAlias(c, symbol));
    if (target === c.unknownSymbol) return SymbolFlags.All;
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

// ---- Module exports

/** Own exports plus those re-exported with `export *`; own exports shadow re-exported ones. */
export function getExportsOfModuleWorker(c: Checker, moduleSymbol: Symbol): SymbolTable {
  const collector = new ExportCollector(c);
  const exportEquals = moduleSymbol.exports?.get(InternalSymbolName.ExportEquals);
  const originalModule =
    exportEquals !== undefined && resolveSymbolEx(c, exportEquals, false) !== undefined ? moduleSymbol : undefined;
  const resolvedModule = resolveExternalModuleSymbol(c, moduleSymbol, false);
  const exports = collector.visit(resolvedModule, undefined, false) ?? new Map<string, Symbol>();
  // A CommonJS module with `export =` may also export types, stored on the original module.
  if (originalModule !== undefined && originalModule.exports !== undefined && originalModule.exports.size > 1) {
    for (const symbol of originalModule.exports.values()) {
      if (symbol.name === InternalSymbolName.ExportEquals || symbol.name === InternalSymbolName.ExportStar) continue;
      const flags = getSymbolFlags(c, symbol);
      if (
        (flags & (SymbolFlags.Type | SymbolFlags.Namespace)) !== 0 &&
        (flags & SymbolFlags.Value) === 0 &&
        !exports.has(symbol.name)
      )
        exports.set(symbol.name, symbol);
    }
  }
  const typeOnlyExportStarMap = collector.typeOnlyExportStarMap;
  if (typeOnlyExportStarMap !== undefined) {
    for (const name of collector.nonTypeOnlyNames) typeOnlyExportStarMap.delete(name);
    c.symbolLinks(moduleSymbol).typeOnlyExportStarMap = typeOnlyExportStarMap;
  }
  return exports;
}

/** A name re-exported by several `export *` declarations. */
class ExportCollision {
  readonly specifierText: string;
  readonly exportsWithDuplicate: Node[] = [];

  constructor(specifierText: string) {
    this.specifierText = specifierText;
  }
}

class ExportCollector {
  readonly c: Checker;
  readonly visited: Symbol[] = [];
  readonly nonTypeOnlyNames = new Set<string>();
  typeOnlyExportStarMap: Map<string, Node> | undefined = undefined;

  constructor(c: Checker) {
    this.c = c;
  }

  // Modules may re-export each other circularly.
  visit(symbol: Symbol | undefined, exportStar: Node | undefined, isTypeOnly: boolean): SymbolTable | undefined {
    if (!isTypeOnly && symbol !== undefined && symbol.exports !== undefined)
      // Added before the visited check: `export *` overrides an earlier `export type *` of the same module.
      for (const name of symbol.exports.keys()) this.nonTypeOnlyNames.add(name);
    if (symbol === undefined || symbol.exports === undefined || this.visited.includes(symbol)) return undefined;
    this.visited.push(symbol);
    const symbols: SymbolTable = new Map(symbol.exports);
    const exportStars = symbol.exports.get(InternalSymbolName.ExportStar);
    if (exportStars !== undefined) {
      const nested: SymbolTable = new Map<string, Symbol>();
      const lookupTable = new Map<string, ExportCollision>();
      for (const node of getDeclarations(exportStars)) {
        const specifier = (node as ExportDeclaration).moduleSpecifier;
        const resolved = resolveExternalModuleName(
          this.c,
          node,
          specifier,
          false,
          getTypeFromImportAttributes(this.c, getImportAttributes(node)),
        );
        const exported = this.visit(resolved, node, isTypeOnly || getIsTypeOnly(node));
        this.extendExportSymbols(nested, exported, lookupTable, node);
      }
      for (const [id, collision] of lookupTable) {
        // A module that exports the name itself resolves the ambiguity.
        if (id === InternalSymbolName.ExportEquals || collision.exportsWithDuplicate.length === 0 || symbols.has(id))
          continue;
        for (const node of collision.exportsWithDuplicate)
          this.c.error(
            node,
            Diagnostics.Module_0_has_already_exported_a_member_named_1_Consider_explicitly_re_exporting_to_resolve_the_ambiguity,
            collision.specifierText,
            id,
          );
      }
      this.extendExportSymbols(symbols, nested, undefined, undefined);
    }
    if (exportStar !== undefined && getIsTypeOnly(exportStar)) {
      if (this.typeOnlyExportStarMap === undefined) this.typeOnlyExportStarMap = new Map<string, Node>();
      for (const name of symbols.keys()) this.typeOnlyExportStarMap.set(name, exportStar);
    }
    return symbols;
  }

  extendExportSymbols(
    target: SymbolTable,
    source: SymbolTable | undefined,
    lookupTable: Map<string, ExportCollision> | undefined,
    exportNode: Node | undefined,
  ): void {
    if (source === undefined) return;
    for (const [id, sourceSymbol] of source) {
      if (id === InternalSymbolName.Default) continue;
      const targetSymbol = target.get(id);
      if (targetSymbol === undefined) {
        target.set(id, sourceSymbol);
        if (lookupTable !== undefined && exportNode !== undefined) {
          const specifier = (exportNode as ExportDeclaration).moduleSpecifier!;
          lookupTable.set(id, new ExportCollision(getSourceTextOfNode(getSourceFileOfNode(specifier), specifier)));
        }
      } else if (
        lookupTable !== undefined &&
        exportNode !== undefined &&
        resolveSymbol(this.c, targetSymbol) !== resolveSymbol(this.c, sourceSymbol)
      )
        lookupTable.get(id)?.exportsWithDuplicate.push(exportNode);
    }
  }
}

// ---- Import types and dynamic imports

/** The type of `import("m")`, `import("m").T` or `typeof import("m").v`. */
export function getTypeFromImportTypeNode(c: Checker, node: Node): Type {
  const type = c.resolvedTypes.get(node.id);
  if (type !== undefined) return type;
  const importType = node as ImportTypeNode;
  if (!isLiteralImportTypeNode(node)) {
    c.error(importType.argument, Diagnostics.String_literal_expected);
    c.resolvedSymbols.set(node.id, c.unknownSymbol);
    c.resolvedTypes.set(node.id, c.errorType);
    return c.resolvedTypes.get(node.id)!;
  }
  const targetMeaning = importType.isTypeOf ? SymbolFlags.Value : SymbolFlags.Type;
  const literal = (importType.argument as LiteralTypeNode).literal;
  const innerModuleSymbol = resolveExternalModuleName(
    c,
    node,
    literal,
    false,
    getTypeFromImportAttributes(c, importType.attributes),
  );
  if (innerModuleSymbol === undefined) {
    c.resolvedSymbols.set(node.id, c.unknownSymbol);
    c.resolvedTypes.set(node.id, c.errorType);
    return c.resolvedTypes.get(node.id)!;
  }
  const moduleSymbol = resolveExternalModuleSymbol(c, innerModuleSymbol, false)!;
  const qualifier = importType.qualifier;
  if (qualifier !== undefined && !nodeIsMissing(qualifier)) {
    const nameChain = getIdentifierChain(qualifier);
    let currentNamespace = moduleSymbol;
    for (let i = 0; i < nameChain.length; i++) {
      const current = nameChain[i]!;
      const meaning = i === nameChain.length - 1 ? targetMeaning : SymbolFlags.Namespace;
      const merged = getMergedSymbol(c, resolveSymbol(c, currentNamespace)!);
      const text = getText(current);
      const next = importType.isTypeOf
        ? getPropertyOfTypeEx(c, getTypeOfSymbol(c, merged), text, false, true)
        : getSymbolOfMeaning(c, getExportsOfSymbol(c, merged), text, meaning);
      if (next === undefined) {
        c.error(
          current,
          Diagnostics.Namespace_0_has_no_exported_member_1,
          getFullyQualifiedName(c, currentNamespace),
          declarationNameToString(getSourceFileOfNode(current), current),
        );
        c.resolvedTypes.set(node.id, c.errorType);
        return c.resolvedTypes.get(node.id)!;
      }
      c.resolvedSymbols.set(current.id, next);
      c.resolvedSymbols.set(current.parent!.id, next);
      currentNamespace = next;
    }
    c.resolvedTypes.set(node.id, resolveImportSymbolType(c, node, currentNamespace, targetMeaning));
  } else if ((getSymbolFlags(c, moduleSymbol) & targetMeaning) !== 0) {
    c.resolvedTypes.set(node.id, resolveImportSymbolType(c, node, moduleSymbol, targetMeaning));
  } else {
    c.error(
      node,
      targetMeaning === SymbolFlags.Value
        ? Diagnostics.Module_0_does_not_refer_to_a_value_but_is_used_as_a_value_here
        : Diagnostics.Module_0_does_not_refer_to_a_type_but_is_used_as_a_type_here_Did_you_mean_typeof_import_0,
      getText(literal),
    );
    c.resolvedSymbols.set(node.id, c.unknownSymbol);
    c.resolvedTypes.set(node.id, c.errorType);
  }
  return c.resolvedTypes.get(node.id)!;
}

function getIdentifierChain(node: Node): Node[] {
  if (node.kind === SyntaxKind.Identifier) return [node];
  const chain = getIdentifierChain((node as QualifiedName).left);
  chain.push((node as QualifiedName).right);
  return chain;
}

function resolveImportSymbolType(c: Checker, node: Node, symbol: Symbol, meaning: SymbolFlags): Type {
  const resolvedSymbol = resolveSymbol(c, symbol)!;
  c.resolvedSymbols.set(node.id, resolvedSymbol);
  // A value's type comes from the alias, which caches it, instantiated with the node's type arguments.
  if (meaning === SymbolFlags.Value) return getInstantiationExpressionType(c, getTypeOfSymbol(c, symbol), node);
  return getTypeReferenceType(c, node, resolvedSymbol);
}

/** `import(specifier, options)`: a promise of the module namespace. */
export function checkImportCallExpression(c: Checker, node: Node): Type {
  const args = (node as CallExpression).arguments.nodes;
  if (args.length === 0) return createPromiseReturnType(c, node, c.anyType);
  const specifier = args[0]!;
  const specifierType = checkExpressionCached(c, specifier);
  const optionsType = args.length > 1 ? checkExpressionCached(c, args[1]!) : undefined;
  // Extra arguments are a grammar error; check them for completions.
  for (let i = 2; i < args.length; i++) checkExpressionCached(c, args[i]!);
  if ((specifierType.flags & TypeFlags.Nullable) !== 0 || !isTypeAssignableTo(c, specifierType, c.stringType))
    c.error(
      specifier,
      Diagnostics.Dynamic_import_s_specifier_must_be_of_type_string_but_here_has_type_0,
      typeToString(c, specifierType),
    );
  let importAttributesType: Type | undefined;
  if (optionsType !== undefined) {
    const importCallOptionsType = getCachedGlobalType(c, 'ImportCallOptions', 0, true);
    if (importCallOptionsType !== c.emptyObjectType)
      checkTypeAssignableTo(
        c,
        optionsType,
        getNullableType(c, importCallOptionsType, TypeFlags.Undefined),
        args[1]!,
        undefined,
      );
    if (args[1]!.kind === SyntaxKind.ObjectLiteralExpression)
      for (const property of (args[1]! as ObjectLiteralExpression).properties.nodes) {
        const name = getName(property);
        if (
          property.kind === SyntaxKind.PropertyAssignment &&
          name !== undefined &&
          name.kind === SyntaxKind.Identifier &&
          getText(name) === 'assert'
        ) {
          c.error(
            name,
            Diagnostics.Import_assertions_have_been_replaced_by_import_attributes_Use_with_instead_of_assert,
          );
          break;
        }
      }
    importAttributesType = getTypeOfPropertyOfType(c, optionsType, 'with');
  }
  if (isSourcePhaseImportCall(node)) return createPromiseReturnType(c, node, getGlobalAbstractModuleSourceType(c));
  const moduleSymbol = resolveExternalModuleName(c, node, specifier, false, importAttributesType);
  if (moduleSymbol !== undefined) {
    const esModuleSymbol = resolveExternalModuleSymbol(c, moduleSymbol, true);
    if (esModuleSymbol !== undefined)
      return createPromiseReturnType(
        c,
        node,
        getTypeWithSyntheticDefaultOnly(
          c,
          getTypeOfSymbol(c, esModuleSymbol),
          esModuleSymbol,
          moduleSymbol,
          specifier,
          importAttributesType,
        ) ??
          getTypeWithSyntheticDefaultImportType(
            c,
            getTypeOfSymbol(c, esModuleSymbol),
            esModuleSymbol,
            moduleSymbol,
            specifier,
          ),
      );
  }
  return createPromiseReturnType(c, node, c.anyType);
}

/** `AbstractModuleSource`, the type of a source phase import's binding (lib.esnext.modulesource). */
function getGlobalAbstractModuleSourceType(c: Checker): Type {
  return getCachedGlobalType(c, 'AbstractModuleSource', 0, true);
}

function createPromiseReturnType(c: Checker, node: Node, promisedType: Type): Type {
  const promiseType = createPromiseType(c, promisedType);
  if (promiseType !== c.unknownType) return promiseType;
  c.error(
    node,
    Diagnostics.A_dynamic_import_call_returns_a_Promise_Make_sure_you_have_a_declaration_for_Promise_or_include_ES2015_in_your_lib_option,
  );
  return c.errorType;
}

// ---- JSDoc links

/** The symbol a `{@link}` name refers to, as an entity or a member of one. */
export function resolveJSDocMemberName(c: Checker, name: Node | undefined): Symbol | undefined {
  if (name === undefined || (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.QualifiedName))
    return undefined;
  const meaning = SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Value;
  const symbol = resolveEntityName(c, name, meaning, true, true, getHostSignatureFromJSDoc(name));
  if (symbol !== undefined) return symbol;
  if (name.kind !== SyntaxKind.QualifiedName) return undefined;
  const left = resolveJSDocMemberName(c, (name as QualifiedName).left);
  if (left === undefined) return undefined;
  let type: Type | undefined;
  if ((left.flags & SymbolFlags.Value) !== 0) {
    const prototype = getPropertyOfType(c, getTypeOfSymbol(c, left), 'prototype');
    if (prototype !== undefined) type = getTypeOfSymbol(c, prototype);
  }
  return getPropertyOfType(c, type ?? getDeclaredTypeOfSymbol(c, left), getText((name as QualifiedName).right));
}

export function getHostSignatureFromJSDoc(node: Node): Node | undefined {
  let current: Node | undefined = node;
  while (current !== undefined && current.kind !== SyntaxKind.JSDoc) current = current.parent;
  const host = current?.parent;
  return host !== undefined && isFunctionLike(host) ? host : undefined;
}

// ---- Meta properties

/** `import.meta` and `new.target`. */
export function checkMetaProperty(c: Checker, node: Node): Type {
  const meta = node as MetaProperty;
  if (meta.keywordToken === SyntaxKind.NewKeyword) return checkNewTargetMetaProperty(c, node);
  // `import.defer` and `import.source` are only valid as callees.
  if (isImportPhaseMetaProperty(node)) return c.errorType;
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  if (moduleKind >= ModuleKind.Node16 && moduleKind <= ModuleKind.NodeNext) {
    if (c.host.getImpliedNodeFormatForEmit(getSourceFileOfNode(node)) === ModuleKind.CommonJS)
      c.error(
        node,
        Diagnostics.The_import_meta_meta_property_is_not_allowed_in_files_which_will_build_into_CommonJS_output,
      );
  } else if (moduleKind < ModuleKind.ES2020 && moduleKind !== ModuleKind.System)
    c.error(
      node,
      Diagnostics.The_import_meta_meta_property_is_only_allowed_when_the_module_option_is_es2020_es2022_esnext_system_node16_node18_node20_or_nodenext,
    );
  return meta.name.text === 'meta' ? getCachedGlobalType(c, 'ImportMeta', 0, true) : c.errorType;
}

export function checkNewTargetMetaProperty(c: Checker, node: Node): Type {
  const container = getThisContainer(node, false, false);
  if (
    container.kind !== SyntaxKind.Constructor &&
    container.kind !== SyntaxKind.FunctionDeclaration &&
    container.kind !== SyntaxKind.FunctionExpression
  ) {
    c.error(
      node,
      Diagnostics.Meta_property_0_is_only_allowed_in_the_body_of_a_function_declaration_function_expression_or_constructor,
      'new.target',
    );
    return c.errorType;
  }
  const symbol = getSymbolOfDeclaration(c, container.kind === SyntaxKind.Constructor ? container.parent! : container);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.errorType;
}

// ---- Import and export declarations

/**
 * Whether an import or export with a module specifier is in a valid place with a valid specifier;
 * the grammar checker reports the errors.
 */
function isValidExternalImportOrExportDeclaration(node: Node): boolean {
  const moduleName = getExternalModuleName(node);
  if (moduleName === undefined || nodeIsMissing(moduleName) || moduleName.kind !== SyntaxKind.StringLiteral)
    return false;
  const parent = node.parent!;
  const inAmbientExternalModule = parent.kind === SyntaxKind.ModuleBlock && isAmbientModule(parent.parent!);
  if (parent.kind !== SyntaxKind.SourceFile && !inAmbientExternalModule) return false;
  if (
    inAmbientExternalModule &&
    isExternalModuleNameRelative(getText(moduleName)) &&
    !isModuleAugmentationExternal(parent.parent!)
  )
    return false;
  if (node.kind === SyntaxKind.ImportEqualsDeclaration) return true;
  const attributes = getImportAttributes(node);
  if (attributes === undefined) return true;
  for (const attribute of attributes.attributes.nodes)
    if ((attribute as ImportAttribute).value.kind !== SyntaxKind.StringLiteral) return false;
  return true;
}

/**
 * Resolves the module an import or export in an illegal context names, when that context is still
 * in a file's global scope (a block), to report a missing module. A side-effect import isn't resolved.
 */
function checkExternalModuleNameInGlobalScope(c: Checker, node: Node): void {
  let container = node.parent;
  while (container !== undefined && (getContainerFlags(container) & ContainerFlags.IsContainer) === 0)
    container = container.parent;
  if (container === undefined || container.kind !== SyntaxKind.SourceFile) return;
  if (
    (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.JSImportDeclaration) &&
    (node as ImportDeclaration).importClause === undefined
  )
    return;
  const moduleName = getExternalModuleName(node);
  if (moduleName !== undefined)
    resolveExternalModuleName(c, node, moduleName, false, getTypeFromImportAttributes(c, getImportAttributes(node)));
}

function isInModuleElementContext(node: Node): boolean {
  const parent = node.parent!.kind;
  return (
    parent === SyntaxKind.SourceFile || parent === SyntaxKind.ModuleBlock || parent === SyntaxKind.ModuleDeclaration
  );
}

function getImportAttributes(node: Node): ImportAttributes | undefined {
  if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.JSImportDeclaration)
    return (node as ImportDeclaration).attributes;
  if (node.kind === SyntaxKind.ExportDeclaration) return (node as ExportDeclaration).attributes;
  if (node.kind === SyntaxKind.ImportType) return (node as ImportTypeNode).attributes;
  return undefined;
}

/** Whether the grammar checker reports the import clause, which skips its bindings. */
function hasImportClauseGrammarError(c: Checker, node: ImportClause): boolean {
  const namedBindings = node.namedBindings;
  if (node.phaseModifier === SyntaxKind.TypeKeyword) {
    if ((node.flags & NodeFlags.JSDoc) === 0 && node.name !== undefined && namedBindings !== undefined)
      return !hasParseErrors(node);
    if (namedBindings !== undefined && namedBindings.kind === SyntaxKind.NamedImports)
      for (const specifier of (namedBindings as NamedImports).elements.nodes)
        if (getIsTypeOnly(specifier)) return !hasParseErrors(node);
  } else if (node.phaseModifier === SyntaxKind.DeferKeyword) {
    if (node.name !== undefined) return !hasParseErrors(node);
    if (namedBindings !== undefined && namedBindings.kind === SyntaxKind.NamedImports) return !hasParseErrors(node);
    const moduleKind = getEmitModuleKind(c.compilerOptions);
    if (moduleKind !== ModuleKind.ESNext && moduleKind !== ModuleKind.Preserve) return !hasParseErrors(node);
  }
  return false;
}

function hasParseErrors(node: Node): boolean {
  return getSourceFileOfNode(node).diagnostics.length > 0;
}

export function checkImportDeclaration(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node)) checkExternalModuleNameInGlobalScope(c, node);
  if (!isInModuleElementContext(node) || !isValidExternalImportOrExportDeclaration(node)) {
    checkImportAttributes(c, node);
    return;
  }
  const declaration = node as ImportDeclaration;
  const clause = declaration.importClause;
  if (clause !== undefined && !hasImportClauseGrammarError(c, clause)) {
    if (clause.name !== undefined) checkImportBinding(c, clause);
    const namedBindings = clause.namedBindings;
    let resolvedModule: Symbol | undefined;
    const emittedAsCommonJS = c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS;
    let needsImportStar = false;
    if (namedBindings !== undefined) {
      if (namedBindings.kind === SyntaxKind.NamespaceImport) {
        checkImportBinding(c, namedBindings);
        if (emittedAsCommonJS) {
          needsImportStar = true;
          checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ImportStar);
        }
      } else {
        resolvedModule = resolveExternalModuleName(
          c,
          node,
          declaration.moduleSpecifier,
          false,
          getTypeFromImportAttributes(c, declaration.attributes),
        );
        if (resolvedModule !== undefined)
          for (const binding of (namedBindings as NamedImports).elements.nodes) checkImportBinding(c, binding);
      }
    }
    if (clause.name !== undefined && !needsImportStar && emittedAsCommonJS)
      checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ImportDefault);
    const moduleKind = getEmitModuleKind(c.compilerOptions);
    if (
      !isTypeOnly(clause) &&
      moduleKind >= ModuleKind.Node18 &&
      moduleKind <= ModuleKind.NodeNext &&
      isOnlyImportableAsDefault(
        c,
        declaration.moduleSpecifier,
        resolvedModule,
        getTypeFromImportAttributes(c, declaration.attributes),
      ) &&
      !hasTypeJsonImportAttribute(declaration)
    )
      c.error(
        declaration.moduleSpecifier,
        Diagnostics.Importing_a_JSON_file_into_an_ECMAScript_module_requires_a_type_Colon_json_import_attribute_when_module_is_set_to_0,
        moduleKindName(moduleKind),
      );
  } else if (clause === undefined && c.compilerOptions.noUncheckedSideEffectImports !== false)
    resolveExternalModuleNameWorker(
      c,
      node,
      declaration.moduleSpecifier,
      Diagnostics.Cannot_find_module_or_type_declarations_for_side_effect_import_of_0,
      false,
      false,
      getTypeFromImportAttributes(c, declaration.attributes),
    );
  checkImportAttributes(c, node);
}

function hasTypeJsonImportAttribute(node: ImportDeclaration): boolean {
  const attributes = getImportAttributes(node) as ImportAttributes | undefined;
  if (attributes === undefined) return false;
  for (const attribute of attributes.attributes.nodes) {
    const value = (attribute as ImportAttribute).value;
    if (getText(getName(attribute)!) === 'type' && isStringLiteralLike(value) && getText(value) === 'json') return true;
  }
  return false;
}

function checkImportBinding(c: Checker, node: Node): void {
  checkCollisionsForDeclarationName(c, node, getName(node));
  checkAliasSymbol(c, node);
  if (
    node.kind === SyntaxKind.ImportSpecifier &&
    moduleExportNameIsDefault(getPropertyNameOrName(node)) &&
    c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS
  )
    checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ImportDefault);
}

/** Import attributes must be assignable to the global `ImportAttributes`. */
export function checkImportAttributes(c: Checker, declaration: Node): void {
  const node = getImportAttributes(declaration);
  if (node === undefined) return;
  const importAttributesType = getCachedGlobalType(c, 'ImportAttributes', 0, true);
  if (importAttributesType !== c.emptyObjectType)
    checkTypeAssignableTo(
      c,
      checkImportAttributesExpression(c, node),
      getNullableType(c, importAttributesType, TypeFlags.Undefined),
      node,
      undefined,
    );
}

/** The type of import attributes, which resolution matches against the attributes types of pattern ambient modules. */
function getTypeFromImportAttributes(c: Checker, node: Node | undefined): Type | undefined {
  if (node === undefined) return undefined;
  if (node.kind === SyntaxKind.ImportAttributes) return checkImportAttributesExpression(c, node as ImportAttributes);
  return checkExpressionCached(c, node);
}

/** The import attributes type of the declaration `node` is the module specifier of. */
export function getImportAttributesTypeForModuleSpecifier(c: Checker, moduleSpecifier: Node): Type | undefined {
  const parent = moduleSpecifier.parent!;
  switch (parent.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportDeclaration:
      return getTypeFromImportAttributes(c, getImportAttributes(parent));
    case SyntaxKind.LiteralType:
      if (parent.parent!.kind === SyntaxKind.ImportType)
        return getTypeFromImportAttributes(c, (parent.parent as ImportTypeNode).attributes);
      return undefined;
    case SyntaxKind.CallExpression: {
      const args = (parent as CallExpression).arguments.nodes;
      if (isImportCall(parent) && args.length > 1)
        return getTypeOfPropertyOfType(c, checkExpressionCached(c, args[1]!), 'with');
      return undefined;
    }
  }
  return undefined;
}

export function checkImportAttributesExpression(c: Checker, node: ImportAttributes): Type {
  if (c.resolvedTypes.get(node.id) === undefined) {
    const symbol = c.newSymbol(SymbolFlags.ObjectLiteral, InternalSymbolName.ImportAttributes);
    const members: SymbolTable = new Map<string, Symbol>();
    for (const attribute of node.attributes.nodes) {
      const name = getText((attribute as ImportAttribute).name!);
      const member = c.newSymbol(SymbolFlags.Property, name);
      c.symbolTypes.set(
        getSymbolId(member),
        getRegularTypeOfLiteralType(c, checkExpressionCached(c, (attribute as ImportAttribute).value)),
      );
      members.set(name, member);
    }
    const type = createAnonymousType(c, symbol, members, [], [], []);
    type.objectFlags |= ObjectFlags.ObjectLiteral | ObjectFlags.NonInferrableType;
    c.resolvedTypes.set(node.id, type);
  }
  return c.resolvedTypes.get(node.id)!;
}

export function checkImportEqualsDeclaration(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node)) {
    checkExternalModuleNameInGlobalScope(c, node);
    return;
  }
  const declaration = node as ImportEqualsDeclaration;
  const reference = declaration.moduleReference;
  const isExternal = reference.kind === SyntaxKind.ExternalModuleReference;
  if (shouldCheckErasableSyntax(c, node) && (node.flags & NodeFlags.Ambient) === 0)
    c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
  if (isExternal && !isValidExternalImportOrExportDeclaration(node)) return;
  checkImportBinding(c, node);
  if (hasSyntacticModifier(node, ModifierFlags.Export) && (node.flags & NodeFlags.Ambient) === 0)
    markExportAsReferenced(c, node);
  if (isExternal) return;
  const target = resolveAlias(c, getSymbolOfDeclaration(c, node)!);
  if (target === c.unknownSymbol) return;
  const targetFlags = getSymbolFlags(c, target);
  if ((targetFlags & SymbolFlags.Value) !== 0) {
    // A value target must not be hidden by a local declaration of the same name.
    const moduleName = getFirstIdentifierOfEntityName(reference);
    const resolved = resolveEntityName(
      c,
      moduleName,
      SymbolFlags.Value | SymbolFlags.Namespace,
      false,
      false,
      undefined,
    );
    if (resolved !== undefined && (resolved.flags & SymbolFlags.Namespace) === 0)
      c.error(
        moduleName,
        Diagnostics.Module_0_is_hidden_by_a_local_declaration_with_the_same_name,
        declarationNameToString(getSourceFileOfNode(moduleName), moduleName),
      );
  }
  if ((targetFlags & SymbolFlags.Type) !== 0)
    checkTypeNameIsReserved(c, declaration.name, Diagnostics.Import_name_cannot_be_0);
}

function getFirstIdentifierOfEntityName(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.QualifiedName) current = (current as QualifiedName).left;
  return current;
}

/** The string literal name of `export * as "x" from`, which module es2015 and es2020 don't support. */
function checkNamespaceExportName(c: Checker, name: Node | undefined): void {
  if (name === undefined || name.kind !== SyntaxKind.StringLiteral) return;
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  if (
    (moduleKind === ModuleKind.ES2015 || moduleKind === ModuleKind.ES2020) &&
    !getSourceFileOfNode(name).isDeclarationFile
  )
    grammarErrorOnNode(
      c,
      name,
      Diagnostics.String_literal_import_and_export_names_are_not_supported_when_the_module_flag_is_set_to_es2015_or_es2020,
    );
}

export function checkExportDeclaration(c: Checker, node: Node): void {
  if (!isInModuleElementContext(node)) {
    checkExternalModuleNameInGlobalScope(c, node);
    return;
  }
  const declaration = node as ExportDeclaration;
  if (declaration.moduleSpecifier === undefined || isValidExternalImportOrExportDeclaration(node)) {
    const clause = declaration.exportClause;
    if (clause !== undefined && clause.kind === SyntaxKind.NamedExports) {
      for (const specifier of (clause as NamedExports).elements.nodes) checkExportSpecifier(c, specifier);
    } else {
      const moduleSymbol = resolveExternalModuleName(
        c,
        node,
        declaration.moduleSpecifier,
        false,
        getTypeFromImportAttributes(c, declaration.attributes),
      );
      if (moduleSymbol !== undefined && hasExportAssignmentSymbol(moduleSymbol))
        c.error(
          declaration.moduleSpecifier,
          Diagnostics.Module_0_uses_export_and_cannot_be_used_with_export_Asterisk,
          symbolToString(c, moduleSymbol),
        );
      else if (clause !== undefined) {
        checkAliasSymbol(c, clause);
        checkNamespaceExportName(c, getName(clause));
      }
      if (c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS)
        checkExternalEmitHelpers(
          c,
          node,
          clause !== undefined ? ExternalEmitHelpers.ImportStar : ExternalEmitHelpers.ExportStar,
        );
    }
  }
  checkImportAttributes(c, node);
}

function checkExportSpecifier(c: Checker, node: Node): void {
  checkAliasSymbol(c, node);
  if ((node.parent!.parent as ExportDeclaration).moduleSpecifier !== undefined) {
    if (
      c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS &&
      moduleExportNameIsDefault(getPropertyNameOrName(node))
    )
      checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ImportDefault);
    return;
  }
  const exportedName = getPropertyNameOrName(node);
  // `export { "x" }` is a syntax error.
  if (exportedName.kind === SyntaxKind.StringLiteral) return;
  // The immediate symbol of the name, without following aliases.
  const symbol = resolveName(
    c,
    exportedName,
    getText(exportedName),
    SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias,
    undefined,
    true,
    false,
  );
  if (
    symbol !== undefined &&
    (symbol === c.undefinedSymbol ||
      symbol === c.globalThisSymbol ||
      (declarationCount(symbol) > 0 && isGlobalSourceFile(getDeclarationContainer(symbol.declaration!))))
  )
    c.error(
      exportedName,
      Diagnostics.Cannot_export_0_Only_local_declarations_can_be_exported_from_a_module,
      getText(exportedName),
    );
  else markExportSpecifierAliasReferenced(c, node, symbol, exportedName);
}

export function getDeclarationContainer(node: Node): Node {
  let current = getRootDeclaration(node);
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return current;
    switch (current.kind) {
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.VariableDeclarationList:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportClause:
        current = parent;
        continue;
    }
    return parent;
  }
}

/** `export = e` and `export default e`; the grammar checker reports misplaced ones. */
/** Whether an export assignment is in a namespace, rather than a file or an ambient module. */
function isContainedByNamespace(node: Node): boolean {
  const container = node.parent!.kind === SyntaxKind.SourceFile ? node.parent! : node.parent!.parent!;
  return container.kind === SyntaxKind.ModuleDeclaration && !isAmbientModule(container);
}

export function checkExportAssignment(c: Checker, node: Node): void {
  const declaration = node as ExportAssignment;
  // The expression is checked also where an export assignment is a grammar error.
  const exprType = checkExpressionCached(c, declaration.expression);
  if (!isInModuleElementContext(node)) return;
  const isExportEquals = declaration.isExportEquals;
  const ambient = (node.flags & NodeFlags.Ambient) !== 0;
  if (shouldCheckErasableSyntax(c, node) && isExportEquals && !ambient)
    c.error(node, Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled);
  if (isContainedByNamespace(node)) return;
  const container = node.parent!.kind === SyntaxKind.SourceFile ? node.parent! : node.parent!.parent!;
  const verbatimModuleSyntax = c.compilerOptions.verbatimModuleSyntax === true;
  const isIllegalExportDefaultInCJS =
    !isExportEquals &&
    !ambient &&
    verbatimModuleSyntax &&
    c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS;
  const expression = declaration.expression;
  if (expression.kind === SyntaxKind.Identifier) {
    const id = expression;
    const resolved = resolveEntityName(c, id, SymbolFlags.All, true, true, node);
    if (resolved !== undefined) {
      const sym = getExportSymbolOfValueSymbolIfExported(c, resolved);
      if (!ambient) markAliasReferenced(c, sym, id);
      const typeOnlyDeclaration = getTypeOnlyAliasDeclarationOfMeaning(c, sym, SymbolFlags.Value);
      const name = getText(id);
      // A non-value is exported as a type, like `export { Id as default }`.
      if ((getSymbolFlags(c, sym) & SymbolFlags.Value) !== 0) {
        if (!isIllegalExportDefaultInCJS && !ambient && verbatimModuleSyntax && typeOnlyDeclaration !== undefined)
          c.error(
            id,
            isExportEquals
              ? Diagnostics.An_export_declaration_must_reference_a_real_value_when_verbatimModuleSyntax_is_enabled_but_0_resolves_to_a_type_only_declaration
              : Diagnostics.An_export_default_must_reference_a_real_value_when_verbatimModuleSyntax_is_enabled_but_0_resolves_to_a_type_only_declaration,
            name,
          );
      } else if (!isIllegalExportDefaultInCJS && !ambient && verbatimModuleSyntax)
        c.error(
          id,
          isExportEquals
            ? Diagnostics.An_export_declaration_must_reference_a_value_when_verbatimModuleSyntax_is_enabled_but_0_only_refers_to_a_type
            : Diagnostics.An_export_default_must_reference_a_value_when_verbatimModuleSyntax_is_enabled_but_0_only_refers_to_a_type,
          name,
        );
      if (!isIllegalExportDefaultInCJS && !ambient && c.isolatedModules && (sym.flags & SymbolFlags.Value) === 0)
        checkIsolatedModulesExportAssignment(c, node, sym, typeOnlyDeclaration, isExportEquals);
    }
  }
  if (isIllegalExportDefaultInCJS) c.error(node, verbatimModuleSyntaxErrorMessage(node));
  checkExternalModuleExports(c, container);
  // A JSDoc `@type` on `export default`.
  const typeNode = getType(node);
  if (typeNode !== undefined) {
    const expr = getExpression(node)!;
    checkTypeAssignableToAndOptionallyElaborate(c, exprType, getTypeFromTypeNode(c, typeNode), expr, expr);
  }
}

function checkIsolatedModulesExportAssignment(
  c: Checker,
  node: Node,
  sym: Symbol,
  typeOnlyDeclaration: Node | undefined,
  isExportEquals: boolean,
): void {
  const id = getExpression(node)!;
  const name = getText(id);
  const nonLocalMeanings = getSymbolFlagsEx(c, sym, false, true);
  const sameFile =
    typeOnlyDeclaration !== undefined && getSourceFileOfNode(typeOnlyDeclaration) === getSourceFileOfNode(node);
  if (
    (sym.flags & SymbolFlags.Alias) !== 0 &&
    (nonLocalMeanings & SymbolFlags.Type) !== 0 &&
    (nonLocalMeanings & SymbolFlags.Value) === 0 &&
    !sameFile
  )
    c.error(
      id,
      isExportEquals
        ? Diagnostics.X_0_resolves_to_a_type_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_import_type_where_0_is_imported
        : Diagnostics.X_0_resolves_to_a_type_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_export_type_0_as_default,
      name,
      getIsolatedModulesLikeFlagName(c),
    );
  else if (typeOnlyDeclaration !== undefined && !sameFile)
    addTypeOnlyDeclarationRelatedInfo(
      c.error(
        id,
        isExportEquals
          ? Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_import_type_where_0_is_imported
          : Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_marked_type_only_in_this_file_before_re_exporting_when_1_is_enabled_Consider_using_export_type_0_as_default,
        name,
        getIsolatedModulesLikeFlagName(c),
      ),
      typeOnlyDeclaration,
      name,
    );
}

/** Reports aliases that conflict with local declarations, and type-only rules of isolated modules. */
export function checkAliasSymbol(c: Checker, node: Node): void {
  const aliasSymbol = getSymbolOfDeclaration(c, node);
  if (aliasSymbol === undefined) return;
  const target = resolveAlias(c, aliasSymbol);
  if (target === c.unknownSymbol) return;
  // The local symbol merges other local (and exported) declarations, whose meanings the target can't have.
  const symbol = getMergedSymbol(c, aliasSymbol.exportSymbol ?? aliasSymbol);
  const targetFlags = getSymbolFlags(c, target);
  // Type-only imports and exports are grammar errors in JavaScript.
  if (isInJSFile(node) && (targetFlags & SymbolFlags.Value) === 0 && !isTypeOnlyImportOrExportDeclaration(node)) {
    reportJSTypeAlias(c, node, symbol);
    return;
  }
  const excludedMeanings =
    ((symbol.flags & (SymbolFlags.Value | SymbolFlags.ExportValue)) !== 0 ? SymbolFlags.Value : 0) |
    ((symbol.flags & SymbolFlags.Type) !== 0 ? SymbolFlags.Type : 0) |
    ((symbol.flags & SymbolFlags.Namespace) !== 0 ? SymbolFlags.Namespace : 0);
  if ((targetFlags & excludedMeanings) !== 0)
    c.error(
      node,
      node.kind === SyntaxKind.ExportSpecifier
        ? Diagnostics.Export_declaration_conflicts_with_exported_declaration_of_0
        : Diagnostics.Import_declaration_conflicts_with_local_declaration_of_0,
      symbolToString(c, symbol),
    );
  else if (
    node.kind !== SyntaxKind.ExportSpecifier &&
    c.compilerOptions.isolatedModules === true &&
    !isPartOfTypeOnlyImportOrExportDeclaration(node) &&
    (symbol.flags & (SymbolFlags.Value | SymbolFlags.ExportValue)) !== 0
  )
    // A transpiler sees a value import that collides with the local value.
    c.error(
      node,
      Diagnostics.Import_0_conflicts_with_local_value_so_must_be_declared_with_a_type_only_import_when_isolatedModules_is_enabled,
      symbolToString(c, symbol),
      getIsolatedModulesLikeFlagName(c),
    );
  if (c.isolatedModules && !isTypeOnlyImportOrExportDeclaration(node) && (node.flags & NodeFlags.Ambient) === 0)
    checkIsolatedModulesAlias(c, node, symbol, target, targetFlags);
  if (node.kind === SyntaxKind.ImportSpecifier) checkDeprecatedImportSpecifier(c, node, symbol);
}

function reportJSTypeAlias(c: Checker, node: Node, symbol: Symbol): void {
  const errorNode = getPropertyName(node) ?? getName(node) ?? node;
  if (node.kind === SyntaxKind.ExportSpecifier) {
    c.error(errorNode, Diagnostics.Types_cannot_appear_in_export_declarations_in_JavaScript_files);
    return;
  }
  const identifierText = errorNode.kind === SyntaxKind.Identifier ? getText(errorNode) : symbol.name;
  let specifierText = '...';
  let declaration: Node | undefined = node;
  while (
    declaration !== undefined &&
    declaration.kind !== SyntaxKind.ImportDeclaration &&
    declaration.kind !== SyntaxKind.ImportEqualsDeclaration &&
    declaration.kind !== SyntaxKind.VariableDeclaration
  )
    declaration = declaration.parent;
  if (declaration !== undefined) {
    const specifier =
      declaration.kind === SyntaxKind.VariableDeclaration
        ? isVariableDeclarationInitializedToRequire(declaration)
          ? (getInitializer(declaration) as CallExpression).arguments.nodes[0]!
          : undefined
        : getExternalModuleName(declaration);
    if (specifier !== undefined && isStringLiteralLike(specifier)) specifierText = getText(specifier);
  }
  let importText = 'import("' + specifierText + '")';
  if (node.kind === SyntaxKind.ImportSpecifier) importText += '.' + identifierText;
  c.error(
    errorNode,
    Diagnostics.X_0_is_a_type_and_cannot_be_imported_in_JavaScript_files_Use_1_in_a_JSDoc_type_annotation,
    identifierText,
    importText,
  );
}

function checkIsolatedModulesAlias(
  c: Checker,
  node: Node,
  symbol: Symbol,
  target: Symbol,
  targetFlags: SymbolFlags,
): void {
  const verbatimModuleSyntax = c.compilerOptions.verbatimModuleSyntax === true;
  const typeOnlyAlias = getTypeOnlyAliasDeclaration(c, symbol);
  const isType = (targetFlags & SymbolFlags.Value) === 0;
  if (isType || typeOnlyAlias !== undefined) {
    switch (node.kind) {
      case SyntaxKind.ImportClause:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.ImportEqualsDeclaration: {
        if (verbatimModuleSyntax) {
          const message =
            node.kind === SyntaxKind.ImportEqualsDeclaration &&
            (node as ImportEqualsDeclaration).moduleReference.kind !== SyntaxKind.ExternalModuleReference
              ? Diagnostics.An_import_alias_cannot_resolve_to_a_type_or_type_only_declaration_when_verbatimModuleSyntax_is_enabled
              : isType
                ? Diagnostics.X_0_is_a_type_and_must_be_imported_using_a_type_only_import_when_verbatimModuleSyntax_is_enabled
                : Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_imported_using_a_type_only_import_when_verbatimModuleSyntax_is_enabled;
          const name = getText(getPropertyNameOrName(node));
          addTypeOnlyDeclarationRelatedInfo(c.error(node, message, name), isType ? undefined : typeOnlyAlias, name);
        }
        if (
          isType &&
          node.kind === SyntaxKind.ImportEqualsDeclaration &&
          hasSyntacticModifier(node, ModifierFlags.Export)
        )
          c.error(
            node,
            Diagnostics.Cannot_use_export_import_on_a_type_or_type_only_namespace_when_0_is_enabled,
            getIsolatedModulesLikeFlagName(c),
          );
        break;
      }
      case SyntaxKind.ExportSpecifier:
        // `import type { A } from './a'; export { A }` is fine: one file shows the export is a type.
        if (
          verbatimModuleSyntax ||
          typeOnlyAlias === undefined ||
          getSourceFileOfNode(typeOnlyAlias) !== getSourceFileOfNode(node)
        ) {
          const name = getText(getPropertyNameOrName(node));
          const diagnostic = isType
            ? c.error(
                node,
                Diagnostics.Re_exporting_a_type_when_0_is_enabled_requires_using_export_type,
                getIsolatedModulesLikeFlagName(c),
              )
            : c.error(
                node,
                Diagnostics.X_0_resolves_to_a_type_only_declaration_and_must_be_re_exported_using_a_type_only_re_export_when_1_is_enabled,
                name,
                getIsolatedModulesLikeFlagName(c),
              );
          addTypeOnlyDeclarationRelatedInfo(diagnostic, isType ? undefined : typeOnlyAlias, name);
        }
        break;
    }
  }
  if (
    verbatimModuleSyntax &&
    node.kind !== SyntaxKind.ImportEqualsDeclaration &&
    !isInJSFile(node) &&
    c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS
  )
    c.error(node, verbatimModuleSyntaxErrorMessage(node));
  else if (
    getEmitModuleKind(c.compilerOptions) === ModuleKind.Preserve &&
    node.kind !== SyntaxKind.ImportEqualsDeclaration &&
    node.kind !== SyntaxKind.VariableDeclaration &&
    node.kind !== SyntaxKind.BindingElement &&
    c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) === ModuleKind.CommonJS
  )
    // Under `--module preserve` ESM syntax emits as ESM, so it is an error in a file that is CommonJS (.cts, .cjs).
    c.error(
      node,
      Diagnostics.ECMAScript_module_syntax_is_not_allowed_in_a_CommonJS_module_when_module_is_set_to_preserve,
    );
  if (
    verbatimModuleSyntax &&
    (targetFlags & SymbolFlags.ConstEnum) !== 0 &&
    target.valueDeclaration !== undefined &&
    (target.valueDeclaration.flags & NodeFlags.Ambient) !== 0
  )
    c.error(node, Diagnostics.Cannot_access_ambient_const_enums_when_0_is_enabled, getIsolatedModulesLikeFlagName(c));
}

/** The error for ESM syntax in a CommonJS file under `verbatimModuleSyntax`: shorter in a .cts or .cjs file. */
function verbatimModuleSyntaxErrorMessage(node: Node): DiagnosticMessage {
  return fileExtensionIsOneOf(getSourceFileOfNode(node).fileName, ['.cts', '.cjs'])
    ? Diagnostics.ECMAScript_imports_and_exports_cannot_be_written_in_a_CommonJS_file_under_verbatimModuleSyntax
    : Diagnostics.ECMAScript_imports_and_exports_cannot_be_written_in_a_CommonJS_file_under_verbatimModuleSyntax_Adjust_the_type_field_in_the_nearest_package_json_to_make_this_file_an_ECMAScript_module_or_adjust_your_verbatimModuleSyntax_module_and_moduleResolution_settings_in_TypeScript;
}

function isPartOfTypeOnlyImportOrExportDeclaration(node: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (isTypeOnlyImportOrExportDeclaration(current)) return true;
  return false;
}

export function getIsolatedModulesLikeFlagName(c: Checker): string {
  return c.compilerOptions.verbatimModuleSyntax === true ? 'verbatimModuleSyntax' : 'isolatedModules';
}

/** The file a module declaration or import names. */
export function getExternalModuleFileFromDeclaration(c: Checker, declaration: Node): SourceFile | undefined {
  let specifier: Node | undefined = undefined;
  if (declaration.kind === SyntaxKind.ModuleDeclaration) {
    const name = getName(declaration);
    if (name !== undefined && name.kind === SyntaxKind.StringLiteral) specifier = name;
  } else specifier = getExternalModuleName(declaration);
  if (specifier === undefined) return undefined;
  // Used by emit and type printing after checking reported any resolution errors, so it adds none.
  const moduleSymbol = resolveExternalModuleNameWorker(
    c,
    specifier,
    specifier,
    undefined,
    true,
    false,
    getTypeFromImportAttributes(c, getImportAttributes(declaration)),
  );
  if (moduleSymbol === undefined) return undefined;
  const file = getDeclarationOfKind(moduleSymbol, SyntaxKind.SourceFile);
  return file === undefined ? undefined : (file as SourceFile);
}
