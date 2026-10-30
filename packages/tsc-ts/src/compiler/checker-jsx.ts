// JSX: element and fragment types, the `JSX` namespace, intrinsic elements, attributes and children.
import { checkDeprecatedSignature } from './checker-deprecation.js';
import {
  type BinaryExpression,
  type JsxAttribute,
  type JsxAttributes,
  type JsxElement,
  type JsxExpression,
  type JsxFragment,
  type JsxNamespacedName,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type JsxSpreadAttribute,
  type JsxText,
  type Node,
  type NodeList,
  NodeVisitor,
  type PropertyAccessExpression,
  type QualifiedName,
  type SourceFile,
  getSymbol,
  getTagName,
  getText,
  getTypeArguments,
  getExpression,
  Identifier,
  PropertySignatureDeclaration,
} from './ast.js';
import { getSourceFileOfNode, getSourceTextOfNode } from './binder-utilities.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics, chainDiagnostic } from './diagnostics.js';
import { JsxEmit } from './options.js';
import { parseIsolatedEntityName } from './parser.js';
import { skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  AccessFlags,
  CheckMode,
  type LiteralType,
  ObjectFlags,
  type Signature,
  SignatureFlags,
  SignatureKind,
  type Type,
  TypeFlags,
  newTypeMapper,
} from './checker-types.js';
import {
  createAnonymousType,
  createArrayType,
  createTupleType,
  createTypeReference,
  getIntersectionType,
  getPropagatingFlagsOfTypes,
  getStringLiteralType,
  getUnionType,
  intersectTypes,
  isErrorType,
  everyType,
  isArrayType,
  mapTypeEx,
  someType,
  typesOf,
} from './checker-type-factory.js';
import {
  getApparentType,
  getApplicableIndexInfo,
  getApplicableIndexInfoForName,
  getIndexTypeOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
  getUnionSignatures,
  isArrayLikeType,
} from './checker-members.js';
import {
  getMergedSymbol,
  getExportsOfSymbol,
  getFirstIdentifier,
  getGlobalSymbol,
  getSymbolOfMeaning,
  resolveAlias,
  resolveEntityName,
  getSpellingSuggestionForName,
  resolveName,
  resolveSymbol,
} from './checker-symbols.js';
import { resolveExternalModule } from './checker-modules.js';
import {
  fillMissingTypeArguments,
  getDeclaredTypeOfSymbol,
  getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
  getMinTypeArgumentCount,
} from './checker-declared-types.js';
import { getTypeAliasInstantiation } from './checker-type-nodes.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import {
  getMinArgumentCount,
  getOrCreateTypeFromSignature,
  getParameterCount,
  getReturnTypeOfSignature,
  getTypeAtPosition,
  hasEffectiveRestParameter,
} from './checker-signatures.js';
import { instantiateType } from './instantiation.js';
import {
  checkTypeRelatedTo,
  getRegularTypeOfObjectLiteral,
  isExactOptionalPropertyMismatch,
  isTypeRelatedTo,
  type Relation,
} from './relations.js';
import {
  checkExpression,
  checkExpressionCached,
  checkExpressionEx,
  checkExpressionForMutableLocationEx,
} from './checker-expressions.js';
import {
  ContextFlags,
  checkExpressionWithContextualType,
  findContextualNode,
  getApparentTypeOfContextualType,
  getApparentTypeOfContextualTypeEx,
  getContextualType,
  getContextualTypeEx,
  getTypeOfPropertyOfContextualType,
  getInferenceContext,
} from './checker-contextual.js';
import { checkNodeDeferred, checkSourceElement } from './checker-source-file.js';
import { getResolvedSignature, resolveCall } from './checker-calls.js';
import {
  type InferenceContext,
  InferencePriority,
  addIntraExpressionInferenceSite,
  getInferredTypes,
  inferTypes,
} from './checker-inference.js';
import { isContextSensitive } from './checker-functions.js';
import { checkSpreadPropOverrides, getSpreadType } from './checker-object-literals.js';
import { isValidSpreadType } from './checker-destructuring.js';
import {
  checkExpressionForMutableLocationWithContextualType,
  checkTypeRelatedToAndOptionallyElaborate,
  elaborateElement,
  elaborateError,
  getBestMatchIndexedAccessTypeOrUndefined,
} from './checker-elaboration.js';
import {
  IterationTypeKind,
  IterationUse,
  getGlobalIterableType,
  getIterationTypeOfIterable,
} from './checker-iteration.js';
import { getIndexedAccessTypeOrUndefined, getPropertyNameFromIndex } from './checker-type-operators.js';
import { removeMissingType } from './checker-symbol-types.js';
import { typeToString } from './type-printer.js';
import { getReducedType } from './checker-members.js';
import { getNumberLiteralType } from './checker-type-factory.js';
import { getIndexedAccessType } from './checker-type-operators.js';
import { filterType, isTupleType } from './checker-type-factory.js';
import { createTypeFromGenericGlobalType } from './checker-type-factory.js';
import { isTypeAssignableTo } from './relations.js';
import {
  copyDeclarations,
  declarationCount,
  getSymbolId,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
  type SymbolTable,
} from './symbol.js';

const enum JsxFlags {
  None = 0,
  /** An element from a named property of `JSX.IntrinsicElements`. */
  IntrinsicNamedElement = 1 << 0,
  /** An element from the string index signature of `JSX.IntrinsicElements`. */
  IntrinsicIndexedElement = 1 << 1,
}

const enum JsxReferenceKind {
  Component,
  Function,
  Mixed,
}

// Names in the `JSX` namespace.
const jsxNamespaceName = 'JSX';
const jsxIntrinsicElementsName = 'IntrinsicElements';
const jsxElementClassName = 'ElementClass';
const jsxElementAttributesPropertyName = 'ElementAttributesProperty';
const jsxElementChildrenAttributeName = 'ElementChildrenAttribute';
const jsxElementName = 'Element';
const jsxElementTypeName = 'ElementType';
const jsxIntrinsicAttributesName = 'IntrinsicAttributes';
const jsxIntrinsicClassAttributesName = 'IntrinsicClassAttributes';
const jsxLibraryManagedAttributesName = 'LibraryManagedAttributes';

/** Per-element JSX state. */
class JsxElementLinks {
  jsxFlags = JsxFlags.None;
  resolvedJsxElementAttributesType: Type | undefined = undefined;
  resolvedSymbol: Symbol | undefined = undefined;
  /** The resolved `JSX` namespace; `unknownSymbol` when the local lookup failed. */
  jsxNamespace: Symbol | undefined = undefined;
}

/** Per-file JSX state: pragmas, factories and the implicit runtime import. */
class JsxFileLinks {
  localJsxNamespace = '';
  localJsxFactory: Node | undefined = undefined;
  localJsxFragmentNamespace = '';
  localJsxFragmentFactory: Node | undefined = undefined;
  jsxFragmentType: Type | undefined = undefined;
  /** `unknownSymbol` when there is no implicit import container. */
  jsxImplicitImportContainer: Symbol | undefined = undefined;
}

/** The checker's JSX caches. */
export class JsxState {
  readonly elementLinks = new Map<Node, JsxElementLinks>();
  readonly fileLinks = new Map<SourceFile, JsxFileLinks>();
  /** getJsxIntrinsicConstructorType by attributes and element type ids. */
  readonly intrinsicConstructorTypes = new Map<string, Type>();
  jsxNamespace = '';
  jsxFactoryEntity: Node | undefined = undefined;
}

function elementLinks(c: Checker, node: Node): JsxElementLinks {
  let links = c.jsx.elementLinks.get(node);
  if (links === undefined) {
    links = new JsxElementLinks();
    c.jsx.elementLinks.set(node, links);
  }
  return links;
}

function fileLinks(c: Checker, file: SourceFile): JsxFileLinks {
  let links = c.jsx.fileLinks.get(file);
  if (links === undefined) {
    links = new JsxFileLinks();
    c.jsx.fileLinks.set(file, links);
  }
  return links;
}

// ---- Syntax helpers

export function isJsxOpeningLikeElement(node: Node): boolean {
  return node.kind === SyntaxKind.JsxOpeningElement || node.kind === SyntaxKind.JsxSelfClosingElement;
}

function isIntrinsicJsxName(name: string): boolean {
  if (name.length === 0) return false;
  const ch = name.charCodeAt(0);
  return (ch >= 0x61 && ch <= 0x7a) || name.includes('-');
}

/** Whether a tag name refers to an intrinsic element: a lowercase or dashed identifier, or `ns:name`. */
export function isJsxIntrinsicTagName(tagName: Node): boolean {
  return (
    (tagName.kind === SyntaxKind.Identifier && isIntrinsicJsxName(getText(tagName))) ||
    tagName.kind === SyntaxKind.JsxNamespacedName
  );
}

/** The text of an identifier or `ns:name`. */
function jsxNameText(node: Node): string {
  if (node.kind === SyntaxKind.JsxNamespacedName) {
    const name = node as JsxNamespacedName;
    return name.namespace.text + ':' + name.name.text;
  }
  return getText(node);
}

function getTextOfNode(node: Node): string {
  return getSourceTextOfNode(getSourceFileOfNode(node), node);
}

function entityNameToString(node: Node): string {
  switch (node.kind) {
    case SyntaxKind.ThisKeyword:
      return 'this';
    case SyntaxKind.PropertyAccessExpression: {
      const access = node as PropertyAccessExpression;
      return entityNameToString(access.expression) + '.' + entityNameToString(access.name);
    }
    case SyntaxKind.QualifiedName:
      return entityNameToString((node as QualifiedName).left) + '.' + getText((node as QualifiedName).right);
    case SyntaxKind.JsxNamespacedName:
      return jsxNameText(node);
  }
  return getText(node);
}

export function getTagNameOf(node: Node): Node {
  return getTagName(node)!;
}

export function getAttributesOf(node: Node): JsxAttributes {
  return node.kind === SyntaxKind.JsxSelfClosingElement
    ? (node as JsxSelfClosingElement).attributes
    : (node as JsxOpeningElement).attributes;
}

function getTypeArgumentListOf(node: Node): NodeList | undefined {
  return getTypeArguments(node);
}

function getChildrenOf(node: Node): Node[] {
  if (node.kind === SyntaxKind.JsxElement) return (node as JsxElement).children.nodes;
  if (node.kind === SyntaxKind.JsxFragment) return (node as JsxFragment).children.nodes;
  return [];
}

