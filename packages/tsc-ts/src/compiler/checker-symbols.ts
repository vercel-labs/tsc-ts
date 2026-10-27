// Symbols: merging globals and augmentations, merged and late-bound symbols, aliases, exports,
// entity names and the checker's name resolver.
import { sideOf, signatureSideOf } from './side-state.js';
import { isTypeAssignableToKindEx } from './checker-type-operators.js';
import {
  BinaryExpression,
  type ElementAccessExpression,
  type ExportAssignment,
  type Identifier,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  PatternAmbientModule,
  type QualifiedName,
  type SourceFile,
  Tristate,
  type TypeReferenceNode,
  getExpression,
  getInitializer,
  getMembers as getMemberNodes,
  getName,
  getSymbol,
  getText,
  getIsTypeOnly,
  HeritageClause,
  getProperties,
  getType,
  getLocals,
} from './ast.js';
import { isAmbientModule, isGlobalScopeAugmentation, nodeIsMissing } from './ast-utilities.js';
import { CodePoints, distanceToCandidate, utf8Length } from './spelling.js';
import { setValueDeclaration } from './binder.js';
import { checkResolvedBlockScopedVariable, getEmitStandardClassFields } from './checker-declaration-order.js';
import {
  declarationNameToString,
  getNameOfDeclaration,
  getRootDeclaration,
  getSourceFileOfNode,
  getSourceTextOfNode,
  getDeclarationOfKind,
  getThisContainer,
  hasStaticModifier,
  isClassLike,
  isEntityNameExpression,
  isExternalOrCommonJSModule,
  isPartOfTypeQuery,
  isStatic,
} from './binder-utilities.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics, compareDiagnostics } from './diagnostics.js';
import { NameResolver } from './name-resolver.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  InterfaceType,
  type Type,
  TypeFlags,
  type Signature,
  TypeReference,
  UnionOrIntersectionType,
} from './checker-types.js';
import { compareSymbols } from './checker-type-factory.js';
import { getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { symbolToString } from './type-printer.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getPropertyOfType } from './checker-members.js';
import {
  checkComputedPropertyName,
  checkExpressionCached,
  entityNameToString,
  isConstTypeReference,
} from './checker-expressions.js';
import {
  getLateBindableNameOfDeclaration,
  getPropertyNameFromType,
  isTypeUsableAsPropertyName,
  hasLateBindableName,
  hasLateBindableIndexSignature,
} from './checker-utilities.js';
import {
  checkTypeOnlyAliasUse,
  markAliasDeclarationOfNameIfTypeOnly,
  getExportsOfModuleWorker,
  getTargetOfAliasDeclaration,
  getTypeOfModuleImportAttributes,
  getTypeOnlyAliasDeclaration,
  isTypeOnlyImportOrExportDeclaration,
  resolveExternalModuleNameWorker,
  resolveExternalModuleSymbol,
  resolveIndirectionAlias,
} from './checker-modules.js';
import { isJSAliasDeclaration } from './checker-javascript.js';
import { isTypeIdenticalTo } from './relations.js';
import { getFeatureMap } from './checker-features.js';
import { NodeBuilderInternalFlags } from './transformers/declarations-resolver.js';
import {
  addDeclaration,
  CheckFlags,
  declarationAt,
  declarationCount,
  getDeclarations,
  getSymbolId,
  InternalSymbolName,
  setDeclarations,
  Symbol,
  SymbolFlags,
  type SymbolTable,
  tryGetAmbientModuleNameFromSymbolName,
} from './symbol.js';

// ---- Name resolution

/** The binder's name resolver with the checker's merging, alias handling and errors. */
export class CheckerNameResolver extends NameResolver {
  readonly checker: Checker;

  constructor(checker: Checker) {
    super(checker.compilerOptions);
    this.checker = checker;
    this.globals = checker.globals;
    this.argumentsSymbol = checker.argumentsSymbol;
    this.requireSymbol = checker.requireSymbol;
  }

  lookup(symbols: SymbolTable, name: string, meaning: SymbolFlags): Symbol | undefined {
    return getSymbolOfMeaning(this.checker, symbols, name, meaning);
  }

  getSymbolOfDeclaration(node: Node): Symbol | undefined {
    return getSymbolOfDeclaration(this.checker, node);
  }

  error(location: Node, message: DiagnosticMessage, args: readonly string[]): void {
    this.checker.error(location, message, ...args);
  }

  symbolReferenced(symbol: Symbol, meaning: SymbolFlags): void {
    const kinds = this.checker.symbolReferenceKinds;
    const id = getSymbolId(symbol);
    kinds.set(id, kinds.get(id) | meaning);
  }

  getRequiresScopeChangeCache(node: Node): Tristate {
    return (this.checker.existingNodeLinks(node)?.declarationRequiresScopeChange ?? 0) as Tristate;
  }

  setRequiresScopeChangeCache(node: Node, value: Tristate): void {
    this.checker.nodeLinks(node).declarationRequiresScopeChange = value;
  }

  /**
   * A property initializer that references a local of the constructor, where the initializer is emitted
   * when class fields aren't standard: reports a missing `this.` when the name resolves to nothing, else
   * that the initializer (or the property's type) can't reference it.
   */
  onPropertyWithInvalidInitializer(
    location: Node,
    name: string,
    declaration: Node,
    result: Symbol | undefined,
  ): boolean {
    const c = this.checker;
    if (getEmitStandardClassFields(c)) return false;
    if (result === undefined && checkAndReportErrorForMissingPrefix(c, location, name)) return true;
    const typeNode = getType(declaration);
    const inType = typeNode !== undefined && typeNode.pos <= location.pos && location.pos <= typeNode.end;
    c.error(
      location,
      inType
        ? Diagnostics.Type_of_instance_member_variable_0_cannot_reference_identifier_1_declared_in_the_constructor
        : Diagnostics.Initializer_of_instance_member_variable_0_cannot_reference_identifier_1_declared_in_the_constructor,
      declarationNameToString(getSourceFileOfNode(declaration), getName(declaration)!),
      name,
    );
    return true;
  }

  onFailedToResolveSymbol(
    location: Node | undefined,
    name: string,
    meaning: SymbolFlags,
    message: DiagnosticMessage,
  ): void {
    onFailedToResolveSymbol(this.checker, location, name, meaning, message);
  }

  onSuccessfullyResolvedSymbol(
    location: Node | undefined,
    result: Symbol,
    meaning: SymbolFlags,
    lastLocation: Node | undefined,
    associatedDeclarationForContainingInitializerOrBindingName: Node | undefined,
    withinDeferredContext: boolean,
  ): void {
    const c = this.checker;
    const isInExternalModule =
      lastLocation !== undefined &&
      lastLocation.kind === SyntaxKind.SourceFile &&
      isExternalOrCommonJSModule(lastLocation as SourceFile);
    // Only names in value positions check block-scoped declaration order: a symbol may be both a
    // block-scoped variable and a namespace, as in `const foo: foo.bar`.
    if (
      location !== undefined &&
      ((meaning & SymbolFlags.BlockScopedVariable) !== 0 ||
        ((meaning & (SymbolFlags.Class | SymbolFlags.Enum)) !== 0 &&
          (meaning & SymbolFlags.Value) === SymbolFlags.Value))
    )
      checkResolvedBlockScopedVariable(this.checker, result, location);
    // A module can't reference the value of a UMD global (`export as namespace`).
    if (
      isInExternalModule &&
      location !== undefined &&
      (meaning & SymbolFlags.Value) === SymbolFlags.Value &&
      (location.flags & NodeFlags.JSDoc) === 0
    ) {
      const merged = getMergedSymbol(c, result);
      if (
        declarationCount(merged) !== 0 &&
        getDeclarations(merged).every(
          (d) =>
            d.kind === SyntaxKind.NamespaceExportDeclaration ||
            (d.kind === SyntaxKind.SourceFile && (d as SourceFile).globalExports !== undefined),
        )
      )
        c.addErrorOrSuggestion(
          c.compilerOptions.allowUmdGlobalAccess !== true,
          createDiagnosticForNode(
            location,
            Diagnostics.X_0_refers_to_a_UMD_global_but_the_current_file_is_a_module_Consider_adding_an_import_instead,
            [result.name],
          ),
        );
    }
    // A parameter initializer or binding name can't reference its own parameter or the ones after it.
    const associated = associatedDeclarationForContainingInitializerOrBindingName;
    if (
      location !== undefined &&
      associated !== undefined &&
      !withinDeferredContext &&
      (meaning & SymbolFlags.Value) === SymbolFlags.Value
    ) {
      const candidate = getMergedSymbol(c, getLateBoundSymbol(c, result));
      const root = getRootDeclaration(associated);
      const file = getSourceFileOfNode(associated);
      if (candidate === getSymbolOfDeclaration(c, associated))
        c.error(
          location,
          Diagnostics.Parameter_0_cannot_reference_itself,
          declarationNameToString(file, getName(associated)),
        );
      else if (
        candidate.valueDeclaration !== undefined &&
        candidate.valueDeclaration.pos > associated.pos &&
        getLocals(root.parent!) !== undefined &&
        getSymbolOfMeaning(c, getLocals(root.parent!)!, candidate.name, meaning) === candidate
      )
        c.error(
          location,
          Diagnostics.Parameter_0_cannot_reference_identifier_1_declared_after_it,
          declarationNameToString(file, getName(associated)),
          declarationNameToString(file, location),
        );
    }
    if (location !== undefined && (meaning & SymbolFlags.Value) !== 0)
      checkTypeOnlyAliasUse(this.checker, location, result, result.name);
    // Under isolatedModules, a value import named like a global value that the file uses must be type-only.
    if (
      c.compilerOptions.isolatedModules === true &&
      isInExternalModule &&
      (meaning & SymbolFlags.Value) === SymbolFlags.Value
    ) {
      const name = result.name;
      const isGlobal = getSymbolOfMeaning(c, c.globals, name, meaning) === result;
      const locals = isGlobal ? getLocals(lastLocation!) : undefined;
      const nonValueSymbol = locals !== undefined ? getSymbolOfMeaning(c, locals, name, ~SymbolFlags.Value) : undefined;
      if (nonValueSymbol !== undefined) {
        const importDeclaration = getDeclarations(nonValueSymbol).find(
          (d) =>
            d.kind === SyntaxKind.ImportSpecifier ||
            d.kind === SyntaxKind.ImportClause ||
            d.kind === SyntaxKind.NamespaceImport ||
            d.kind === SyntaxKind.ImportEqualsDeclaration,
        );
        if (importDeclaration !== undefined && !isTypeOnlyImportOrExportDeclaration(importDeclaration))
          c.error(
            importDeclaration,
            Diagnostics.Import_0_conflicts_with_global_value_used_in_this_file_so_must_be_declared_with_a_type_only_import_when_isolatedModules_is_enabled,
            name,
          );
      }
    }
  }
}

export function resolveName(
  c: Checker,
  location: Node | undefined,
  name: string,
  meaning: SymbolFlags,
  nameNotFoundMessage: DiagnosticMessage | undefined,
  isUse: boolean,
  excludeGlobals: boolean,
): Symbol | undefined {
  return c.resolver.resolve(location, name, meaning, nameNotFoundMessage, isUse, excludeGlobals);
}

/** `symbols[name]` (merged) if it has `meaning`, directly or through an alias. */
export function getSymbolOfMeaning(
  c: Checker,
  symbols: SymbolTable,
  name: string,
  meaning: SymbolFlags,
): Symbol | undefined {
  if ((meaning & SymbolFlags.All) === 0) return undefined;
  const found = symbols.get(name);
  if (found === undefined) return undefined;
  const symbol = getMergedSymbol(c, found);
  if ((symbol.flags & meaning) !== 0) return symbol;
  // getSymbolFlags is All when alias resolution failed, which avoids cascading errors.
  if ((symbol.flags & SymbolFlags.Alias) !== 0 && (getSymbolFlags(c, symbol) & meaning) !== 0) return symbol;
  return undefined;
}

function isPrimitiveTypeName(name: string): boolean {
  return (
    name === 'any' ||
    name === 'string' ||
    name === 'number' ||
    name === 'boolean' ||
    name === 'never' ||
    name === 'unknown'
  );
}

function isES2015OrLaterConstructorName(name: string): boolean {
  return (
    name === 'Promise' ||
    name === 'Symbol' ||
    name === 'Map' ||
    name === 'WeakMap' ||
    name === 'Set' ||
    name === 'WeakSet'
  );
}

/**
 * The name-not-found message of an identifier resolved from its own location, chosen only once the name
 * isn't found (`onFailedToResolveSymbol`). Choosing it up front, as tsgo does, compares every resolved
 * identifier's text with the list of names `getCannotFindNameDiagnosticForName` has messages for.
 */
export const cannotFindNameAtLocation = -1 as DiagnosticMessage;

function onFailedToResolveSymbol(
  c: Checker,
  location: Node | undefined,
  name: string,
  meaning: SymbolFlags,
  message: DiagnosticMessage,
): void {
  if (message === cannotFindNameAtLocation) message = getCannotFindNameDiagnosticForName(c, location!);
  let declarationName = name;
  if (location !== undefined) {
    // The `const` of a `const` assertion is not a name.
    if (isConstTypeReferenceName(location)) return;
    if (location.parent !== undefined && location.parent.kind === SyntaxKind.JSDocLink) return;
    if (
      checkAndReportErrorForMissingPrefix(c, location, name) ||
      checkAndReportErrorForExtendingInterface(c, location) ||
      checkAndReportErrorForUsingTypeAsNamespace(c, location, name, meaning) ||
      checkAndReportErrorForExportingPrimitiveType(c, location, name) ||
      checkAndReportErrorForUsingNamespaceAsTypeOrValue(c, location, name, meaning) ||
      checkAndReportErrorForUsingTypeAsValue(c, location, name, meaning) ||
      checkAndReportErrorForUsingValueAsType(c, location, name, meaning)
    )
      return;
    if (location.kind === SyntaxKind.Identifier && getText(location) === name)
      declarationName = declarationNameToString(getSourceFileOfNode(location), location);
  }
  // A missing library comes before spelling suggestions.
  const features = getFeatureMap().get(name);
  if (features !== undefined) {
    c.error(location, message, declarationName, features[0]!.lib);
    return;
  }
  const suggestion = c.suggestionResolver.resolve(location, name, meaning, undefined, false, false);
  if (
    suggestion !== undefined &&
    !(
      suggestion.valueDeclaration !== undefined &&
      isAmbientModule(suggestion.valueDeclaration) &&
      isGlobalScopeAugmentation(suggestion.valueDeclaration)
    )
  ) {
    const suggestionName = symbolToString(c, suggestion);
    const diagnostic = createDiagnosticForNode(
      location,
      meaning === SymbolFlags.Namespace
        ? Diagnostics.Cannot_find_namespace_0_Did_you_mean_1
        : Diagnostics.Cannot_find_name_0_Did_you_mean_1,
      [declarationName, suggestionName],
    );
    if (suggestion.valueDeclaration !== undefined)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(suggestion.valueDeclaration, Diagnostics.X_0_is_declared_here, [suggestionName]),
      );
    c.addDiagnostic(diagnostic);
    return;
  }
  c.error(location, message, declarationName);
}