/** Children that produce values: non-empty expressions, non-whitespace text and elements. */
export function getSemanticJsxChildren(children: readonly Node[]): Node[] {
  const result: Node[] = [];
  for (const child of children) {
    if (child.kind === SyntaxKind.JsxExpression) {
      if ((child as JsxExpression).expression !== undefined) result.push(child);
    } else if (child.kind === SyntaxKind.JsxText) {
      if (!(child as JsxText).containsOnlyTriviaWhiteSpaces) result.push(child);
    } else result.push(child);
  }
  return result;
}

function isHyphenatedJsxName(name: string): boolean {
  return name.includes('-');
}

function getPragma(file: SourceFile, name: string, argument: string): string | undefined {
  let result: string | undefined = undefined;
  // The last pragma wins.
  for (const pragma of file.pragmas) if (pragma.name === name) result = pragma.args.get(argument)?.value ?? '';
  return result;
}

function isJsxTransformEnabled(c: Checker): boolean {
  const jsx = c.compilerOptions.jsx;
  return jsx === JsxEmit.React || jsx === JsxEmit.ReactJSX || jsx === JsxEmit.ReactJSXDev;
}

function grammarErrorOnNode(c: Checker, node: Node, message: DiagnosticMessage, ...args: string[]): boolean {
  if (getSourceFileOfNode(node).diagnostics.length !== 0) return false;
  c.error(node, message, ...args);
  return true;
}

function grammarErrorAtPos(c: Checker, node: Node, pos: number, length: number, message: DiagnosticMessage): boolean {
  const file = getSourceFileOfNode(node);
  if (file.diagnostics.length !== 0) return false;
  c.addDiagnostic(new Diagnostic(file.diagnosticFile(), pos, pos + length, message, []));
  return true;
}

// ---- The JSX namespace

/** The name of the factory namespace in scope at `location`, such as `React`. */
export function getJsxNamespace(c: Checker, location: Node | undefined): string {
  if (location !== undefined) {
    const file = getSourceFileOfNode(location);
    const links = fileLinks(c, file);
    if (location.kind === SyntaxKind.JsxOpeningFragment) {
      if (links.localJsxFragmentNamespace !== '') return links.localJsxFragmentNamespace;
      const fragmentPragma = getPragma(file, 'jsxfrag', 'factory');
      if (fragmentPragma !== undefined) {
        links.localJsxFragmentFactory = parseIsolatedEntityName(fragmentPragma);
        if (links.localJsxFragmentFactory !== undefined) {
          links.localJsxFragmentNamespace = getText(getFirstIdentifier(links.localJsxFragmentFactory));
          return links.localJsxFragmentNamespace;
        }
      }
      const entity = getJsxFragmentFactoryEntity(c, location);
      if (entity !== undefined) {
        links.localJsxFragmentFactory = entity;
        links.localJsxFragmentNamespace = getText(getFirstIdentifier(entity));
        return links.localJsxFragmentNamespace;
      }
    } else {
      const local = getLocalJsxNamespace(c, file);
      if (local !== '') {
        links.localJsxNamespace = local;
        return local;
      }
    }
  }
  const state = c.jsx;
  if (state.jsxNamespace === '') {
    state.jsxNamespace = 'React';
    const factory = c.compilerOptions.jsxFactory;
    if (factory !== undefined && factory !== '') {
      state.jsxFactoryEntity = parseIsolatedEntityName(factory);
      if (state.jsxFactoryEntity !== undefined)
        state.jsxNamespace = getText(getFirstIdentifier(state.jsxFactoryEntity));
    } else {
      const reactNamespace = c.compilerOptions.reactNamespace;
      if (reactNamespace !== undefined && reactNamespace !== '') state.jsxNamespace = reactNamespace;
    }
  }
  if (state.jsxFactoryEntity === undefined)
    state.jsxFactoryEntity = parseIsolatedEntityName(state.jsxNamespace + '.createElement');
  return state.jsxNamespace;
}

function getLocalJsxNamespace(c: Checker, file: SourceFile): string {
  const links = fileLinks(c, file);
  if (links.localJsxNamespace !== '') return links.localJsxNamespace;
  const pragma = getPragma(file, 'jsx', 'factory');
  if (pragma !== undefined) {
    links.localJsxFactory = parseIsolatedEntityName(pragma);
    if (links.localJsxFactory !== undefined) {
      links.localJsxNamespace = getText(getFirstIdentifier(links.localJsxFactory));
      return links.localJsxNamespace;
    }
  }
  return '';
}

function getJsxFactoryEntity(c: Checker, location: Node): Node | undefined {
  getJsxNamespace(c, location);
  const local = fileLinks(c, getSourceFileOfNode(location)).localJsxFactory;
  return local ?? c.jsx.jsxFactoryEntity;
}

function getJsxFragmentFactoryEntity(c: Checker, location: Node): Node | undefined {
  const file = getSourceFileOfNode(location);
  const links = fileLinks(c, file);
  if (links.localJsxFragmentFactory !== undefined) return links.localJsxFragmentFactory;
  const pragma = getPragma(file, 'jsxfrag', 'factory');
  if (pragma !== undefined) {
    links.localJsxFragmentFactory = parseIsolatedEntityName(pragma);
    return links.localJsxFragmentFactory;
  }
  const factory = c.compilerOptions.jsxFragmentFactory;
  if (factory !== undefined && factory !== '') return parseIsolatedEntityName(factory);
  return undefined;
}

/** The module of the automatic runtime's implicit import, such as `react/jsx-runtime`. */
export function getJsxNamespaceContainerForImplicitImport(c: Checker, location: Node): Symbol | undefined {
  const file = getSourceFileOfNode(location);
  const links = fileLinks(c, file);
  const cached = links.jsxImplicitImportContainer;
  if (cached !== undefined) return cached === c.unknownSymbol ? undefined : cached;
  const specifier = c.host.getJSXRuntimeImportSpecifier(file);
  if (specifier === undefined) {
    links.jsxImplicitImportContainer = c.unknownSymbol;
    return undefined;
  }
  // A missing module is reported once, at the first JSX tag of the file, whichever tag is checked first.
  const finder = new FirstJsxTagFinder();
  file.forEachChild(finder);
  const mod = resolveExternalModule(
    c,
    specifier,
    getText(specifier),
    Diagnostics.This_JSX_tag_requires_the_module_path_0_to_exist_but_none_could_be_found_Make_sure_you_have_types_for_the_appropriate_package_installed,
    finder.tag ?? location,
    false,
    undefined,
  );
  const resolved = mod !== undefined && mod !== c.unknownSymbol ? resolveSymbol(c, mod) : undefined;
  const result = resolved !== undefined ? getMergedSymbol(c, resolved) : undefined;
  links.jsxImplicitImportContainer = result ?? c.unknownSymbol;
  return result;
}

/** The first JSX element or self-closing element of a file, or the opening tag of its first fragment. */
class FirstJsxTagFinder extends NodeVisitor {
  tag: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.JsxElement || node.kind === SyntaxKind.JsxSelfClosingElement) {
      this.tag = node;
      return true;
    }
    if (node.kind === SyntaxKind.JsxFragment) {
      this.tag = (node as JsxFragment).openingFragment;
      return true;
    }
    return node.forEachChild(this);
  }
}

/** The `JSX` namespace for `location`: the factory's, the runtime module's, or the global one. */
export function getJsxNamespaceAt(c: Checker, location: Node): Symbol | undefined {
  const links = elementLinks(c, location);
  if (links.jsxNamespace !== undefined && links.jsxNamespace !== c.unknownSymbol) return links.jsxNamespace;
  if (links.jsxNamespace !== c.unknownSymbol) {
    let resolvedNamespace = getJsxNamespaceContainerForImplicitImport(c, location);
    if (resolvedNamespace === undefined || resolvedNamespace === c.unknownSymbol) {
      const namespaceName = getJsxNamespace(c, location);
      resolvedNamespace = resolveName(c, location, namespaceName, SymbolFlags.Namespace, undefined, false, false);
    }
    if (resolvedNamespace !== undefined) {
      const container = resolveSymbol(c, resolvedNamespace)!;
      const candidate = resolveSymbol(
        c,
        getSymbolOfMeaning(c, getExportsOfSymbol(c, container), jsxNamespaceName, SymbolFlags.Namespace),
      );
      if (candidate !== undefined && candidate !== c.unknownSymbol) {
        links.jsxNamespace = candidate;
        return candidate;
      }
    }
    links.jsxNamespace = c.unknownSymbol;
  }
  const global = resolveSymbol(c, getGlobalSymbol(c, jsxNamespaceName, SymbolFlags.Namespace, undefined));
  return global === c.unknownSymbol ? undefined : global;
}

export function getJsxType(c: Checker, name: string, location: Node): Type {
  const namespace = getJsxNamespaceAt(c, location);
  if (namespace !== undefined) {
    const typeSymbol = getSymbolOfMeaning(c, getExportsOfSymbol(c, namespace), name, SymbolFlags.Type);
    if (typeSymbol !== undefined) return getDeclaredTypeOfSymbol(c, typeSymbol);
  }
  return c.errorType;
}

/** `JSX.Element`, or the error type when it doesn't exist. */
export function getJsxElementTypeAt(c: Checker, location: Node): Type {
  return getJsxType(c, jsxElementName, location);
}

function getJsxStatelessElementTypeAt(c: Checker, location: Node): Type | undefined {
  return getUnionType(c, [getJsxElementTypeAt(c, location), c.nullType]);
}

function getJsxElementClassTypeAt(c: Checker, location: Node): Type | undefined {
  const t = getJsxType(c, jsxElementClassName, location);
  return isErrorType(c, t) ? undefined : t;
}

function getJsxElementTypeTypeAt(c: Checker, location: Node): Type | undefined {
  const ns = getJsxNamespaceAt(c, location);
  if (ns === undefined) return undefined;
  const sym = getSymbolOfMeaning(c, getExportsOfSymbol(c, ns), jsxElementTypeName, SymbolFlags.Type);
  if (sym === undefined) return undefined;
  const t = instantiateAliasOrInterfaceWithDefaults(c, sym, []);
  return t === undefined || isErrorType(c, t) ? undefined : t;
}

function instantiateAliasOrInterfaceWithDefaults(
  c: Checker,
  managedSym: Symbol,
  typeArguments: Type[],
): Type | undefined {
  const declaredManagedType = getDeclaredTypeOfSymbol(c, managedSym);
  if ((managedSym.flags & SymbolFlags.TypeAlias) !== 0) {
    const params = c.symbolLinks(managedSym).typeParameters ?? [];
    if (params.length >= typeArguments.length) {
      const args = fillMissingTypeArguments(c, typeArguments, params, typeArguments.length, false);
      return args.length === 0 ? declaredManagedType : getTypeAliasInstantiation(c, managedSym, args, undefined);
    }
  }
  if ((declaredManagedType.objectFlags & ObjectFlags.ClassOrInterface) !== 0) {
    const params = getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, managedSym);
    if (params.length >= typeArguments.length) {
      const args = fillMissingTypeArguments(c, typeArguments, params, typeArguments.length, false);
      return createTypeReference(c, declaredManagedType, args);
    }
  }
  return undefined;
}

/**
 * The single property name of `JSX.ElementAttributesProperty` or `JSX.ElementChildrenAttribute`: `''` when
 * the interface is empty, `InternalSymbolName.Missing` when it doesn't exist.
 */
function getNameFromJsxElementAttributesContainer(c: Checker, containerName: string, ns: Symbol | undefined): string {
  if (ns !== undefined) {
    const sym = getSymbolOfMeaning(c, getExportsOfSymbol(c, ns), containerName, SymbolFlags.Type);
    if (sym !== undefined) {
      const props = getPropertiesOfType(c, getDeclaredTypeOfSymbol(c, sym));
      if (props.length === 0) return '';
      if (props.length === 1) return props[0]!.name;
      if (declarationCount(sym) !== 0)
        c.error(sym.declaration!, Diagnostics.The_global_type_JSX_0_may_not_have_more_than_one_property, containerName);
    }
  }
  return InternalSymbolName.Missing;
}

function getJsxElementPropertiesName(c: Checker, ns: Symbol | undefined): string {
  return getNameFromJsxElementAttributesContainer(c, jsxElementAttributesPropertyName, ns);
}

export function getJsxElementChildrenPropertyName(c: Checker, ns: Symbol | undefined): string {
  const jsx = c.compilerOptions.jsx;
  // The automatic runtime always passes children as `children`.
  if (jsx === JsxEmit.ReactJSX || jsx === JsxEmit.ReactJSXDev) return 'children';
  return getNameFromJsxElementAttributesContainer(c, jsxElementChildrenAttributeName, ns);
}

function getJsxLibraryManagedAttributes(c: Checker, ns: Symbol | undefined): Symbol | undefined {
  return ns !== undefined
    ? getSymbolOfMeaning(c, getExportsOfSymbol(c, ns), jsxLibraryManagedAttributesName, SymbolFlags.Type)
    : undefined;
}

// ---- Intrinsic elements and props types

/**
 * The `JSX.IntrinsicElements` property or index signature for an intrinsic tag, recording which in the
 * element's flags; `unknownSymbol` when neither exists.
 */
export function getIntrinsicTagSymbol(c: Checker, node: Node): Symbol {
  const links = elementLinks(c, node);
  if (links.resolvedSymbol !== undefined) return links.resolvedSymbol;
  const intrinsicElementsType = getJsxType(c, jsxIntrinsicElementsName, node);
  if (!isErrorType(c, intrinsicElementsType)) {
    const tagName = getTagNameOf(node);
    const propName = jsxNameText(tagName);
    const intrinsicProp = getPropertyOfType(c, intrinsicElementsType, propName);
    if (intrinsicProp !== undefined) {
      links.jsxFlags |= JsxFlags.IntrinsicNamedElement;
      links.resolvedSymbol = intrinsicProp;
      return intrinsicProp;
    }
    const info = getApplicableIndexInfo(c, intrinsicElementsType, getStringLiteralType(c, propName));
    if (
      (info !== undefined && info !== c.anyBaseTypeIndexInfo) ||
      getApplicableIndexInfoForName(c, intrinsicElementsType, propName) !== undefined
    ) {
      links.jsxFlags |= JsxFlags.IntrinsicIndexedElement;
      links.resolvedSymbol = intrinsicElementsType.symbol ?? c.unknownSymbol;
      return links.resolvedSymbol;
    }
    c.error(node, Diagnostics.Property_0_does_not_exist_on_type_1, propName, 'JSX.' + jsxIntrinsicElementsName);
    links.resolvedSymbol = c.unknownSymbol;
    return c.unknownSymbol;
  }
  if (c.noImplicitAny)
    c.error(
      node,
      Diagnostics.JSX_element_implicitly_has_type_any_because_no_interface_JSX_0_exists,
      jsxIntrinsicElementsName,
    );
  links.resolvedSymbol = c.unknownSymbol;
  return c.unknownSymbol;
}

/** The props type of an intrinsic element. */
function getIntrinsicAttributesTypeFromJsxOpeningLikeElement(c: Checker, node: Node): Type {
  const links = elementLinks(c, node);
  if (links.resolvedJsxElementAttributesType !== undefined) return links.resolvedJsxElementAttributesType;
  const symbol = getIntrinsicTagSymbol(c, node);
  let result: Type = c.errorType;
  if ((links.jsxFlags & JsxFlags.IntrinsicNamedElement) !== 0) result = getTypeOfSymbol(c, symbol);
  else if ((links.jsxFlags & JsxFlags.IntrinsicIndexedElement) !== 0) {
    const info = getApplicableIndexInfoForName(
      c,
      getJsxType(c, jsxIntrinsicElementsName, node),
      jsxNameText(getTagNameOf(node)),
    );
    if (info !== undefined) result = info.valueType;
  }
  links.resolvedJsxElementAttributesType = result;
  return result;
}

function getIntrinsicAttributesTypeFromStringLiteralType(c: Checker, t: Type, location: Node): Type | undefined {
  const intrinsicElementsType = getJsxType(c, jsxIntrinsicElementsName, location);
  if (isErrorType(c, intrinsicElementsType)) return c.anyType;
  const name = (t as LiteralType).stringValue;
  const intrinsicProp = getPropertyOfType(c, intrinsicElementsType, name);
  if (intrinsicProp !== undefined) return getTypeOfSymbol(c, intrinsicProp);
  return getIndexTypeOfType(c, intrinsicElementsType, c.stringType);
}

/** A `(props: result) => JSX.Element` signature for an intrinsic element. */
function createSignatureForJSXIntrinsic(c: Checker, node: Node, result: Type): Signature {
  return newJsxIntrinsicSignature(c, result, getJsxElementTypeForIntrinsic(c, node));
}

/** The return type of createSignatureForJSXIntrinsic: `JSX.Element` at `node`, or the error type. */
function getJsxElementTypeForIntrinsic(c: Checker, node: Node): Type {
  let elementType: Type = c.errorType;
  const namespace = getJsxNamespaceAt(c, node);
  if (namespace !== undefined) {
    const typeSymbol = getSymbolOfMeaning(c, getExportsOfSymbol(c, namespace), jsxElementName, SymbolFlags.Type);
    if (typeSymbol !== undefined) elementType = getDeclaredTypeOfSymbol(c, typeSymbol);
  }
  return elementType;
}

function newJsxIntrinsicSignature(c: Checker, result: Type, elementType: Type): Signature {
  const parameterSymbol = c.newSymbol(SymbolFlags.FunctionScopedVariable, 'props');
  c.symbolTypes.set(getSymbolId(parameterSymbol), result);
  return c.newSignature(SignatureFlags.None, undefined, [], undefined, [parameterSymbol], elementType, 1);
}

/**
 * `getOrCreateTypeFromSignature(createSignatureForJSXIntrinsic(node, result))`, the type that
 * getStaticTypeOfReferencedJsxConstructor gives an intrinsic element: `new (props: result) =>
 * JSX.Element`. tsgo creates a new one for every element, which makes each element's
 * `LibraryManagedAttributes<C, P>` a new instantiation; it is a function of the two types, so one is
 * kept per pair.
 */
function getJsxIntrinsicConstructorType(c: Checker, node: Node, result: Type): Type {
  const elementType = getJsxElementTypeForIntrinsic(c, node);
  const key = result.id + ',' + elementType.id;
  let t = c.jsx.intrinsicConstructorTypes.get(key);
  if (t === undefined) {
    t = getOrCreateTypeFromSignature(c, newJsxIntrinsicSignature(c, result, elementType));
    c.jsx.intrinsicConstructorTypes.set(key, t);
  }
  return t;
}

function getJsxReferenceKind(c: Checker, node: Node): JsxReferenceKind {
  const tagName = getTagNameOf(node);
  if (isJsxIntrinsicTagName(tagName)) return JsxReferenceKind.Mixed;
  const tagType = getApparentType(c, checkExpression(c, tagName));
  if (getSignaturesOfType(c, tagType, SignatureKind.Construct).length !== 0) return JsxReferenceKind.Component;
  if (getSignaturesOfType(c, tagType, SignatureKind.Call).length !== 0) return JsxReferenceKind.Function;
  return JsxReferenceKind.Mixed;
}

function getUninstantiatedJsxSignaturesOfType(c: Checker, elementType: Type, caller: Node): Signature[] {
  if ((elementType.flags & TypeFlags.String) !== 0) return [c.anySignature];
  if ((elementType.flags & TypeFlags.StringLiteral) !== 0) {
    const intrinsicType = getIntrinsicAttributesTypeFromStringLiteralType(c, elementType, caller);
    if (intrinsicType === undefined) {
      c.error(
        caller,
        Diagnostics.Property_0_does_not_exist_on_type_1,
        (elementType as LiteralType).stringValue,
        'JSX.' + jsxIntrinsicElementsName,
      );
      return [];
    }
    return [createSignatureForJSXIntrinsic(c, caller, intrinsicType)];
  }
  const apparentElemType = getApparentType(c, elementType);
  // Prefer construct signatures.
  let signatures = getSignaturesOfType(c, apparentElemType, SignatureKind.Construct);
  if (signatures.length === 0) signatures = getSignaturesOfType(c, apparentElemType, SignatureKind.Call);
  if (signatures.length === 0 && (apparentElemType.flags & TypeFlags.Union) !== 0) {
    const lists: Signature[][] = [];
    for (const t of typesOf(apparentElemType)) lists.push(getUninstantiatedJsxSignaturesOfType(c, t, caller));
    signatures = getUnionSignatures(c, lists);
  }
  return signatures;
}

function getTypeOfFirstParameterOfSignatureWithFallback(c: Checker, sig: Signature, fallback: Type): Type {
  return sig.parameters.length > 0 ? getTypeAtPosition(c, sig, 0) : fallback;
}

/** The props type a signature expects of an element's attributes. */
export function getEffectiveFirstArgumentForJsxSignature(c: Checker, signature: Signature, node: Node): Type {
  if (node.kind === SyntaxKind.JsxOpeningFragment || getJsxReferenceKind(c, node) !== JsxReferenceKind.Component)
    return getJsxPropsTypeFromCallSignature(c, signature, node);
  return getJsxPropsTypeFromClassType(c, signature, node);
}