function checkAndReportErrorForMissingPrefix(c: Checker, location: Node, name: string): boolean {
  if (
    location.kind !== SyntaxKind.Identifier ||
    getText(location) !== name ||
    isTypeReferenceIdentifier(location) ||
    isPartOfTypeQuery(location)
  )
    return false;
  const container = getThisContainer(location, false, false);
  for (let current = container; current.parent !== undefined; current = current.parent) {
    if (!isClassLike(current.parent)) continue;
    const classSymbol = getSymbolOfDeclaration(c, current.parent);
    if (classSymbol === undefined) break;
    if (getPropertyOfType(c, getTypeOfSymbol(c, classSymbol), name) !== undefined) {
      c.error(
        location,
        Diagnostics.Cannot_find_name_0_Did_you_mean_the_static_member_1_0,
        name,
        symbolToString(c, classSymbol),
      );
      return true;
    }
    if (current === container && !isStatic(current)) {
      const thisType = (getDeclaredTypeOfSymbol(c, classSymbol) as InterfaceType).thisType;
      if (thisType !== undefined && getPropertyOfType(c, thisType, name) !== undefined) {
        c.error(location, Diagnostics.Cannot_find_name_0_Did_you_mean_the_instance_member_this_0, name);
        return true;
      }
    }
  }
  return false;
}

function isTypeReferenceIdentifier(node: Node): boolean {
  let current = node;
  while (current.parent !== undefined && current.parent.kind === SyntaxKind.QualifiedName) current = current.parent;
  return current.parent !== undefined && current.parent.kind === SyntaxKind.TypeReference;
}

function checkAndReportErrorForExtendingInterface(c: Checker, location: Node): boolean {
  const expression = getEntityNameForExtendingInterface(location);
  if (
    expression !== undefined &&
    resolveEntityName(c, expression, SymbolFlags.Interface, true, false, undefined) !== undefined
  ) {
    c.error(
      location,
      Diagnostics.Cannot_extend_an_interface_0_Did_you_mean_implements,
      getSourceTextOfNode(getSourceFileOfNode(expression), expression),
    );
    return true;
  }
  return false;
}

function getEntityNameForExtendingInterface(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.QualifiedName:
    case SyntaxKind.PropertyAccessExpression:
      return node.parent !== undefined ? getEntityNameForExtendingInterface(node.parent) : undefined;
    case SyntaxKind.TypeReference:
      return (node as TypeReferenceNode).typeName;
    case SyntaxKind.ExpressionWithTypeArguments: {
      const expression = getExpression(node)!;
      return isEntityNameExpression(expression, false) ? expression : undefined;
    }
  }
  return undefined;
}

/** Resolves names to their closest misspelling in scope, for "Did you mean" suggestions. */
export class SuggestionNameResolver extends CheckerNameResolver {
  lookup(symbols: SymbolTable, name: string, meaning: SymbolFlags): Symbol | undefined {
    const symbol = getSymbolOfMeaning(this.checker, symbols, name, meaning);
    if (symbol !== undefined) return symbol;
    const candidates: Symbol[] = [];
    for (const s of symbols.values()) candidates.push(s);
    if ((meaning & SymbolFlags.GlobalLookup) !== 0) {
      for (const builtin of primitiveBuiltins.split(' '))
        if (symbols.has(builtin))
          candidates.push(getPrimitiveTypeAliasSuggestion(this.checker, primitiveTypeAliasFor(builtin)));
    }
    return getSpellingSuggestionForName(this.checker, name, candidates, meaning);
  }

  error(_location: Node, _message: DiagnosticMessage, _args: readonly string[]): void {}

  symbolReferenced(_symbol: Symbol, _meaning: SymbolFlags): void {}

  onFailedToResolveSymbol(
    _location: Node | undefined,
    _name: string,
    _meaning: SymbolFlags,
    _message: DiagnosticMessage,
  ): void {}
}

/** The primitive type alias suggested for a misspelled builtin wrapper name, or ''. */
function primitiveTypeAliasFor(builtin: string): string {
  switch (builtin) {
    case 'String':
      return 'string';
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    case 'Object':
      return 'object';
    case 'BigInt':
      return 'bigint';
    case 'Symbol':
      return 'symbol';
  }
  return '';
}

const primitiveBuiltins = 'String Number Boolean Object BigInt Symbol';

function getPrimitiveTypeAliasSuggestion(c: Checker, name: string): Symbol {
  let symbol = c.primitiveTypeAliasSuggestions.get(name);
  if (symbol === undefined) {
    symbol = c.newSymbol(SymbolFlags.TypeAlias, name);
    c.primitiveTypeAliasSuggestions.set(name, symbol);
  }
  return symbol;
}

/** The symbol whose name is closest to `name` and that has `meaning`, if close enough. */
export function getSpellingSuggestionForName(
  c: Checker,
  name: string,
  symbols: readonly Symbol[],
  meaning: SymbolFlags,
): Symbol | undefined {
  const nameCodePoints = new CodePoints();
  nameCodePoints.set(name);
  const maximumLengthDifference = Math.max(2, Math.floor(nameCodePoints.length * 0.34));
  let bestDistance = Math.floor(nameCodePoints.length * 0.4) + 0.9;
  let best: Symbol | undefined = undefined;
  const lowerName = name.toLowerCase();
  for (const candidate of symbols) {
    const candidateName = getCandidateName(c, candidate, meaning);
    if (candidateName === '') continue;
    // tsgo measures candidates in bytes and the name in code points. A candidate has at least as
    // many bytes as UTF-16 units, so most long candidates are out without measuring them.
    if (candidateName.length - nameCodePoints.length > maximumLengthDifference) continue;
    const candidateLength = utf8Length(candidateName);
    if (
      Math.max(candidateLength, nameCodePoints.length) - Math.min(candidateLength, nameCodePoints.length) >
      maximumLengthDifference
    )
      continue;
    if (candidateName === name) continue;
    if (candidateLength < 3 && candidateName.toLowerCase() !== lowerName) continue;
    const distance = distanceToCandidate(nameCodePoints, candidateName, bestDistance);
    if (distance < 0) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    } else if (best === undefined || compareSymbols(c, candidate, best) < 0) best = candidate;
  }
  return best;
}

function getCandidateName(c: Checker, candidate: Symbol, meaning: SymbolFlags): string {
  const name = candidate.name;
  if (name.length === 0 || name.charCodeAt(0) === 0x22 || name.charCodeAt(0) === 0xfffe) return '';
  if ((candidate.flags & meaning) !== 0) return name;
  if ((candidate.flags & SymbolFlags.Alias) !== 0) {
    const target = tryResolveAlias(c, candidate);
    if (target !== undefined && (target.flags & meaning) !== 0) return name;
  }
  return '';
}

function checkAndReportErrorForUsingTypeAsNamespace(
  c: Checker,
  location: Node,
  name: string,
  meaning: SymbolFlags,
): boolean {
  if (meaning !== SymbolFlags.Namespace) return false;
  const symbol = resolveSymbol(
    c,
    resolveName(c, location, name, SymbolFlags.Type & ~SymbolFlags.Namespace, undefined, false, false),
  );
  if (symbol === undefined) return false;
  const parent = location.parent;
  if (parent !== undefined && parent.kind === SyntaxKind.QualifiedName) {
    const propName = getText((parent as QualifiedName).right);
    if (getPropertyOfType(c, getDeclaredTypeOfSymbol(c, symbol), propName) !== undefined) {
      c.error(
        parent,
        Diagnostics.Cannot_access_0_1_because_0_is_a_type_but_not_a_namespace_Did_you_mean_to_retrieve_the_type_of_the_property_1_in_0_with_0_1,
        name,
        propName,
      );
      return true;
    }
  }
  c.error(location, Diagnostics.X_0_only_refers_to_a_type_but_is_being_used_as_a_namespace_here, name);
  return true;
}

function checkAndReportErrorForExportingPrimitiveType(c: Checker, location: Node, name: string): boolean {
  if (
    isPrimitiveTypeName(name) &&
    location.parent !== undefined &&
    location.parent.kind === SyntaxKind.ExportSpecifier
  ) {
    c.error(location, Diagnostics.Cannot_export_0_Only_local_declarations_can_be_exported_from_a_module, name);
    return true;
  }
  return false;
}

/** Whether `node` is the `const` of a `const` assertion (`x as const`, `<const>x`). */
function isConstTypeReferenceName(node: Node): boolean {
  const parent = node.parent;
  return (
    node.kind === SyntaxKind.Identifier &&
    parent !== undefined &&
    isConstTypeReference(parent) &&
    parent.parent !== undefined &&
    (parent.parent.kind === SyntaxKind.AsExpression || parent.parent.kind === SyntaxKind.TypeAssertionExpression)
  );
}