function getJsxPropsTypeFromCallSignature(c: Checker, sig: Signature, context: Node): Type {
  let propsType = getTypeOfFirstParameterOfSignatureWithFallback(c, sig, c.unknownType);
  propsType = getJsxManagedAttributesFromLocatedAttributes(c, context, getJsxNamespaceAt(c, context), propsType);
  const intrinsicAttribs = getJsxType(c, jsxIntrinsicAttributesName, context);
  if (!isErrorType(c, intrinsicAttribs)) propsType = intersectTypes(c, intrinsicAttribs, propsType)!;
  return propsType;
}

function getJsxPropsTypeFromClassType(c: Checker, sig: Signature, context: Node): Type {
  const ns = getJsxNamespaceAt(c, context);
  const forcedLookupLocation = getJsxElementPropertiesName(c, ns);
  let attributesType: Type | undefined;
  if (forcedLookupLocation === InternalSymbolName.Missing)
    attributesType = getTypeOfFirstParameterOfSignatureWithFallback(c, sig, c.unknownType);
  else if (forcedLookupLocation === '') attributesType = getReturnTypeOfSignature(c, sig);
  else {
    attributesType = getJsxPropsTypeForSignatureFromMember(c, sig, forcedLookupLocation);
    if (attributesType === undefined && getAttributesOf(context).properties.nodes.length !== 0)
      c.error(
        context,
        Diagnostics.JSX_element_class_does_not_support_attributes_because_it_does_not_have_a_0_property,
        forcedLookupLocation,
      );
  }
  if (attributesType === undefined) return c.unknownType;
  attributesType = getJsxManagedAttributesFromLocatedAttributes(c, context, ns, attributesType);
  if ((attributesType.flags & TypeFlags.Any) !== 0) return attributesType;
  let apparentAttributesType = attributesType;
  const intrinsicClassAttribs = getJsxType(c, jsxIntrinsicClassAttributesName, context);
  if (!isErrorType(c, intrinsicClassAttribs)) {
    const typeParams = getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, intrinsicClassAttribs.symbol!);
    const hostClassType = getReturnTypeOfSignature(c, sig);
    let libraryManagedAttributeType = intrinsicClassAttribs;
    if (typeParams.length !== 0) {
      const inferredArgs = fillMissingTypeArguments(
        c,
        [hostClassType],
        typeParams,
        getMinTypeArgumentCount(c, typeParams),
        false,
      );
      libraryManagedAttributeType = instantiateType(c, intrinsicClassAttribs, newTypeMapper(typeParams, inferredArgs));
    }
    apparentAttributesType = intersectTypes(c, libraryManagedAttributeType, apparentAttributesType)!;
  }
  const intrinsicAttribs = getJsxType(c, jsxIntrinsicAttributesName, context);
  if (!isErrorType(c, intrinsicAttribs))
    apparentAttributesType = intersectTypes(c, intrinsicAttribs, apparentAttributesType)!;
  return apparentAttributesType;
}

function getJsxPropsTypeForSignatureFromMember(c: Checker, sig: Signature, name: string): Type | undefined {
  if (sig.composite !== undefined) {
    // `props` of a union or intersection signature is an input: intersect the members' instance props.
    const results: Type[] = [];
    for (const signature of sig.composite.signatures) {
      const instance = getReturnTypeOfSignature(c, signature);
      if ((instance.flags & TypeFlags.Any) !== 0) return instance;
      const propType = getTypeOfPropertyOfType(c, instance, name);
      if (propType === undefined) return undefined;
      results.push(propType);
    }
    return getIntersectionType(c, results);
  }
  const instanceType = getReturnTypeOfSignature(c, sig);
  if ((instanceType.flags & TypeFlags.Any) !== 0) return instanceType;
  return getTypeOfPropertyOfType(c, instanceType, name);
}

function getJsxManagedAttributesFromLocatedAttributes(
  c: Checker,
  context: Node,
  ns: Symbol | undefined,
  attributesType: Type,
): Type {
  const managedSym = getJsxLibraryManagedAttributes(c, ns);
  if (managedSym !== undefined) {
    const ctorType = getStaticTypeOfReferencedJsxConstructor(c, context);
    const result = instantiateAliasOrInterfaceWithDefaults(c, managedSym, [ctorType, attributesType]);
    if (result !== undefined) return result;
  }
  return attributesType;
}

function getStaticTypeOfReferencedJsxConstructor(c: Checker, context: Node): Type {
  if (context.kind === SyntaxKind.JsxOpeningFragment) return getJSXFragmentType(c, context);
  const tagName = getTagNameOf(context);
  if (isJsxIntrinsicTagName(tagName)) {
    const result = getIntrinsicAttributesTypeFromJsxOpeningLikeElement(c, context);
    return getJsxIntrinsicConstructorType(c, context, result);
  }
  const tagType = checkExpressionCached(c, tagName);
  if ((tagType.flags & TypeFlags.StringLiteral) !== 0) {
    const result = getIntrinsicAttributesTypeFromStringLiteralType(c, tagType, context);
    if (result === undefined) return c.errorType;
    return getJsxIntrinsicConstructorType(c, context, result);
  }
  return tagType;
}

/** The type of the fragment factory, such as `React.Fragment`. */
function getJSXFragmentType(c: Checker, node: Node): Type {
  const links = fileLinks(c, getSourceFileOfNode(node));
  if (links.jsxFragmentType !== undefined) return links.jsxFragmentType;
  const jsxFragmentFactoryName = getJsxNamespace(c, node);
  // `null` is allowed as the fragment factory.
  const shouldResolveFactoryReference =
    (c.compilerOptions.jsx === JsxEmit.React ||
      (c.compilerOptions.jsxFragmentFactory !== undefined && c.compilerOptions.jsxFragmentFactory !== '')) &&
    jsxFragmentFactoryName !== 'null';
  if (!shouldResolveFactoryReference) {
    links.jsxFragmentType = c.anyType;
    return c.anyType;
  }
  let jsxFactorySymbol = getJsxNamespaceContainerForImplicitImport(c, node);
  if (jsxFactorySymbol === undefined) {
    const shouldModuleRefErr =
      c.compilerOptions.jsx !== JsxEmit.Preserve && c.compilerOptions.jsx !== JsxEmit.ReactNative;
    let flags = SymbolFlags.Value;
    if (!shouldModuleRefErr) flags &= ~SymbolFlags.Enum;
    jsxFactorySymbol = resolveName(
      c,
      node,
      jsxFragmentFactoryName,
      flags,
      Diagnostics.Using_JSX_fragments_requires_fragment_factory_0_to_be_in_scope_but_it_could_not_be_found,
      true,
      false,
    );
  }
  if (jsxFactorySymbol === undefined) {
    links.jsxFragmentType = c.errorType;
    return c.errorType;
  }
  if (jsxFactorySymbol.name === 'Fragment') {
    links.jsxFragmentType = getTypeOfSymbol(c, jsxFactorySymbol);
    return links.jsxFragmentType;
  }
  const resolvedAlias =
    (jsxFactorySymbol.flags & SymbolFlags.Alias) !== 0 ? resolveAlias(c, jsxFactorySymbol) : jsxFactorySymbol;
  const typeSymbol = getSymbolOfMeaning(
    c,
    getExportsOfSymbol(c, resolvedAlias),
    'Fragment',
    SymbolFlags.BlockScopedVariable,
  );
  links.jsxFragmentType = typeSymbol !== undefined ? getTypeOfSymbol(c, typeSymbol) : c.errorType;
  return links.jsxFragmentType;
}

// ---- Attributes and children

export function checkJsxAttribute(c: Checker, node: Node, checkMode: CheckMode): Type {
  const initializer = (node as JsxAttribute).initializer;
  // `<Elem attr />` is `<Elem attr={true} />`.
  return initializer !== undefined ? checkExpressionForMutableLocationEx(c, initializer, checkMode) : c.trueType;
}

export function checkJsxChildren(c: Checker, node: Node, checkMode: CheckMode): Type[] {
  const childTypes: Type[] = [];
  for (const child of getChildrenOf(node)) {
    // Whitespace-only text isn't a child in React.
    if (child.kind === SyntaxKind.JsxText) {
      if (!(child as JsxText).containsOnlyTriviaWhiteSpaces) childTypes.push(c.stringType);
    } else if (child.kind === SyntaxKind.JsxExpression && (child as JsxExpression).expression === undefined) continue;
    else childTypes.push(checkExpressionForMutableLocationEx(c, child, checkMode));
  }
  return childTypes;
}

function parentHasSemanticJsxChildren(openingLikeElement: Node): boolean {
  const parent = openingLikeElement.parent;
  if (parent === undefined) return false;
  if (parent.kind === SyntaxKind.JsxElement && (parent as JsxElement).openingElement === openingLikeElement)
    return getSemanticJsxChildren((parent as JsxElement).children.nodes).length !== 0;
  if (parent.kind === SyntaxKind.JsxFragment && (parent as JsxFragment).openingFragment === openingLikeElement)
    return getSemanticJsxChildren((parent as JsxFragment).children.nodes).length !== 0;
  return false;
}

function createJsxAttributesType(
  c: Checker,
  symbol: Symbol | undefined,
  table: SymbolTable,
  objectFlags: ObjectFlags,
): Type {
  const result = createAnonymousType(c, symbol, table, [], [], []);
  result.objectFlags |=
    objectFlags | ObjectFlags.FreshLiteral | ObjectFlags.ObjectLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
  return result;
}

/** The object type of an element's attributes and children, like an object literal's. */
export function createJsxAttributesTypeFromAttributesProperty(
  c: Checker,
  openingLikeElement: Node,
  checkMode: CheckMode,
): Type {
  const allAttributesTable: SymbolTable | undefined = c.strictNullChecks ? new Map<string, Symbol>() : undefined;
  let attributesTable: SymbolTable = new Map<string, Symbol>();
  let attributesSymbol: Symbol | undefined = undefined;
  let attributeParent = openingLikeElement;
  let spread: Type = c.emptyJsxObjectType;
  let hasSpreadAnyType = false;
  let typeToIntersect: Type | undefined = undefined;
  let explicitlySpecifyChildrenAttribute = false;
  let objectFlags = ObjectFlags.JsxAttributes;
  const jsxChildrenPropertyName = getJsxElementChildrenPropertyName(c, getJsxNamespaceAt(c, openingLikeElement));
  if (openingLikeElement.kind !== SyntaxKind.JsxOpeningFragment) {
    const attributes = getAttributesOf(openingLikeElement);
    attributesSymbol = attributes.symbol;
    attributeParent = attributes;
    const contextualType = getContextualType(c, attributes);
    for (const attributeDecl of attributes.properties.nodes) {
      if (attributeDecl.kind === SyntaxKind.JsxAttribute) {
        const member = getSymbol(attributeDecl)!;
        const exprType = checkJsxAttribute(c, attributeDecl, checkMode);
        objectFlags |= exprType.objectFlags & ObjectFlags.PropagatingFlags;
        const attributeSymbol = c.newSymbol(SymbolFlags.Property | member.flags, member.name);
        copyDeclarations(attributeSymbol, member);
        attributeSymbol.parent = member.parent;
        if (member.valueDeclaration !== undefined) attributeSymbol.valueDeclaration = member.valueDeclaration;
        const id = getSymbolId(attributeSymbol);
        c.symbolTypes.set(id, exprType);
        c.symbolTargets.set(id, member);
        attributesTable.set(attributeSymbol.name, attributeSymbol);
        if (allAttributesTable !== undefined) allAttributesTable.set(attributeSymbol.name, attributeSymbol);
        if (jsxNameText((attributeDecl as JsxAttribute).name) === jsxChildrenPropertyName)
          explicitlySpecifyChildrenAttribute = true;
        if (
          contextualType !== undefined &&
          (checkMode & CheckMode.Inferential) !== 0 &&
          (checkMode & CheckMode.SkipContextSensitive) === 0 &&
          isContextSensitive(c, attributeDecl)
        ) {
          // Inferences flowing between context-sensitive attributes are made before fixing.
          const inferenceContext = getInferenceContext(c, attributes);
          const initializer = (attributeDecl as JsxAttribute).initializer;
          if (inferenceContext !== undefined && initializer !== undefined)
            addIntraExpressionInferenceSite(inferenceContext, getExpression(initializer)!, exprType);
        }
      } else {
        if (attributesTable.size !== 0) {
          // Attribute objects are fresh, and so are spreads after the first one.
          objectFlags |= ObjectFlags.FreshLiteral;
          spread = getSpreadType(
            c,
            spread,
            createJsxAttributesType(c, attributesSymbol, attributesTable, objectFlags),
            attributesSymbol,
            objectFlags,
            false,
          );
          attributesTable = new Map<string, Symbol>();
        }
        const expression = (attributeDecl as JsxSpreadAttribute).expression;
        const exprType = getReducedType(c, checkExpressionEx(c, expression, checkMode & CheckMode.Inferential));
        if ((exprType.flags & TypeFlags.Any) !== 0) hasSpreadAnyType = true;
        if (isValidSpreadType(c, exprType)) {
          spread = getSpreadType(c, spread, exprType, attributesSymbol, objectFlags, false);
          if (allAttributesTable !== undefined)
            checkSpreadPropOverrides(c, exprType, allAttributesTable, attributeDecl);
        } else {
          c.error(expression, Diagnostics.Spread_types_may_only_be_created_from_object_types);
          typeToIntersect =
            typeToIntersect !== undefined ? getIntersectionType(c, [typeToIntersect, exprType]) : exprType;
        }
      }
    }
    if (!hasSpreadAnyType && attributesTable.size !== 0) {
      objectFlags |= ObjectFlags.FreshLiteral;
      spread = getSpreadType(
        c,
        spread,
        createJsxAttributesType(c, attributesSymbol, attributesTable, objectFlags),
        attributesSymbol,
        objectFlags,
        false,
      );
    }
  }
  if (parentHasSemanticJsxChildren(openingLikeElement)) {
    const childTypes = checkJsxChildren(c, openingLikeElement.parent!, checkMode);
    if (!hasSpreadAnyType && jsxChildrenPropertyName !== InternalSymbolName.Missing && jsxChildrenPropertyName !== '') {
      // Children overwrite a `children` attribute; one from a spread isn't reported.
      if (explicitlySpecifyChildrenAttribute)
        c.error(
          attributeParent,
          Diagnostics.X_0_are_specified_twice_The_attribute_named_0_will_be_overwritten,
          jsxChildrenPropertyName,
        );
      let childrenContextualType: Type | undefined = undefined;
      if (openingLikeElement.kind === SyntaxKind.JsxOpeningElement) {
        const contextualType = getApparentTypeOfContextualType(c, getAttributesOf(openingLikeElement));
        if (contextualType !== undefined)
          childrenContextualType = getTypeOfPropertyOfContextualType(c, contextualType, jsxChildrenPropertyName);
      }
      const childrenPropSymbol = c.newSymbol(SymbolFlags.Property, jsxChildrenPropertyName);
      const id = getSymbolId(childrenPropSymbol);
      if (childTypes.length === 1) c.symbolTypes.set(id, childTypes[0]!);
      else if (childrenContextualType !== undefined && someType(childrenContextualType, (t) => isTupleLikeType(c, t)))
        c.symbolTypes.set(id, createTupleType(c, childTypes));
      else c.symbolTypes.set(id, createArrayType(c, getUnionType(c, childTypes)));
      // A property signature in the attributes declares the synthetic `children` property, so it is
      // checked as an excess property like the attributes.
      const childrenDeclaration = new PropertySignatureDeclaration(
        undefined,
        new Identifier(jsxChildrenPropertyName),
        undefined,
        undefined,
        undefined,
      );
      childrenDeclaration.parent = attributeParent;
      childrenDeclaration.symbol = childrenPropSymbol;
      childrenPropSymbol.valueDeclaration = childrenDeclaration;
      const childPropMap: SymbolTable = new Map<string, Symbol>();
      childPropMap.set(jsxChildrenPropertyName, childrenPropSymbol);
      spread = getSpreadType(
        c,
        spread,
        createAnonymousType(c, attributesSymbol, childPropMap, [], [], []),
        attributesSymbol,
        objectFlags | getPropagatingFlagsOfTypes(childTypes, TypeFlags.None),
        false,
      );
    }
  }
  if (hasSpreadAnyType) return c.anyType;
  if (typeToIntersect !== undefined)
    return spread !== c.emptyJsxObjectType ? getIntersectionType(c, [typeToIntersect, spread]) : typeToIntersect;
  if (spread === c.emptyJsxObjectType)
    return createJsxAttributesType(c, attributesSymbol, attributesTable, objectFlags);
  return spread;
}

export function isTupleLikeType(c: Checker, t: Type): boolean {
  if (isTupleType(t) || getPropertyOfType(c, t, '0') !== undefined) return true;
  if (isArrayLikeType(c, t)) {
    const lengthType = getTypeOfPropertyOfType(c, t, 'length');
    if (lengthType !== undefined) return everyType(lengthType, (u) => (u.flags & TypeFlags.NumberLiteral) !== 0);
  }
  return false;
}

export function isArrayOrTupleLikeType(c: Checker, t: Type): boolean {
  return isArrayLikeType(c, t) || isTupleLikeType(c, t);
}

// ---- Signature resolution

/** The attributes argument of an element, if it has attributes or children. */
export function getEffectiveJsxArguments(node: Node): Node[] {
  const attributes = getAttributesOf(node);
  if (
    attributes.properties.nodes.length !== 0 ||
    (node.kind === SyntaxKind.JsxOpeningElement && (node.parent as JsxElement).children.nodes.length !== 0)
  )
    return [attributes];
  return [];
}

/** Whether `signature` accepts the element's attributes, reporting why not when `reportErrors`. */
export function checkApplicableSignatureForJsxCallLikeElement(
  c: Checker,
  node: Node,
  signature: Signature,
  relation: Relation,
  checkMode: CheckMode,
  reportErrors: boolean,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  // Function components get props, context and an updater; only props come from attributes.
  const paramType = getEffectiveFirstArgumentForJsxSignature(c, signature, node);
  const attributesType =
    node.kind === SyntaxKind.JsxOpeningFragment
      ? createJsxAttributesTypeFromAttributesProperty(c, node, CheckMode.Normal)
      : checkExpressionWithContextualType(c, getAttributesOf(node), paramType, undefined, checkMode);
  const checkAttributesType =
    (checkMode & CheckMode.SkipContextSensitive) !== 0
      ? getRegularTypeOfObjectLiteral(c, attributesType)
      : attributesType;
  if (!checkTagNameDoesNotExpectTooManyArguments(c, node, reportErrors, diagnosticOutput)) return false;
  const errorNode = reportErrors
    ? node.kind === SyntaxKind.JsxOpeningFragment
      ? node
      : getTagNameOf(node)
    : undefined;
  const attributes = node.kind === SyntaxKind.JsxOpeningFragment ? undefined : getAttributesOf(node);
  return checkTypeRelatedToAndOptionallyElaborate(
    c,
    checkAttributesType,
    paramType,
    relation,
    errorNode,
    attributes,
    undefined,
    diagnosticOutput,
  );
}

/** Whether a function component's required parameters fit what the factory passes it. */
function checkTagNameDoesNotExpectTooManyArguments(
  c: Checker,
  node: Node,
  reportErrors: boolean,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  // The automatic runtime's factories aren't looked at.
  if (getJsxNamespaceContainerForImplicitImport(c, node) !== undefined) return true;
  if (node.kind === SyntaxKind.JsxOpeningFragment) return true;
  const tagName = getTagNameOf(node);
  if (isJsxIntrinsicTagName(tagName)) return true;
  const tagType = checkExpression(c, tagName);
  const tagCallSignatures = getSignaturesOfType(c, tagType, SignatureKind.Call);
  if (tagCallSignatures.length === 0) return true;
  const factory = getJsxFactoryEntity(c, node);
  if (factory === undefined) return true;
  const factorySymbol = resolveEntityName(c, factory, SymbolFlags.Value, true, false, node);
  if (factorySymbol === undefined) return true;
  const callSignatures = getSignaturesOfType(c, getTypeOfSymbol(c, factorySymbol), SignatureKind.Call);
  if (callSignatures.length === 0) return true;
  let hasFirstParamSignatures = false;
  let maxParamCount = 0;
  // Some first parameter must expect a function component that takes the element's arguments.
  for (const sig of callSignatures) {
    const firstParam = getTypeAtPosition(c, sig, 0);
    for (const paramSig of getSignaturesOfType(c, firstParam, SignatureKind.Call)) {
      hasFirstParamSignatures = true;
      if (hasEffectiveRestParameter(c, paramSig)) return true;
      maxParamCount = Math.max(maxParamCount, getParameterCount(c, paramSig));
    }
  }
  // Generic factories have no signatures to look at.
  if (!hasFirstParamSignatures) return true;
  let absoluteMinArgCount = Number.MAX_SAFE_INTEGER;
  for (const tagSig of tagCallSignatures)
    absoluteMinArgCount = Math.min(absoluteMinArgCount, getMinArgumentCount(c, tagSig));
  if (absoluteMinArgCount <= maxParamCount) return true;
  if (reportErrors) {
    const diagnostic = createDiagnosticForNode(
      tagName,
      Diagnostics.Tag_0_expects_at_least_1_arguments_but_the_JSX_factory_2_provides_at_most_3,
      [entityNameToString(tagName), String(absoluteMinArgCount), entityNameToString(factory), String(maxParamCount)],
    );
    const tagNameSymbol = getSymbolOfTagName(c, tagName);
    if (tagNameSymbol !== undefined && tagNameSymbol.valueDeclaration !== undefined)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(tagNameSymbol.valueDeclaration, Diagnostics.X_0_is_declared_here, [
          entityNameToString(tagName),
        ]),
      );
    reportDiagnostic(c, diagnostic, diagnosticOutput);
  }
  return false;
}