/** Whether `node` is the expression of an `export =` or `export default`, or the leftmost name of it. */
function isExportAssignmentExpressionName(node: Node): boolean {
  let current = node;
  while (
    current.parent !== undefined &&
    (current.parent.kind === SyntaxKind.PropertyAccessExpression || current.parent.kind === SyntaxKind.QualifiedName)
  )
    current = current.parent;
  const parent = current.parent;
  return (
    parent !== undefined &&
    parent.kind === SyntaxKind.ExportAssignment &&
    (parent as ExportAssignment).expression === current
  );
}

function checkAndReportErrorForUsingNamespaceAsTypeOrValue(
  c: Checker,
  location: Node,
  name: string,
  meaning: SymbolFlags,
): boolean {
  if ((meaning & (SymbolFlags.Value & ~SymbolFlags.Type)) !== 0) {
    const symbol = resolveSymbol(
      c,
      resolveName(c, location, name, SymbolFlags.NamespaceModule, undefined, false, false),
    );
    if (symbol !== undefined) {
      // checkExportAssignment decides whether `export = ns` is an error.
      if (!isExportAssignmentExpressionName(location))
        c.error(location, Diagnostics.Cannot_use_namespace_0_as_a_value, name);
      return true;
    }
  } else if ((meaning & (SymbolFlags.Type & ~SymbolFlags.Value)) !== 0) {
    const symbol = resolveSymbol(c, resolveName(c, location, name, SymbolFlags.Module, undefined, false, false));
    if (symbol !== undefined) {
      c.error(location, Diagnostics.Cannot_use_namespace_0_as_a_type, name);
      return true;
    }
  }
  return false;
}

function checkAndReportErrorForUsingTypeAsValue(
  c: Checker,
  location: Node,
  name: string,
  meaning: SymbolFlags,
): boolean {
  if ((meaning & SymbolFlags.Value) === 0) return false;
  if (isPrimitiveTypeName(name)) {
    const grandparent = location.parent?.parent;
    if (
      grandparent !== undefined &&
      grandparent.parent !== undefined &&
      grandparent.kind === SyntaxKind.HeritageClause
    ) {
      const heritageKind = (grandparent as HeritageClause).token;
      const containerKind = grandparent.parent.kind;
      const isClass = containerKind === SyntaxKind.ClassDeclaration || containerKind === SyntaxKind.ClassExpression;
      if (containerKind === SyntaxKind.InterfaceDeclaration && heritageKind === SyntaxKind.ExtendsKeyword)
        c.error(
          location,
          Diagnostics.An_interface_cannot_extend_a_primitive_type_like_0_It_can_only_extend_other_named_object_types,
          name,
        );
      else if (isClass && heritageKind === SyntaxKind.ExtendsKeyword)
        c.error(
          location,
          Diagnostics.A_class_cannot_extend_a_primitive_type_like_0_Classes_can_only_extend_constructable_values,
          name,
        );
      else if (isClass && heritageKind === SyntaxKind.ImplementsKeyword)
        c.error(
          location,
          Diagnostics.A_class_cannot_implement_a_primitive_type_like_0_It_can_only_implement_other_named_object_types,
          name,
        );
    } else c.error(location, Diagnostics.X_0_only_refers_to_a_type_but_is_being_used_as_a_value_here, name);
    return true;
  }
  const symbol = resolveSymbol(
    c,
    resolveName(c, location, name, SymbolFlags.Type & ~SymbolFlags.Value, undefined, false, false),
  );
  if (symbol !== undefined && (getSymbolFlags(c, symbol) & SymbolFlags.Value) === 0) {
    // checkExportAssignment decides whether `export = T` of a type is an error.
    if (isExportAssignmentExpressionName(location)) return true;
    if (isES2015OrLaterConstructorName(name))
      c.error(
        location,
        Diagnostics.X_0_only_refers_to_a_type_but_is_being_used_as_a_value_here_Do_you_need_to_change_your_target_library_Try_changing_the_lib_compiler_option_to_es2015_or_later,
        name,
      );
    else if (maybeMappedType(c, location, symbol))
      c.error(
        location,
        Diagnostics.X_0_only_refers_to_a_type_but_is_being_used_as_a_value_here_Did_you_mean_to_use_1_in_0,
        name,
        name === 'K' ? 'P' : 'K',
      );
    else c.error(location, Diagnostics.X_0_only_refers_to_a_type_but_is_being_used_as_a_value_here, name);
    return true;
  }
  return false;
}

function maybeMappedType(c: Checker, node: Node, symbol: Symbol): boolean {
  let container = node.parent;
  while (
    container !== undefined &&
    (container.kind === SyntaxKind.ComputedPropertyName || container.kind === SyntaxKind.PropertySignature)
  )
    container = container.parent;
  if (container === undefined || container.kind !== SyntaxKind.TypeLiteral) return false;
  const members = getMemberNodes(container);
  if (members === undefined || members.nodes.length !== 1) return false;
  const type = getDeclaredTypeOfSymbol(c, symbol);
  if ((type.flags & TypeFlags.Union) === 0) return false;
  for (const t of (type as UnionOrIntersectionType).types)
    if (!isTypeAssignableToKindEx(c, t, TypeFlags.StringOrNumberLiteral, true)) return false;
  return true;
}

function checkAndReportErrorForUsingValueAsType(
  c: Checker,
  location: Node,
  name: string,
  meaning: SymbolFlags,
): boolean {
  if ((meaning & (SymbolFlags.Type & ~SymbolFlags.Namespace)) === 0) return false;
  const symbol = resolveSymbol(
    c,
    resolveName(c, location, name, ~SymbolFlags.Type & SymbolFlags.Value, undefined, false, false),
  );
  if (symbol !== undefined && (symbol.flags & SymbolFlags.Namespace) === 0) {
    c.error(location, Diagnostics.X_0_refers_to_a_value_but_is_being_used_as_a_type_here_Did_you_mean_typeof_0, name);
    return true;
  }
  return false;
}

// ---- Merging

function mergeFileGlobals(c: Checker, file: SourceFile): void {
  if (!isExternalOrCommonJSModule(file)) {
    const locals = file.locals;
    if (locals !== undefined) {
      const fileGlobalThis = locals.get('globalThis');
      if (fileGlobalThis !== undefined)
        for (const d of getDeclarations(fileGlobalThis))
          c.addDiagnostic(
            createDiagnosticForNode(d, Diagnostics.Declaration_name_conflicts_with_built_in_global_identifier_0, [
              'globalThis',
            ]),
          );
      for (const symbol of locals.values()) {
        if ((symbol.flags & SymbolFlags.Module) !== 0 && isAmbientModuleSymbolName(symbol.name))
          c.ambientModuleSymbols.push(symbol);
        else mergeGlobalSymbol(c, symbol);
      }
    }
  }
  for (const pattern of file.patternAmbientModules) c.patternAmbientModules.push(pattern);
  if (file.symbol !== undefined && file.globalExports !== undefined)
    // UMD exports, first in wins.
    for (const [name, symbol] of file.globalExports) if (!c.globals.has(name)) setGlobal(c, name, symbol);
}

/** Changes to a map, recorded so that they can be undone. */
export class TableChanges<K, V> {
  private readonly added = new Set<K>();
  private readonly replaced = new Map<K, V>();

  set(table: Map<K, V>, key: K, value: V): void {
    const previous = table.get(key);
    if (previous === undefined) this.added.add(key);
    else if (!this.added.has(key) && !this.replaced.has(key)) this.replaced.set(key, previous);
    table.set(key, value);
  }

  /** Restores `table`, or a copy of it, to its state before the changes. */
  undo(table: Map<K, V>): void {
    for (const key of this.added) table.delete(key);
    for (const [key, value] of this.replaced) table.set(key, value);
  }
}

/**
 * Globals merged from the locals of a program's leading default libraries. Checkers of programs
 * with the same libraries start from them; a later merge into a shared symbol merges into a copy.
 * One checker at a time borrows the tables and changes them in place; the others copy them.
 */
export class LibGlobals {
  readonly files: SourceFile[];
  readonly globals: SymbolTable;
  readonly mergedSymbols: Map<number, Symbol>;
  readonly ambientModuleSymbols: Symbol[];
  readonly patternAmbientModules: PatternAmbientModule[];
  /** Ids of the symbols merged into each shared symbol. */
  readonly sources = new Map<Symbol, number[]>();
  /** The checker using `globals` and `mergedSymbols` in place. */
  borrower: Checker | undefined = undefined;

  constructor(c: Checker, files: SourceFile[]) {
    this.files = files;
    this.globals = new Map(c.globals);
    // Each checker sets its own `globalThis`, keeping it first.
    this.globals.set(c.globalThisSymbol.name, new Symbol(SymbolFlags.None, 'globalThis'));
    this.mergedSymbols = new Map(c.mergedSymbols);
    this.ambientModuleSymbols = c.ambientModuleSymbols.slice();
    this.patternAmbientModules = c.patternAmbientModules.slice();
    for (const [id, target] of this.mergedSymbols) {
      let ids = this.sources.get(target);
      if (ids === undefined) {
        ids = [];
        this.sources.set(target, ids);
      }
      ids.push(id);
    }
  }

  copyGlobals(): SymbolTable {
    const globals = new Map(this.globals);
    if (this.borrower !== undefined) this.borrower.globalChanges!.undo(globals);
    return globals;
  }

  copyMergedSymbols(): Map<number, Symbol> {
    const mergedSymbols = new Map(this.mergedSymbols);
    if (this.borrower !== undefined) this.borrower.mergedSymbolChanges!.undo(mergedSymbols);
    return mergedSymbols;
  }

  /** Whether `files` starts with exactly these `count` libraries. */
  matches(files: readonly SourceFile[], count: number): boolean {
    if (count !== this.files.length) return false;
    for (let i = 0; i < count; i++) if (files[i]! !== this.files[i]!) return false;
    return true;
  }
}

/**
 * The globals, merged symbols and module augmentations of a whole program, as one checker merged
 * them before checker threads share the program (parallel-check.ts). Other checkers of the program
 * start from copies of the tables and add the diagnostics the merges reported; the merged symbols
 * are shared, and a later merge into one merges into a copy.
 */
export class MergedGlobals {
  readonly globals: SymbolTable;
  readonly mergedSymbols: Map<number, Symbol>;
  readonly ambientModuleSymbols: Symbol[];
  readonly patternAmbientModules: PatternAmbientModule[];
  readonly patternAmbientModuleAugmentations: Map<string, Symbol>;
  readonly patternAmbientModuleAugmentationTargets: Map<string, Symbol>;
  /** Whether the global `undefined` is the checker's own (no declaration of `undefined` merged). */
  readonly ownUndefined: boolean;
  /** Ids of the symbols merged into each shared symbol. */
  readonly sources = new Map<Symbol, number[]>();
  /** Copies of the checker's `mergeDiagnostics`. */
  readonly diagnostics: Diagnostic[][] = [];

  constructor(c: Checker) {
    this.globals = new Map(c.globals);
    // Each checker sets its own `globalThis` and `undefined`, in the same places in the table.
    this.globals.set(c.globalThisSymbol.name, new Symbol(SymbolFlags.None, 'globalThis'));
    this.ownUndefined = c.globals.get('undefined') === c.undefinedSymbol;
    if (this.ownUndefined) this.globals.set('undefined', new Symbol(SymbolFlags.None, 'undefined'));
    for (const symbol of this.globals.values()) getSymbolId(symbol);
    this.mergedSymbols = new Map(c.mergedSymbols);
    this.ambientModuleSymbols = c.ambientModuleSymbols.slice();
    this.patternAmbientModules = c.patternAmbientModules.slice();
    this.patternAmbientModuleAugmentations = new Map(c.patternAmbientModuleAugmentations);
    this.patternAmbientModuleAugmentationTargets = new Map(c.patternAmbientModuleAugmentationTargets);
    for (const [id, target] of this.mergedSymbols) {
      let ids = this.sources.get(target);
      if (ids === undefined) {
        // Shared symbols are never written, so they need their ids now.
        getSymbolId(target);
        ids = [];
        this.sources.set(target, ids);
      }
      ids.push(id);
    }
    // The checker can add related information to its diagnostics later.
    for (const list of c.mergeDiagnostics) this.diagnostics.push(copyDiagnostics(list));
  }
}

function copyDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const diagnostic of list) {
    const copy = diagnostic.clone();
    copy.relatedInformation = diagnostic.relatedInformation.slice();
    result.push(copy);
  }
  return result;
}

/** Adds the diagnostics and suggestions of `merged`'s merge `step` (0: globals, 1: augmentations). */
function addMergeDiagnostics(c: Checker, merged: MergedGlobals, step: number): void {
  for (const diagnostic of copyDiagnostics(merged.diagnostics[2 * step]!)) c.diagnostics.add(diagnostic);
  for (const diagnostic of copyDiagnostics(merged.diagnostics[2 * step + 1]!)) c.suggestionDiagnostics.add(diagnostic);
}

/**
 * Shares the globals and module augmentations `c` merged with the other checkers of its program;
 * `c` treats its merged symbols as shared from now on.
 */
export function shareMergedGlobals(c: Checker): MergedGlobals {
  const merged = new MergedGlobals(c);
  c.mergedGlobals = merged;
  return merged;
}

/** The ids of the symbols merged into `symbol`, if it is shared with other checkers. */
function sharedSources(c: Checker, symbol: Symbol): number[] | undefined {
  const merged = c.mergedGlobals;
  const ids = merged !== undefined ? merged.sources.get(symbol) : undefined;
  if (ids !== undefined) return ids;
  const libs = c.libGlobals;
  return libs !== undefined ? libs.sources.get(symbol) : undefined;
}

const libGlobalsCache: LibGlobals[] = [];

/** Drops the shared library globals (a rebuild reparses the library files). */
export function clearLibGlobalsCache(): void {
  libGlobalsCache.length = 0;
}

/** Drops the shared library globals merged from any of `files`, for a program that is no longer used. */
export function dropLibGlobals(files: readonly SourceFile[]): void {
  const dropped = new Set(files);
  for (let i = libGlobalsCache.length - 1; i >= 0; i--)
    if (dropped.has(libGlobalsCache[i]!.files[0]!)) libGlobalsCache.splice(i, 1);
}

/** Number of leading default library files, whose merged locals can be shared. */
function getLibraryCount(c: Checker): number {
  const files = c.files;
  let count = 0;
  while (count < files.length && c.host.isSourceFileDefaultLibrary(files[count]!)) count++;
  return count;
}

/** The shared globals of the checker's default libraries, if another checker merged them. */
export function findLibGlobals(c: Checker): LibGlobals | undefined {
  const count = getLibraryCount(c);
  if (count > 0) for (const libs of libGlobalsCache) if (libs.matches(c.files, count)) return libs;
  return undefined;
}

export function borrowLibGlobals(c: Checker, libs: LibGlobals): void {
  libs.borrower = c;
  c.globalChanges = new TableChanges<string, Symbol>();
  c.mergedSymbolChanges = new TableChanges<number, Symbol>();
}

/** Undoes a disposed checker's changes to the tables it borrowed. */
export function returnLibGlobals(c: Checker): void {
  const libs = c.libGlobals!;
  c.globalChanges!.undo(libs.globals);
  c.mergedSymbolChanges!.undo(libs.mergedSymbols);
  c.globalChanges = undefined;
  c.mergedSymbolChanges = undefined;
  libs.borrower = undefined;
}

export function setGlobal(c: Checker, name: string, symbol: Symbol): void {
  if (c.globalChanges !== undefined) c.globalChanges.set(c.globals, name, symbol);
  else c.globals.set(name, symbol);
}

function setMergedSymbol(c: Checker, id: number, target: Symbol): void {
  if (c.mergedSymbolChanges !== undefined) c.mergedSymbolChanges.set(c.mergedSymbols, id, target);
  else c.mergedSymbols.set(id, target);
  c.mergedSymbolIds.add(id);
}

/** Merges script locals into globals; ambient modules and augmentations wait for global types. */
export function initializeGlobals(c: Checker): void {
  const globals = c.globals;
  const merged = c.mergedGlobals;
  if (merged !== undefined) {
    // The constructor copied the globals and merged symbols.
    for (const symbol of merged.ambientModuleSymbols) c.ambientModuleSymbols.push(symbol);
    for (const pattern of merged.patternAmbientModules) c.patternAmbientModules.push(pattern);
    for (const [name, symbol] of merged.patternAmbientModuleAugmentations)
      c.patternAmbientModuleAugmentations.set(name, symbol);
    for (const [name, symbol] of merged.patternAmbientModuleAugmentationTargets)
      c.patternAmbientModuleAugmentationTargets.set(name, symbol);
    addMergeDiagnostics(c, merged, 0);
    if (merged.ownUndefined) setGlobal(c, 'undefined', c.undefinedSymbol);
    return;
  }
  const libraryCount = getLibraryCount(c);
  const libs = c.libGlobals;
  if (libs !== undefined) {
    // The constructor copied the globals and merged symbols.
    for (const symbol of libs.ambientModuleSymbols) c.ambientModuleSymbols.push(symbol);
    for (const pattern of libs.patternAmbientModules) c.patternAmbientModules.push(pattern);
  } else if (libraryCount > 0) {
    const diagnosticCount = c.diagnostics.count();
    for (let i = 0; i < libraryCount; i++) mergeFileGlobals(c, c.files[i]!);
    // Diagnostics belong to one checker, so libraries that report any aren't shared.
    if (c.diagnostics.count() === diagnosticCount) {
      c.libGlobals = new LibGlobals(c, c.files.slice(0, libraryCount));
      libGlobalsCache.push(c.libGlobals);
    }
  }
  for (let i = libraryCount; i < c.files.length; i++) mergeFileGlobals(c, c.files[i]!);
  for (const file of c.files)
    for (const augmentation of file.moduleAugmentations)
      if (augmentation.parent !== undefined && isGlobalScopeAugmentation(augmentation.parent))
        mergeModuleAugmentation(c, augmentation);
  // addUndefinedToGlobalsOrErrorOnRedeclaration
  const target = globals.get('undefined');
  if (target !== undefined) {
    for (const declaration of getDeclarations(target))
      if (!isTypeDeclaration(declaration))
        c.addDiagnostic(
          createDiagnosticForNode(
            declaration,
            Diagnostics.Declaration_name_conflicts_with_built_in_global_identifier_0,
            ['undefined'],
          ),
        );
  } else setGlobal(c, 'undefined', c.undefinedSymbol);
}

export function mergeAmbientModulesAndAugmentations(c: Checker): void {
  const merged = c.mergedGlobals;
  if (merged !== undefined) {
    addMergeDiagnostics(c, merged, 1);
    return;
  }
  for (const symbol of c.ambientModuleSymbols) mergeGlobalSymbol(c, symbol);
  mergePatternAmbientModules(c);
  for (const file of c.files)
    for (const augmentation of file.moduleAugmentations)
      if (augmentation.parent !== undefined && !isGlobalScopeAugmentation(augmentation.parent))
        mergeModuleAugmentation(c, augmentation);
}

export function isAmbientModuleSymbolName(name: string): boolean {
  return tryGetAmbientModuleNameFromSymbolName(name) !== undefined;
}

function isTypeDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.TypeParameter:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
      return true;
    case SyntaxKind.ImportClause:
      return getIsTypeOnly(node);
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier:
      return getIsTypeOnly(node);
  }
  return false;
}

function mergeGlobalSymbol(c: Checker, symbol: Symbol): void {
  const globalSymbol = c.globals.get(symbol.name);
  setGlobal(
    c,
    symbol.name,
    globalSymbol !== undefined ? mergeSymbol(c, globalSymbol, symbol, false) : getMergedSymbol(c, symbol),
  );
}

/** Merges the pattern ambient modules with the same pattern and identical import attributes types. */
function mergePatternAmbientModules(c: Checker): void {
  const modules = c.patternAmbientModules;
  if (modules.length === 0) return;
  const groupsByPattern = new Map<string, number[]>();
  const grouped: PatternAmbientModule[] = [];
  for (const module of modules) {
    const attributesType = getTypeOfModuleImportAttributes(c, module.symbol);
    let groups = groupsByPattern.get(module.text);
    let groupIndex = -1;
    if (groups !== undefined)
      for (const index of groups)
        if (isTypeIdenticalTo(c, attributesType, getTypeOfModuleImportAttributes(c, grouped[index]!.symbol))) {
          groupIndex = index;
          break;
        }
    if (groupIndex === -1) {
      if (groups === undefined) {
        groups = [];
        groupsByPattern.set(module.text, groups);
      }
      groups.push(grouped.length);
      grouped.push(new PatternAmbientModule(module.text, module.starIndex, module.symbol));
    } else {
      const group = grouped[groupIndex]!;
      grouped[groupIndex] = new PatternAmbientModule(
        group.text,
        group.starIndex,
        mergeSymbol(c, group.symbol, module.symbol, false),
      );
    }
  }
  for (const module of modules)
    if (c.globals.has(module.symbol.name)) setGlobal(c, module.symbol.name, getMergedSymbol(c, module.symbol));
  modules.length = 0;
  for (const module of grouped) modules.push(module);
}

function mergeModuleAugmentation(c: Checker, moduleName: Node): void {
  const moduleNode = moduleName.parent as ModuleDeclaration;
  const augmentationSymbol = moduleNode.symbol!;
  // Several augmentations in one file share a symbol; merge it once.
  if (augmentationSymbol.declaration! !== moduleNode) return;
  if (isGlobalScopeAugmentation(moduleNode)) {
    if (augmentationSymbol.exports !== undefined)
      mergeSymbolTable(c, c.globals, augmentationSymbol.exports, false, undefined);
    return;
  }
  const moduleNotFoundError =
    (moduleNode.parent!.flags & NodeFlags.Ambient) === 0
      ? Diagnostics.Invalid_module_name_in_augmentation_module_0_cannot_be_found
      : undefined;
  // Module augmentations can't have import attributes.
  let mainModule = resolveExternalModuleNameWorker(
    c,
    moduleName,
    moduleName,
    moduleNotFoundError,
    false,
    true,
    undefined,
  );
  if (mainModule === undefined) return;
  mainModule = resolveExternalModuleSymbol(c, mainModule, false)!;
  if ((mainModule.flags & SymbolFlags.Namespace) !== 0) {
    for (const pattern of c.patternAmbientModules)
      if (getMergedSymbol(c, pattern.symbol) === mainModule) {
        // Merging the pattern into the augmentation keeps the pattern's own exports unchanged.
        const merged = mergeSymbol(c, augmentationSymbol, mainModule, true);
        c.patternAmbientModuleAugmentations.set(getText(moduleName), merged);
        c.patternAmbientModuleAugmentationTargets.set(getText(moduleName), mainModule);
        return;
      }
    // Exports the module gets through `export *` live on the re-exported symbols; merge into those.
    const mainExports = mainModule.exports;
    const exports = augmentationSymbol.exports;
    if (
      mainExports !== undefined &&
      mainExports.has(InternalSymbolName.ExportStar) &&
      exports !== undefined &&
      exports.size > 0
    ) {
      const resolvedExports = getExportsOfModuleWorker(c, mainModule);
      for (const [id, symbol] of exports) {
        const resolved = resolvedExports.get(id);
        if (resolved !== undefined && !mainExports.has(id)) mergeSymbol(c, resolved, symbol, false);
      }
    }
    mergeSymbol(c, mainModule, augmentationSymbol, false);
  } else
    c.error(
      moduleName,
      Diagnostics.Cannot_augment_module_0_because_it_resolves_to_a_non_module_entity,
      getText(moduleName),
    );
}

export function mergeSymbolTable(
  c: Checker,
  target: SymbolTable,
  source: SymbolTable,
  unidirectional: boolean,
  mergedParent: Symbol | undefined,
): void {
  for (const [id, sourceSymbol] of source) {
    const targetSymbol = target.get(id);
    const merged =
      targetSymbol !== undefined
        ? mergeSymbol(c, targetSymbol, sourceSymbol, unidirectional)
        : getMergedSymbol(c, sourceSymbol);
    // A merged symbol takes the parent that initiated the merge of its exports.
    if (mergedParent !== undefined && targetSymbol !== undefined && (merged.flags & SymbolFlags.Transient) !== 0)
      merged.parent = mergedParent;
    if (target === c.globals) setGlobal(c, id, merged);
    else target.set(id, merged);
  }
}