function getSymbolOfTagName(c: Checker, tagName: Node): Symbol | undefined {
  if (tagName.kind === SyntaxKind.Identifier || tagName.kind === SyntaxKind.PropertyAccessExpression)
    return resolveEntityName(c, tagName, SymbolFlags.Value, true, false, undefined);
  return undefined;
}

function reportDiagnostic(c: Checker, diagnostic: Diagnostic, output: Diagnostic[] | undefined): void {
  if (output !== undefined) output.push(diagnostic);
  else c.addDiagnostic(diagnostic);
}

export function resolveJsxOpeningLikeElement(c: Checker, node: Node, checkMode: CheckMode): Signature {
  const isJsxOpenFragment = node.kind === SyntaxKind.JsxOpeningFragment;
  let exprTypes: Type;
  if (!isJsxOpenFragment) {
    const tagName = getTagNameOf(node);
    if (isJsxIntrinsicTagName(tagName)) {
      const result = getIntrinsicAttributesTypeFromJsxOpeningLikeElement(c, node);
      const fakeSignature = createSignatureForJSXIntrinsic(c, node, result);
      const attributes = getAttributesOf(node);
      checkTypeAssignableToAndOptionallyElaborateJsx(
        c,
        checkExpressionWithContextualType(
          c,
          attributes,
          getEffectiveFirstArgumentForJsxSignature(c, fakeSignature, node),
          undefined,
          CheckMode.Normal,
        ),
        result,
        tagName,
        attributes,
      );
      const typeArguments = getTypeArgumentListOf(node);
      if (typeArguments !== undefined && typeArguments.nodes.length !== 0) {
        for (const t of typeArguments.nodes) checkSourceElement(c, t);
        const file = getSourceFileOfNode(node);
        c.addDiagnostic(
          new Diagnostic(
            file.diagnosticFile(),
            skipTrivia(file.text, typeArguments.pos),
            typeArguments.end,
            Diagnostics.Expected_0_type_arguments_but_got_1,
            ['0', String(typeArguments.nodes.length)],
          ),
        );
      }
      return fakeSignature;
    }
    exprTypes = checkExpression(c, tagName);
  } else exprTypes = getJSXFragmentType(c, node);
  const apparentType = getApparentType(c, exprTypes);
  if (isErrorType(c, apparentType)) return resolveErrorCall(c, node);
  const signatures = getUninstantiatedJsxSignaturesOfType(c, exprTypes, node);
  if (isUntypedFunctionCall(c, exprTypes, apparentType, signatures.length)) return resolveUntypedCall(c, node);
  if (signatures.length === 0) {
    const errorNode = isJsxOpenFragment ? node : getTagNameOf(node);
    c.error(
      errorNode,
      Diagnostics.JSX_element_type_0_does_not_have_any_construct_or_call_signatures,
      getTextOfNode(errorNode),
    );
    return resolveErrorCall(c, node);
  }
  return resolveCall(c, node, signatures, checkMode, SignatureFlags.None, undefined);
}

function checkTypeAssignableToAndOptionallyElaborateJsx(
  c: Checker,
  source: Type,
  target: Type,
  errorNode: Node,
  expr: Node,
): boolean {
  return checkTypeRelatedToAndOptionallyElaborate(
    c,
    source,
    target,
    c.assignableRelation,
    errorNode,
    expr,
    undefined,
    undefined,
  );
}

function isUntypedFunctionCall(c: Checker, funcType: Type, apparentFuncType: Type, numCallSignatures: number): boolean {
  if ((funcType.flags & TypeFlags.Any) !== 0) return true;
  if ((apparentFuncType.flags & TypeFlags.Any) !== 0) return true;
  if ((funcType.flags & TypeFlags.TypeParameter) !== 0) return false;
  return (
    numCallSignatures === 0 &&
    (apparentFuncType.flags & TypeFlags.Union) === 0 &&
    (getReducedType(c, apparentFuncType).flags & TypeFlags.Never) === 0 &&
    isTypeAssignableTo(c, funcType, c.globalFunctionType)
  );
}

function resolveUntypedCall(c: Checker, node: Node): Signature {
  if (node.kind !== SyntaxKind.JsxOpeningFragment) {
    // Type arguments are checked even though an untyped element can't accept them: they get their
    // diagnostics and mark what they reference as used.
    const typeArguments = getTypeArgumentListOf(node);
    if (typeArguments !== undefined) for (const t of typeArguments.nodes) checkSourceElement(c, t);
    checkExpression(c, getAttributesOf(node));
  }
  return c.anySignature;
}

function resolveErrorCall(c: Checker, node: Node): Signature {
  resolveUntypedCall(c, node);
  return c.unknownSignature;
}

/** The signature an element resolves to, computed once. */
export function getResolvedJsxSignature(c: Checker, node: Node): Signature {
  return getResolvedSignature(c, node, CheckMode.Normal);
}

/** Infers a generic component's type arguments from the element's attributes. */
export function inferJsxTypeArguments(
  c: Checker,
  node: Node,
  signature: Signature,
  checkMode: CheckMode,
  context: InferenceContext,
): Type[] {
  const paramType = getEffectiveFirstArgumentForJsxSignature(c, signature, node);
  const checkAttrType = checkExpressionWithContextualType(c, getAttributesOf(node), paramType, context, checkMode);
  inferTypes(c, context.inferences, checkAttrType, paramType, InferencePriority.None, false);
  return getInferredTypes(c, context);
}

// ---- Checking

/** Checks a JSX expression, element, fragment or attributes node. */
export function checkJsx(c: Checker, node: Node, checkMode: CheckMode): Type {
  switch (node.kind) {
    case SyntaxKind.JsxExpression:
      return checkJsxExpression(c, node as JsxExpression, checkMode);
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement: {
      checkNodeDeferred(c, node);
      return getJsxElementTypeAt(c, node);
    }
    case SyntaxKind.JsxFragment:
      return checkJsxFragment(c, node as JsxFragment);
    case SyntaxKind.JsxAttributes:
      checkNodeDeferred(c, node);
      return createJsxAttributesTypeFromAttributesProperty(c, node.parent!, checkMode);
  }
  return c.errorType;
}

function checkJsxExpression(c: Checker, node: JsxExpression, checkMode: CheckMode): Type {
  checkGrammarJsxExpression(c, node);
  if (node.expression === undefined) return c.errorType;
  const t = checkExpressionEx(c, node.expression, checkMode);
  if (node.dotDotDotToken !== undefined && t !== c.anyType && !isArrayType(c, t))
    c.error(node, Diagnostics.JSX_spread_child_must_be_an_array_type);
  return t;
}

function checkJsxFragment(c: Checker, node: JsxFragment): Type {
  checkJsxOpeningLikeElementOrOpeningFragment(c, node.openingFragment);
  // With a custom factory, fragments need a fragment factory too.
  const file = getSourceFileOfNode(node);
  const options = c.compilerOptions;
  const hasFactory = options.jsxFactory !== undefined && options.jsxFactory !== '';
  const hasFragmentFactory = options.jsxFragmentFactory !== undefined && options.jsxFragmentFactory !== '';
  if (
    isJsxTransformEnabled(c) &&
    (hasFactory || getPragma(file, 'jsx', 'factory') !== undefined) &&
    !hasFragmentFactory &&
    getPragma(file, 'jsxfrag', 'factory') === undefined
  )
    c.error(
      node,
      hasFactory
        ? Diagnostics.The_jsxFragmentFactory_compiler_option_must_be_provided_to_use_JSX_fragments_with_the_jsxFactory_compiler_option
        : Diagnostics.An_jsxFrag_pragma_is_required_when_using_an_jsx_pragma_with_JSX_fragments,
    );
  checkJsxChildren(c, node, CheckMode.Normal);
  const t = getJsxElementTypeAt(c, node);
  return isErrorType(c, t) ? c.anyType : t;
}

/** The deferred check of an element: its signature, closing tag and children. */
export function checkJsxElementDeferred(c: Checker, node: Node): void {
  if (node.kind === SyntaxKind.JsxSelfClosingElement) {
    checkJsxOpeningLikeElementOrOpeningFragment(c, node);
    return;
  }
  const element = node as JsxElement;
  checkJsxOpeningLikeElementOrOpeningFragment(c, element.openingElement);
  const closingTagName = element.closingElement.tagName;
  if (isJsxIntrinsicTagName(closingTagName)) getIntrinsicTagSymbol(c, element.closingElement);
  else checkExpression(c, closingTagName);
  checkJsxChildren(c, node, CheckMode.Normal);
}

function checkJsxOpeningLikeElementOrOpeningFragment(c: Checker, node: Node): void {
  const isNodeOpeningLikeElement = isJsxOpeningLikeElement(node);
  if (isNodeOpeningLikeElement) checkGrammarJsxElement(c, node);
  checkJsxPreconditions(c, node);
  markJsxAliasReferenced(c, node);
  const sig = getResolvedJsxSignature(c, node);
  checkDeprecatedSignature(c, sig, node);
  if (!isNodeOpeningLikeElement) return;
  const elementTypeConstraint = getJsxElementTypeTypeAt(c, node);
  if (elementTypeConstraint !== undefined) {
    const tagName = getTagNameOf(node);
    const tagType = isJsxIntrinsicTagName(tagName)
      ? getStringLiteralType(c, jsxNameText(tagName))
      : checkExpression(c, tagName);
    const diagnostics: Diagnostic[] = [];
    if (
      !checkTypeRelatedTo(
        c,
        tagType,
        elementTypeConstraint,
        c.assignableRelation,
        tagName,
        Diagnostics.Its_type_0_is_not_a_valid_JSX_element_type,
        diagnostics,
      )
    )
      c.addDiagnostic(
        chainDiagnostic(diagnostics[0]!, Diagnostics.X_0_cannot_be_used_as_a_JSX_component, getTextOfNode(tagName)),
      );
  } else
    checkJsxReturnAssignableToAppropriateBound(c, getJsxReferenceKind(c, node), getReturnTypeOfSignature(c, sig), node);
}