/** Merges `source` into `target`, cloning a non-transient target first. */
export function mergeSymbol(c: Checker, target: Symbol, source: Symbol, unidirectional: boolean): Symbol {
  if (
    (target.flags & getExcludedSymbolFlags(source.flags)) === 0 ||
    ((source.flags | target.flags) & SymbolFlags.Assignment) !== 0
  ) {
    if (source === target) return target;
    if ((target.flags & SymbolFlags.Transient) === 0) {
      const resolvedTarget = resolveSymbol(c, target)!;
      if (resolvedTarget === c.unknownSymbol) return source;
      if (
        (resolvedTarget.flags & getExcludedSymbolFlags(source.flags)) === 0 ||
        ((source.flags | resolvedTarget.flags) & SymbolFlags.Assignment) !== 0
      )
        target = cloneSymbol(c, resolvedTarget);
      else {
        reportMergeSymbolError(c, target, source);
        return source;
      }
    } else if (sharedSources(c, target) !== undefined) target = copySharedSymbol(c, target);
    if (
      (source.flags & SymbolFlags.ValueModule) !== 0 &&
      (target.flags & SymbolFlags.ValueModule) !== 0 &&
      (target.flags & SymbolFlags.ConstEnumOnlyModule) !== 0 &&
      (source.flags & SymbolFlags.ConstEnumOnlyModule) === 0
    )
      target.flags &= ~SymbolFlags.ConstEnumOnlyModule;
    let sourceFlags = source.flags;
    if ((target.flags & SymbolFlags.ConstEnumOnlyModule) === 0) sourceFlags &= ~SymbolFlags.ConstEnumOnlyModule;
    target.flags |= sourceFlags;
    if (source.valueDeclaration !== undefined) setValueDeclaration(target, source.valueDeclaration);
    for (const d of getDeclarations(source)) addDeclaration(target, d);
    if (source.members !== undefined) {
      if (target.members === undefined) target.members = new Map<string, Symbol>();
      mergeSymbolTable(c, target.members, source.members, unidirectional, undefined);
    }
    if (source.exports !== undefined) {
      if (target.exports === undefined) target.exports = new Map<string, Symbol>();
      mergeSymbolTable(c, target.exports, source.exports, unidirectional, target);
    }
    if (!unidirectional) recordMergedSymbol(c, target, source);
  } else if ((target.flags & SymbolFlags.NamespaceModule) !== 0) {
    // `var globalThis` already reports a conflict with the built-in.
    if (target !== c.globalThisSymbol)
      c.error(
        getNameOfDeclaration(source.declaration!),
        Diagnostics.Cannot_augment_module_0_with_value_exports_because_it_resolves_to_a_non_module_entity,
        symbolToString(c, target),
      );
  } else reportMergeSymbolError(c, target, source);
  return target;
}

function reportMergeSymbolError(c: Checker, target: Symbol, source: Symbol): void {
  const isEitherEnum = ((target.flags | source.flags) & SymbolFlags.Enum) !== 0;
  const isEitherBlockScoped = ((target.flags | source.flags) & SymbolFlags.BlockScopedVariable) !== 0;
  const message = isEitherEnum
    ? Diagnostics.Enum_declarations_can_only_merge_with_namespace_or_other_enum_declarations
    : isEitherBlockScoped
      ? Diagnostics.Cannot_redeclare_block_scoped_variable_0
      : Diagnostics.Duplicate_identifier_0;
  const name = symbolToString(c, source);
  if (!isPlainJSFile(source)) addDuplicateDeclarationErrors(c, source, message, name, target);
  if (!isPlainJSFile(target)) addDuplicateDeclarationErrors(c, target, message, name, source);
}

function isPlainJSFile(symbol: Symbol): boolean {
  if (declarationCount(symbol) === 0) return false;
  const file = getSourceFileOfNode(symbol.declaration!);
  return file.isJS() && file.checkJsDirective === undefined;
}

function addDuplicateDeclarationErrors(
  c: Checker,
  target: Symbol,
  message: DiagnosticMessage,
  name: string,
  source: Symbol,
): void {
  for (const node of getDeclarations(target))
    addDuplicateDeclarationError(c, node, message, name, getDeclarations(source));
}

export function addDuplicateDeclarationError(
  c: Checker,
  node: Node,
  message: DiagnosticMessage,
  name: string,
  relatedNodes: readonly Node[],
): void {
  const errorNode = getNameOfDeclaration(node) ?? node;
  const error = lookupOrIssueError(c, errorNode, message, [name]);
  for (const relatedNode of relatedNodes) {
    const adjusted = getNameOfDeclaration(relatedNode) ?? relatedNode;
    if (adjusted === errorNode) continue;
    const leading = createDiagnosticForNode(adjusted, Diagnostics.X_0_was_also_declared_here, [name]);
    const followOn = createDiagnosticForNode(adjusted, Diagnostics.X_and_here, []);
    const related = error.relatedInformation;
    if (related.length >= 5 || hasMatchingDiagnostic(related, leading, followOn)) continue;
    error.addRelatedInfo(related.length === 0 ? leading : followOn);
  }
}

function hasMatchingDiagnostic(diagnostics: readonly Diagnostic[], a: Diagnostic, b: Diagnostic): boolean {
  for (const d of diagnostics) if (compareDiagnostics(d, b) === 0 || compareDiagnostics(d, a) === 0) return true;
  return false;
}

function lookupOrIssueError(c: Checker, location: Node, message: DiagnosticMessage, args: string[]) {
  return c.addDiagnostic(createDiagnosticForNode(location, message, args));
}

export function getExcludedSymbolFlags(flags: SymbolFlags): SymbolFlags {
  let result = 0;
  if ((flags & SymbolFlags.BlockScopedVariable) !== 0) result |= SymbolFlags.BlockScopedVariableExcludes;
  if ((flags & SymbolFlags.FunctionScopedVariable) !== 0) result |= SymbolFlags.FunctionScopedVariableExcludes;
  if ((flags & SymbolFlags.Property) !== 0) result |= SymbolFlags.PropertyExcludes;
  if ((flags & SymbolFlags.EnumMember) !== 0) result |= SymbolFlags.EnumMemberExcludes;
  if ((flags & SymbolFlags.Function) !== 0) result |= SymbolFlags.FunctionExcludes;
  if ((flags & SymbolFlags.Class) !== 0) result |= SymbolFlags.ClassExcludes;
  if ((flags & SymbolFlags.Interface) !== 0) result |= SymbolFlags.InterfaceExcludes;
  if ((flags & SymbolFlags.RegularEnum) !== 0) result |= SymbolFlags.RegularEnumExcludes;
  if ((flags & SymbolFlags.ConstEnum) !== 0) result |= SymbolFlags.ConstEnumExcludes;
  if ((flags & SymbolFlags.ValueModule) !== 0) result |= SymbolFlags.ValueModuleExcludes;
  if ((flags & SymbolFlags.Method) !== 0) result |= SymbolFlags.MethodExcludes;
  if ((flags & SymbolFlags.GetAccessor) !== 0) result |= SymbolFlags.GetAccessorExcludes;
  if ((flags & SymbolFlags.SetAccessor) !== 0) result |= SymbolFlags.SetAccessorExcludes;
  if ((flags & SymbolFlags.TypeParameter) !== 0) result |= SymbolFlags.TypeParameterExcludes;
  if ((flags & SymbolFlags.TypeAlias) !== 0) result |= SymbolFlags.TypeAliasExcludes;
  if ((flags & SymbolFlags.Alias) !== 0) result |= SymbolFlags.AliasExcludes;
  if ((flags & SymbolFlags.ReplaceableByMethod) !== 0) result &= ~SymbolFlags.Method;
  return result;
}

export function cloneSymbol(c: Checker, symbol: Symbol): Symbol {
  const result = c.newSymbol(symbol.flags, symbol.name);
  setDeclarations(result, getDeclarations(symbol).slice());
  result.parent = symbol.parent;
  result.valueDeclaration = symbol.valueDeclaration;
  if (symbol.members !== undefined) result.members = new Map(symbol.members);
  if (symbol.exports !== undefined) result.exports = new Map(symbol.exports);
  recordMergedSymbol(c, result, symbol);
  return result;
}

/**
 * A checker's own copy of a symbol shared through `LibGlobals`, which stands for it: the symbols
 * merged into the shared one, and the shared one itself, now merge into the copy.
 */
function copySharedSymbol(c: Checker, shared: Symbol): Symbol {
  const result = c.newSymbol(shared.flags, shared.name);
  setDeclarations(result, getDeclarations(shared).slice());
  result.parent = shared.parent;
  result.valueDeclaration = shared.valueDeclaration;
  if (shared.members !== undefined) result.members = new Map(shared.members);
  if (shared.exports !== undefined) result.exports = new Map(shared.exports);
  c.sharedSymbolCopies.set(result, shared);
  recordMergedSymbol(c, result, result);
  return result;
}

function recordMergedSymbol(c: Checker, target: Symbol, source: Symbol): void {
  setMergedSymbol(c, getSymbolId(source), target);
  // Merging a copy merges what it stands for.
  const shared = c.sharedSymbolCopies.get(source);
  if (shared !== undefined) {
    setMergedSymbol(c, getSymbolId(shared), target);
    for (const id of sharedSources(c, shared)!) setMergedSymbol(c, id, target);
  }
}

export function getMergedSymbol(c: Checker, symbol: Symbol): Symbol {
  const id = symbol.id;
  if (id !== 0 && c.mergedSymbolIds.has(id)) {
    const merged = c.mergedSymbols.get(id);
    if (merged !== undefined) return merged;
  }
  return symbol;
}

export function getParentOfSymbol(c: Checker, symbol: Symbol): Symbol | undefined {
  return symbol.parent !== undefined ? getMergedSymbol(c, getLateBoundSymbol(c, symbol.parent)) : undefined;
}

export function getExportSymbolOfValueSymbolIfExported(c: Checker, symbol: Symbol): Symbol {
  if ((symbol.flags & SymbolFlags.ExportValue) !== 0 && symbol.exportSymbol !== undefined) symbol = symbol.exportSymbol;
  return getMergedSymbol(c, symbol);
}

export function getSymbolOfDeclaration(c: Checker, node: Node): Symbol | undefined {
  const symbol = getSymbol(node);
  return symbol !== undefined ? getMergedSymbol(c, getLateBoundSymbol(c, symbol)) : undefined;
}

function hasStaticDeclaration(symbol: Symbol): boolean {
  for (const d of getDeclarations(symbol)) if (hasStaticModifier(d)) return true;
  return false;
}

export function getLateBoundSymbol(c: Checker, symbol: Symbol): Symbol {
  if ((symbol.flags & SymbolFlags.ClassMember) === 0 || symbol.name !== InternalSymbolName.Computed) return symbol;
  const links = c.symbolLinks(symbol);
  if (links.lateSymbol === undefined && hasLateBindableDeclaration(c, symbol)) {
    // Force late binding of the parent's members or exports, which sets lateSymbol.
    if (symbol.parent !== undefined) {
      const parent = getMergedSymbol(c, symbol.parent);
      if (hasStaticDeclaration(symbol)) getExportsOfSymbol(c, parent);
      else getMembersOfSymbol(c, parent);
    } else {
      // An `F[name] = …` assignment in a script has no parent. Checking its target late-binds it
      // with the members of the function it's assigned to.
      for (const declaration of getDeclarations(symbol))
        if (declaration instanceof BinaryExpression) checkExpressionCached(c, declaration.left);
    }
  }
  if (links.lateSymbol === undefined) links.lateSymbol = symbol;
  return links.lateSymbol;
}