function checkJsxPreconditions(c: Checker, errorNode: Node): void {
  if (c.compilerOptions.jsx === undefined)
    c.error(errorNode, Diagnostics.Cannot_use_JSX_unless_the_jsx_flag_is_provided);
  // A missing `JSX.Element` is the error type rather than absent, so TS2602 is never reported.
}

function checkJsxReturnAssignableToAppropriateBound(
  c: Checker,
  refKind: JsxReferenceKind,
  elemInstanceType: Type,
  openingLikeElement: Node,
): void {
  const diagnostics: Diagnostic[] = [];
  const tagName = getTagNameOf(openingLikeElement);
  if (refKind === JsxReferenceKind.Function) {
    const sfcReturnConstraint = getJsxStatelessElementTypeAt(c, openingLikeElement);
    if (sfcReturnConstraint !== undefined)
      checkTypeRelatedTo(
        c,
        elemInstanceType,
        sfcReturnConstraint,
        c.assignableRelation,
        tagName,
        Diagnostics.Its_return_type_0_is_not_a_valid_JSX_element,
        diagnostics,
      );
  } else if (refKind === JsxReferenceKind.Component) {
    const classConstraint = getJsxElementClassTypeAt(c, openingLikeElement);
    if (classConstraint !== undefined)
      checkTypeRelatedTo(
        c,
        elemInstanceType,
        classConstraint,
        c.assignableRelation,
        tagName,
        Diagnostics.Its_instance_type_0_is_not_a_valid_JSX_element,
        diagnostics,
      );
  } else {
    const sfcReturnConstraint = getJsxStatelessElementTypeAt(c, openingLikeElement);
    const classConstraint = getJsxElementClassTypeAt(c, openingLikeElement);
    if (sfcReturnConstraint === undefined || classConstraint === undefined) return;
    const combined = getUnionType(c, [sfcReturnConstraint, classConstraint]);
    checkTypeRelatedTo(
      c,
      elemInstanceType,
      combined,
      c.assignableRelation,
      tagName,
      Diagnostics.Its_element_type_0_is_not_a_valid_JSX_element,
      diagnostics,
    );
  }
  if (diagnostics.length !== 0)
    c.addDiagnostic(
      chainDiagnostic(diagnostics[0]!, Diagnostics.X_0_cannot_be_used_as_a_JSX_component, getTextOfNode(tagName)),
    );
}

/** Resolves the factory namespace, which must be in scope for the classic React transform. */
function markJsxAliasReferenced(c: Checker, node: Node): void {
  if (getJsxNamespaceContainerForImplicitImport(c, node) !== undefined) return;
  const jsxFactoryRefErr =
    c.compilerOptions.jsx === JsxEmit.React
      ? Diagnostics.This_JSX_tag_requires_0_to_be_in_scope_but_it_could_not_be_found
      : undefined;
  const jsxFactoryNamespace = getJsxNamespace(c, node);
  const jsxFactoryLocation = isJsxOpeningLikeElement(node) ? getTagNameOf(node) : node;
  const shouldFactoryRefErr =
    c.compilerOptions.jsx !== JsxEmit.Preserve && c.compilerOptions.jsx !== JsxEmit.ReactNative;
  let flags = SymbolFlags.Value;
  if (!shouldFactoryRefErr) flags &= ~SymbolFlags.Enum;
  // `null` is allowed as the fragment factory.
  if (!(node.kind === SyntaxKind.JsxOpeningFragment && jsxFactoryNamespace === 'null'))
    resolveName(c, jsxFactoryLocation, jsxFactoryNamespace, flags, jsxFactoryRefErr, true, false);
  if (node.kind === SyntaxKind.JsxOpeningFragment) {
    const file = getSourceFileOfNode(node);
    const entity = getJsxFactoryEntity(c, file);
    if (entity !== undefined)
      resolveName(c, jsxFactoryLocation, getText(getFirstIdentifier(entity)), flags, jsxFactoryRefErr, true, false);
  }
}

// ---- Grammar

function checkGrammarJsxElement(c: Checker, node: Node): boolean {
  checkGrammarJsxName(c, getTagNameOf(node));
  checkGrammarTypeArguments(c, node, getTypeArgumentListOf(node));
  const seen = new Set<string>();
  for (const attrNode of getAttributesOf(node).properties.nodes) {
    if (attrNode.kind === SyntaxKind.JsxSpreadAttribute) continue;
    const attr = attrNode as JsxAttribute;
    const textOfName = jsxNameText(attr.name);
    if (seen.has(textOfName))
      return grammarErrorOnNode(
        c,
        attr.name,
        Diagnostics.JSX_elements_cannot_have_multiple_attributes_with_the_same_name,
      );
    seen.add(textOfName);
    const initializer = attr.initializer;
    if (
      initializer !== undefined &&
      initializer.kind === SyntaxKind.JsxExpression &&
      (initializer as JsxExpression).expression === undefined
    )
      return grammarErrorOnNode(
        c,
        initializer,
        Diagnostics.JSX_attributes_must_only_be_assigned_a_non_empty_expression,
      );
  }
  return false;
}

function checkGrammarJsxName(c: Checker, node: Node): boolean {
  if (
    node.kind === SyntaxKind.PropertyAccessExpression &&
    (node as PropertyAccessExpression).expression.kind === SyntaxKind.JsxNamespacedName
  )
    return grammarErrorOnNode(
      c,
      (node as PropertyAccessExpression).expression,
      Diagnostics.JSX_property_access_expressions_cannot_include_JSX_namespace_names,
    );
  if (
    node.kind === SyntaxKind.JsxNamespacedName &&
    isJsxTransformEnabled(c) &&
    !isIntrinsicJsxName((node as JsxNamespacedName).namespace.text)
  )
    return grammarErrorOnNode(c, node, Diagnostics.React_components_cannot_include_JSX_namespace_names);
  return false;
}

function checkGrammarTypeArguments(c: Checker, node: Node, typeArguments: NodeList | undefined): boolean {
  if (typeArguments === undefined) return false;
  if (typeArguments.hasTrailingComma())
    return grammarErrorAtPos(
      c,
      typeArguments.nodes[0]!,
      typeArguments.end - 1,
      1,
      Diagnostics.Trailing_comma_not_allowed,
    );
  if (typeArguments.nodes.length === 0) {
    const file = getSourceFileOfNode(node);
    const start = typeArguments.pos - 1;
    const end = skipTrivia(file.text, typeArguments.end) + 1;
    return grammarErrorAtPos(c, file, start, end - start, Diagnostics.Type_argument_list_cannot_be_empty);
  }
  return false;
}

function checkGrammarJsxExpression(c: Checker, node: JsxExpression): boolean {
  const expression = node.expression;
  if (
    expression !== undefined &&
    expression.kind === SyntaxKind.BinaryExpression &&
    (expression as BinaryExpression).operatorToken.kind === SyntaxKind.CommaToken
  )
    return grammarErrorOnNode(
      c,
      expression,
      Diagnostics.JSX_expressions_may_not_use_the_comma_operator_Did_you_mean_to_write_an_array,
    );
  return false;
}

// ---- Contextual types

export function getContextualTypeForJsxExpression(
  c: Checker,
  node: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.JsxAttribute || parent.kind === SyntaxKind.JsxSpreadAttribute)
    return getContextualTypeEx(c, node, contextFlags);
  if (parent.kind === SyntaxKind.JsxElement)
    return getContextualTypeForChildJsxExpression(c, parent, node, contextFlags);
  return undefined;
}

export function getContextualTypeForJsxAttribute(
  c: Checker,
  attribute: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  // While a function component's signature is tried, its attributes carry the parameter type.
  if (attribute.kind === SyntaxKind.JsxAttribute) {
    const attributesType = getApparentTypeOfContextualTypeEx(c, attribute.parent!, contextFlags);
    if (attributesType === undefined || (attributesType.flags & TypeFlags.Any) !== 0) return undefined;
    return getTypeOfPropertyOfContextualType(c, attributesType, jsxNameText((attribute as JsxAttribute).name));
  }
  return getContextualTypeEx(c, attribute.parent!, contextFlags);
}

export function getContextualJsxElementAttributesType(
  c: Checker,
  node: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  if (node.kind === SyntaxKind.JsxOpeningElement) {
    // Contextual types of an element's attributes are pushed onto the element, which spans the children.
    // Cached contextual types were obtained without flags.
    const index = findContextualNode(c, node.parent!, contextFlags === ContextFlags.None);
    if (index >= 0) return c.inferenceCaches.contextualTypes[index];
  }
  const signature =
    c.resolvedSignatures.get(node.id) === c.resolvingSignature
      ? c.resolvingSignature
      : getResolvedJsxSignature(c, node);
  return getEffectiveFirstArgumentForJsxSignature(c, signature, node);
}

function getContextualTypeForChildJsxExpression(
  c: Checker,
  node: Node,
  child: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  const element = node as JsxElement;
  const attributesType = getApparentTypeOfContextualTypeEx(c, element.openingElement.attributes, contextFlags);
  // Children are the `children` attribute (named by `JSX.ElementChildrenAttribute`).
  const jsxChildrenPropertyName = getJsxElementChildrenPropertyName(c, getJsxNamespaceAt(c, node));
  if (
    attributesType === undefined ||
    (attributesType.flags & TypeFlags.Any) !== 0 ||
    jsxChildrenPropertyName === InternalSymbolName.Missing ||
    jsxChildrenPropertyName === ''
  )
    return undefined;
  const realChildren = getSemanticJsxChildren(element.children.nodes);
  const childIndex = realChildren.indexOf(child);
  const childFieldType = getTypeOfPropertyOfContextualType(c, attributesType, jsxChildrenPropertyName);
  if (childFieldType === undefined) return undefined;
  if (realChildren.length === 1) return childFieldType;
  return mapTypeEx(
    c,
    childFieldType,
    (t) => (isArrayLikeType(c, t) ? getIndexedAccessType(c, t, getNumberLiteralType(c, childIndex)) : t),
    true,
  );
}

export function isJsxAttributesContextSensitive(c: Checker, node: Node): boolean {
  for (const p of (node as JsxAttributes).properties.nodes) if (isContextSensitive(c, p)) return true;
  if (node.parent!.kind === SyntaxKind.JsxOpeningElement)
    for (const child of (node.parent!.parent as JsxElement).children.nodes)
      if (isContextSensitive(c, child)) return true;
  return false;
}

// ---- Elaboration