function hasLateBindableDeclaration(c: Checker, symbol: Symbol): boolean {
  for (const declaration of getDeclarations(symbol)) if (hasLateBindableName(c, declaration)) return true;
  return false;
}

// ---- Global types

export function getGlobalSymbol(
  c: Checker,
  name: string,
  meaning: SymbolFlags,
  diagnostic: DiagnosticMessage | undefined,
): Symbol | undefined {
  // Without a location, missing globals are global diagnostics.
  return resolveName(c, undefined, name, meaning, diagnostic, false, false);
}

function getGlobalTypeDeclaration(symbol: Symbol): Node | undefined {
  for (const d of getDeclarations(symbol)) {
    switch (d.kind) {
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
        return d;
    }
  }
  return undefined;
}

/** The global class or interface `name` with `arity` type parameters, or the empty (generic) object type. */
export function getGlobalType(c: Checker, name: string, arity: number, reportErrors: boolean): Type {
  const symbol = getGlobalSymbol(
    c,
    name,
    SymbolFlags.Type,
    reportErrors ? Diagnostics.Cannot_find_global_type_0 : undefined,
  );
  if (symbol !== undefined) {
    if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0) {
      const type = getDeclaredTypeOfSymbol(c, symbol);
      if ((type as InterfaceType).typeParameterCount() === arity) return type;
      if (reportErrors)
        c.error(
          getGlobalTypeDeclaration(symbol),
          Diagnostics.Global_type_0_must_have_1_type_parameter_s,
          symbol.name,
          String(arity),
        );
    } else if (reportErrors)
      c.error(
        getGlobalTypeDeclaration(symbol),
        Diagnostics.Global_type_0_must_be_a_class_or_interface_type,
        symbol.name,
      );
  }
  return arity !== 0 ? c.emptyGenericType : c.emptyObjectType;
}

/** Memoized `getGlobalType`, keyed by name, arity and whether errors were reported. */
export function getCachedGlobalType(c: Checker, name: string, arity: number, reportErrors: boolean): Type {
  // By name, then by arity and whether errors are reported: callers pass literal names.
  let byArity = c.globalTypeCache.get(name);
  if (byArity === undefined) {
    byArity = new Map<number, Type>();
    c.globalTypeCache.set(name, byArity);
  }
  const slot = arity * 2 + (reportErrors ? 1 : 0);
  let type = byArity.get(slot);
  if (type === undefined) {
    type = getGlobalType(c, name, arity, reportErrors);
    byArity.set(slot, type);
  }
  return type;
}

export function getGlobalTypeAliasSymbol(
  c: Checker,
  name: string,
  arity: number,
  reportErrors: boolean,
): Symbol | undefined {
  const key = 'alias:' + name + '/' + arity + (reportErrors ? '!' : '');
  const cached = c.globalSymbolCache.get(key);
  if (cached !== undefined) return cached === null ? undefined : cached;
  let symbol = getGlobalSymbol(
    c,
    name,
    SymbolFlags.TypeAlias,
    reportErrors ? Diagnostics.Cannot_find_global_type_0 : undefined,
  );
  if (symbol !== undefined) {
    getDeclaredTypeOfSymbol(c, symbol);
    const typeParameters = c.symbolLinks(symbol).typeParameters;
    if ((typeParameters === undefined ? 0 : typeParameters.length) !== arity) {
      if (reportErrors) {
        c.error(
          getDeclarationOfKind(symbol, SyntaxKind.TypeAliasDeclaration),
          Diagnostics.Global_type_0_must_have_1_type_parameter_s,
          symbol.name,
          String(arity),
        );
      }
      symbol = undefined;
    }
  }
  c.globalSymbolCache.set(key, symbol === undefined ? null : symbol);
  return symbol;
}

export function getGlobalValueSymbol(c: Checker, name: string, reportErrors: boolean): Symbol | undefined {
  const key = 'value:' + name + (reportErrors ? '!' : '');
  const cached = c.globalSymbolCache.get(key);
  if (cached !== undefined) return cached === null ? undefined : cached;
  const symbol = getGlobalSymbol(
    c,
    name,
    SymbolFlags.Value,
    reportErrors ? Diagnostics.Cannot_find_global_value_0 : undefined,
  );
  c.globalSymbolCache.set(key, symbol === undefined ? null : symbol);
  return symbol;
}

export function getGlobalStrictFunctionType(c: Checker, name: string): Type {
  return c.strictBindCallApply ? getGlobalType(c, name, 0, true) : c.globalFunctionType;
}

// ---- Aliases

export function isNonLocalAlias(symbol: Symbol | undefined, excludes: SymbolFlags): boolean {
  if (symbol === undefined) return false;
  return (
    (symbol.flags & (SymbolFlags.Alias | excludes)) === SymbolFlags.Alias ||
    ((symbol.flags & SymbolFlags.Alias) !== 0 && (symbol.flags & SymbolFlags.Assignment) !== 0)
  );
}

export function resolveSymbol(c: Checker, symbol: Symbol | undefined): Symbol | undefined {
  if (symbol !== undefined && isNonLocalAlias(symbol, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace))
    return resolveAlias(c, symbol);
  return symbol;
}

export function resolveSymbolEx(c: Checker, symbol: Symbol, dontResolveAlias: boolean): Symbol {
  if (!dontResolveAlias && isNonLocalAlias(symbol, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace))
    return resolveAlias(c, symbol);
  return symbol;
}

export function getDeclarationOfAliasSymbol(symbol: Symbol): Node | undefined {
  for (let i = declarationCount(symbol) - 1; i >= 0; i--) {
    const d = declarationAt(symbol, i);
    if (isAliasSymbolDeclaration(d)) return d;
  }
  return undefined;
}

export function isAliasSymbolDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.NamespaceExport:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier:
      return true;
    case SyntaxKind.ImportClause:
      return getName(node) !== undefined;
    case SyntaxKind.ExportAssignment: {
      const e = getExpression(node);
      return e !== undefined && isEntityNameExpressionNode(e);
    }
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.BindingElement:
    case SyntaxKind.BinaryExpression:
      return isJSAliasDeclaration(node);
  }
  return false;
}

function isEntityNameExpressionNode(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const e = getExpression(node)!;
    const name = getName(node);
    return name !== undefined && name.kind === SyntaxKind.Identifier && isEntityNameExpressionNode(e);
  }
  return false;
}

/** The alias target, unless resolving it now would be circular. */
export function tryResolveAlias(c: Checker, symbol: Symbol): Symbol | undefined {
  if (
    c.symbolLinks(symbol).aliasTarget !== undefined ||
    findResolutionCycleStartIndex(c, symbol, TypeSystemPropertyName.AliasTarget) < 0
  )
    return resolveAlias(c, symbol);
  return undefined;
}

export function resolveAlias(c: Checker, symbol: Symbol): Symbol {
  const links = c.symbolLinks(symbol);
  let target = links.aliasTarget;
  if (target !== undefined) return target;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.AliasTarget)) return c.unknownSymbol;
  const node = getDeclarationOfAliasSymbol(symbol);
  let resolved = getTargetOfAliasDeclaration(c, node);
  // A pure alias target is resolved transitively, carrying over its type-only declaration.
  if (resolved !== undefined && isNonLocalAlias(resolved, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace))
    resolved = resolveIndirectionAlias(c, symbol, resolved);
  target = resolved ?? c.unknownSymbol;
  links.aliasTarget = target;
  if (!popTypeResolution(c)) {
    c.error(node, Diagnostics.Circular_definition_of_import_alias_0, symbolToString(c, symbol));
    links.aliasTarget = c.unknownSymbol;
  }
  return links.aliasTarget;
}

/**
 * The combined flags of `symbol` and every alias target; All when an alias resolves to unknown. With
 * `excludeTypeOnlyMeanings`, the chain stops at the first alias with a type-only declaration.
 */
export function getSymbolFlags(c: Checker, symbol: Symbol, excludeTypeOnlyMeanings = false): SymbolFlags {
  let flags = symbol.flags;
  // Created for the first alias of an alias, as tsgo's zero-value set.
  let seen: Set<Symbol> | undefined = undefined;
  while ((symbol.flags & SymbolFlags.Alias) !== 0) {
    if (excludeTypeOnlyMeanings && getTypeOnlyAliasDeclaration(c, symbol) !== undefined) break;
    const target = getExportSymbolOfValueSymbolIfExported(c, resolveAlias(c, symbol));
    if (target === c.unknownSymbol) return SymbolFlags.All;
    if ((target.flags & SymbolFlags.Alias) !== 0) {
      if (target === symbol || (seen !== undefined && seen.has(target))) break;
      if (seen === undefined) seen = new Set<Symbol>();
      seen.add(symbol);
      seen.add(target);
    }
    flags |= target.flags;
    symbol = target;
  }
  return flags;
}

// ---- Members and exports

export function getExportsOfSymbol(c: Checker, symbol: Symbol): SymbolTable {
  if ((symbol.flags & SymbolFlags.LateBindingContainer) !== 0) return getResolvedMembersOrExports(c, symbol, true);
  if ((symbol.flags & SymbolFlags.Module) !== 0) return getExportsOfModule(c, symbol);
  return symbol.exports ?? emptySymbolTable;
}

export const emptySymbolTable: SymbolTable = new Map<string, Symbol>();

export function getExportsOfModule(c: Checker, moduleSymbol: Symbol): SymbolTable {
  // Late-bound members share the cache.
  if ((moduleSymbol.flags & SymbolFlags.LateBindingContainer) !== 0)
    return getResolvedMembersOrExports(c, moduleSymbol, true);
  const links = c.symbolLinks(moduleSymbol);
  let exports = links.resolvedExports;
  if (exports === undefined) {
    exports = getExportsOfModuleWorker(c, moduleSymbol);
    links.resolvedExports = exports;
  }
  return exports;
}

export function getMembersOfSymbol(c: Checker, symbol: Symbol): SymbolTable {
  if ((symbol.flags & SymbolFlags.LateBindingContainer) !== 0) return getResolvedMembersOrExports(c, symbol, false);
  return symbol.members ?? emptySymbolTable;
}

function getResolvedMembersOrExports(c: Checker, symbol: Symbol, isStatic: boolean): SymbolTable {
  const links = c.symbolLinks(symbol);
  const cached = isStatic ? links.resolvedExports : links.resolvedMembers;
  if (cached !== undefined) return cached;
  let early: SymbolTable;
  if (!isStatic) early = symbol.members ?? emptySymbolTable;
  else if ((symbol.flags & SymbolFlags.Module) !== 0) early = getExportsOfModuleWorker(c, symbol);
  else early = symbol.exports ?? emptySymbolTable;
  if (isStatic) links.resolvedExports = early;
  else links.resolvedMembers = early;
  let late: SymbolTable | undefined;
  for (const decl of getDeclarations(symbol)) {
    const members = getMembersOfDeclaration(decl);
    if (members === undefined) continue;
    for (const member of members) {
      if (isStatic !== hasStaticModifier(member)) continue;
      if (hasLateBindableName(c, member)) {
        if (late === undefined) late = new Map<string, Symbol>();
        lateBindMember(c, symbol, early, late, member);
      } else if (hasLateBindableIndexSignature(c, member)) {
        if (late === undefined) late = new Map<string, Symbol>();
        lateBindIndexSignature(c, early, late, member);
      }
    }
  }
  // JavaScript `F[name] = …` assignments with late-bindable names.
  const assignments = isStatic ? symbol.exports?.get(InternalSymbolName.AssignmentDeclaration) : undefined;
  if (assignments !== undefined)
    for (const member of getDeclarations(assignments))
      if (hasLateBindableName(c, member)) {
        if (late === undefined) late = new Map<string, Symbol>();
        lateBindMember(c, symbol, early, late, member);
      }
  const result = late === undefined ? early : combineSymbolTables(c, early, late);
  if (isStatic) links.resolvedExports = result;
  else links.resolvedMembers = result;
  return result;
}

function getMembersOfDeclaration(decl: Node): Node[] | undefined {
  switch (decl.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeLiteral:
      return getMemberNodes(decl)?.nodes;
    case SyntaxKind.ObjectLiteralExpression:
      return getProperties(decl)!.nodes;
  }
  return undefined;
}

export function combineSymbolTables(c: Checker, first: SymbolTable, second: SymbolTable): SymbolTable {
  if (first.size === 0) return second;
  if (second.size === 0) return first;
  const combined = new Map<string, Symbol>();
  mergeSymbolTable(c, combined, first, false, undefined);
  mergeSymbolTable(c, combined, second, false, undefined);
  return combined;
}

/** Binds a member with a computed name whose type is a literal or unique symbol under that name. */
function lateBindMember(c: Checker, parent: Symbol, early: SymbolTable, late: SymbolTable, decl: Node): Symbol {
  const cached = c.resolvedSymbols.get(decl.id);
  if (cached !== undefined) return cached;
  // A recursive request falls back to the early-bound symbol.
  c.resolvedSymbols.set(decl.id, getSymbol(decl));
  const declName = getLateBindableNameOfDeclaration(decl)!;
  const type =
    declName.kind === SyntaxKind.ElementAccessExpression
      ? checkExpressionCached(c, (declName as ElementAccessExpression).argumentExpression)
      : checkComputedPropertyName(c, declName);
  if (isTypeUsableAsPropertyName(type)) {
    const memberName = getPropertyNameFromType(type);
    const symbolFlags = getSymbol(decl)!.flags;
    let lateSymbol = late.get(memberName);
    if (lateSymbol === undefined) {
      lateSymbol = c.newSymbolWithCheckFlags(SymbolFlags.None, memberName, CheckFlags.Late);
      late.set(memberName, lateSymbol);
    }
    const earlySymbol = early.get(memberName);
    if ((lateSymbol.flags & getExcludedSymbolFlags(symbolFlags)) !== 0) {
      const declarations =
        earlySymbol !== undefined
          ? getDeclarations(earlySymbol).concat(getDeclarations(lateSymbol))
          : getDeclarations(lateSymbol);
      const name =
        (type.flags & 16384) !== 0 ? declarationNameToString(getSourceFileOfNode(declName), declName) : memberName;
      for (const d of declarations) c.error(getNameOfDeclaration(d) ?? d, Diagnostics.Duplicate_identifier_0, name);
      c.error(declName, Diagnostics.Duplicate_identifier_0, name);
      lateSymbol = c.newSymbolWithCheckFlags(SymbolFlags.None, memberName, CheckFlags.Late);
    }
    c.symbolNameTypes.set(getSymbolId(lateSymbol), type);
    addDeclarationToLateBoundSymbol(c, lateSymbol, decl, symbolFlags);
    if (lateSymbol.parent === undefined) lateSymbol.parent = parent;
    c.resolvedSymbols.set(decl.id, lateSymbol);
  }
  return c.resolvedSymbols.get(decl.id)!;
}

/** Adds a member whose computed name has a non-literal key type to the index symbol. */
function lateBindIndexSignature(c: Checker, early: SymbolTable, late: SymbolTable, decl: Node): void {
  let indexSymbol = late.get(InternalSymbolName.Index);
  if (indexSymbol === undefined) {
    const earlyIndex = early.get(InternalSymbolName.Index);
    if (earlyIndex === undefined)
      indexSymbol = c.newSymbolWithCheckFlags(SymbolFlags.None, InternalSymbolName.Index, CheckFlags.Late);
    else {
      indexSymbol = cloneSymbol(c, earlyIndex);
      indexSymbol.checkFlags |= CheckFlags.Late;
    }
    late.set(InternalSymbolName.Index, indexSymbol);
  }
  // Unlike late-bound members, `decl` gets no late symbol: the index symbol isn't one property.
  if (declarationCount(indexSymbol) === 0 || (getSymbol(decl)!.flags & SymbolFlags.ReplaceableByMethod) === 0)
    addDeclaration(indexSymbol, decl);
}

function addDeclarationToLateBoundSymbol(c: Checker, symbol: Symbol, member: Node, symbolFlags: SymbolFlags): void {
  const memberSymbol = getSymbol(member)!;
  c.symbolLinks(memberSymbol).lateSymbol = symbol;
  if (declarationCount(symbol) === 0 || (memberSymbol.flags & SymbolFlags.ReplaceableByMethod) === 0) {
    symbol.flags |= symbolFlags;
    addDeclaration(symbol, member);
  }
  if ((symbolFlags & SymbolFlags.Value) !== 0) setValueDeclaration(symbol, member);
}

export function isReservedMemberName(name: string): boolean {
  if (name.length < 2 || name.charCodeAt(0) !== 0xfffe) return false;
  const second = name.charCodeAt(1);
  return second !== 0x40 && second !== 0x23;
}

/** Whether `symbol` has a value meaning; one reached through a type-only alias doesn't count. */
export function symbolIsValue(c: Checker, symbol: Symbol): boolean {
  return (
    (symbol.flags & SymbolFlags.Value) !== 0 ||
    ((symbol.flags & SymbolFlags.Alias) !== 0 && (getSymbolFlags(c, symbol, true) & SymbolFlags.Value) !== 0)
  );
}

function isDeclarationContainedBy(symbol: Symbol, container: Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  if (declaration !== undefined)
    for (let i = 0; i < declarationCount(container); i++) {
      const d = declarationAt(container, i);
      if (declaration.pos >= d.pos && declaration.end <= d.end) return true;
    }
  return false;
}