/** A child of an element that an error can be reported on. */
class JsxElaborationElement {
  constructor(
    readonly errorNode: Node,
    readonly innerExpression: Node | undefined,
    readonly nameType: Type,
    /** Text children report this message instead of a relation error. */
    readonly isText: boolean,
  ) {}
}

function getElaborationElementForJsxChild(child: Node, nameType: Type): JsxElaborationElement | undefined {
  switch (child.kind) {
    case SyntaxKind.JsxExpression:
      return new JsxElaborationElement(child, (child as JsxExpression).expression, nameType, false);
    case SyntaxKind.JsxText:
      // Whitespace-only text isn't a child.
      if ((child as JsxText).containsOnlyTriviaWhiteSpaces) return undefined;
      return new JsxElaborationElement(child, undefined, nameType, true);
  }
  return new JsxElaborationElement(child, child, nameType, false);
}

/** Reports attribute and children errors at the attributes and children themselves. */
export function elaborateJsxComponents(
  c: Checker,
  node: Node,
  source: Type,
  target: Type,
  relation: Relation,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  let reportedError = false;
  for (const prop of (node as JsxAttributes).properties.nodes) {
    if (prop.kind === SyntaxKind.JsxSpreadAttribute) continue;
    const attr = prop as JsxAttribute;
    const name = jsxNameText(attr.name);
    if (isHyphenatedJsxName(name)) continue;
    const nameType = getStringLiteralType(c, name);
    reportedError =
      elaborateElement(
        c,
        source,
        target,
        relation,
        attr.name,
        attr.initializer,
        nameType,
        undefined,
        undefined,
        [],
        diagnosticOutput,
      ) || reportedError;
  }
  const opening = node.parent!;
  if (opening.kind !== SyntaxKind.JsxOpeningElement || opening.parent!.kind !== SyntaxKind.JsxElement)
    return reportedError;
  const containingElement = opening.parent as JsxElement;
  let childrenPropName = getJsxElementChildrenPropertyName(c, getJsxNamespaceAt(c, node));
  if (childrenPropName === InternalSymbolName.Missing) childrenPropName = 'children';
  const childrenNameType = getStringLiteralType(c, childrenPropName);
  const childrenTargetType = getIndexedAccessType(c, target, childrenNameType);
  const validChildren = getSemanticJsxChildren(containingElement.children.nodes);
  if (validChildren.length === 0) return reportedError;
  const moreThanOneRealChildren = validChildren.length > 1;
  let arrayLikeTargetParts: Type;
  let nonArrayLikeTargetParts: Type;
  const iterableType = getGlobalIterableType(c, false);
  if (iterableType !== c.emptyGenericType) {
    const anyIterable = createTypeFromGenericGlobalType(c, iterableType, [c.anyType, c.anyType, c.anyType]);
    arrayLikeTargetParts = filterType(c, childrenTargetType, (t) => isTypeAssignableTo(c, t, anyIterable));
    nonArrayLikeTargetParts = filterType(c, childrenTargetType, (t) => !isTypeAssignableTo(c, t, anyIterable));
  } else {
    arrayLikeTargetParts = filterType(c, childrenTargetType, (t) => isArrayOrTupleLikeType(c, t));
    nonArrayLikeTargetParts = filterType(c, childrenTargetType, (t) => !isArrayOrTupleLikeType(c, t));
  }
  const textMessage =
    Diagnostics.X_0_components_don_t_accept_text_as_child_elements_Text_in_JSX_has_the_type_string_but_the_expected_type_of_1_is_2;
  const textArgs = [
    getTextOfNode(opening.kind === SyntaxKind.JsxOpeningElement ? getTagNameOf(opening) : opening),
    childrenPropName,
    typeToString(c, childrenTargetType),
  ];
  if (moreThanOneRealChildren) {
    if (arrayLikeTargetParts !== c.neverType) {
      const realSource = createTupleType(c, checkJsxChildren(c, containingElement, CheckMode.Normal));
      const children: JsxElaborationElement[] = [];
      let memberOffset = 0;
      const allChildren = containingElement.children.nodes;
      for (let i = 0; i < allChildren.length; i++) {
        const e = getElaborationElementForJsxChild(allChildren[i]!, getNumberLiteralType(c, i - memberOffset));
        if (e !== undefined) children.push(e);
        else memberOffset++;
      }
      reportedError =
        elaborateIterableOrArrayLikeTargetElementwise(
          c,
          children,
          realSource,
          arrayLikeTargetParts,
          relation,
          textMessage,
          textArgs,
          diagnosticOutput,
        ) || reportedError;
    } else if (!isTypeRelatedTo(c, getIndexedAccessType(c, source, childrenNameType), childrenTargetType, relation)) {
      // Arity errors are reported both directly and through the output.
      const diagnostic = c.error(
        containingElement.openingElement.tagName,
        Diagnostics.This_JSX_tag_s_0_prop_expects_a_single_child_of_type_1_but_multiple_children_were_provided,
        childrenPropName,
        typeToString(c, childrenTargetType),
      );
      reportDiagnostic(c, diagnostic, diagnosticOutput);
      reportedError = true;
    }
  } else if (nonArrayLikeTargetParts !== c.neverType) {
    const e = getElaborationElementForJsxChild(validChildren[0]!, childrenNameType);
    if (e !== undefined)
      reportedError =
        elaborateElement(
          c,
          source,
          target,
          relation,
          e.errorNode,
          e.innerExpression,
          e.nameType,
          undefined,
          e.isText ? textMessage : undefined,
          textArgs,
          diagnosticOutput,
        ) || reportedError;
  } else if (!isTypeRelatedTo(c, getIndexedAccessType(c, source, childrenNameType), childrenTargetType, relation)) {
    const diagnostic = c.error(
      containingElement.openingElement.tagName,
      Diagnostics.This_JSX_tag_s_0_prop_expects_type_1_which_requires_multiple_children_but_only_a_single_child_was_provided,
      childrenPropName,
      typeToString(c, childrenTargetType),
    );
    reportDiagnostic(c, diagnostic, diagnosticOutput);
    reportedError = true;
  }
  return reportedError;
}

function elaborateIterableOrArrayLikeTargetElementwise(
  c: Checker,
  elements: JsxElaborationElement[],
  source: Type,
  target: Type,
  relation: Relation,
  textMessage: DiagnosticMessage,
  textArgs: string[],
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  const tupleOrArrayLikeTargetParts = filterType(c, target, (t) => isArrayOrTupleLikeType(c, t));
  const nonTupleOrArrayLikeTargetParts = filterType(c, target, (t) => !isArrayOrTupleLikeType(c, t));
  // A non-array-like part means `Iterable` exists.
  const iterationType =
    nonTupleOrArrayLikeTargetParts !== c.neverType
      ? getIterationTypeOfIterable(
          c,
          IterationUse.ForOf,
          IterationTypeKind.Yield,
          nonTupleOrArrayLikeTargetParts,
          undefined,
        )
      : undefined;
  let reportedError = false;
  for (const e of elements) {
    let targetPropType = iterationType;
    const targetIndexedPropType =
      tupleOrArrayLikeTargetParts !== c.neverType
        ? getBestMatchIndexedAccessTypeOrUndefined(c, source, tupleOrArrayLikeTargetParts, e.nameType)
        : undefined;
    if (targetIndexedPropType !== undefined && (targetIndexedPropType.flags & TypeFlags.IndexedAccess) === 0)
      targetPropType =
        iterationType !== undefined ? getUnionType(c, [iterationType, targetIndexedPropType]) : targetIndexedPropType;
    if (targetPropType === undefined) continue;
    let sourcePropType = getIndexedAccessTypeOrUndefined(c, source, e.nameType, AccessFlags.None);
    if (sourcePropType === undefined) continue;
    if (checkTypeRelatedTo(c, sourcePropType, targetPropType, relation, undefined, undefined, undefined)) continue;
    const next = e.innerExpression;
    const elaborated =
      next !== undefined &&
      elaborateError(c, next, sourcePropType, targetPropType, relation, undefined, diagnosticOutput);
    reportedError = true;
    if (elaborated) continue;
    // Report on the child itself, with the expression's type when there is one.
    const specificSource =
      next !== undefined
        ? checkExpressionForMutableLocationWithContextualType(c, next, sourcePropType)
        : sourcePropType;
    if (e.isText) {
      reportDiagnostic(c, createDiagnosticForNode(e.errorNode, textMessage, textArgs), diagnosticOutput);
      continue;
    }
    if (c.exactOptionalPropertyTypes && isExactOptionalPropertyMismatch(c, specificSource, targetPropType)) {
      reportDiagnostic(
        c,
        createDiagnosticForNode(
          e.errorNode,
          Diagnostics.Type_0_is_not_assignable_to_type_1_with_exactOptionalPropertyTypes_Colon_true_Consider_adding_undefined_to_the_type_of_the_target,
          [typeToString(c, specificSource), typeToString(c, targetPropType)],
        ),
        diagnosticOutput,
      );
      continue;
    }
    const propName = getPropertyNameFromIndex(e.nameType);
    const targetProp = propName !== undefined ? getPropertyOfType(c, tupleOrArrayLikeTargetParts, propName) : undefined;
    const sourceProp = propName !== undefined ? getPropertyOfType(c, source, propName) : undefined;
    const targetIsOptional = targetProp !== undefined && (targetProp.flags & SymbolFlags.Optional) !== 0;
    const sourceIsOptional = sourceProp !== undefined && (sourceProp.flags & SymbolFlags.Optional) !== 0;
    targetPropType = removeMissingType(c, targetPropType, targetIsOptional);
    sourcePropType = removeMissingType(c, sourcePropType, targetIsOptional && sourceIsOptional);
    const result = checkTypeRelatedTo(
      c,
      specificSource,
      targetPropType,
      relation,
      e.errorNode,
      undefined,
      diagnosticOutput,
    );
    if (result && specificSource !== sourcePropType)
      checkTypeRelatedTo(c, sourcePropType, targetPropType, relation, e.errorNode, undefined, diagnosticOutput);
  }
  return reportedError;
}

/** Suggests `htmlFor` for `for`, `className` for `class`, or a similar property name. */
export function getSuggestedSymbolForNonexistentJSXAttribute(
  c: Checker,
  name: string,
  containingType: Type,
): Symbol | undefined {
  const properties = getPropertiesOfType(c, containingType);
  const jsxSpecific = name === 'for' ? 'htmlFor' : name === 'class' ? 'className' : '';
  if (jsxSpecific !== '') for (const p of properties) if (p.name === jsxSpecific) return p;
  return getSpellingSuggestionForName(c, name, properties, SymbolFlags.Value);
}