/** Value members other than signatures and index signatures, declared ones first, each part ordered by declaration. */
export function getNamedMembers(c: Checker, members: SymbolTable | undefined, container: Symbol | undefined): Symbol[] {
  if (members === undefined || members.size === 0) return [];
  const isClassOrInterface =
    container !== undefined && (container.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0;
  const contained: Symbol[] = [];
  const rest: Symbol[] = [];
  for (const [id, symbol] of members) {
    if (isReservedMemberName(id) || !symbolIsValue(c, symbol)) continue;
    if (isClassOrInterface && isDeclarationContainedBy(symbol, container!)) contained.push(symbol);
    else rest.push(symbol);
  }
  sortSymbols(c, contained);
  sortSymbols(c, rest);
  return contained.length === 0 ? rest : contained.concat(rest);
}

/**
 * `getNamedMembers(c, table, container)` for a table that holds `members` in this order under their names, as
 * positions in `members`; undefined where a member is an alias (`symbolIsValue` then resolves it) or a name repeats.
 */
export function getNamedMemberPositions(
  c: Checker,
  members: Symbol[],
  container: Symbol | undefined,
): number[] | undefined {
  const isClassOrInterface =
    container !== undefined && (container.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0;
  const names = new Set<string>();
  const contained: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < members.length; i++) {
    const symbol = members[i]!;
    if ((symbol.flags & SymbolFlags.Alias) !== 0 || names.has(symbol.name)) return undefined;
    names.add(symbol.name);
    if (isReservedMemberName(symbol.name) || !symbolIsValue(c, symbol)) continue;
    if (isClassOrInterface && isDeclarationContainedBy(symbol, container!)) contained.push(i);
    else rest.push(i);
  }
  sortPositions(c, members, contained);
  sortPositions(c, members, rest);
  return contained.length === 0 ? rest : contained.concat(rest);
}

/** `sortSymbols` for positions in `members`. */
function sortPositions(c: Checker, members: Symbol[], positions: number[]): void {
  for (let i = 1; i < positions.length; i++)
    if (compareSymbols(c, members[positions[i - 1]!]!, members[positions[i]!]!) > 0) {
      positions.sort((a, b) => compareSymbols(c, members[a]!, members[b]!));
      return;
    }
}

/** Sorts symbols by declaration order; members are usually in that order already. */
function sortSymbols(c: Checker, symbols: Symbol[]): void {
  for (let i = 1; i < symbols.length; i++)
    if (compareSymbols(c, symbols[i - 1]!, symbols[i]!) > 0) {
      symbols.sort((a, b) => compareSymbols(c, a, b));
      return;
    }
}

// ---- Entity names

export function getFirstIdentifier(node: Node): Identifier {
  let current = node;
  for (;;) {
    if (current.kind === SyntaxKind.QualifiedName) current = (current as QualifiedName).left;
    else if (current.kind === SyntaxKind.PropertyAccessExpression) current = getExpression(current)!;
    else return current as Identifier;
  }
}

export function resolveEntityName(
  c: Checker,
  name: Node,
  meaning: SymbolFlags,
  ignoreErrors: boolean,
  dontResolveAlias: boolean,
  location: Node | undefined,
): Symbol | undefined {
  if (nodeIsMissing(name)) return undefined;
  let symbol: Symbol | undefined;
  if (name.kind === SyntaxKind.Identifier) {
    const message = ignoreErrors
      ? undefined
      : meaning === SymbolFlags.Namespace || (name.flags & NodeFlags.Synthesized) !== 0
        ? Diagnostics.Cannot_find_namespace_0
        : location === undefined
          ? cannotFindNameAtLocation
          : getCannotFindNameDiagnosticForName(c, getFirstIdentifier(name));
    const resolveLocation = location ?? name;
    const text = getText(name);
    if (meaning === SymbolFlags.Namespace) {
      const found = resolveName(c, resolveLocation, text, meaning, undefined, true, false);
      symbol = found !== undefined ? getMergedSymbol(c, found) : undefined;
      if (symbol === undefined) {
        // Typedefs exported from CommonJS are stored on the module symbol, the parent of its `export=`. The
        // lookup also marks an alias of the name as referenced.
        const alias = resolveName(c, resolveLocation, text, SymbolFlags.Alias, undefined, true, false);
        if (alias !== undefined && getMergedSymbol(c, alias).name === InternalSymbolName.ExportEquals)
          symbol = getMergedSymbol(c, alias).parent;
      }
      if (symbol === undefined && message !== undefined)
        resolveName(c, resolveLocation, text, meaning, message, true, false);
    } else {
      const found = resolveName(c, resolveLocation, text, meaning, message, true, false);
      symbol = found !== undefined ? getMergedSymbol(c, found) : undefined;
    }
  } else if (name.kind === SyntaxKind.QualifiedName) {
    const qualified = name as QualifiedName;
    symbol = resolveQualifiedName(c, name, qualified.left, qualified.right, meaning, ignoreErrors, location);
  } else if (name.kind === SyntaxKind.PropertyAccessExpression) {
    symbol = resolveQualifiedName(c, name, getExpression(name)!, getName(name)!, meaning, ignoreErrors, location);
  } else return undefined;
  if (symbol !== undefined && symbol !== c.unknownSymbol) {
    if (
      (name.flags & NodeFlags.Synthesized) === 0 &&
      name.kind !== SyntaxKind.PropertyAccessExpression &&
      ((symbol.flags & SymbolFlags.Alias) !== 0 ||
        (name.parent !== undefined && name.parent.kind === SyntaxKind.ExportAssignment))
    )
      markAliasDeclarationOfNameIfTypeOnly(c, name);
    // Resolve along the alias chain to the symbol with the meaning.
    while ((symbol.flags & meaning) === 0 && !dontResolveAlias && (symbol.flags & SymbolFlags.Alias) !== 0)
      symbol = resolveAlias(c, symbol);
  }
  return symbol;
}

function resolveQualifiedName(
  c: Checker,
  name: Node,
  left: Node,
  right: Node,
  meaning: SymbolFlags,
  ignoreErrors: boolean,
  location: Node | undefined,
): Symbol | undefined {
  const namespace = resolveEntityName(c, left, SymbolFlags.Namespace, ignoreErrors, false, location);
  if (namespace === undefined || nodeIsMissing(right)) return undefined;
  if (namespace === c.unknownSymbol) return namespace;
  const text = getText(right);
  let found = getSymbolOfMeaning(c, getExportsOfSymbol(c, namespace), text, meaning);
  // A namespace merged with a re-export resolves further.
  if (found === undefined && (namespace.flags & SymbolFlags.Alias) !== 0)
    found = getSymbolOfMeaning(c, getExportsOfSymbol(c, resolveAlias(c, namespace)), text, meaning);
  if (found !== undefined) return getMergedSymbol(c, found);
  if (ignoreErrors) return undefined;
  const namespaceName = getFullyQualifiedName(c, namespace);
  const declarationName = declarationNameToString(getSourceFileOfNode(right), right);
  const suggestion = getSpellingSuggestionForName(
    c,
    text,
    Array.from(getExportsOfModule(c, namespace).values()),
    SymbolFlags.ModuleMember,
  );
  if (suggestion !== undefined) {
    c.error(
      right,
      Diagnostics.X_0_has_no_exported_member_named_1_Did_you_mean_2,
      namespaceName,
      declarationName,
      symbolToString(c, suggestion),
    );
    return undefined;
  }
  let containingQualifiedName: Node | undefined;
  if (name.kind === SyntaxKind.QualifiedName) {
    containingQualifiedName = name;
    while (containingQualifiedName.parent!.kind === SyntaxKind.QualifiedName)
      containingQualifiedName = containingQualifiedName.parent!;
  }
  if (
    // Not while the checker is being created, before global types are known.
    c.hasGlobalObjectType &&
    (meaning & SymbolFlags.Type) !== 0 &&
    containingQualifiedName !== undefined &&
    containingQualifiedName.parent!.kind !== SyntaxKind.TypeOfExpression &&
    tryGetQualifiedNameAsValue(c, containingQualifiedName) !== undefined
  ) {
    c.error(
      containingQualifiedName,
      Diagnostics.X_0_refers_to_a_value_but_is_being_used_as_a_type_here_Did_you_mean_typeof_0,
      entityNameToString(containingQualifiedName),
    );
    return undefined;
  }
  if (
    (meaning & SymbolFlags.Namespace) !== 0 &&
    name.parent !== undefined &&
    name.parent.kind === SyntaxKind.QualifiedName
  ) {
    const exportedType = getSymbolOfMeaning(c, getExportsOfSymbol(c, namespace), text, SymbolFlags.Type);
    if (exportedType !== undefined) {
      const qualified = name.parent as QualifiedName;
      c.error(
        qualified.right,
        Diagnostics.Cannot_access_0_1_because_0_is_a_type_but_not_a_namespace_Did_you_mean_to_retrieve_the_type_of_the_property_1_in_0_with_0_1,
        symbolToString(c, getMergedSymbol(c, exportedType)),
        getText(qualified.right),
      );
      return undefined;
    }
  }
  c.error(right, Diagnostics.Namespace_0_has_no_exported_member_1, namespaceName, declarationName);
  return undefined;
}

/** The value a qualified name denotes as a property access, if any. */
function tryGetQualifiedNameAsValue(c: Checker, node: Node): Symbol | undefined {
  const id = getFirstIdentifier(node);
  let symbol = resolveName(c, id, getText(id), SymbolFlags.Value, undefined, true, false);
  if (symbol === undefined) return undefined;
  let current: Node = id;
  while (current.parent!.kind === SyntaxKind.QualifiedName) {
    symbol = getPropertyOfType(c, getTypeOfSymbol(c, symbol), getText((current.parent as QualifiedName).right));
    if (symbol === undefined) return undefined;
    current = current.parent!;
  }
  return symbol;
}

/**
 * `symbol` qualified by its parents. The outermost one is written as seen from `containingLocation`
 * if given, so that a module is named by a specifier the containing file could import it with.
 */
export function getFullyQualifiedName(c: Checker, symbol: Symbol, containingLocation?: Node): string {
  return symbol.parent !== undefined
    ? getFullyQualifiedName(c, symbol.parent, containingLocation) + '.' + symbolToString(c, symbol)
    : symbolToString(c, symbol, containingLocation, NodeBuilderInternalFlags.DoNotIncludeSymbolChain);
}

export function getCannotFindNameDiagnosticForName(c: Checker, node: Node): DiagnosticMessage {
  const wildcard = c.compilerOptions.types !== undefined && c.compilerOptions.types.includes('*');
  switch (getText(node)) {
    case 'document':
    case 'console':
      return Diagnostics.Cannot_find_name_0_Do_you_need_to_change_your_target_library_Try_changing_the_lib_compiler_option_to_include_dom;
    case '$':
      return wildcard
        ? Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_jQuery_Try_npm_i_save_dev_types_Slashjquery
        : Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_jQuery_Try_npm_i_save_dev_types_Slashjquery_and_then_add_jquery_to_the_types_field_in_your_tsconfig;
    case 'beforeEach':
    case 'describe':
    case 'suite':
    case 'it':
    case 'test':
      return wildcard
        ? Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_a_test_runner_Try_npm_i_save_dev_types_Slashjest_or_npm_i_save_dev_types_Slashmocha
        : Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_a_test_runner_Try_npm_i_save_dev_types_Slashjest_or_npm_i_save_dev_types_Slashmocha_and_then_add_jest_or_mocha_to_the_types_field_in_your_tsconfig;
    case 'process':
    case 'require':
    case 'Buffer':
    case 'module':
    case 'NodeJS':
      return wildcard
        ? Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_node_Try_npm_i_save_dev_types_Slashnode
        : Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_node_Try_npm_i_save_dev_types_Slashnode_and_then_add_node_to_the_types_field_in_your_tsconfig;
    case 'Bun':
      return wildcard
        ? Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_Bun_Try_npm_i_save_dev_types_Slashbun
        : Diagnostics.Cannot_find_name_0_Do_you_need_to_install_type_definitions_for_Bun_Try_npm_i_save_dev_types_Slashbun_and_then_add_bun_to_the_types_field_in_your_tsconfig;
    // tsgo lists `ast.Symbol` here rather than `Symbol`.
    case 'Map':
    case 'Set':
    case 'Promise':
    case 'WeakMap':
    case 'WeakSet':
    case 'Iterator':
    case 'AsyncIterator':
    case 'SharedArrayBuffer':
    case 'Atomics':
    case 'AsyncIterable':
    case 'AsyncIterableIterator':
    case 'AsyncGenerator':
    case 'AsyncGeneratorFunction':
    case 'BigInt':
    case 'Reflect':
    case 'BigInt64Array':
    case 'BigUint64Array':
      return Diagnostics.Cannot_find_name_0_Do_you_need_to_change_your_target_library_Try_changing_the_lib_compiler_option_to_1_or_later;
    case 'await':
      if (node.parent !== undefined && node.parent.kind === SyntaxKind.CallExpression)
        return Diagnostics.Cannot_find_name_0_Did_you_mean_to_write_this_in_an_async_function;
      break;
  }
  if (node.parent !== undefined && node.parent.kind === SyntaxKind.ShorthandPropertyAssignment)
    return Diagnostics.No_value_exists_in_scope_for_the_shorthand_property_0_Either_declare_one_or_provide_an_initializer;
  return Diagnostics.Cannot_find_name_0;
}

// ---- Resolution stack

export const enum TypeSystemPropertyName {
  Type = 0,
  ResolvedBaseConstructorType = 1,
  DeclaredType = 2,
  ResolvedReturnType = 3,
  ResolvedBaseConstraint = 4,
  ResolvedTypeArguments = 5,
  ResolvedBaseTypes = 6,
  WriteType = 7,
  InitializerIsUndefined = 8,
  AliasTarget = 9,
}

type ResolutionTarget = Symbol | Type | Signature | Node;

/**
 * Pushes a resolution of `propertyName` on `target`. When the same resolution is already on the
 * stack with no resolved entries above it, marks the cycle and returns false.
 */
export function pushTypeResolution(
  c: Checker,
  target: ResolutionTarget,
  propertyName: TypeSystemPropertyName,
): boolean {
  const start = findResolutionCycleStartIndex(c, target, propertyName);
  if (start >= 0) {
    c.resolutionCycleCount++;
    for (let i = start; i < c.resolutionDepth; i++) c.resolutionResults[i] = false;
    return false;
  }
  const depth = c.resolutionDepth;
  if (depth < c.resolutionTargets.length) {
    c.resolutionTargets[depth] = target;
    c.resolutionPropertyNames[depth] = propertyName;
    c.resolutionResults[depth] = true;
  } else {
    c.resolutionTargets.push(target);
    c.resolutionPropertyNames.push(propertyName);
    c.resolutionResults.push(true);
  }
  c.resolutionDepth = depth + 1;
  return true;
}

/** Pops the last resolution; false if it was part of a cycle. */
export function popTypeResolution(c: Checker): boolean {
  const depth = c.resolutionDepth - 1;
  c.resolutionDepth = depth;
  return c.resolutionResults[depth]!;
}

export function findResolutionCycleStartIndex(
  c: Checker,
  target: ResolutionTarget,
  propertyName: TypeSystemPropertyName,
): number {
  for (let i = c.resolutionDepth - 1; i >= c.resolutionStart; i--) {
    if (resolutionHasProperty(c, c.resolutionTargets[i]!, c.resolutionPropertyNames[i]!)) return -1;
    if (c.resolutionTargets[i]! === target && c.resolutionPropertyNames[i]! === propertyName) return i;
  }
  return -1;
}

function resolutionHasProperty(c: Checker, target: ResolutionTarget, propertyName: number): boolean {
  switch (propertyName) {
    case TypeSystemPropertyName.Type:
      return c.symbolTypes.get(getSymbolId(target as Symbol)) !== undefined;
    case TypeSystemPropertyName.DeclaredType:
      return c.symbolLinks(target as Symbol).declaredType !== undefined;
    case TypeSystemPropertyName.ResolvedTypeArguments:
      return (
        typeReferenceOf(target as Type).resolvedTypeArguments !== undefined ||
        sideOf(c, typeReferenceOf(target as Type)).resolvedTypeArguments !== undefined
      );
    case TypeSystemPropertyName.ResolvedBaseTypes:
      return sideOf(c, interfaceTypeOf(target as Type)).baseTypesResolved;
    case TypeSystemPropertyName.ResolvedBaseConstructorType:
      return sideOf(c, interfaceTypeOf(target as Type)).resolvedBaseConstructorType !== undefined;
    case TypeSystemPropertyName.ResolvedReturnType:
      return (
        (target as Signature).resolvedReturnType !== undefined ||
        signatureSideOf(c, target as Signature).resolvedReturnType !== undefined
      );
    case TypeSystemPropertyName.ResolvedBaseConstraint:
      return (
        (target as Type).resolvedBaseConstraint !== undefined ||
        sideOf(c, target as Type).resolvedBaseConstraint !== undefined
      );
    case TypeSystemPropertyName.InitializerIsUndefined:
      return ((c.existingNodeLinks(target as Node)?.flags ?? 0) & (1 << 25)) !== 0;
    case TypeSystemPropertyName.WriteType:
      return c.symbolLinks(target as Symbol).writeType !== undefined;
    case TypeSystemPropertyName.AliasTarget:
      return c.symbolLinks(target as Symbol).aliasTarget !== undefined;
  }
  return false;
}

function typeReferenceOf(t: Type): TypeReference {
  return t as TypeReference;
}

function interfaceTypeOf(t: Type): InterfaceType {
  return t as InterfaceType;
}

export function reportCircularityError(c: Checker, symbol: Symbol): Type {
  const declaration = symbol.valueDeclaration;
  if (declaration !== undefined) {
    if (getType(declaration) !== undefined) {
      c.error(
        declaration,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
      return c.errorType;
    }
    if (c.noImplicitAny && (declaration.kind !== SyntaxKind.Parameter || getInitializer(declaration) !== undefined))
      c.error(
        declaration,
        Diagnostics.X_0_implicitly_has_type_any_because_it_does_not_have_a_type_annotation_and_is_referenced_directly_or_indirectly_in_its_own_initializer,
        symbolToString(c, symbol),
      );
  } else if ((symbol.flags & SymbolFlags.Alias) !== 0) {
    const node = getDeclarationOfAliasSymbol(symbol);
    if (node !== undefined) c.error(node, Diagnostics.Circular_definition_of_import_alias_0, symbolToString(c, symbol));
  }
  // Circularities could also result from parameters in function expressions that end up having themselves as
  // contextual types. Those are reported elsewhere.
  return c.anyType;
}

export { getTypeOfSymbol, getSourceFileOfNode };
export type { SourceFile };
