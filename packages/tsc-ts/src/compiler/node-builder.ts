// Building type nodes from types, like tsgo's node builder: `typeToTypeNode` and
// `signatureToSignatureDeclaration` for the API, and the serializers declaration emit uses.
//
// A `NodeBuilder` is one serialization: its fields are tsgo's node builder context. Naming
// symbols is in node-builder-names.ts and reusing existing type nodes in node-builder-reuse.ts.
import { sideOf } from './side-state.js';
import { utf8Length } from './character-codes.js';
import {
  ArrayTypeNode,
  ArrowFunction,
  BinaryExpression,
  ElementAccessExpression,
  ImportTypeNode,
  NodeVisitor,
  getExpression,
  getParameters,
  getPostfixToken,
  getQuestionToken,
  getSymbol,
  BigIntLiteral,
  BindingElement,
  BindingPattern,
  Block,
  CallSignatureDeclaration,
  ConditionalTypeNode,
  ConstructSignatureDeclaration,
  ConstructorDeclaration,
  ConstructorTypeNode,
  FunctionDeclaration,
  FunctionExpression,
  FunctionTypeNode,
  GetAccessorDeclaration,
  Identifier,
  IndexSignatureDeclaration,
  IndexedAccessTypeNode,
  InferTypeNode,
  IntersectionTypeNode,
  KeywordTypeNode,
  LiteralTypeNode,
  MappedTypeNode,
  MethodDeclaration,
  MethodSignatureDeclaration,
  ModifierFlags,
  type ModifierList,
  NamedTupleMember,
  type Node,
  NodeFlags,
  NodeList,
  NotEmittedTypeElement,
  OptionalTypeNode,
  ParameterDeclaration,
  PrefixUnaryExpression,
  PropertySignatureDeclaration,
  QualifiedName,
  RestTypeNode,
  SetAccessorDeclaration,
  type SourceFile,
  StringLiteral,
  TemplateHead,
  TemplateLiteralTypeNode,
  TemplateLiteralTypeSpan,
  TemplateMiddle,
  TemplateTail,
  ThisTypeNode,
  Token,
  TupleTypeNode,
  TypeLiteralNode,
  TypeOperatorNode,
  TypeParameterDeclaration,
  TypePredicateNode,
  TypeQueryNode,
  TypeReferenceNode,
  UnionTypeNode,
  getModifiers,
  getName,
  getNodeId,
  getText,
  getType,
} from './ast.js';
import { isModifierKind, modifierToFlag } from './ast-utilities.js';
import {
  declarationNameToString,
  getCombinedModifierFlags,
  getDeclarationOfKind,
  getImmediatelyInvokedFunctionExpression,
  getNameOfDeclaration,
  getSourceFileOfNode,
  getThisContainer,
  hasSyntacticModifier,
  isClassLike,
  isEntityNameExpression,
  isStatic,
  symbolName,
} from './binder-utilities.js';
import { getEffectiveCallArguments } from './checker-calls.js';
import { getIntendedTypeFromJSDocTypeReference } from './checker-jsdoc.js';
import { type Checker, maxSerializationLevel } from './checker.js';
import {
  getConstraintDeclaration,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getDefaultFromTypeParameter,
  getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
  getMinTypeArgumentCount,
} from './checker-declared-types.js';
import { getTypeWithFacts, TypeFacts } from './checker-flow.js';
import { getInferredTypeParameterConstraint } from './checker-inference.js';
import { getGlobalIterableIteratorType, getGlobalIterableType, isReferenceToType } from './checker-iteration.js';
import {
  getDeclarationModifierFlagsFromSymbol,
  getPropertiesOfObjectType,
  getReducedType,
  getSignaturesOfType,
  getTargetSymbol,
  membersHolder,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import {
  getOrCreateTypeFromSignature,
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getTypeParametersFromDeclaration,
  getTypePredicateOfSignature,
  instantiateTypePredicate,
} from './checker-signatures.js';
import {
  getBaseTypeVariableOfClass,
  getNonMissingTypeOfSymbol,
  getOptionalType,
  getTypeForVariableLikeDeclaration,
  getTypeOfSymbol,
  getWriteTypeOfSymbol,
  isReadonlySymbol,
  removeMissingType,
} from './checker-symbol-types.js';
import { isVariableLike } from './checker-declarations.js';
import {
  getFirstIdentifier,
  getGlobalTypeAliasSymbol,
  getMergedSymbol,
  getParentOfSymbol,
  getSymbolOfDeclaration,
  resolveName,
} from './checker-symbols.js';
import {
  createArrayType,
  createTypeReference,
  filterType,
  getIntersectionType,
  getTypeArguments,
  getTypeReferenceArity,
  getWidenedLiteralType,
  isArrayOrTupleType,
  isErrorType,
  isTupleType,
  inDeclarationOrder,
  newAnonymousType,
  typeListKey,
} from './checker-type-factory.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  MappedTypeModifiers,
  getConstraintTypeFromMappedType,
  getFalseTypeFromConditionalType,
  getHomomorphicTypeVariable,
  getMappedTypeModifiers,
  getModifiersTypeFromMappedType,
  getNameTypeFromMappedType,
  getTemplateTypeFromMappedType,
  getTrueTypeFromConditionalType,
  getTypeParameterFromMappedType,
  isGenericMappedType,
  isMappedTypeWithKeyofConstraintDeclaration,
  isNoInferType,
} from './checker-type-operators.js';
import {
  type ConditionalType,
  ElementFlags,
  type IndexInfo,
  type IndexType,
  type IndexedAccessType,
  type InstantiationExpressionType,
  type InterfaceType,
  type LiteralType,
  type MappedType,
  ObjectFlags,
  type ReverseMappedType,
  Signature,
  SignatureFlags,
  SignatureKind,
  type StringMappingType,
  type StructuredType,
  type SubstitutionType,
  type TemplateLiteralType,
  type TupleType,
  type Type,
  TypeFlags,
  type TypeMapper,
  type TypeParameter,
  type TypePredicate,
  TypePredicateKind,
  type TypeReference,
  type UnionType,
  type UnionOrIntersectionType,
  newTypeMapper,
  prependTypeMapping,
  getNonDistributedTypeParameter,
} from './checker-types.js';
import {
  hasLateBindableIndexSignature,
  hasLateBindableName,
  isLateBindableName,
  isLateBoundName,
} from './checker-utilities.js';
import { instantiateSignature, instantiateType } from './instantiation.js';
import { EmitContext } from './printer/emit-context.js';
import { EmitFlags } from './printer/emit-flags.js';
import { Printer, PrinterOptions } from './printer/printer.js';
import { TextWriter } from './printer/text-writer.js';
import type { NodeFactory } from './printer/factory.js';
import { isTypeIdenticalTo } from './relations.js';
import { isIdentifierText } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import {
  NodeBuilderFlags,
  NodeBuilderInternalFlags,
  SymbolAccessibility,
  SymbolAccessibilityResult,
  SymbolTracker,
  accessible,
} from './transformers/declarations-resolver.js';
import { getMeaningOfEntityNameReference } from './transformers/declarations-syntactic.js';
import { TokenFlags } from './types.js';
import { formatUnionTypes, symbolToString } from './type-printer.js';
import {
  hasVisibleDeclarations,
  isSymbolAccessible,
  isTypeSymbolAccessible,
  isValueSymbolAccessible,
} from './symbol-accessibility.js';
import {
  getPropertyNameNodeForSymbol,
  symbolToEntityNameNode,
  symbolToExpression,
  symbolToName,
  symbolToTypeNode,
  appendReferenceToType,
} from './node-builder-names.js';
import { tryReuseExistingNode } from './node-builder-reuse.js';
import {
  containsNonMissingUndefinedType,
  hasInferredTypeKind,
  hasQuestionToken,
  isAccessorKind,
  pseudoReturnTypeMatchesPredicate,
  pseudoTypeEquivalentToType,
  pseudoTypeToNodeWithCheckerFallback,
  pseudoTypeToType,
  newPseudoChecker,
  requiresAddingImplicitUndefinedForDeclaration,
} from './node-builder-pseudo.js';
import {
  InferredType,
  type PseudoChecker,
  type PseudoType,
  PseudoTypeKind,
  UnionType as PseudoUnionType,
  couldAlreadyReferToUndefined,
  undefinedType as pseudoUndefinedType,
} from './transformers/declarations-pseudo.js';
import {
  CheckFlags,
  declarationCount,
  getDeclarations,
  getSymbolId,
  type Symbol,
  SymbolFlags,
  type SymbolTable,
} from './symbol.js';

const defaultMaximumTruncationLength = 160;
const noTruncationMaximumTruncationLength = 1_000_000;
const maxReverseMappedNestingInspectionDepth = 3;

/** A symbol the builder named, kept with a cached result so it can be tracked again. */
export class TrackedSymbol {
  readonly symbol: Symbol;
  readonly enclosingDeclaration: Node | undefined;
  readonly meaning: SymbolFlags;

  constructor(symbol: Symbol, enclosingDeclaration: Node | undefined, meaning: SymbolFlags) {
    this.symbol = symbol;
    this.enclosingDeclaration = enclosingDeclaration;
    this.meaning = meaning;
  }
}

class SerializedTypeEntry {
  readonly node: Node;
  readonly truncating: boolean;
  readonly addedLength: number;
  readonly trackedSymbols: TrackedSymbol[];

  constructor(node: Node, truncating: boolean, addedLength: number, trackedSymbols: TrackedSymbol[]) {
    this.node = node;
    this.truncating = truncating;
    this.addedLength = addedLength;
    this.trackedSymbols = trackedSymbols;
  }
}

/**
 * What a builder's tracker records for it. The builder and its tracker share it, so the tracker doesn't refer to
 * the builder: a builder and a tracker that pointed at each other made every builder a reference cycle.
 */
export class BuilderReports {
  reportedDiagnostic = false;
  trackedSymbols: TrackedSymbol[] = [];
}

/**
 * The tracker a builder reports to: records the symbols it names and that a diagnostic was
 * reported (`BuilderReports`), and forwards to the caller's tracker, if any.
 */
export class BuilderTracker extends SymbolTracker {
  readonly reports: BuilderReports;
  readonly inner: SymbolTracker | undefined;

  constructor(reports: BuilderReports, inner: SymbolTracker | undefined) {
    super();
    this.reports = reports;
    // Don't stack builder trackers.
    let unwrapped = inner;
    while (unwrapped instanceof BuilderTracker) unwrapped = unwrapped.inner;
    this.inner = unwrapped;
  }

  trackSymbol(symbol: Symbol, enclosingDeclaration: Node, meaning: SymbolFlags): boolean {
    if (this.inner !== undefined && this.inner.trackSymbol(symbol, enclosingDeclaration, meaning)) {
      this.reports.reportedDiagnostic = true;
      return true;
    }
    // Type parameters don't need late painted statements.
    if ((symbol.flags & SymbolFlags.TypeParameter) === 0)
      this.reports.trackedSymbols.push(new TrackedSymbol(symbol, enclosingDeclaration, meaning));
    return false;
  }

  reportInferenceFallback(node: Node): boolean {
    return this.inner !== undefined && this.inner.reportInferenceFallback(node);
  }

  reportCyclicStructureError(): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportCyclicStructureError();
  }

  reportInaccessibleThisError(): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportInaccessibleThisError();
  }

  reportInaccessibleUniqueSymbolError(): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportInaccessibleUniqueSymbolError();
  }

  reportLikelyUnsafeImportRequiredError(specifier: string, symbolName: string): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportLikelyUnsafeImportRequiredError(specifier, symbolName);
  }

  reportNonSerializableProperty(propertyName: string): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportNonSerializableProperty(propertyName);
  }

  reportPrivateInBaseOfClassExpression(propertyName: string): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportPrivateInBaseOfClassExpression(propertyName);
  }

  reportTruncationError(): boolean {
    this.reports.reportedDiagnostic = true;
    return this.inner !== undefined && this.inner.reportTruncationError();
  }

  reportNonlocalAugmentation(containingFile: SourceFile, parentSymbol: Symbol, augmentingSymbol: Symbol): boolean {
    this.reports.reportedDiagnostic = true;
    return (
      this.inner !== undefined && this.inner.reportNonlocalAugmentation(containingFile, parentSymbol, augmentingSymbol)
    );
  }

  pushErrorFallbackNode(node: Node): boolean {
    return this.inner !== undefined && this.inner.pushErrorFallbackNode(node);
  }

  popErrorFallbackNode(): boolean {
    return this.inner !== undefined && this.inner.popErrorFallbackNode();
  }
}

/** What `signatureToSignatureDeclaration` may add to the declaration. */
class SignatureDeclarationOptions {
  readonly modifiers: Node[];
  readonly name: Node | undefined;
  readonly questionToken: Token | undefined;

  constructor(modifiers: Node[], name: Node | undefined, questionToken: Token | undefined) {
    this.modifiers = modifiers;
    this.name = name;
    this.questionToken = questionToken;
  }
}

export const enum PropertyNameKind {
  Identifier,
  NumericLiteral,
  StringLiteral,
}

export function classifyPropertyName(name: string, stringNamed: boolean, isMethod: boolean): PropertyNameKind {
  if (isMethod && name === 'new') return PropertyNameKind.StringLiteral;
  if (isIdentifierText(name)) return PropertyNameKind.Identifier;
  return !stringNamed && isNumericLiteralName(name) && Number(name) >= 0
    ? PropertyNameKind.NumericLiteral
    : PropertyNameKind.StringLiteral;
}

export function isNumericLiteralName(name: string): boolean {
  return String(Number(name)) === name;
}

/** One serialization of types to nodes. */
export class NodeBuilder {
  readonly c: Checker;
  readonly context: EmitContext;
  readonly factory: NodeFactory;
  tracker: SymbolTracker;
  flags: NodeBuilderFlags;
  internalFlags: NodeBuilderInternalFlags;
  approximateLength = 0;
  encounteredError = false;
  truncating = false;
  enclosingDeclaration: Node | undefined;
  readonly enclosingFile: SourceFile | undefined;
  inferTypeParameters: Type[] = [];
  private visitedTypesStore: Set<number> | undefined = undefined;
  private symbolDepthStore: Map<string, number> | undefined = undefined;
  /** What its tracker records (`reportedDiagnostic`, `trackedSymbols`). */
  readonly reports = new BuilderReports();
  mapper: TypeMapper | undefined = undefined;
  private reverseMappedStackStore: Symbol[] | undefined = undefined;
  private enclosingSymbolTypesStore: Map<number, Type> | undefined = undefined;
  suppressReportInferenceFallback = false;
  private remappedSymbolReferencesStore: Map<number, Symbol> | undefined = undefined;
  // Per signature scope; undefined while empty.
  typeParameterNames: Map<number, Identifier> | undefined = undefined;
  typeParameterNamesByText: Set<string> | undefined = undefined;
  typeParameterNamesByTextNextNameCount: Map<string, number> | undefined = undefined;
  typeParameterSymbolList: Set<number> | undefined = undefined;
  private serializedTypesStore: Map<number, Map<string, SerializedTypeEntry>> | undefined = undefined;
  private fakeScopesStore: Map<Node, string> | undefined = undefined;
  /**
   * Declaration emit's pseudochecker: with it, types of declarations are written from what the
   * source wrote where that denotes the checker's type.
   */
  pseudo: PseudoChecker | undefined = undefined;
  /** Set for declaration emit, which writes unions in an order that doesn't depend on the checker's history. */
  declarationOrder = false;
  /** When set, the symbol each identifier naming a symbol refers to. */
  idToSymbol: Map<Node, Symbol> | undefined = undefined;

  constructor(
    c: Checker,
    enclosingDeclaration: Node | undefined,
    flags: NodeBuilderFlags,
    internalFlags: NodeBuilderInternalFlags,
    tracker: SymbolTracker | undefined,
    context: EmitContext | undefined = undefined,
  ) {
    this.c = c;
    this.context = context ?? new EmitContext();
    this.factory = this.context.factory;
    this.flags = flags;
    this.internalFlags = internalFlags;
    this.enclosingDeclaration = enclosingDeclaration;
    this.enclosingFile = enclosingDeclaration === undefined ? undefined : getSourceFileOfNode(enclosingDeclaration);
    this.tracker = new BuilderTracker(this.reports, tracker);
  }

  get reportedDiagnostic(): boolean {
    return this.reports.reportedDiagnostic;
  }

  set reportedDiagnostic(value: boolean) {
    this.reports.reportedDiagnostic = value;
  }

  get trackedSymbols(): TrackedSymbol[] {
    return this.reports.trackedSymbols;
  }

  set trackedSymbols(value: TrackedSymbol[]) {
    this.reports.trackedSymbols = value;
  }

  // Created when first used: most types a builder writes need none of these.

  get visitedTypes(): Set<number> {
    return (this.visitedTypesStore ??= new Set<number>());
  }

  /** Nesting depth of each symbol, node or constructor being written. */
  get symbolDepth(): Map<string, number> {
    return (this.symbolDepthStore ??= new Map<string, number>());
  }

  get reverseMappedStack(): Symbol[] {
    return (this.reverseMappedStackStore ??= []);
  }

  /** Types of symbols being written, which may differ from their declared types. */
  get enclosingSymbolTypes(): Map<number, Type> {
    return (this.enclosingSymbolTypesStore ??= new Map<number, Type>());
  }

  get remappedSymbolReferences(): Map<number, Symbol> {
    return (this.remappedSymbolReferencesStore ??= new Map<number, Symbol>());
  }

  /** Serialized types by enclosing declaration id, then type, flags and internal flags. */
  get serializedTypes(): Map<number, Map<string, SerializedTypeEntry>> {
    return (this.serializedTypesStore ??= new Map<number, Map<string, SerializedTypeEntry>>());
  }

  /** The kind of fake scope a block stands for: `params` or `typeParams`. */
  get fakeScopes(): Map<Node, string> {
    return (this.fakeScopesStore ??= new Map<Node, string>());
  }

  /** `result`, or undefined if serialization failed. */
  finish<T>(result: T | undefined): T | undefined {
    if (this.truncating && (this.flags & NodeBuilderFlags.NoTruncation) !== 0) this.tracker.reportTruncationError();
    return this.encounteredError ? undefined : result;
  }

  /** Reports a symbol the builder names; without a location it's only recorded. */
  trackSymbol(symbol: Symbol, enclosingDeclaration: Node | undefined, meaning: SymbolFlags): void {
    if (enclosingDeclaration !== undefined) this.tracker.trackSymbol(symbol, enclosingDeclaration, meaning);
    else if ((symbol.flags & SymbolFlags.TypeParameter) === 0)
      this.trackedSymbols.push(new TrackedSymbol(symbol, enclosingDeclaration, meaning));
  }

  checkTruncationLength(): boolean {
    if (this.truncating) return true;
    const maxLength =
      (this.flags & NodeBuilderFlags.NoTruncation) !== 0
        ? noTruncationMaximumTruncationLength
        : defaultMaximumTruncationLength;
    this.truncating = this.approximateLength > maxLength;
    return this.truncating;
  }

  // ---- Node creation

  created<T extends Node>(node: T): T {
    return this.factory.created(node);
  }

  list(nodes: Node[]): NodeList {
    return this.factory.createNodeList(nodes);
  }

  modifierList(nodes: Node[]): ModifierList | undefined {
    return nodes.length === 0 ? undefined : this.factory.createModifierList(nodes);
  }

  keyword(kind: SyntaxKind): Node {
    return this.created(new KeywordTypeNode(kind));
  }

  token(kind: SyntaxKind): Token {
    return this.factory.createToken(kind);
  }

  identifier(text: string): Identifier {
    return this.factory.createIdentifier(text);
  }

  /** An identifier naming `symbol`, recorded in `idToSymbol`. */
  symbolIdentifier(text: string, symbol: Symbol): Identifier {
    const identifier = this.factory.createIdentifier(text);
    this.idToSymbol?.set(identifier, symbol);
    return identifier;
  }

  stringLiteral(text: string, isSingleQuote: boolean): StringLiteral {
    const flags =
      isSingleQuote || (this.flags & NodeBuilderFlags.UseSingleQuotesForStringLiteralType) !== 0
        ? TokenFlags.SingleQuote
        : TokenFlags.None;
    return this.factory.createStringLiteral(text, flags);
  }

  typeReference(name: Node, typeArguments: NodeList | undefined): Node {
    return this.created(new TypeReferenceNode(name, typeArguments));
  }

  /** `...`, or `any /*elided*\/` without truncation. */
  createElidedInformationPlaceholder(): Node {
    this.approximateLength += 3;
    if ((this.flags & NodeBuilderFlags.NoTruncation) === 0)
      return this.typeReference(this.identifier('...'), undefined);
    return this.context.addSyntheticLeadingComment(
      this.keyword(SyntaxKind.AnyKeyword),
      SyntaxKind.MultiLineCommentTrivia,
      'elided',
      false,
    );
  }

  // ---- Scopes

  /** Sets the type `symbol` is written with until the returned function restores it. */
  addSymbolTypeToContext(symbol: Symbol, t: Type): () => void {
    const id = getSymbolId(symbol);
    const old = this.enclosingSymbolTypes.get(id);
    this.enclosingSymbolTypes.set(id, t);
    return () => {
      if (old !== undefined) this.enclosingSymbolTypes.set(id, old);
      else this.enclosingSymbolTypes.delete(id);
    };
  }

  /** Enters the scope of a signature, returning its exit; `expandedParameters` holds its parameters. */
  enterSignatureScope(signature: Signature): () => void {
    const expandedParams = getExpandedParameters(this.c, signature, true)[0]!;
    this.expandedParameters = expandedParams;
    return this.enterNewScope(
      signature.declaration,
      expandedParams,
      signature.typeParameters,
      signature.parameters,
      signature.mapper,
    );
  }

  /** The parameters of the signature scope entered last. */
  expandedParameters: Symbol[] = [];

  /**
   * Enters a scope introducing parameters and type parameters. Names generated within it don't
   * consume names outside it. The enclosing declaration gets a fake scope making the parameters
   * visible, so names they shadow are qualified; it's shared along a chain of scopes.
   */
  enterNewScope(
    declaration: Node | undefined,
    expandedParams: Symbol[] | undefined,
    typeParameters: Type[] | undefined,
    originalParameters: Symbol[] | undefined,
    mapper: TypeMapper | undefined,
  ): () => void {
    const savedNames = this.typeParameterNames;
    const savedNamesByText = this.typeParameterNamesByText;
    const savedNextNameCount = this.typeParameterNamesByTextNextNameCount;
    const savedSymbolList = this.typeParameterSymbolList;
    // The scope starts from the enclosing one's names, copied where there are any.
    this.typeParameterNames = savedNames === undefined ? undefined : new Map<number, Identifier>(savedNames);
    this.typeParameterNamesByText = savedNamesByText === undefined ? undefined : new Set<string>(savedNamesByText);
    this.typeParameterNamesByTextNextNameCount =
      savedNextNameCount === undefined ? undefined : new Map<string, number>(savedNextNameCount);
    this.typeParameterSymbolList = savedSymbolList === undefined ? undefined : new Set<number>(savedSymbolList);
    const oldEnclosingDeclaration = this.enclosingDeclaration;
    const oldMapper = this.mapper;
    if (mapper !== undefined) this.mapper = mapper;
    let cleanupParams: (() => void) | undefined = undefined;
    let cleanupTypeParams: (() => void) | undefined = undefined;
    if (this.enclosingDeclaration !== undefined && declaration !== undefined) {
      if (expandedParams !== undefined && expandedParams.length > 0) {
        const table = new Map<string, Symbol>();
        for (let i = 0; i < expandedParams.length; i++) {
          const param = expandedParams[i]!;
          const originalParam =
            originalParameters !== undefined && i < originalParameters.length ? originalParameters[i]! : undefined;
          if (originalParameters !== undefined && originalParam !== param) {
            // An expanded parameter can't be named; the original can.
            if (originalParam !== undefined) table.set(originalParam.name, originalParam);
          } else if (!this.addBindingPatternParameters(param, table)) table.set(param.name, param);
        }
        cleanupParams = this.pushFakeScope('params', table);
      }
      if (
        (this.flags & NodeBuilderFlags.GenerateNamesForShadowedTypeParams) !== 0 &&
        typeParameters !== undefined &&
        typeParameters.length > 0
      ) {
        const table = new Map<string, Symbol>();
        for (const typeParameter of typeParameters)
          table.set(this.typeParameterToName(typeParameter).text, typeParameter.symbol!);
        cleanupTypeParams = this.pushFakeScope('typeParams', table);
      }
    }
    return () => {
      if (cleanupParams !== undefined) cleanupParams();
      if (cleanupTypeParams !== undefined) cleanupTypeParams();
      this.typeParameterNames = savedNames;
      this.typeParameterNamesByText = savedNamesByText;
      this.typeParameterNamesByTextNextNameCount = savedNextNameCount;
      this.typeParameterSymbolList = savedSymbolList;
      this.enclosingDeclaration = oldEnclosingDeclaration;
      this.mapper = oldMapper;
    };
  }

  /** Adds the names bound by a destructured parameter; false if `param` isn't one. */
  private addBindingPatternParameters(param: Symbol, table: SymbolTable): boolean {
    for (const d of getDeclarations(param)) {
      if (d.kind !== SyntaxKind.Parameter) continue;
      const name = asBindingPattern(getName(d));
      if (name !== undefined) {
        this.addBindingPattern(name, table);
        return true;
      }
    }
    return false;
  }

  private addBindingPattern(pattern: BindingPattern, table: SymbolTable): void {
    // Only the first element is visited, as tsgo does.
    for (const e of pattern.elements.nodes) {
      if (!(e instanceof BindingElement)) return;
      const name = asBindingPattern(e.name);
      if (name !== undefined) {
        this.addBindingPattern(name, table);
        return;
      }
      const symbol = getSymbolOfDeclaration(this.c, e);
      if (symbol !== undefined) table.set(symbol.name, symbol);
      return;
    }
  }

  /** Adds `names` to the fake scope of `kind` at the enclosing declaration, creating it if needed. */
  private pushFakeScope(kind: string, names: SymbolTable): (() => void) | undefined {
    const enclosing = this.enclosingDeclaration!;
    let existing: Node | undefined = undefined;
    if (this.fakeScopes.get(enclosing) === kind) existing = enclosing;
    else if (enclosing.parent !== undefined && this.fakeScopes.get(enclosing.parent) === kind)
      existing = enclosing.parent;
    if (existing === undefined) {
      const fakeScope = this.created(new Block(this.list([]), false));
      fakeScope.locals = names;
      fakeScope.parent = enclosing;
      this.fakeScopes.set(fakeScope, kind);
      this.enclosingDeclaration = fakeScope;
      return undefined;
    }
    const locals = (existing as Block).locals!;
    const added: string[] = [];
    const replaced = new Map<string, Symbol>();
    for (const [name, symbol] of names) {
      const old = locals.get(name);
      if (old === undefined) added.push(name);
      else replaced.set(name, old);
      locals.set(name, symbol);
    }
    return () => {
      for (const name of added) locals.delete(name);
      for (const [name, symbol] of replaced) locals.set(name, symbol);
    };
  }

  /** The enclosing declaration without fake scopes. */
  getEnclosingDeclarationIgnoringFakeScope(): Node | undefined {
    let enclosing = this.enclosingDeclaration;
    while (enclosing !== undefined && this.fakeScopes.has(enclosing)) enclosing = enclosing.parent;
    return enclosing;
  }

  // ---- Type lists

  private elidedCount(count: number, noTruncation: boolean): Node {
    if (noTruncation)
      return this.context.addSyntheticLeadingComment(
        this.keyword(SyntaxKind.AnyKeyword),
        SyntaxKind.MultiLineCommentTrivia,
        '... ' + count + ' more elided ...',
        false,
      );
    return this.typeReference(this.identifier('... ' + count + ' more ...'), undefined);
  }

  /** Type nodes of `list`; a bare list (union or intersection members) truncates in the middle. */
  mapToTypeNodes(list: readonly Type[], isBareList: boolean): NodeList | undefined {
    if (list.length === 0) return undefined;
    const noTruncation = (this.flags & NodeBuilderFlags.NoTruncation) !== 0;
    if (this.checkTruncationLength()) {
      if (!isBareList) {
        const node = noTruncation
          ? this.context.addSyntheticLeadingComment(
              this.keyword(SyntaxKind.AnyKeyword),
              SyntaxKind.MultiLineCommentTrivia,
              'elided',
              false,
            )
          : this.typeReference(this.identifier('...'), undefined);
        return this.list([node]);
      }
      if (list.length > 2) {
        const nodes: Node[] = [];
        const first = this.typeToTypeNode(list[0]!);
        if (first !== undefined) nodes.push(first);
        nodes.push(this.elidedCount(list.length - 2, noTruncation));
        const last = this.typeToTypeNode(list[list.length - 1]!);
        if (last !== undefined) nodes.push(last);
        return this.list(nodes);
      }
    }
    const mayHaveNameCollisions = (this.flags & NodeBuilderFlags.UseFullyQualifiedType) === 0;
    // Single-identifier references: indexes into `seenTypes`/`seenIndexes` by name.
    const seenNames = new Map<string, number[]>();
    const seenTypes: Type[] = [];
    const seenIndexes: number[] = [];
    const result: Node[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      const displayIndex = i + 1;
      if (this.checkTruncationLength() && displayIndex + 2 < list.length - 1) {
        result.push(this.elidedCount(list.length - displayIndex, noTruncation));
        const last = this.typeToTypeNode(list[list.length - 1]!);
        if (last !== undefined) result.push(last);
        break;
      }
      this.approximateLength += 2;
      const typeNode = this.typeToTypeNode(t);
      if (typeNode === undefined) continue;
      result.push(typeNode);
      if (mayHaveNameCollisions && typeNode instanceof TypeReferenceNode && typeNode.typeName instanceof Identifier) {
        const name = typeNode.typeName.text;
        let indexes = seenNames.get(name);
        if (indexes === undefined) {
          indexes = [];
          seenNames.set(name, indexes);
        }
        indexes.push(seenTypes.length);
        seenTypes.push(t);
        seenIndexes.push(result.length - 1);
      }
    }
    if (mayHaveNameCollisions) {
      // References by one name to different types are written qualified, so `[Foo, Foo]`
      // doesn't hide that they come from different namespaces.
      const savedFlags = this.flags;
      this.flags |= NodeBuilderFlags.UseFullyQualifiedType;
      for (const indexes of seenNames.values()) {
        let homogeneous = true;
        for (let k = 1; k < indexes.length; k++)
          if (!typesAreSameReference(seenTypes[indexes[0]!]!, seenTypes[indexes[k]!]!)) homogeneous = false;
        if (homogeneous) continue;
        for (const k of indexes) {
          const node = this.typeToTypeNode(seenTypes[k]!);
          if (node !== undefined) result[seenIndexes[k]!] = node;
        }
      }
      this.flags = savedFlags;
    }
    return this.list(result);
  }

  // ---- Types

  typeToTypeNode(type: Type | undefined): Node | undefined {
    const c = this.c;
    const inTypeAlias = this.flags & NodeBuilderFlags.InTypeAlias;
    this.flags &= ~NodeBuilderFlags.InTypeAlias;
    if (type === undefined) {
      if ((this.flags & NodeBuilderFlags.AllowEmptyUnionOrIntersection) === 0) {
        this.encounteredError = true;
        return undefined;
      }
      this.approximateLength += 3;
      return this.keyword(SyntaxKind.AnyKeyword);
    }
    // A distributed type parameter prints as the type parameter it was made from.
    let t = getNonDistributedTypeParameter(type);
    if ((this.flags & NodeBuilderFlags.NoTypeReduction) === 0) t = getReducedType(c, t);
    const flags = t.flags;
    if ((flags & TypeFlags.Any) !== 0) {
      if (t.alias !== undefined)
        return this.typeReference(
          symbolToEntityNameNode(this, t.alias.symbol),
          this.mapToTypeNodes(t.alias.typeArguments, false),
        );
      if (t === c.unresolvedType)
        return this.context.addSyntheticLeadingComment(
          this.keyword(SyntaxKind.AnyKeyword),
          SyntaxKind.MultiLineCommentTrivia,
          'unresolved',
          false,
        );
      this.approximateLength += 3;
      return this.keyword(t === c.intrinsicMarkerType ? SyntaxKind.IntrinsicKeyword : SyntaxKind.AnyKeyword);
    }
    if ((flags & TypeFlags.Unknown) !== 0) return this.keyword(SyntaxKind.UnknownKeyword);
    if ((flags & TypeFlags.String) !== 0) {
      this.approximateLength += 6;
      return this.keyword(SyntaxKind.StringKeyword);
    }
    if ((flags & TypeFlags.Number) !== 0) {
      this.approximateLength += 6;
      return this.keyword(SyntaxKind.NumberKeyword);
    }
    if ((flags & TypeFlags.BigInt) !== 0) {
      this.approximateLength += 6;
      return this.keyword(SyntaxKind.BigIntKeyword);
    }
    if ((flags & TypeFlags.Boolean) !== 0 && t.alias === undefined) {
      this.approximateLength += 7;
      return this.keyword(SyntaxKind.BooleanKeyword);
    }
    if ((flags & TypeFlags.EnumLike) !== 0) {
      const symbol = t.symbol!;
      if ((symbol.flags & SymbolFlags.EnumMember) !== 0) {
        const parentSymbol = getParentOfSymbol(c, symbol)!;
        const parentName = symbolToTypeNode(this, parentSymbol, SymbolFlags.Type, undefined)!;
        if (getDeclaredTypeOfSymbol(c, parentSymbol) === t) return parentName;
        const memberName = symbol.name;
        if (isIdentifierText(memberName))
          return appendReferenceToType(this, parentName, this.typeReference(this.identifier(memberName), undefined));
        if (parentName instanceof ImportTypeNode) {
          // Freshly made, so it can be changed in place.
          parentName.isTypeOf = true;
          return this.created(
            new IndexedAccessTypeNode(
              parentName,
              this.created(new LiteralTypeNode(this.stringLiteral(memberName, false))),
            ),
          );
        }
        if (parentName instanceof TypeReferenceNode)
          return this.created(
            new IndexedAccessTypeNode(
              this.created(new TypeQueryNode(parentName.typeName, undefined)),
              this.created(new LiteralTypeNode(this.stringLiteral(memberName, false))),
            ),
          );
        throw new Error('Unhandled type node kind returned from symbolToTypeNode');
      }
      return symbolToTypeNode(this, symbol, SymbolFlags.Type, undefined);
    }
    if ((flags & TypeFlags.StringLiteral) !== 0) {
      const value = (t as LiteralType).stringValue;
      this.approximateLength += value.length + 2;
      const literal = this.stringLiteral(value, false);
      this.context.addEmitFlags(literal, EmitFlags.NoAsciiEscaping);
      return this.created(new LiteralTypeNode(literal));
    }
    if ((flags & TypeFlags.NumberLiteral) !== 0) {
      const value = (t as LiteralType).numberValue;
      const text = String(value);
      this.approximateLength += text.length;
      if (value < 0)
        return this.created(
          new LiteralTypeNode(
            this.created(
              new PrefixUnaryExpression(SyntaxKind.MinusToken, this.factory.createNumericLiteral(text.substring(1))),
            ),
          ),
        );
      return this.created(new LiteralTypeNode(this.factory.createNumericLiteral(text)));
    }
    if ((flags & TypeFlags.BigIntLiteral) !== 0) {
      const text = (t as LiteralType).stringValue;
      this.approximateLength += text.length + 1;
      return this.created(new LiteralTypeNode(this.created(new BigIntLiteral(text + 'n', TokenFlags.None))));
    }
    if ((flags & TypeFlags.BooleanLiteral) !== 0) {
      const isTrue = (t as LiteralType).stringValue === 'true';
      this.approximateLength += isTrue ? 4 : 5;
      return this.created(
        new LiteralTypeNode(
          this.factory.createKeywordExpression(isTrue ? SyntaxKind.TrueKeyword : SyntaxKind.FalseKeyword),
        ),
      );
    }
    if ((flags & TypeFlags.UniqueESSymbol) !== 0) {
      if ((this.flags & NodeBuilderFlags.AllowUniqueESSymbolType) === 0) {
        if (isValueSymbolAccessible(c, t.symbol!, this.enclosingDeclaration)) {
          this.approximateLength += 6;
          return symbolToTypeNode(this, t.symbol!, SymbolFlags.Value, undefined);
        }
        this.tracker.reportInaccessibleUniqueSymbolError();
      }
      this.approximateLength += 13;
      return this.created(new TypeOperatorNode(SyntaxKind.UniqueKeyword, this.keyword(SyntaxKind.SymbolKeyword)));
    }
    if ((flags & TypeFlags.Void) !== 0) {
      this.approximateLength += 4;
      return this.keyword(SyntaxKind.VoidKeyword);
    }
    if ((flags & TypeFlags.Undefined) !== 0) {
      this.approximateLength += 9;
      return this.keyword(SyntaxKind.UndefinedKeyword);
    }
    if ((flags & TypeFlags.Null) !== 0) {
      this.approximateLength += 4;
      return this.created(new LiteralTypeNode(this.factory.createKeywordExpression(SyntaxKind.NullKeyword)));
    }
    if ((flags & TypeFlags.Never) !== 0) {
      this.approximateLength += 5;
      return this.keyword(SyntaxKind.NeverKeyword);
    }
    if ((flags & TypeFlags.ESSymbol) !== 0) {
      this.approximateLength += 6;
      return this.keyword(SyntaxKind.SymbolKeyword);
    }
    if ((flags & TypeFlags.NonPrimitive) !== 0) {
      this.approximateLength += 6;
      return this.keyword(SyntaxKind.ObjectKeyword);
    }
    if ((flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isThisType) {
      if ((this.flags & NodeBuilderFlags.InObjectTypeLiteral) !== 0) {
        if (!this.encounteredError && (this.flags & NodeBuilderFlags.AllowThisInObjectLiteral) === 0)
          this.encounteredError = true;
        this.tracker.reportInaccessibleThisError();
      }
      this.approximateLength += 4;
      return this.created(new ThisTypeNode());
    }
    if (
      inTypeAlias === 0 &&
      t.alias !== undefined &&
      ((this.flags & NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope) !== 0 ||
        isTypeSymbolAccessible(c, t.alias.symbol, this.enclosingDeclaration))
    ) {
      const symbol = t.alias.symbol;
      const typeArgumentNodes = this.mapToTypeNodes(t.alias.typeArguments, false);
      if (isReservedMemberName(symbol.name) && (symbol.flags & SymbolFlags.Class) === 0)
        return this.typeReference(this.identifier(''), typeArgumentNodes);
      if (
        typeArgumentNodes !== undefined &&
        typeArgumentNodes.nodes.length === 1 &&
        symbol === c.globalArrayType.symbol
      )
        return this.created(new ArrayTypeNode(typeArgumentNodes.nodes[0]!));
      return symbolToTypeNode(this, symbol, SymbolFlags.Type, typeArgumentNodes);
    }
    const objectFlags = t.objectFlags;
    if ((objectFlags & ObjectFlags.Reference) !== 0) {
      // Arrays and tuples are checked for cycles, as their element types can refer back to them.
      if (isArrayOrTupleType(c, t) || (t as TypeReference).node !== undefined)
        return this.visitAndTransformType(t, TransformKind.TypeReference);
      return this.typeReferenceToTypeNode(t as TypeReference);
    }
    if ((flags & TypeFlags.TypeParameter) !== 0 || (objectFlags & ObjectFlags.ClassOrInterface) !== 0) {
      if ((flags & TypeFlags.TypeParameter) !== 0 && this.inferTypeParameters.indexOf(t) >= 0) {
        this.approximateLength += t.symbol!.name.length + 6;
        let constraintNode: Node | undefined = undefined;
        const constraint = getConstraintOfTypeParameter(c, t);
        if (constraint !== undefined) {
          // Write `infer T extends C` unless the position implies the same constraint.
          const inferredConstraint = getInferredTypeParameterConstraint(c, t, true);
          if (inferredConstraint === undefined || !isTypeIdenticalTo(c, constraint, inferredConstraint)) {
            this.approximateLength += 9;
            constraintNode = this.typeToTypeNode(constraint);
          }
        }
        return this.created(new InferTypeNode(this.typeParameterToDeclarationWithConstraint(t, constraintNode)));
      }
      if (
        (this.flags & NodeBuilderFlags.GenerateNamesForShadowedTypeParams) !== 0 &&
        (flags & TypeFlags.TypeParameter) !== 0
      ) {
        const name = this.typeParameterToName(t);
        this.approximateLength += name.text.length;
        return this.typeReference(this.identifier(name.text), undefined);
      }
      // A use of a type parameter, not its declaration: no constraint or default.
      if (t.symbol !== undefined) return symbolToTypeNode(this, t.symbol, SymbolFlags.Type, undefined);
      const varianceTypeParameter = c.varianceTypeParameter;
      let name = '?';
      if (
        (t === c.markerSuperTypeForCheck || t === c.markerSubTypeForCheck) &&
        varianceTypeParameter !== undefined &&
        varianceTypeParameter.symbol !== undefined
      )
        name = (t === c.markerSubTypeForCheck ? 'sub-' : 'super-') + varianceTypeParameter.symbol.name;
      return this.typeReference(this.identifier(name), undefined);
    }
    let u = t;
    if ((flags & TypeFlags.Union) !== 0 && (t as UnionType).origin !== undefined) u = (t as UnionType).origin!;
    if ((u.flags & (TypeFlags.Union | TypeFlags.Intersection)) !== 0) {
      let types: readonly Type[] =
        (u.flags & TypeFlags.Union) !== 0
          ? formatUnionTypes(c, (u as UnionOrIntersectionType).types, false)
          : (u as UnionOrIntersectionType).types;
      // Declaration emit writes unions in an order that doesn't depend on the checker's history; type
      // text in messages keeps the union's order.
      if (this.declarationOrder && (u.flags & TypeFlags.Union) !== 0) types = inDeclarationOrder(c, types);
      if (types.length === 1) return this.typeToTypeNode(types[0]!);
      const typeNodes = this.mapToTypeNodes(types, true);
      if (typeNodes !== undefined && typeNodes.nodes.length > 0)
        return (u.flags & TypeFlags.Union) !== 0
          ? this.created(new UnionTypeNode(typeNodes))
          : this.created(new IntersectionTypeNode(typeNodes));
      if (!this.encounteredError && (this.flags & NodeBuilderFlags.AllowEmptyUnionOrIntersection) === 0)
        this.encounteredError = true;
      return undefined;
    }
    if ((objectFlags & (ObjectFlags.Anonymous | ObjectFlags.Mapped)) !== 0)
      return this.createAnonymousTypeNode(u, false, false);
    if ((u.flags & TypeFlags.Index) !== 0) {
      this.approximateLength += 6;
      const indexTypeNode = this.typeToTypeNode((u as IndexType).target);
      return this.created(new TypeOperatorNode(SyntaxKind.KeyOfKeyword, indexTypeNode!));
    }
    if ((u.flags & TypeFlags.TemplateLiteral) !== 0) {
      const texts = (u as TemplateLiteralType).texts;
      const types = (u as TemplateLiteralType).types;
      const head = this.created(new TemplateHead(texts[0]!, '', TokenFlags.None));
      this.context.addEmitFlags(head, EmitFlags.NoAsciiEscaping);
      const spans: Node[] = [];
      for (let i = 0; i < types.length; i++) {
        let literal: Node;
        if (i < types.length - 1) literal = this.created(new TemplateMiddle(texts[i + 1]!, '', TokenFlags.None));
        else literal = this.created(new TemplateTail(texts[i + 1]!, '', TokenFlags.None));
        this.context.addEmitFlags(literal, EmitFlags.NoAsciiEscaping);
        spans.push(this.created(new TemplateLiteralTypeSpan(this.typeToTypeNode(types[i]!)!, literal)));
      }
      this.approximateLength += 2;
      return this.created(new TemplateLiteralTypeNode(head, this.list(spans)));
    }
    if ((u.flags & TypeFlags.StringMapping) !== 0) {
      const typeNode = this.typeToTypeNode((u as StringMappingType).target);
      return symbolToTypeNode(this, u.symbol!, SymbolFlags.Type, this.list(typeNode === undefined ? [] : [typeNode]));
    }
    if ((u.flags & TypeFlags.IndexedAccess) !== 0) {
      const objectTypeNode = this.typeToTypeNode((u as IndexedAccessType).objectType);
      const indexTypeNode = this.typeToTypeNode((u as IndexedAccessType).indexType);
      this.approximateLength += 2;
      return this.created(new IndexedAccessTypeNode(objectTypeNode!, indexTypeNode!));
    }
    if ((u.flags & TypeFlags.Conditional) !== 0) return this.visitAndTransformType(u, TransformKind.Conditional);
    if ((u.flags & TypeFlags.Substitution) !== 0) {
      const typeNode = this.typeToTypeNode((u as SubstitutionType).baseType);
      if (!isNoInferType(c, u)) return typeNode;
      const noInferSymbol = getGlobalTypeAliasSymbol(c, 'NoInfer', 1, false);
      if (noInferSymbol === undefined) return typeNode;
      return symbolToTypeNode(
        this,
        noInferSymbol,
        SymbolFlags.Type,
        this.list(typeNode === undefined ? [] : [typeNode]),
      );
    }
    throw new Error('Unhandled type in typeToTypeNode');
  }

  /** Writes `t` with `transform`, eliding its circular references; cached per enclosing declaration. */
  visitAndTransformType(t: Type, transform: TransformKind): Node | undefined {
    if (this.checkTruncationLength()) return this.createElidedInformationPlaceholder();
    const c = this.c;
    let typeId = t.id;
    const isArrayOrTuple = isArrayOrTupleType(c, t);
    // A deferred reference and the regular reference to the same array or tuple are one cycle identity.
    if (isArrayOrTuple) typeId = createTypeReference(c, (t as TypeReference).target!, getTypeArguments(c, t)).id;
    if (this.visitedTypes.has(typeId)) return this.createCyclicStructurePlaceholder();
    const isConstructorObject =
      (t.objectFlags & ObjectFlags.Anonymous) !== 0 &&
      t.symbol !== undefined &&
      (t.symbol.flags & SymbolFlags.Class) !== 0;
    // Instantiations of one anonymous type share a symbol, so tracking symbols rather than
    // types catches circular references through them. Nesting of arrays and tuples, which share the Array
    // symbol or a tuple target, is not bounded by it. A deferred array or tuple reference is bounded by its
    // node, which stops a recursive alias whose type arguments grow at each level (`type R<T> = R<T[]>[]`).
    let id: string | undefined = undefined;
    if (isArrayOrTuple) {
      const node = (t as TypeReference).node;
      if (node !== undefined) id = 'n' + getNodeId(node);
    } else if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (t as TypeReference).node !== undefined)
      id = 'n' + getNodeId((t as TypeReference).node!);
    else if ((t.flags & TypeFlags.Conditional) !== 0) id = 'n' + getNodeId((t as ConditionalType).root.node);
    else if (t.symbol !== undefined) id = (isConstructorObject ? 'c' : 's') + getSymbolId(t.symbol);
    let key = typeId + ':' + this.flags + ':' + this.internalFlags;
    if (this.inferTypeParameters.length !== 0) key += ':' + typeListKey(this.inferTypeParameters);
    if (this.enclosingDeclaration !== undefined) {
      const cached = this.serializedTypes.get(getNodeId(this.enclosingDeclaration))?.get(key);
      if (cached !== undefined) {
        for (const tracked of cached.trackedSymbols)
          this.trackSymbol(tracked.symbol, tracked.enclosingDeclaration, tracked.meaning);
        if (cached.truncating) this.truncating = true;
        this.approximateLength += cached.addedLength;
        return this.deepCloneNode(cached.node);
      }
    }
    // Growing type arguments can keep a reverse mapped type from repeating, so its expansion is also bounded by
    // its mapped type's declaration.
    let origin: string | undefined = undefined;
    let originDepth = 0;
    if ((t.objectFlags & ObjectFlags.ReverseMapped) !== 0) {
      origin = 'n' + getNodeId(((t as ReverseMappedType).mappedType as MappedType).declaration!);
      originDepth = this.symbolDepth.get(origin) ?? 0;
      if (originDepth >= 100) {
        this.truncating = true;
        return this.createElidedInformationPlaceholder();
      }
      this.symbolDepth.set(origin, originDepth + 1);
    }
    let depth = 0;
    if (id !== undefined) {
      depth = this.symbolDepth.get(id) ?? 0;
      if (depth > 10) {
        this.truncating = true;
        if (origin !== undefined) this.symbolDepth.set(origin, originDepth);
        return this.createElidedInformationPlaceholder();
      }
      this.symbolDepth.set(id, depth + 1);
    }
    this.visitedTypes.add(typeId);
    const prevTrackedSymbols = this.trackedSymbols;
    this.trackedSymbols = [];
    const startLength = this.approximateLength;
    let result: Node | undefined;
    switch (transform) {
      case TransformKind.TypeReference:
        result = this.typeReferenceToTypeNode(t as TypeReference);
        break;
      case TransformKind.Conditional:
        result = this.conditionalTypeToTypeNode(t as ConditionalType);
        break;
      case TransformKind.ObjectType:
        result = this.createTypeNodeFromObjectType(t);
        break;
      default:
        result = this.typeToTypeNode(t);
        break;
    }
    const addedLength = this.approximateLength - startLength;
    if (
      this.enclosingDeclaration !== undefined &&
      !this.reportedDiagnostic &&
      !this.encounteredError &&
      result !== undefined
    ) {
      const enclosingId = getNodeId(this.enclosingDeclaration);
      let entries = this.serializedTypes.get(enclosingId);
      if (entries === undefined) {
        entries = new Map<string, SerializedTypeEntry>();
        this.serializedTypes.set(enclosingId, entries);
      }
      entries.set(key, new SerializedTypeEntry(result, this.truncating, addedLength, this.trackedSymbols));
    }
    this.visitedTypes.delete(typeId);
    if (id !== undefined) this.symbolDepth.set(id, depth);
    if (origin !== undefined) this.symbolDepth.set(origin, originDepth);
    this.trackedSymbols = prevTrackedSymbols;
    return result;
  }

  private typeToTypeNodeOrCircularityElision(t: Type): Node | undefined {
    if ((t.flags & TypeFlags.Union) !== 0) {
      if (this.visitedTypes.has(t.id)) return this.createCyclicStructurePlaceholder();
      return this.visitAndTransformType(t, TransformKind.Type);
    }
    return this.typeToTypeNode(t);
  }

  /** The placeholder for a circular reference; outside of display, it is an error. */
  private createCyclicStructurePlaceholder(): Node {
    if ((this.flags & NodeBuilderFlags.AllowAnonymousIdentifier) === 0) {
      this.encounteredError = true;
      this.tracker.reportCyclicStructureError();
    }
    return this.createElidedInformationPlaceholder();
  }

  private conditionalTypeToTypeNode(t: ConditionalType): Node | undefined {
    const c = this.c;
    if (this.checkTruncationLength()) return this.createElidedInformationPlaceholder();
    const checkTypeNode = this.typeToTypeNode(t.checkType)!;
    this.approximateLength += 15;
    const root = t.root;
    const node = root.node as ConditionalTypeNode;
    if (
      (this.flags & NodeBuilderFlags.GenerateNamesForShadowedTypeParams) !== 0 &&
      root.isDistributive &&
      (t.checkType.flags & TypeFlags.TypeParameter) === 0
    ) {
      // `checkType extends infer T ? T extends checkType ? T extends extendsType<T> ? trueType<T> :
      // falseType<T> : never : never` keeps the conditional distributive over a non-parameter.
      const newParam = c.newTypeParameter(c.newSymbol(SymbolFlags.TypeParameter, 'T'));
      const name = this.typeParameterToName(newParam);
      const newTypeVariable = this.typeReference(name, undefined) as TypeReferenceNode;
      this.approximateLength += 37;
      const newMapper = prependTypeMapping(root.checkType, newParam, t.mapper);
      const saveInferTypeParameters = this.inferTypeParameters;
      this.inferTypeParameters = root.inferTypeParameters;
      const extendsTypeNode = this.typeToTypeNode(instantiateType(c, root.extendsType, newMapper))!;
      this.inferTypeParameters = saveInferTypeParameters;
      const trueTypeNode = this.typeToTypeNodeOrCircularityElision(
        instantiateType(c, this.getTypeFromTypeNode(node.trueType, false)!, newMapper),
      )!;
      const falseTypeNode = this.typeToTypeNodeOrCircularityElision(
        instantiateType(c, this.getTypeFromTypeNode(node.falseType, false)!, newMapper),
      )!;
      const newId = this.factory.cloneIdentifier(newTypeVariable.typeName as Identifier);
      const syntheticExtendsNode = this.created(
        new InferTypeNode(
          this.created(new TypeParameterDeclaration(undefined, newId, undefined, undefined, undefined)),
        ),
      );
      const innerCheckConditionalNode = this.created(
        new ConditionalTypeNode(newTypeVariable, extendsTypeNode, trueTypeNode, falseTypeNode),
      );
      const syntheticTrueNode = this.created(
        new ConditionalTypeNode(
          this.typeReference(this.factory.cloneIdentifier(name), undefined),
          checkTypeNode.deepClone(),
          innerCheckConditionalNode,
          this.keyword(SyntaxKind.NeverKeyword),
        ),
      );
      return this.created(
        new ConditionalTypeNode(
          checkTypeNode,
          syntheticExtendsNode,
          syntheticTrueNode,
          this.keyword(SyntaxKind.NeverKeyword),
        ),
      );
    }
    const saveInferTypeParameters = this.inferTypeParameters;
    this.inferTypeParameters = root.inferTypeParameters;
    const extendsTypeNode = this.typeToTypeNode(t.extendsType)!;
    this.inferTypeParameters = saveInferTypeParameters;
    const trueTypeNode = this.typeToTypeNodeOrCircularityElision(getTrueTypeFromConditionalType(c, t))!;
    const falseTypeNode = this.typeToTypeNodeOrCircularityElision(getFalseTypeFromConditionalType(c, t))!;
    return this.created(new ConditionalTypeNode(checkTypeNode, extendsTypeNode, trueTypeNode, falseTypeNode));
  }

  private getParentSymbolOfTypeParameter(typeParameter: Type): Symbol | undefined {
    const tp = getDeclarationOfKind(typeParameter.symbol!, SyntaxKind.TypeParameter);
    const host = tp?.parent;
    if (host === undefined) return undefined;
    return getSymbolOfDeclaration(this.c, host);
  }

  private typeReferenceToTypeNode(t: TypeReference): Node | undefined {
    const c = this.c;
    let typeArguments = getTypeArguments(c, t);
    const target = t.target!;
    if (target === c.globalArrayType || target === c.globalReadonlyArrayType) {
      if ((this.flags & NodeBuilderFlags.WriteArrayAsGenericType) !== 0) {
        const typeArgumentNode = this.typeToTypeNode(typeArguments[0]!)!;
        return this.typeReference(
          this.identifier(target === c.globalArrayType ? 'Array' : 'ReadonlyArray'),
          this.list([typeArgumentNode]),
        );
      }
      const elementType = this.typeToTypeNode(typeArguments[0]!)!;
      const arrayType = this.created(new ArrayTypeNode(elementType));
      return target === c.globalArrayType
        ? arrayType
        : this.created(new TypeOperatorNode(SyntaxKind.ReadonlyKeyword, arrayType));
    }
    if ((target.objectFlags & ObjectFlags.Tuple) !== 0) {
      const tuple = target as TupleType;
      const elementInfos = tuple.elementInfos;
      const elementTypes: Type[] = [];
      for (let i = 0; i < typeArguments.length; i++)
        elementTypes.push(
          removeMissingType(
            c,
            typeArguments[i]!,
            i < elementInfos.length && (elementInfos[i]!.flags & ElementFlags.Optional) !== 0,
          ),
        );
      typeArguments = elementTypes;
      if (typeArguments.length > 0) {
        const arity = getTypeReferenceArity(t);
        const nodes = this.mapToTypeNodes(typeArguments.slice(0, arity), false);
        if (nodes !== undefined) {
          const elements = nodes.nodes;
          for (let i = 0; i < elements.length; i++) {
            const flags = elementInfos[i].flags;
            const labeledDeclaration = elementInfos[i].labeledDeclaration;
            const element = elements[i]!;
            if (labeledDeclaration !== undefined)
              elements[i] = this.created(
                new NamedTupleMember(
                  (flags & ElementFlags.Variable) !== 0 ? this.token(SyntaxKind.DotDotDotToken) : undefined,
                  this.identifier(getTupleElementLabel(c, elementInfos[i].flags, labeledDeclaration, undefined, i)),
                  (flags & ElementFlags.Optional) !== 0 ? this.token(SyntaxKind.QuestionToken) : undefined,
                  (flags & ElementFlags.Rest) !== 0 ? this.created(new ArrayTypeNode(element)) : element,
                ),
              );
            else if ((flags & ElementFlags.Variable) !== 0)
              elements[i] = this.created(
                new RestTypeNode(
                  (flags & ElementFlags.Rest) !== 0 ? this.created(new ArrayTypeNode(element)) : element,
                ),
              );
            else if ((flags & ElementFlags.Optional) !== 0) elements[i] = this.created(new OptionalTypeNode(element));
          }
          const tupleTypeNode = this.created(new TupleTypeNode(nodes));
          this.context.setEmitFlags(tupleTypeNode, EmitFlags.SingleLine);
          return tuple.readonly
            ? this.created(new TypeOperatorNode(SyntaxKind.ReadonlyKeyword, tupleTypeNode))
            : tupleTypeNode;
        }
      }
      if (this.encounteredError || (this.flags & NodeBuilderFlags.AllowEmptyTuple) !== 0) {
        const tupleTypeNode = this.created(new TupleTypeNode(this.list([])));
        this.context.setEmitFlags(tupleTypeNode, EmitFlags.SingleLine);
        return tuple.readonly
          ? this.created(new TypeOperatorNode(SyntaxKind.ReadonlyKeyword, tupleTypeNode))
          : tupleTypeNode;
      }
      this.encounteredError = true;
      return undefined;
    }
    const symbol = t.symbol!;
    if (
      (this.flags & NodeBuilderFlags.WriteClassExpressionAsTypeLiteral) !== 0 &&
      symbol.valueDeclaration !== undefined &&
      isClassLike(symbol.valueDeclaration) &&
      !isValueSymbolAccessible(c, symbol, this.enclosingDeclaration)
    )
      return this.createAnonymousTypeNode(t, false, false);
    const interfaceTarget = target as InterfaceType;
    const outerTypeParameters = interfaceTarget.outerTypeParameters();
    let i = 0;
    let resultType: Node | undefined = undefined;
    const length = outerTypeParameters.length;
    while (i < length) {
      // A group of type arguments for type parameters of one declaring container.
      const start = i;
      const parent = this.getParentSymbolOfTypeParameter(outerTypeParameters[i]!);
      do i++;
      while (i < length && this.getParentSymbolOfTypeParameter(outerTypeParameters[i]!) === parent);
      // A group of its own type parameters (the default outer type arguments) isn't written.
      let same = true;
      for (let k = start; k < i; k++) if (outerTypeParameters[k] !== typeArguments[k]) same = false;
      if (same) continue;
      const typeArgumentSlice = this.mapToTypeNodes(typeArguments.slice(start, i), false);
      const savedFlags = this.flags;
      this.flags |= NodeBuilderFlags.ForbidIndexedAccessSymbolReferences;
      const ref = symbolToTypeNode(this, parent!, SymbolFlags.Type, typeArgumentSlice);
      this.flags = savedFlags;
      if (ref !== undefined) resultType = resultType === undefined ? ref : appendReferenceToType(this, resultType, ref);
    }
    let typeArgumentNodes: NodeList | undefined = undefined;
    if (typeArguments.length > 0) {
      const typeParameters = interfaceTarget.typeParameters();
      let typeParameterCount = Math.min(typeParameters.length, typeArguments.length);
      // Iterable types elide type arguments equal to their defaults, for backwards compatible
      // declaration emit since they gained type parameters.
      if (
        isReferenceToType(t, getGlobalIterableType(c, false)) ||
        isReferenceToType(t, getGlobalIterableIteratorType(c, false)) ||
        isReferenceToType(t, getGlobalIterableType(c, true)) ||
        isReferenceToType(t, getGlobalIterableIteratorType(c, true))
      ) {
        const node = t.node;
        const written =
          node instanceof TypeReferenceNode && node.typeArguments !== undefined ? node.typeArguments.nodes.length : -1;
        if (written < typeParameterCount)
          while (typeParameterCount > 0) {
            const typeArgument = typeArguments[typeParameterCount - 1]!;
            const defaultType = getDefaultFromTypeParameter(c, typeParameters[typeParameterCount - 1]!);
            if (defaultType === undefined || !isTypeIdenticalTo(c, typeArgument, defaultType)) break;
            typeParameterCount--;
          }
      }
      typeArgumentNodes = this.mapToTypeNodes(typeArguments.slice(i, Math.max(i, typeParameterCount)), false);
    }
    const savedFlags = this.flags;
    this.flags |= NodeBuilderFlags.ForbidIndexedAccessSymbolReferences;
    const finalRef = symbolToTypeNode(this, symbol, SymbolFlags.Type, typeArgumentNodes);
    this.flags = savedFlags;
    if (resultType === undefined) return finalRef;
    return finalRef === undefined ? resultType : appendReferenceToType(this, resultType, finalRef);
  }

  // ---- Object types

  private shouldWriteTypeOfFunctionSymbol(symbol: Symbol, typeId: number): Symbol | undefined {
    const c = this.c;
    let isStaticMethodSymbol = false;
    // `typeof C.name` can only be written when the member's name is an identifier.
    if ((symbol.flags & SymbolFlags.Method) !== 0 && isIdentifierText(symbol.name))
      for (const d of getDeclarations(symbol))
        if (isStatic(d) && !hasLateBindableIndexSignature(c, d)) isStaticMethodSymbol = true;
    let isNonLocalFunctionSymbol = false;
    let isFunctionExpressionSymbol = false;
    if ((symbol.flags & SymbolFlags.Function) !== 0) {
      if (symbol.parent !== undefined) isNonLocalFunctionSymbol = true;
      else
        for (const d of getDeclarations(symbol)) {
          const parent = d.parent!;
          if (parent.kind === SyntaxKind.SourceFile || parent.kind === SyntaxKind.ModuleBlock) {
            isNonLocalFunctionSymbol = true;
            break;
          }
          const statement = parent.parent?.parent;
          const container = statement?.parent;
          if (
            (d.kind === SyntaxKind.FunctionExpression || d.kind === SyntaxKind.ArrowFunction) &&
            parent.kind === SyntaxKind.VariableDeclaration &&
            parent.parent!.kind === SyntaxKind.VariableDeclarationList &&
            statement !== undefined &&
            statement.kind === SyntaxKind.VariableStatement &&
            container !== undefined &&
            (container.kind === SyntaxKind.SourceFile || container.kind === SyntaxKind.ModuleBlock)
          ) {
            isNonLocalFunctionSymbol = true;
            isFunctionExpressionSymbol = true;
            break;
          }
        }
    }
    if (!isStaticMethodSymbol && !isNonLocalFunctionSymbol) return undefined;
    let named = symbol;
    const valueDeclaration = symbol.valueDeclaration;
    if (
      isFunctionExpressionSymbol &&
      valueDeclaration !== undefined &&
      valueDeclaration.parent !== undefined &&
      valueDeclaration.parent !== this.enclosingDeclaration
    ) {
      const variable = getSymbol(valueDeclaration.parent);
      if (variable !== undefined) named = getMergedSymbol(c, variable);
    }
    // `typeof f` is allowed for static and non-local functions, or a function referring to itself,
    // when it can be named or there's no structural fallback.
    if (
      ((this.flags & NodeBuilderFlags.UseTypeOfFunction) !== 0 || this.visitedTypes.has(typeId)) &&
      ((this.flags & NodeBuilderFlags.UseStructuralFallback) === 0 ||
        isValueSymbolAccessible(c, named, this.enclosingDeclaration))
    )
      return named;
    return undefined;
  }

  /** The symbol to write `typeof` of for an anonymous type, if any. */
  private shouldEmitTypeOfSymbol(
    forceExpansion: boolean,
    forceClassExpansion: boolean,
    isInstanceType: SymbolFlags,
    symbol: Symbol,
    typeId: number,
  ): Symbol | undefined {
    if (forceExpansion) return undefined;
    const c = this.c;
    const valueDeclaration = symbol.valueDeclaration;
    if (
      ((symbol.flags & SymbolFlags.Class) !== 0 &&
        !forceClassExpansion &&
        getBaseTypeVariableOfClass(c, symbol) === undefined &&
        !(
          valueDeclaration !== undefined &&
          isClassLike(valueDeclaration) &&
          (this.flags & NodeBuilderFlags.WriteClassExpressionAsTypeLiteral) !== 0 &&
          (valueDeclaration.kind !== SyntaxKind.ClassDeclaration ||
            isSymbolAccessible(c, symbol, this.enclosingDeclaration, isInstanceType, false).accessibility !==
              SymbolAccessibility.Accessible)
        )) ||
      (symbol.flags & (SymbolFlags.Enum | SymbolFlags.ValueModule)) !== 0
    )
      return symbol;
    return this.shouldWriteTypeOfFunctionSymbol(symbol, typeId);
  }

  createAnonymousTypeNode(t: Type, forceClassExpansion: boolean, forceExpansion: boolean): Node | undefined {
    const c = this.c;
    const typeId = t.id;
    const symbol = t.symbol;
    if (symbol === undefined) {
      // In declaration emit a reverse mapped type is written out, so it can be circular; for display, its
      // properties and index signatures use placeholders.
      if (
        (t.objectFlags & ObjectFlags.ReverseMapped) !== 0 &&
        (this.flags & NodeBuilderFlags.AllowAnonymousIdentifier) === 0
      ) {
        if (this.visitedTypes.has(typeId)) return this.createCyclicStructurePlaceholder();
        return this.visitAndTransformType(t, TransformKind.ObjectType);
      }
      return this.createTypeNodeFromObjectType(t);
    }
    if ((t.objectFlags & ObjectFlags.InstantiationExpressionType) !== 0) {
      const existing = (t as InstantiationExpressionType).node;
      // The node is unreliable for members of unions and intersections, so it's checked.
      if (
        existing !== undefined &&
        existing.kind === SyntaxKind.TypeQuery &&
        this.getTypeFromTypeNode(existing, false) === t
      ) {
        if (this.visitedTypes.has(typeId)) return this.createCyclicStructurePlaceholder();
        this.visitedTypes.add(typeId);
        const typeNode = this.tryReuseExistingNonParameterTypeNode(existing, t, undefined, undefined);
        this.visitedTypes.delete(typeId);
        if (typeNode !== undefined) return typeNode;
      }
      if (this.visitedTypes.has(typeId)) return this.createCyclicStructurePlaceholder();
      return this.visitAndTransformType(t, TransformKind.ObjectType);
    }
    const isInstanceType = isClassInstanceSide(c, t) ? SymbolFlags.Type : SymbolFlags.Value;
    const typeOfSymbol = this.shouldEmitTypeOfSymbol(
      forceExpansion,
      forceClassExpansion,
      isInstanceType,
      symbol,
      typeId,
    );
    if (typeOfSymbol !== undefined) return symbolToTypeNode(this, typeOfSymbol, isInstanceType, undefined);
    if (this.visitedTypes.has(typeId)) {
      // An anonymous type literal in a type alias is written as the alias.
      const typeAlias = getTypeAliasForTypeLiteral(c, t);
      if (typeAlias !== undefined) return symbolToTypeNode(this, typeAlias, SymbolFlags.Type, undefined);
      return this.createCyclicStructurePlaceholder();
    }
    return this.visitAndTransformType(t, TransformKind.ObjectType);
  }

  createTypeNodeFromObjectType(t: Type): Node | undefined {
    const c = this.c;
    if (
      isGenericMappedType(c, t) ||
      ((t.objectFlags & ObjectFlags.Mapped) !== 0 && sideOf(c, t as MappedType).containsError)
    )
      return this.createMappedTypeNodeFromType(t as MappedType);
    const resolved = resolveStructuredTypeMembers(c, t);
    const callSignatures = resolved.callSignatures;
    const constructSignatures = resolved.constructSignatures;
    if (resolved.properties.length === 0 && resolved.indexInfos.length === 0) {
      if (callSignatures.length === 0 && constructSignatures.length === 0) {
        this.approximateLength += 2;
        const result = this.created(new TypeLiteralNode(this.list([])));
        this.context.setEmitFlags(result, EmitFlags.SingleLine);
        return result;
      }
      if (callSignatures.length === 1 && constructSignatures.length === 0)
        return this.signatureToSignatureDeclaration(callSignatures[0]!, SyntaxKind.FunctionType, undefined);
      if (constructSignatures.length === 1 && callSignatures.length === 0)
        return this.signatureToSignatureDeclaration(constructSignatures[0]!, SyntaxKind.ConstructorType, undefined);
    }
    const abstractSignatures = constructSignatures.filter((s) => (s.flags & SignatureFlags.Abstract) !== 0);
    if (abstractSignatures.length > 0) {
      const types: Type[] = [];
      for (const s of abstractSignatures) types.push(getOrCreateTypeFromSignature(c, s));
      // Type elements other than abstract construct signatures.
      let propertyCount = resolved.properties.length;
      if ((this.flags & NodeBuilderFlags.WriteClassExpressionAsTypeLiteral) !== 0) {
        propertyCount = 0;
        for (const p of resolved.properties) if ((p.flags & SymbolFlags.Prototype) === 0) propertyCount++;
      }
      const typeElementCount =
        callSignatures.length +
        (constructSignatures.length - abstractSignatures.length) +
        resolved.indexInfos.length +
        propertyCount;
      // `abstract class C {}` is `abstract new () => C`, not `(abstract new () => C) & {}`.
      if (typeElementCount !== 0) types.push(getResolvedTypeWithoutAbstractConstructSignatures(c, t, resolved));
      return this.typeToTypeNode(getIntersectionType(c, types));
    }
    const savedFlags = this.flags;
    this.flags |= NodeBuilderFlags.InObjectTypeLiteral;
    const members = this.createTypeNodesFromResolvedType(t, resolved);
    this.flags = savedFlags;
    const typeLiteralNode = this.created(new TypeLiteralNode(members ?? this.list([])));
    this.approximateLength += 2;
    this.context.setEmitFlags(
      typeLiteralNode,
      (this.flags & NodeBuilderFlags.MultilineObjectLiterals) !== 0 ? EmitFlags.None : EmitFlags.SingleLine,
    );
    return typeLiteralNode;
  }

  /** The type elements of `t`, whose members are `resolved`. */
  private createTypeNodesFromResolvedType(t: Type, resolved: StructuredType): NodeList | undefined {
    if (this.checkTruncationLength()) {
      if ((this.flags & NodeBuilderFlags.NoTruncation) !== 0) {
        const element = this.created(new NotEmittedTypeElement());
        this.context.addSyntheticTrailingComment(element, SyntaxKind.MultiLineCommentTrivia, 'elided', false);
        return this.list([element]);
      }
      return this.list([
        this.created(
          new PropertySignatureDeclaration(undefined, this.identifier('...'), undefined, undefined, undefined),
        ),
      ]);
    }
    const typeElements: Node[] = [];
    for (const signature of resolved.callSignatures)
      typeElements.push(this.signatureToSignatureDeclaration(signature, SyntaxKind.CallSignature, undefined));
    for (const signature of resolved.constructSignatures) {
      if ((signature.flags & SignatureFlags.Abstract) !== 0) continue;
      typeElements.push(this.signatureToSignatureDeclaration(signature, SyntaxKind.ConstructSignature, undefined));
    }
    for (const info of resolved.indexInfos) {
      // tsgo creates the placeholder for every index signature, and its length counts toward truncation.
      const placeholder = this.createElidedInformationPlaceholder();
      const typeNode =
        (t.objectFlags & ObjectFlags.ReverseMapped) !== 0 &&
        (this.flags & NodeBuilderFlags.AllowAnonymousIdentifier) !== 0
          ? placeholder
          : undefined;
      for (const element of this.indexInfoToObjectComputedNamesOrSignatureDeclaration(info, typeNode))
        typeElements.push(element);
    }
    const properties = resolved.properties;
    if (properties.length === 0) return this.list(typeElements);
    let i = 0;
    for (const propertySymbol of properties) {
      i++;
      if ((this.flags & NodeBuilderFlags.WriteClassExpressionAsTypeLiteral) !== 0) {
        if ((propertySymbol.flags & SymbolFlags.Prototype) !== 0) continue;
        if (
          (getDeclarationModifierFlagsFromSymbol(this.c, propertySymbol, false) &
            (ModifierFlags.Private | ModifierFlags.Protected)) !==
          0
        )
          this.tracker.reportPrivateInBaseOfClassExpression(propertySymbol.name);
        if (isPrivateIdentifierSymbol(propertySymbol))
          this.tracker.reportPrivateInBaseOfClassExpression(symbolName(propertySymbol));
      }
      if (this.checkTruncationLength() && i + 2 < properties.length - 1) {
        if ((this.flags & NodeBuilderFlags.NoTruncation) !== 0) {
          if (typeElements.length > 0)
            this.context.addSyntheticTrailingComment(
              typeElements[typeElements.length - 1]!,
              SyntaxKind.MultiLineCommentTrivia,
              '... ' + (properties.length - i) + ' more elided ...',
              false,
            );
        } else
          typeElements.push(
            this.created(
              new PropertySignatureDeclaration(
                undefined,
                this.identifier('... ' + (properties.length - i) + ' more ...'),
                undefined,
                undefined,
                undefined,
              ),
            ),
          );
        this.addPropertyToElementList(properties[properties.length - 1]!, typeElements);
        break;
      }
      this.addPropertyToElementList(propertySymbol, typeElements);
    }
    return typeElements.length !== 0 ? this.list(typeElements) : undefined;
  }

  private shouldUsePlaceholderForProperty(propertySymbol: Symbol): boolean {
    // Placeholders for reverse mapped types (1) already being written, (2) nested in a mapping
    // over a non-anonymous type, or (3) nested deeply in the same mapped type. They are for display only:
    // declaration emit writes the types.
    if ((this.flags & NodeBuilderFlags.AllowAnonymousIdentifier) === 0) return false;
    if ((propertySymbol.checkFlags & CheckFlags.ReverseMapped) === 0) return false;
    const stack = this.reverseMappedStack;
    if (stack.indexOf(propertySymbol) >= 0) return true;
    if (stack.length > 0) {
      const propertyType = this.c.symbolLinks(stack[stack.length - 1]!).reverseMappedPropertyType;
      if (propertyType !== undefined && (propertyType.objectFlags & ObjectFlags.Anonymous) === 0) return true;
    }
    if (stack.length < maxReverseMappedNestingInspectionDepth) return false;
    const propMappedType = this.c.symbolLinks(propertySymbol).reverseMappedMappedType;
    if (propMappedType === undefined || propMappedType.symbol === undefined) return false;
    for (let i = 0; i < stack.length; i++) {
      if (i > maxReverseMappedNestingInspectionDepth) break;
      const mappedType = this.c.symbolLinks(stack[stack.length - 1 - i]!).reverseMappedMappedType;
      if (mappedType !== undefined && mappedType.symbol === propMappedType.symbol) return true;
    }
    return false;
  }

  trackComputedName(accessExpression: Node, enclosingDeclaration: Node | undefined): void {
    const c = this.c;
    const firstIdentifier = getFirstIdentifier(accessExpression);
    const name = resolveName(
      c,
      enclosingDeclaration,
      getText(firstIdentifier),
      SymbolFlags.Value | SymbolFlags.ExportValue,
      undefined,
      true,
      false,
    );
    if (name !== undefined) {
      this.trackSymbol(name, enclosingDeclaration, SymbolFlags.Value);
      return;
    }
    // Unresolved at the target: track the symbol at its own location, which is inaccessible.
    const fallback = resolveName(
      c,
      firstIdentifier,
      getText(firstIdentifier),
      SymbolFlags.Value | SymbolFlags.ExportValue,
      undefined,
      true,
      false,
    );
    if (fallback !== undefined) this.trackSymbol(fallback, enclosingDeclaration, SymbolFlags.Value);
  }

  private addPropertyToElementList(propertySymbol: Symbol, typeElements: Node[]): void {
    const c = this.c;
    const propertyIsReverseMapped = (propertySymbol.checkFlags & CheckFlags.ReverseMapped) !== 0;
    const propertyType = this.shouldUsePlaceholderForProperty(propertySymbol)
      ? c.anyType
      : getNonMissingTypeOfSymbol(c, propertySymbol);
    const saveEnclosingDeclaration = this.enclosingDeclaration;
    this.enclosingDeclaration = undefined;
    if (isLateBoundName(propertySymbol.name)) {
      if (declarationCount(propertySymbol) > 0) {
        const decl = propertySymbol.declaration!;
        if (hasLateBindableName(c, decl)) {
          if (decl instanceof BinaryExpression) {
            const name = getNameOfDeclaration(decl);
            if (
              name instanceof ElementAccessExpression &&
              isPropertyAccessEntityNameExpression(name.argumentExpression)
            )
              this.trackComputedName(name.argumentExpression, saveEnclosingDeclaration);
          } else this.trackComputedName(getExpression(getName(decl)!)!, saveEnclosingDeclaration);
        }
      } else this.tracker.reportNonSerializableProperty(symbolToString(c, propertySymbol));
    }
    this.enclosingDeclaration =
      propertySymbol.valueDeclaration ??
      (declarationCount(propertySymbol) > 0 ? propertySymbol.declaration! : saveEnclosingDeclaration);
    const propertyName = getPropertyNameNodeForSymbol(this, propertySymbol, saveEnclosingDeclaration);
    this.enclosingDeclaration = saveEnclosingDeclaration;
    this.approximateLength += symbolName(propertySymbol).length + 1;
    if ((propertySymbol.flags & SymbolFlags.Accessor) !== 0) {
      const writeType = getWriteTypeOfSymbol(c, propertySymbol);
      if (!isErrorType(c, propertyType) && !isErrorType(c, writeType)) {
        const propDeclaration = getDeclarationOfKind(propertySymbol, SyntaxKind.PropertyDeclaration);
        const parentIsClass =
          propertySymbol.parent !== undefined && (propertySymbol.parent.flags & SymbolFlags.Class) !== 0;
        if (propertyType !== writeType || (parentIsClass && propDeclaration === undefined)) {
          const symbolMapper = c.symbolMappers.get(getSymbolId(propertySymbol));
          const getterDeclaration = getDeclarationOfKind(propertySymbol, SyntaxKind.GetAccessor);
          if (getterDeclaration !== undefined) {
            let getterSignature = getSignatureFromDeclaration(c, getterDeclaration);
            if (symbolMapper !== undefined) getterSignature = instantiateSignature(c, getterSignature, symbolMapper);
            const getter = this.signatureToSignatureDeclaration(
              getterSignature,
              SyntaxKind.GetAccessor,
              new SignatureDeclarationOptions([], propertyName, undefined),
            );
            this.setCommentRange(getter, getterDeclaration);
            typeElements.push(getter);
          }
          const setterDeclaration = getDeclarationOfKind(propertySymbol, SyntaxKind.SetAccessor);
          if (setterDeclaration !== undefined) {
            let setterSignature = getSignatureFromDeclaration(c, setterDeclaration);
            if (symbolMapper !== undefined) setterSignature = instantiateSignature(c, setterSignature, symbolMapper);
            const setter = this.signatureToSignatureDeclaration(
              setterSignature,
              SyntaxKind.SetAccessor,
              new SignatureDeclarationOptions([], propertyName, undefined),
            );
            this.setCommentRange(setter, setterDeclaration);
            typeElements.push(setter);
          }
          return;
        }
        if (parentIsClass && propDeclaration !== undefined && hasAccessorKeyword(propDeclaration)) {
          const fakeGetterSignature = c.newSignature(
            SignatureFlags.None,
            undefined,
            [],
            undefined,
            [],
            propertyType,
            0,
          );
          const fakeGetter = this.signatureToSignatureDeclaration(
            fakeGetterSignature,
            SyntaxKind.GetAccessor,
            new SignatureDeclarationOptions([], propertyName, undefined),
          );
          this.setCommentRange(fakeGetter, propDeclaration);
          typeElements.push(fakeGetter);
          const setterParam = c.newSymbol(SymbolFlags.FunctionScopedVariable, 'arg');
          c.symbolTypes.set(getSymbolId(setterParam), writeType);
          const fakeSetterSignature = c.newSignature(
            SignatureFlags.None,
            undefined,
            [],
            undefined,
            [setterParam],
            c.voidType,
            0,
          );
          typeElements.push(
            this.signatureToSignatureDeclaration(
              fakeSetterSignature,
              SyntaxKind.SetAccessor,
              new SignatureDeclarationOptions([], propertyName, undefined),
            ),
          );
          return;
        }
      }
    }
    const optionalToken =
      (propertySymbol.flags & SymbolFlags.Optional) !== 0 ? this.token(SyntaxKind.QuestionToken) : undefined;
    if (
      (propertySymbol.flags & (SymbolFlags.Function | SymbolFlags.Method)) !== 0 &&
      getPropertiesOfObjectType(c, propertyType).length === 0 &&
      !isReadonlySymbol(c, propertySymbol)
    ) {
      const signatures = getSignaturesOfType(
        c,
        filterType(c, propertyType, (u) => (u.flags & TypeFlags.Undefined) === 0),
        SignatureKind.Call,
      );
      for (const signature of signatures) {
        const methodDeclaration = this.signatureToSignatureDeclaration(
          signature,
          SyntaxKind.MethodSignature,
          new SignatureDeclarationOptions([], propertyName, optionalToken),
        );
        this.setCommentRange(methodDeclaration, signature.declaration ?? propertySymbol.valueDeclaration);
        typeElements.push(methodDeclaration);
      }
      if (signatures.length !== 0 || optionalToken === undefined) return;
    }
    let propertyTypeNode: Node;
    if (this.shouldUsePlaceholderForProperty(propertySymbol))
      propertyTypeNode = this.createElidedInformationPlaceholder();
    else {
      if (propertyIsReverseMapped) this.reverseMappedStack.push(propertySymbol);
      propertyTypeNode = this.serializeTypeForDeclaration(undefined, propertyType, propertySymbol, true);
      if (propertyIsReverseMapped) this.reverseMappedStack.pop();
    }
    let modifiers: ModifierList | undefined = undefined;
    if (isReadonlySymbol(c, propertySymbol)) {
      modifiers = this.modifierList([this.token(SyntaxKind.ReadonlyKeyword)]);
      this.approximateLength += 9;
    }
    const propertySignature = this.created(
      new PropertySignatureDeclaration(modifiers, propertyName, optionalToken, propertyTypeNode, undefined),
    );
    this.setCommentRange(propertySignature, propertySymbol.valueDeclaration);
    typeElements.push(propertySignature);
  }

  setCommentRange(node: Node, range: Node | undefined): void {
    // Comments are copied only within the file being written, for declaration emit.
    if (range !== undefined && this.enclosingFile !== undefined && this.enclosingFile === getSourceFileOfNode(range))
      this.context.assignCommentRange(node, range);
  }

  private isDeclaredInEnclosingFile(symbol: Symbol): boolean {
    for (const d of getDeclarations(symbol)) if (getSourceFileOfNode(d) === this.enclosingFile) return true;
    return false;
  }

  private areTriviallySerializableComputedNames(components: readonly Node[]): boolean {
    for (const e of components) if (!this.isTriviallySerializableComputedName(e)) return false;
    return true;
  }

  private isTriviallySerializableComputedName(e: Node): boolean {
    const name = getName(e);
    if (name === undefined || name.kind !== SyntaxKind.ComputedPropertyName) return false;
    const expression = getExpression(name)!;
    if (!isEntityNameExpression(expression, false)) return false;
    return (
      isEntityNameVisible(this.c, expression, this.enclosingDeclaration!).accessibility ===
      SymbolAccessibility.Accessible
    );
  }

  private indexInfoToObjectComputedNamesOrSignatureDeclaration(
    indexInfo: IndexInfo,
    typeNode: Node | undefined,
  ): Node[] {
    const components = indexInfo.components;
    // An index info from computed property names is written as those names when all are visible `a.b.c`.
    if (
      components.length > 0 &&
      this.enclosingDeclaration !== undefined &&
      this.areTriviallySerializableComputedNames(components)
    ) {
      const results: Node[] = [];
      let bailed = false;
      for (const e of components) {
        // Late-bound members are written as properties anyway.
        if (hasLateBindableName(this.c, e)) continue;
        const eName = getName(e)!;
        const name = tryReuseExistingNode(this, eName);
        if (name === undefined) {
          bailed = true;
          break;
        }
        this.trackComputedName(getExpression(eName)!, this.enclosingDeclaration);
        const modifiers = indexInfo.isReadonly
          ? this.modifierList([this.token(SyntaxKind.ReadonlyKeyword)])
          : undefined;
        const postfixToken = getPostfixToken(e);
        const signature = this.created(
          new PropertySignatureDeclaration(
            modifiers,
            name,
            postfixToken === undefined ? undefined : this.token(postfixToken.kind),
            typeNode !== undefined ? typeNode.deepClone() : this.typeToTypeNode(getTypeOfSymbol(this.c, getSymbol(e)!)),
            undefined,
          ),
        );
        signature.pos = e.pos;
        signature.end = e.end;
        results.push(signature);
      }
      if (!bailed) return results;
    }
    return [this.indexInfoToIndexSignatureDeclaration(indexInfo, typeNode)];
  }

  indexInfoToIndexSignatureDeclaration(indexInfo: IndexInfo, typeNode: Node | undefined): Node {
    const name = getNameFromIndexInfo(indexInfo);
    const indexerTypeNode = this.typeToTypeNode(indexInfo.keyType);
    const indexingParameter = this.created(
      new ParameterDeclaration(undefined, undefined, this.identifier(name), undefined, indexerTypeNode, undefined),
    );
    const valueTypeNode = typeNode ?? this.typeToTypeNode(indexInfo.valueType);
    this.approximateLength += name.length + 4;
    let modifiers: ModifierList | undefined = undefined;
    if (indexInfo.isReadonly) {
      this.approximateLength += 9;
      modifiers = this.modifierList([this.token(SyntaxKind.ReadonlyKeyword)]);
    }
    return this.created(new IndexSignatureDeclaration(modifiers, this.list([indexingParameter]), valueTypeNode));
  }

  // ---- Mapped types

  private isMappedTypeHomomorphic(mapped: MappedType): boolean {
    return getHomomorphicTypeVariable(this.c, mapped) !== undefined;
  }

  private isHomomorphicMappedTypeWithNonHomomorphicInstantiation(mapped: MappedType): boolean {
    return (
      mapped.target !== undefined &&
      !this.isMappedTypeHomomorphic(mapped) &&
      this.isMappedTypeHomomorphic(mapped.target as MappedType)
    );
  }

  private createMappedTypeNodeFromType(t: MappedType): Node | undefined {
    const c = this.c;
    const declaration = t.declaration as MappedTypeNode;
    const readonlyToken =
      declaration.readonlyToken !== undefined ? this.token(declaration.readonlyToken.kind) : undefined;
    const questionToken =
      declaration.questionToken !== undefined ? this.token(declaration.questionToken.kind) : undefined;
    let appropriateConstraintTypeNode: Node;
    let newTypeVariable: TypeReferenceNode | undefined = undefined;
    let templateType = getTemplateTypeFromMappedType(c, t);
    const typeParameter = getTypeParameterFromMappedType(c, t);
    const generateNames = (this.flags & NodeBuilderFlags.GenerateNamesForShadowedTypeParams) !== 0;
    // A mapped type preserving modifiers without a `keyof` constraint needs a wrapper to keep
    // preserving them when inlined.
    const constraintType = getConstraintTypeFromMappedType(c, t);
    const needsModifierPreservingWrapper =
      !isMappedTypeWithKeyofConstraintDeclaration(c, t) &&
      (getModifiersTypeFromMappedType(c, t).flags & TypeFlags.Unknown) === 0 &&
      generateNames &&
      !(
        (constraintType.flags & TypeFlags.TypeParameter) !== 0 &&
        ((getConstraintOfTypeParameter(c, constraintType)?.flags ?? 0) & TypeFlags.Index) !== 0
      );
    if (isMappedTypeWithKeyofConstraintDeclaration(c, t)) {
      // `{ [P in keyof T]: X }` keeps its `keyof`, which distribution may lose.
      if (generateNames && this.isHomomorphicMappedTypeWithNonHomomorphicInstantiation(t)) {
        const newConstraintParam = c.newTypeParameter(c.newSymbol(SymbolFlags.TypeParameter, 'T'));
        const name = this.typeParameterToName(newConstraintParam);
        const target = t.target as MappedType;
        newTypeVariable = this.typeReference(name, undefined) as TypeReferenceNode;
        templateType = instantiateType(
          c,
          getTemplateTypeFromMappedType(c, target),
          newTypeMapper(
            [getTypeParameterFromMappedType(c, target), getModifiersTypeFromMappedType(c, target)],
            [typeParameter, newConstraintParam],
          ),
        );
      }
      let indexTarget: Node;
      if (newTypeVariable !== undefined) indexTarget = newTypeVariable;
      else indexTarget = this.typeToTypeNode(getModifiersTypeFromMappedType(c, t))!;
      appropriateConstraintTypeNode = this.created(new TypeOperatorNode(SyntaxKind.KeyOfKeyword, indexTarget));
    } else if (needsModifierPreservingWrapper) {
      // `{ [K in T_1]: Template }` with a new type variable as the constraint.
      const newParam = c.newTypeParameter(c.newSymbol(SymbolFlags.TypeParameter, 'T'));
      const name = this.typeParameterToName(newParam);
      newTypeVariable = this.typeReference(name, undefined) as TypeReferenceNode;
      appropriateConstraintTypeNode = newTypeVariable;
    } else appropriateConstraintTypeNode = this.typeToTypeNode(constraintType)!;
    // The name and template types are in the new scope.
    const exit = this.enterNewScope(declaration, undefined, [typeParameter], undefined, undefined);
    const typeParameterNode = this.typeParameterToDeclarationWithConstraint(
      typeParameter,
      appropriateConstraintTypeNode,
    );
    let nameTypeNode: Node | undefined = undefined;
    if (declaration.nameType !== undefined) nameTypeNode = this.typeToTypeNode(getNameTypeFromMappedType(c, t));
    const templateTypeNode = this.typeToTypeNode(
      removeMissingType(c, templateType, (getMappedTypeModifiers(t) & MappedTypeModifiers.IncludeOptional) !== 0),
    );
    exit();
    const result = this.created(
      new MappedTypeNode(readonlyToken, typeParameterNode, nameTypeNode, questionToken, templateTypeNode, undefined),
    );
    this.approximateLength += 10;
    this.context.addEmitFlags(result, EmitFlags.SingleLine);
    if (generateNames && this.isHomomorphicMappedTypeWithNonHomomorphicInstantiation(t)) {
      // `ModifiersType extends infer U ? { ...mapped type... } : never` stays homomorphic.
      const declaredConstraint = getEffectiveConstraint(declaration.typeParameter);
      let rawConstraint =
        declaredConstraint !== undefined && getType(declaredConstraint) !== undefined
          ? this.getTypeFromTypeNode(getType(declaredConstraint)!, false)
          : undefined;
      if (rawConstraint !== undefined) rawConstraint = getConstraintOfTypeParameter(c, rawConstraint);
      const originalConstraint = instantiateType(c, rawConstraint ?? c.unknownType, t.mapper);
      const originalConstraintNode =
        (originalConstraint.flags & TypeFlags.Unknown) === 0 ? this.typeToTypeNode(originalConstraint) : undefined;
      return this.created(
        new ConditionalTypeNode(
          this.typeToTypeNode(getModifiersTypeFromMappedType(c, t))!,
          this.created(
            new InferTypeNode(
              this.created(
                new TypeParameterDeclaration(
                  undefined,
                  this.factory.cloneIdentifier(newTypeVariable!.typeName as Identifier),
                  originalConstraintNode,
                  undefined,
                  undefined,
                ),
              ),
            ),
          ),
          result,
          this.keyword(SyntaxKind.NeverKeyword),
        ),
      );
    }
    if (needsModifierPreservingWrapper) {
      // `ConstraintType extends infer T_1 extends keyof ModifiersType ? { [K in T_1]: Template } : never`.
      return this.created(
        new ConditionalTypeNode(
          this.typeToTypeNode(constraintType)!,
          this.created(
            new InferTypeNode(
              this.created(
                new TypeParameterDeclaration(
                  undefined,
                  this.factory.cloneIdentifier(newTypeVariable!.typeName as Identifier),
                  this.created(
                    new TypeOperatorNode(
                      SyntaxKind.KeyOfKeyword,
                      this.typeToTypeNode(getModifiersTypeFromMappedType(c, t))!,
                    ),
                  ),
                  undefined,
                  undefined,
                ),
              ),
            ),
          ),
          result,
          this.keyword(SyntaxKind.NeverKeyword),
        ),
      );
    }
    return result;
  }

  // ---- Type parameters

  typeParameterToName(typeParameter: Type): Identifier {
    const generateNames = (this.flags & NodeBuilderFlags.GenerateNamesForShadowedTypeParams) !== 0;
    if (generateNames) {
      const cached = this.typeParameterNames?.get(typeParameter.id);
      if (cached !== undefined) return cached;
    }
    let result = symbolToName(this, typeParameter.symbol!, SymbolFlags.Type, true);
    if (!(result instanceof Identifier)) return this.identifier('(Missing type parameter)');
    const symbol = typeParameter.symbol;
    if (symbol !== undefined && declarationCount(symbol) > 0) {
      const decl = symbol.declaration!;
      if (decl.kind === SyntaxKind.TypeParameter) result = this.setTextRange(result, getName(decl)) as Identifier;
    }
    if (generateNames) {
      const rawText = (result as Identifier).text;
      let i = this.typeParameterNamesByTextNextNameCount?.get(rawText) ?? 0;
      let text = rawText;
      while (
        this.typeParameterNamesByText?.has(text) === true ||
        this.typeParameterShadowsOtherTypeParameterInScope(text, typeParameter)
      ) {
        i++;
        text = rawText + '_' + i;
      }
      if (text !== rawText) result = this.identifier(text);
      // Caching the largest suffix saves iterations when it grows large.
      const nextNameCount = this.typeParameterNamesByTextNextNameCount ?? new Map<string, number>();
      const names = this.typeParameterNames ?? new Map<number, Identifier>();
      const namesByText = this.typeParameterNamesByText ?? new Set<string>();
      nextNameCount.set(rawText, i);
      names.set(typeParameter.id, result as Identifier);
      namesByText.add(text);
      this.typeParameterNamesByTextNextNameCount = nextNameCount;
      this.typeParameterNames = names;
      this.typeParameterNamesByText = namesByText;
    }
    return result as Identifier;
  }

  private typeParameterShadowsOtherTypeParameterInScope(name: string, typeParameter: Type): boolean {
    const result = resolveName(this.c, this.enclosingDeclaration, name, SymbolFlags.Type, undefined, false, false);
    return result !== undefined && (result.flags & SymbolFlags.TypeParameter) !== 0 && result !== typeParameter.symbol;
  }

  typeParameterToDeclarationWithConstraint(
    typeParameter: Type,
    constraintNode: Node | undefined,
  ): TypeParameterDeclaration {
    const savedFlags = this.flags;
    // Avoids an infinite loop on a generic in a qualified name.
    this.flags &= ~NodeBuilderFlags.WriteTypeParametersInQualifiedName;
    const modifiers = this.factory.createModifiersFromFlags(getTypeParameterModifiers(typeParameter));
    const name = this.typeParameterToName(typeParameter);
    const defaultParameter = getDefaultFromTypeParameter(this.c, typeParameter);
    const defaultNode = defaultParameter !== undefined ? this.typeToTypeNode(defaultParameter) : undefined;
    this.flags = savedFlags;
    return this.created(
      new TypeParameterDeclaration(
        modifiers.nodes.length > 0 ? modifiers : undefined,
        name,
        constraintNode,
        undefined,
        defaultNode,
      ),
    );
  }

  typeParameterToDeclaration(parameter: Type): TypeParameterDeclaration {
    const constraint = getConstraintOfTypeParameter(this.c, parameter);
    const constraintNode =
      constraint !== undefined
        ? this.typeToTypeNodeWithPossibleReusableTypeNode(constraint, getConstraintDeclaration(parameter))
        : undefined;
    return this.typeParameterToDeclarationWithConstraint(parameter, constraintNode);
  }

  /** The type node for `t`, reusing `typeNode` if it denotes `t`. */
  private typeToTypeNodeWithPossibleReusableTypeNode(
    t: Type | undefined,
    typeNode: Node | undefined,
  ): Node | undefined {
    if (t === undefined) return this.keyword(SyntaxKind.AnyKeyword);
    if (typeNode !== undefined && this.getTypeFromTypeNode(typeNode, false) === t) {
      const reused = tryReuseExistingNode(this, typeNode);
      if (reused !== undefined) return reused;
    }
    return this.typeToTypeNode(t);
  }

  typeParametersToTypeParameterDeclarations(symbol: Symbol): Node[] {
    const c = this.c;
    const targetSymbol = getTargetSymbol(c, symbol);
    const results: Node[] = [];
    if ((targetSymbol.flags & (SymbolFlags.Class | SymbolFlags.Interface | SymbolFlags.Alias)) !== 0) {
      for (const param of getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, symbol))
        results.push(this.typeParameterToDeclaration(param));
    } else if ((targetSymbol.flags & SymbolFlags.Function) !== 0 && symbol.valueDeclaration !== undefined) {
      for (const param of getTypeParametersFromDeclaration(c, symbol.valueDeclaration))
        results.push(this.typeParameterToDeclaration(param));
    }
    return results;
  }

  getTypeParametersOfClassOrInterface(symbol: Symbol): Type[] {
    const declared = getDeclaredTypeOfClassOrInterface(this.c, symbol);
    return declared.outerTypeParameters().concat(declared.localTypeParameters());
  }

  // ---- Signatures

  signatureToSignatureDeclaration(
    signature: Signature,
    kind: SyntaxKind,
    options: SignatureDeclarationOptions | undefined,
  ): Node {
    const c = this.c;
    const exit = this.enterSignatureScope(signature);
    const expandedParams = this.expandedParameters;
    // Usually more, but 3 is the minimum.
    this.approximateLength += 3;
    const typeParameters: Node[] = [];
    if (
      (this.flags & NodeBuilderFlags.WriteTypeArgumentsOfSignature) !== 0 &&
      signature.target !== undefined &&
      signature.mapper !== undefined &&
      signature.target.typeParameters.length !== 0
    ) {
      for (const parameter of signature.target.typeParameters) {
        const node = this.typeToTypeNode(instantiateType(c, parameter, signature.mapper));
        if (node !== undefined) typeParameters.push(node);
      }
    } else
      for (const parameter of signature.typeParameters) typeParameters.push(this.typeParameterToDeclaration(parameter));
    const savedFlags = this.flags;
    this.flags &= ~NodeBuilderFlags.SuppressAnyReturnType;
    // An expanded parameter list with a variadic before its end isn't used.
    let useOriginal = false;
    for (const p of expandedParams)
      if (p !== expandedParams[expandedParams.length - 1] && (p.checkFlags & CheckFlags.RestParameter) !== 0)
        useOriginal = true;
    const parameters: Node[] = [];
    const thisParameter =
      (this.flags & NodeBuilderFlags.OmitThisParameter) !== 0
        ? undefined
        : this.tryGetThisParameterDeclaration(signature);
    if (thisParameter !== undefined) parameters.push(thisParameter);
    for (const parameter of useOriginal ? signature.parameters : expandedParams)
      parameters.push(this.symbolToParameterDeclaration(parameter, kind === SyntaxKind.Constructor));
    this.flags = savedFlags;
    let returnTypeNode = this.serializeReturnTypeForSignature(signature);
    let modifiers = options !== undefined ? options.modifiers : [];
    if (kind === SyntaxKind.ConstructorType && (signature.flags & SignatureFlags.Abstract) !== 0) {
      let flags = ModifierFlags.Abstract;
      for (const m of modifiers) flags |= modifierToFlag(m.kind);
      modifiers = this.factory.createModifiersFromFlags(flags).nodes;
    }
    const paramList = this.list(parameters);
    const typeParamList = typeParameters.length !== 0 ? this.list(typeParameters) : undefined;
    const modifierList = this.modifierList(modifiers);
    const name = (options !== undefined ? options.name : undefined) ?? this.identifier('');
    let node: Node;
    switch (kind) {
      case SyntaxKind.CallSignature:
        node = this.created(new CallSignatureDeclaration(typeParamList, paramList, returnTypeNode));
        break;
      case SyntaxKind.ConstructSignature:
        node = this.created(new ConstructSignatureDeclaration(typeParamList, paramList, returnTypeNode));
        break;
      case SyntaxKind.MethodSignature:
        node = this.created(
          new MethodSignatureDeclaration(
            modifierList,
            name,
            options !== undefined ? options.questionToken : undefined,
            typeParamList,
            paramList,
            returnTypeNode,
          ),
        );
        break;
      case SyntaxKind.MethodDeclaration:
        node = this.created(
          new MethodDeclaration(
            modifierList,
            undefined,
            name,
            undefined,
            typeParamList,
            paramList,
            returnTypeNode,
            undefined,
            undefined,
          ),
        );
        break;
      case SyntaxKind.Constructor:
        node = this.created(
          new ConstructorDeclaration(modifierList, undefined, paramList, undefined, undefined, undefined),
        );
        break;
      case SyntaxKind.GetAccessor:
        node = this.created(
          new GetAccessorDeclaration(modifierList, name, undefined, paramList, returnTypeNode, undefined, undefined),
        );
        break;
      case SyntaxKind.SetAccessor:
        node = this.created(
          new SetAccessorDeclaration(modifierList, name, undefined, paramList, undefined, undefined, undefined),
        );
        break;
      case SyntaxKind.IndexSignature:
        node = this.created(new IndexSignatureDeclaration(modifierList, paramList, returnTypeNode));
        break;
      case SyntaxKind.FunctionType:
        if (returnTypeNode === undefined) returnTypeNode = this.typeReference(this.identifier(''), undefined);
        node = this.created(new FunctionTypeNode(typeParamList, paramList, returnTypeNode));
        break;
      case SyntaxKind.ConstructorType:
        if (returnTypeNode === undefined) returnTypeNode = this.typeReference(this.identifier(''), undefined);
        node = this.created(new ConstructorTypeNode(modifierList, typeParamList, paramList, returnTypeNode));
        break;
      case SyntaxKind.FunctionDeclaration:
        node = this.created(
          new FunctionDeclaration(
            modifierList,
            undefined,
            name as Identifier,
            typeParamList,
            paramList,
            returnTypeNode,
            undefined,
            undefined,
          ),
        );
        break;
      case SyntaxKind.FunctionExpression:
        node = this.created(
          new FunctionExpression(
            modifierList,
            undefined,
            name as Identifier,
            typeParamList,
            paramList,
            returnTypeNode,
            undefined,
            this.created(new Block(this.list([]), false)),
          ),
        );
        break;
      case SyntaxKind.ArrowFunction:
        node = this.created(
          new ArrowFunction(
            modifierList,
            typeParamList,
            paramList,
            returnTypeNode,
            undefined,
            undefined,
            this.created(new Block(this.list([]), false)),
          ),
        );
        break;
      default:
        throw new Error('Unhandled kind in signatureToSignatureDeclaration');
    }
    exit();
    return node;
  }

  private tryGetThisParameterDeclaration(signature: Signature): Node | undefined {
    if (signature.thisParameter !== undefined) return this.symbolToParameterDeclaration(signature.thisParameter, false);
    return undefined;
  }

  symbolToParameterDeclaration(parameterSymbol: Symbol, preserveModifierFlags: boolean): Node {
    const c = this.c;
    const parameterDeclaration = getEffectiveParameterDeclaration(parameterSymbol);
    const parameterType = getTypeOfSymbol(c, parameterSymbol);
    const parameterTypeNode = this.serializeTypeForDeclaration(
      parameterDeclaration,
      parameterType,
      parameterSymbol,
      true,
    );
    let modifiers: ModifierList | undefined = undefined;
    if (
      (this.flags & NodeBuilderFlags.OmitParameterModifiers) === 0 &&
      preserveModifierFlags &&
      parameterDeclaration !== undefined
    ) {
      const original = getModifiers(parameterDeclaration);
      if (original !== undefined) {
        // Copies keep the source positions and flags, as tsgo does; its positions are UTF-8 offsets.
        const text = getSourceFileOfNode(parameterDeclaration).text;
        const clones: Node[] = [];
        for (const m of original.nodes) {
          if (!isModifierKind(m.kind)) continue;
          const clone = m.deepClone();
          clone.pos = utf8Offset(text, m.pos) | 0;
          clone.end = utf8Offset(text, m.end) | 0;
          clones.push(clone);
        }
        modifiers = this.modifierList(clones);
      }
    }
    const isRest =
      (parameterDeclaration instanceof ParameterDeclaration && parameterDeclaration.dotDotDotToken !== undefined) ||
      (parameterSymbol.checkFlags & CheckFlags.RestParameter) !== 0;
    const name = this.parameterToParameterDeclarationName(parameterSymbol, parameterDeclaration);
    const isOptional =
      (parameterDeclaration !== undefined && isOptionalParameter(c, parameterDeclaration)) ||
      (parameterSymbol.checkFlags & CheckFlags.OptionalParameter) !== 0;
    const parameterNode = this.created(
      new ParameterDeclaration(
        modifiers,
        isRest ? this.token(SyntaxKind.DotDotDotToken) : undefined,
        name,
        isOptional ? this.token(SyntaxKind.QuestionToken) : undefined,
        parameterTypeNode,
        undefined,
      ),
    );
    this.approximateLength += parameterSymbol.name.length + 3;
    return parameterNode;
  }

  parameterToParameterDeclarationName(parameterSymbol: Symbol, parameterDeclaration: Node | undefined): Node {
    const name = parameterDeclaration === undefined ? undefined : getName(parameterDeclaration);
    if (name === undefined) return this.identifier(parameterSymbol.name);
    switch (name.kind) {
      case SyntaxKind.Identifier: {
        const cloned = this.cloneSynthesized(name);
        this.context.setEmitFlags(cloned, EmitFlags.NoAsciiEscaping);
        return cloned;
      }
      case SyntaxKind.QualifiedName: {
        const cloned = this.cloneSynthesized((name as QualifiedName).right);
        this.context.setEmitFlags(cloned, EmitFlags.NoAsciiEscaping);
        return cloned;
      }
    }
    return cloneBindingName(this, name);
  }

  /**
   * A copy of `node`'s subtree without positions, as tsgo's `DeepCloneNode`: each copy has its
   * node as original, and so its emit flags.
   */
  deepCloneNode(node: Node): Node {
    const clone = node.deepClone();
    clearPositions(clone);
    linkClones(this.context, clone, node);
    return clone;
  }

  /** A copy of `node` without positions. */
  cloneSynthesized(node: Node): Node {
    const clone = node.deepClone();
    clearPositions(clone);
    return clone;
  }

  /**
   * The type node for `t` declared by `declaration` (or `symbol`'s declaration). A symbol's own
   * `unique symbol` type is written as such rather than `typeof symbol`.
   */
  serializeTypeForDeclaration(
    declaration: Node | undefined,
    type: Type | undefined,
    symbol: Symbol | undefined,
    tryReuse: boolean,
  ): Node {
    const c = this.c;
    if (declaration === undefined && symbol !== undefined)
      declaration = symbol.valueDeclaration ?? (declarationCount(symbol) > 0 ? symbol.declaration! : undefined);
    if (symbol === undefined && declaration !== undefined) symbol = getSymbolOfDeclaration(c, declaration);
    let t = type;
    // A variable named by a binding pattern has no symbol.
    if (t === undefined && symbol === undefined && declaration !== undefined && isVariableLike(declaration))
      t = getTypeForVariableLikeDeclaration(c, declaration, false);
    if (t === undefined && symbol !== undefined) {
      t = this.enclosingSymbolTypes.get(getSymbolId(symbol));
      if (t === undefined) {
        if (
          (symbol.flags & SymbolFlags.Accessor) !== 0 &&
          declaration !== undefined &&
          declaration.kind === SyntaxKind.SetAccessor
        )
          t = instantiateType(c, getWriteTypeOfSymbol(c, symbol), this.mapper);
        else if ((symbol.flags & (SymbolFlags.TypeLiteral | SymbolFlags.Signature)) === 0)
          t = instantiateType(c, getWidenedLiteralType(c, getTypeOfSymbol(c, symbol)), this.mapper);
        else t = c.errorType;
      }
    }
    if (t === undefined) t = c.errorType;
    if (this.pseudo !== undefined) return this.serializeTypeForDeclarationReusing(declaration, t, symbol, tryReuse);
    if (
      declaration !== undefined &&
      declaration.kind === SyntaxKind.Parameter &&
      requiresAddingImplicitUndefined(c, declaration, this.enclosingDeclaration)
    )
      t = getOptionalType(c, t, false);
    const savedFlags = this.flags;
    if (
      (t.flags & TypeFlags.UniqueESSymbol) !== 0 &&
      symbol !== undefined &&
      t.symbol === symbol &&
      (this.enclosingDeclaration === undefined || this.isDeclaredInEnclosingFile(symbol))
    )
      this.flags |= NodeBuilderFlags.AllowUniqueESSymbolType;
    const result = this.typeToTypeNode(t);
    this.flags = savedFlags;
    return result ?? this.keyword(SyntaxKind.AnyKeyword);
  }

  /** `serializeTypeForDeclaration` with declaration emit's reuse of what the source wrote. */
  private serializeTypeForDeclarationReusing(
    declaration: Node | undefined,
    typeIn: Type,
    symbol: Symbol | undefined,
    tryReuse: boolean,
  ): Node {
    const c = this.c;
    const pseudo = this.pseudo!;
    let t = typeIn;
    const isPropertyLike =
      declaration !== undefined &&
      (declaration.kind === SyntaxKind.Parameter ||
        declaration.kind === SyntaxKind.PropertySignature ||
        declaration.kind === SyntaxKind.PropertyDeclaration);
    const requiresAddingUndefined =
      isPropertyLike &&
      requiresAddingImplicitUndefinedForDeclaration(c, declaration!, symbol, this.enclosingDeclaration);
    if (requiresAddingUndefined && declaration!.kind === SyntaxKind.Parameter) t = getOptionalType(c, t, false);
    const savedFlags = this.flags;
    if (
      (t.flags & TypeFlags.UniqueESSymbol) !== 0 &&
      symbol !== undefined &&
      t.symbol === symbol &&
      (this.enclosingDeclaration === undefined || this.isDeclaredInEnclosingFile(symbol))
    )
      this.flags |= NodeBuilderFlags.AllowUniqueESSymbolType;
    let result: Node | undefined = undefined;
    let reportedInferenceFallback = false;
    if (
      tryReuse &&
      this.enclosingDeclaration !== undefined &&
      declaration !== undefined &&
      (isAccessorKind(declaration) ||
        (hasInferredTypeKind(declaration) &&
          (declaration.flags & NodeFlags.Synthesized) === 0 &&
          (t.objectFlags & ObjectFlags.RequiresWidening) === 0))
    ) {
      const remove = symbol !== undefined ? this.addSymbolTypeToContext(symbol, t) : undefined;
      let pt: PseudoType = isAccessorKind(declaration)
        ? pseudo.getTypeOfAccessor(declaration)
        : pseudo.getTypeOfDeclaration(declaration);
      if (
        pt.kind === PseudoTypeKind.NoResult &&
        declaration.kind === SyntaxKind.BinaryExpression &&
        symbol !== undefined
      ) {
        // The first annotated assignment declares the type for the rest. A type alias's type isn't an annotation.
        for (const d of getDeclarations(symbol))
          if (
            getType(d) !== undefined &&
            d.kind !== SyntaxKind.TypeAliasDeclaration &&
            d.kind !== SyntaxKind.JSTypeAliasDeclaration
          ) {
            pt = pseudo.getTypeOfDeclaration(d);
            break;
          }
      }
      const reportErrors = !this.suppressReportInferenceFallback;
      if (
        pseudoTypeEquivalentToType(
          this,
          pt,
          t,
          !requiresAddingUndefined && isPropertyLike && hasQuestionToken(declaration),
          reportErrors,
        )
      ) {
        const ptt = pseudoTypeToType(this, pt);
        if (
          ptt !== undefined &&
          requiresAddingUndefined &&
          containsNonMissingUndefinedType(c, t) &&
          !containsNonMissingUndefinedType(c, ptt)
        )
          pt = new PseudoUnionType([pt, pseudoUndefinedType]);
        result = pseudoTypeToNodeWithCheckerFallback(this, pt, t);
      } else {
        // Errors reported inside an inferred pseudo-type aren't reported again by the fallback.
        reportedInferenceFallback = reportErrors && pt instanceof InferredType && pt.errorNodes.length > 0;
        let shouldAddUndefined = false;
        if (requiresAddingUndefined) {
          const ptt = pseudoTypeToType(this, pt);
          shouldAddUndefined =
            ptt !== undefined ? !containsNonMissingUndefinedType(c, ptt) : !couldAlreadyReferToUndefined(pt);
        }
        if (shouldAddUndefined) {
          pt = new PseudoUnionType([pt, pseudoUndefinedType]);
          if (pseudoTypeEquivalentToType(this, pt, t, false, reportErrors)) {
            result = pseudoTypeToNodeWithCheckerFallback(this, pt, t);
            reportedInferenceFallback = false;
          }
        }
      }
      if (remove !== undefined) remove();
    }
    if (result === undefined) {
      if (reportedInferenceFallback) {
        const oldSuppress = this.suppressReportInferenceFallback;
        this.suppressReportInferenceFallback = true;
        result = this.typeToTypeNode(t);
        this.suppressReportInferenceFallback = oldSuppress;
      } else result = this.typeToTypeNode(t);
    }
    this.flags = savedFlags;
    return result ?? this.keyword(SyntaxKind.AnyKeyword);
  }

  /** The return type node of `signature`; `any` is omitted with `SuppressAnyReturnType`. */
  serializeReturnTypeForSignature(signature: Signature): Node | undefined {
    return this.serializeReturnTypeForSignatureEx(signature, true);
  }

  /** `serializeReturnTypeForSignature`; with `tryReuse` and a pseudochecker, the source's return type where it matches. */
  serializeReturnTypeForSignatureEx(signature: Signature, tryReuse: boolean): Node | undefined {
    const c = this.c;
    const suppressAny = (this.flags & NodeBuilderFlags.SuppressAnyReturnType) !== 0;
    const savedFlags = this.flags;
    // Only top-level `any`s are suppressed.
    if (suppressAny) this.flags &= ~NodeBuilderFlags.SuppressAnyReturnType;
    let returnType: Type;
    const declaration = signature.declaration;
    if (declaration !== undefined && (declaration.flags & NodeFlags.Synthesized) === 0) {
      const symbol = getSymbolOfDeclaration(c, declaration);
      const known = symbol !== undefined ? this.enclosingSymbolTypes.get(getSymbolId(symbol)) : undefined;
      returnType = known ?? instantiateType(c, getReturnTypeOfSignature(c, signature), this.mapper);
    } else returnType = getReturnTypeOfSignature(c, signature);
    let returnTypeNode: Node | undefined = undefined;
    if (!(suppressAny && (returnType.flags & TypeFlags.Any) !== 0)) {
      if (
        this.pseudo !== undefined &&
        tryReuse &&
        this.enclosingDeclaration !== undefined &&
        declaration !== undefined &&
        (declaration.flags & NodeFlags.Synthesized) === 0
      )
        returnTypeNode = this.serializeReturnTypeReusing(signature, declaration, returnType);
      if (returnTypeNode === undefined)
        returnTypeNode = this.serializeInferredReturnTypeForSignature(signature, returnType);
    }
    if (returnTypeNode === undefined && !suppressAny) returnTypeNode = this.keyword(SyntaxKind.AnyKeyword);
    this.flags = savedFlags;
    return returnTypeNode;
  }

  private serializeReturnTypeReusing(signature: Signature, declaration: Node, returnType: Type): Node | undefined {
    const declarationSymbol = getSymbolOfDeclaration(this.c, declaration);
    if (declarationSymbol === undefined) return undefined;
    const restore = this.addSymbolTypeToContext(declarationSymbol, returnType);
    let result: Node | undefined = undefined;
    let pt: PseudoType | undefined = this.pseudo!.getReturnTypeOfSignature(declaration);
    if (pseudoTypeEquivalentToType(this, pt, returnType, false, !this.suppressReportInferenceFallback)) {
      // The pseudochecker doesn't infer type predicates, which the checker may have.
      const typePredicate = getTypePredicateOfSignature(this.c, signature);
      if (typePredicate !== undefined && !pseudoReturnTypeMatchesPredicate(this, pt, typePredicate)) {
        if (!this.suppressReportInferenceFallback) this.tracker.reportInferenceFallback(declaration);
        pt = undefined;
      }
      if (pt !== undefined) result = pseudoTypeToNodeWithCheckerFallback(this, pt, returnType);
    }
    restore();
    return result;
  }

  private serializeInferredReturnTypeForSignature(signature: Signature, returnType: Type): Node | undefined {
    const oldSuppress = this.suppressReportInferenceFallback;
    this.suppressReportInferenceFallback = true;
    const typePredicate = getTypePredicateOfSignature(this.c, signature);
    let returnTypeNode: Node | undefined;
    if (typePredicate !== undefined) {
      const predicate =
        this.mapper !== undefined ? instantiateTypePredicate(this.c, typePredicate, this.mapper) : typePredicate;
      returnTypeNode = this.typePredicateToTypePredicateNode(predicate);
    } else returnTypeNode = this.typeToTypeNode(returnType);
    this.suppressReportInferenceFallback = oldSuppress;
    return returnTypeNode;
  }

  typePredicateToTypePredicateNode(predicate: TypePredicate): Node {
    const isAsserts =
      predicate.kind === TypePredicateKind.AssertsThis || predicate.kind === TypePredicateKind.AssertsIdentifier;
    let parameterName: Node;
    if (predicate.kind === TypePredicateKind.Identifier || predicate.kind === TypePredicateKind.AssertsIdentifier) {
      parameterName = this.identifier(predicate.parameterName);
      this.context.setEmitFlags(parameterName, EmitFlags.NoAsciiEscaping);
    } else parameterName = this.created(new ThisTypeNode());
    const typeNode = predicate.type !== undefined ? this.typeToTypeNode(predicate.type) : undefined;
    return this.created(
      new TypePredicateNode(isAsserts ? this.token(SyntaxKind.AssertsKeyword) : undefined, parameterName, typeNode),
    );
  }

  // ---- Existing type nodes

  /** The type of a type node, instantiated with the scope's mapper; with `noMappedTypes`, undefined if that changes it. */
  getTypeFromTypeNode(node: Node, noMappedTypes: boolean): Type | undefined {
    const t = getTypeFromTypeNode(this.c, node);
    if (this.mapper === undefined) return t;
    const instantiated = instantiateType(this.c, t, this.mapper);
    if (noMappedTypes && instantiated !== t) return undefined;
    return instantiated;
  }

  private typeNodeIsEquivalentToType(annotatedDeclaration: Node | undefined, t: Type, typeFromTypeNode: Type): boolean {
    if (typeFromTypeNode === t) return true;
    if (annotatedDeclaration === undefined) return false;
    if (getQuestionToken(annotatedDeclaration) !== undefined)
      return getTypeWithFacts(this.c, t, TypeFacts.NEUndefined) === typeFromTypeNode;
    return false;
  }

  tryReuseExistingNonParameterTypeNode(
    existing: Node,
    t: Type,
    host: Node | undefined,
    annotationType: Type | undefined,
  ): Node | undefined {
    const annotation = annotationType ?? this.getTypeFromTypeNode(existing, true);
    if (
      annotation !== undefined &&
      this.typeNodeIsEquivalentToType(host ?? this.enclosingDeclaration, t, annotation) &&
      canReuseExistingJSTypeNode(this, existing, t)
    )
      return tryReuseExistingNode(this, existing);
    return undefined;
  }

  /**
   * A copy of `range` positioned like `location`: without positions unless both are in the file
   * being written, with `location` as its original.
   */
  setTextRange(range: Node, location: Node | undefined): Node {
    // Always a copy, so positions from other files never leak into the result. As tsgo's
    // shallow clone, the copy and its descendants keep their emit flags.
    const result = range.deepClone();
    copyEmitNodes(this.context, result, range, true);
    result.pos = -1;
    result.end = -1;
    this.context.setOriginal(result, range);
    if (location === undefined || result === location) return result;
    let original = this.context.getOriginal(result);
    while (original !== undefined && original !== location) original = this.context.getOriginal(original);
    if (original === undefined) this.context.setOriginalEx(result, location, true);
    if (
      this.enclosingFile !== undefined &&
      this.enclosingFile === getSourceFileOfNode(this.context.mostOriginal(location))
    ) {
      result.pos = location.pos;
      result.end = location.end;
    } else {
      result.pos = -1;
      result.end = -1;
    }
    return result;
  }
}

const enum TransformKind {
  Type,
  TypeReference,
  Conditional,
  ObjectType,
}

// ---- Helpers

function asBindingPattern(node: Node | undefined): BindingPattern | undefined {
  if (node === undefined) return undefined;
  if (node instanceof BindingPattern) return node as BindingPattern;
  return undefined;
}

function typesAreSameReference(a: Type, b: Type): boolean {
  return a === b || (a.symbol !== undefined && a.symbol === b.symbol) || (a.alias !== undefined && a.alias === b.alias);
}

/** Internal names other than late-bound and private names. */
function isReservedMemberName(name: string): boolean {
  return (
    name.length >= 2 && name.charCodeAt(0) === 0xfffe && name.charCodeAt(1) !== 0x40 && name.charCodeAt(1) !== 0x23
  );
}

function isPrivateIdentifierSymbol(symbol: Symbol): boolean {
  return symbol.name.startsWith('￾#');
}

function isClassInstanceSide(c: Checker, t: Type): boolean {
  const symbol = t.symbol;
  return (
    symbol !== undefined &&
    (symbol.flags & SymbolFlags.Class) !== 0 &&
    (t === getDeclaredTypeOfClassOrInterface(c, symbol) ||
      ((t.flags & TypeFlags.Object) !== 0 && (t.objectFlags & ObjectFlags.IsClassInstanceClone) !== 0))
  );
}

function getTypeAliasForTypeLiteral(c: Checker, t: Type): Symbol | undefined {
  const symbol = t.symbol;
  if (symbol === undefined || (symbol.flags & SymbolFlags.TypeLiteral) === 0 || declarationCount(symbol) === 0)
    return undefined;
  let node = symbol.declaration!.parent;
  while (node !== undefined && node.kind === SyntaxKind.ParenthesizedType) node = node.parent;
  if (node !== undefined && node.kind === SyntaxKind.TypeAliasDeclaration) return getSymbolOfDeclaration(c, node);
  return undefined;
}

/** A copy of `t`, whose members are `resolved`, without its abstract construct signatures. */
function getResolvedTypeWithoutAbstractConstructSignatures(c: Checker, t: Type, resolved: StructuredType): Type {
  if (resolved.constructSignatures.length === 0) return t;
  const side = membersHolder(c, t);
  if (side.objectTypeWithoutAbstractConstructSignatures !== undefined)
    return side.objectTypeWithoutAbstractConstructSignatures;
  const constructSignatures = resolved.constructSignatures.filter((s) => (s.flags & SignatureFlags.Abstract) === 0);
  if (constructSignatures.length === resolved.constructSignatures.length) {
    side.objectTypeWithoutAbstractConstructSignatures = t;
    return t;
  }
  const copy = newAnonymousType(c, t.symbol);
  const copied = membersHolder(c, copy);
  copied.objectFlags |= ObjectFlags.MembersResolved;
  copied.members = resolved.members;
  copied.properties = resolved.properties;
  copied.callSignatures = resolved.callSignatures;
  copied.constructSignatures = constructSignatures;
  copied.indexInfos = resolved.indexInfos;
  side.objectTypeWithoutAbstractConstructSignatures = copy;
  sideOf(c, copy).objectTypeWithoutAbstractConstructSignatures = copy;
  return copy;
}

function getNameFromIndexInfo(info: IndexInfo): string {
  const declaration = info.declaration;
  if (declaration === undefined) return 'x';
  const parameters = getParameters(declaration);
  const name = parameters !== undefined && parameters.nodes.length > 0 ? getName(parameters.nodes[0]!) : undefined;
  return name === undefined ? 'x' : declarationNameToString(getSourceFileOfNode(name), name);
}

function hasAccessorKeyword(node: Node): boolean {
  const modifiers = getModifiers(node);
  return modifiers !== undefined && modifiers.nodes.some((m) => m.kind === SyntaxKind.AccessorKeyword);
}

function getEffectiveConstraint(typeParameter: Node): Node | undefined {
  return typeParameter instanceof TypeParameterDeclaration ? typeParameter.constraint : undefined;
}

function getTypeParameterModifiers(tp: Type): ModifierFlags {
  let flags = ModifierFlags.None;
  if (tp.symbol !== undefined) for (const d of getDeclarations(tp.symbol)) flags |= getCombinedModifierFlags(d);
  return flags & (ModifierFlags.In | ModifierFlags.Out | ModifierFlags.Const);
}

function getEffectiveParameterDeclaration(symbol: Symbol): Node | undefined {
  const parameter = getDeclarationOfKind(symbol, SyntaxKind.Parameter);
  if (parameter !== undefined) return parameter;
  if ((symbol.flags & SymbolFlags.Transient) === 0) return getDeclarationOfKind(symbol, SyntaxKind.JSDocParameterTag);
  return undefined;
}

function isPropertyAccessEntityNameExpression(node: Node): boolean {
  return node.kind === SyntaxKind.PropertyAccessExpression && isEntityNameExpression(node, false);
}

/** Whether an existing type reference node can stand for `t`: JS `Foo` meaning `Foo<any>` can't. */
export function canReuseExistingJSTypeNode(b: NodeBuilder, existing: Node, t: Type): boolean {
  const c = b.c;
  if (getIntendedTypeFromJSDocTypeReference(c, existing) !== undefined) return false;
  if ((t.objectFlags & ObjectFlags.Reference) === 0 || !(existing instanceof TypeReferenceNode)) return true;
  getTypeFromTypeNode(c, existing);
  const symbol = c.resolvedSymbols.get(existing.id);
  if (symbol === undefined) return true;
  const existingTarget = getDeclaredTypeOfSymbol(c, symbol);
  if (existingTarget !== (t as TypeReference).target) return true;
  const written = existing.typeArguments === undefined ? 0 : existing.typeArguments.nodes.length;
  return written >= getMinTypeArgumentCount(c, (existingTarget as InterfaceType).typeParameters());
}

/** Copies the emit nodes of `original`'s descendants to the same nodes of its deep clone `clone`. */
function copyEmitNodes(context: EmitContext, clone: Node, original: Node, isRoot: boolean): void {
  // The root is a copy, which gets the original's emit node without its comments when the
  // original is set; the descendants stand for the original's own.
  if (!isRoot) context.copyEmitNode(clone, original);
  const cloneChildren = new ChildCollector();
  clone.forEachChild(cloneChildren);
  const originalChildren = new ChildCollector();
  original.forEachChild(originalChildren);
  const count = Math.min(cloneChildren.nodes.length, originalChildren.nodes.length);
  for (let i = 0; i < count; i++) copyEmitNodes(context, cloneChildren.nodes[i]!, originalChildren.nodes[i]!, false);
}

class ChildCollector extends NodeVisitor {
  readonly nodes: Node[] = [];
  readonly lists: NodeList[] = [];

  visitNode(node: Node): boolean {
    this.nodes.push(node);
    return false;
  }

  visitList(list: NodeList): boolean {
    this.lists.push(list);
    return super.visitList(list);
  }
}

/** Sets each node of `original`'s subtree as the original of its copy in `clone`, keeping trailing commas. */
function linkClones(context: EmitContext, clone: Node, original: Node): void {
  if (context.getOriginal(clone) === undefined) context.setOriginal(clone, original);
  const cloneChildren = new ChildCollector();
  clone.forEachChild(cloneChildren);
  const originalChildren = new ChildCollector();
  original.forEachChild(originalChildren);
  const lists = Math.min(cloneChildren.lists.length, originalChildren.lists.length);
  for (let i = 0; i < lists; i++) {
    const list = cloneChildren.lists[i]!;
    if (originalChildren.lists[i]!.hasTrailingComma() && list.nodes.length > 0) {
      const last = list.nodes[list.nodes.length - 1]!;
      last.pos = -2;
      last.end = -2;
    }
  }
  const count = Math.min(cloneChildren.nodes.length, originalChildren.nodes.length);
  for (let i = 0; i < count; i++) linkClones(context, cloneChildren.nodes[i]!, originalChildren.nodes[i]!);
}

/** A copy of a binding name without initializers, written on one line. */
function cloneBindingName(b: NodeBuilder, node: Node): Node {
  node.forEachChild(new ComputedNameTracker(b));
  const clone = node.deepClone();
  removeBindingInitializers(clone);
  clearPositions(clone);
  keepTrailingCommas(clone, node);
  b.context.setEmitFlags(clone, EmitFlags.SingleLine | EmitFlags.NoAsciiEscaping);
  return clone;
}

/**
 * Marks the element lists of `clone` that have a trailing comma in `original`, which the printer
 * keeps: tsgo's copy keeps the lists' positions.
 */
function keepTrailingCommas(clone: Node, original: Node): void {
  if (!(clone instanceof BindingPattern) || !(original instanceof BindingPattern)) return;
  // As tsgo's deep clone: a last element ending before the list's end.
  if (original.elements.hasTrailingComma() && clone.elements.nodes.length > 0) {
    const last = clone.elements.nodes[clone.elements.nodes.length - 1]!;
    last.pos = -2;
    last.end = -2;
  }
  const elements = clone.elements.nodes;
  const originals = original.elements.nodes;
  for (let i = 0; i < elements.length && i < originals.length; i++) {
    const element = elements[i]!;
    const originalElement = originals[i]!;
    if (
      element instanceof BindingElement &&
      originalElement instanceof BindingElement &&
      element.name !== undefined &&
      originalElement.name !== undefined
    )
      keepTrailingCommas(element.name, originalElement.name);
  }
}

function removeBindingInitializers(node: Node): void {
  if (node instanceof BindingPattern) {
    for (const e of node.elements.nodes) removeBindingInitializers(e);
    return;
  }
  if (node instanceof BindingElement) {
    node.initializer = undefined;
    if (node.name !== undefined) removeBindingInitializers(node.name);
  }
}

/** Tracks the late-bound computed names of a binding name, which the copy writes. */
class ComputedNameTracker extends NodeVisitor {
  readonly b: NodeBuilder;

  constructor(b: NodeBuilder) {
    super();
    this.b = b;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.ComputedPropertyName && isLateBindableName(this.b.c, node))
      this.b.trackComputedName(getExpression(node)!, this.b.enclosingDeclaration);
    return node.forEachChild(this);
  }
}

class PositionClearer extends NodeVisitor {
  visitNode(node: Node): boolean {
    clearPositions(node);
    return false;
  }

  // A list keeping its range would print a trailing comma after its now unpositioned nodes.
  visitList(list: NodeList): boolean {
    list.pos = -1;
    list.end = -1;
    for (const node of list.nodes) clearPositions(node);
    return false;
  }
}

/** Drops the positions of a copied subtree; its flags stay those of the original, as in tsgo. */
export function clearPositions(node: Node): void {
  node.pos = -1;
  node.end = -1;
  node.forEachChild(new PositionClearer());
}

/** Whether a parameter is optional in its signature, as tsgo's `isOptionalParameter`. */
export function isOptionalParameter(c: Checker, node: Node): boolean {
  if (!(node instanceof ParameterDeclaration)) return false;
  if (node.questionToken !== undefined) return true;
  const parent = node.parent!;
  const parameters = getParameters(parent);
  const index = parameters === undefined ? -1 : parameters.nodes.indexOf(node);
  if (node.initializer !== undefined) {
    const signature = getSignatureFromDeclaration(c, parent);
    // Without treating `void` parameters as optional, as grammar checks use this.
    let minArgumentCount = signature.minArgumentCount;
    if (signature.hasRestParameter()) {
      const restType = getTypeOfSymbol(c, signature.parameters[signature.parameters.length - 1]!);
      if (isTupleType(restType)) {
        const tuple = (restType as TypeReference).target as TupleType;
        let requiredCount = tuple.fixedLength;
        for (let i = 0; i < tuple.elementInfos.length; i++)
          if ((tuple.elementInfos[i].flags & ElementFlags.Required) === 0) {
            requiredCount = i;
            break;
          }
        if (requiredCount > 0) minArgumentCount = signature.parameters.length - 1 + requiredCount;
      }
    }
    return index >= minArgumentCount;
  }
  const iife = getImmediatelyInvokedFunctionExpression(parent);
  if (iife !== undefined)
    return (
      node.type === undefined && node.dotDotDotToken === undefined && index >= getEffectiveCallArguments(c, iife).length
    );
  return false;
}

/** Whether a parameter's written type needs `| undefined`: initialized before a required parameter. */
export function requiresAddingImplicitUndefined(
  c: Checker,
  parameter: Node,
  enclosingDeclaration: Node | undefined,
): boolean {
  if (!(parameter instanceof ParameterDeclaration) || (parameter.flags & NodeFlags.Synthesized) !== 0) return false;
  const isPropertyParameter = hasSyntacticModifier(parameter, ModifierFlags.ParameterPropertyModifier);
  let required = false;
  if (c.strictNullChecks && !isOptionalParameter(c, parameter) && parameter.initializer !== undefined)
    required =
      !isPropertyParameter || (enclosingDeclaration !== undefined && isFunctionLikeDeclaration(enclosingDeclaration));
  const optionalProperty =
    c.strictNullChecks &&
    isOptionalParameter(c, parameter) &&
    parameter.initializer === undefined &&
    isPropertyParameter;
  if (!required && !optionalProperty) return false;
  const typeNode = parameter.type;
  if (typeNode === undefined) return true;
  const t = getTypeFromTypeNode(c, typeNode);
  return !isErrorType(c, t) && !containsUndefinedType(c, t);
}

function containsUndefinedType(c: Checker, t: Type): boolean {
  const types = (t.flags & TypeFlags.Union) !== 0 ? (t as UnionType).types : [t];
  return (types[0].flags & TypeFlags.Undefined) !== 0;
}

function isFunctionLikeDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return true;
  }
  return false;
}

/** Whether the first identifier of an entity name can be named from `enclosingDeclaration`. */
export function isEntityNameVisible(
  c: Checker,
  entityName: Node,
  enclosingDeclaration: Node,
  shouldComputeAliasesToMakeVisible: boolean = false,
): SymbolAccessibilityResult {
  if ((entityName.flags & NodeFlags.Synthesized) !== 0)
    return new SymbolAccessibilityResult(SymbolAccessibility.NotAccessible, [], '', undefined, '');
  const meaning = getMeaningOfEntityNameReference(entityName);
  const firstIdentifier = getFirstIdentifier(entityName);
  const text = getText(firstIdentifier);
  const symbol = resolveName(c, enclosingDeclaration, text, meaning, undefined, false, false);
  if (symbol !== undefined && (symbol.flags & SymbolFlags.TypeParameter) !== 0 && (meaning & SymbolFlags.Type) !== 0)
    return accessible([]);
  if (symbol === undefined && firstIdentifier.kind === SyntaxKind.ThisKeyword) {
    const container = getThisContainer(firstIdentifier, false, false);
    const sym = container === undefined ? undefined : getSymbolOfDeclaration(c, container);
    if (
      isSymbolAccessible(c, sym, enclosingDeclaration, meaning, false).accessibility === SymbolAccessibility.Accessible
    )
      return accessible([]);
  }
  if (symbol === undefined)
    return new SymbolAccessibilityResult(SymbolAccessibility.NotResolved, [], text, firstIdentifier, '');
  const visible = hasVisibleDeclarations(c, symbol, shouldComputeAliasesToMakeVisible);
  if (visible !== undefined) return visible;
  return new SymbolAccessibilityResult(SymbolAccessibility.NotAccessible, [], text, firstIdentifier, '');
}

/**
 * The parameter lists of a signature with a tuple rest parameter spread into parameters; one
 * list per member of a union of tuples unless `skipUnionExpanding`.
 */
export function getExpandedParameters(c: Checker, signature: Signature, skipUnionExpanding: boolean): Symbol[][] {
  if (signature.hasRestParameter()) {
    const restIndex = signature.parameters.length - 1;
    const restSymbol = signature.parameters[restIndex]!;
    const restType = getTypeOfSymbol(c, restSymbol);
    if (isTupleType(restType))
      return [expandSignatureParametersWithTupleMembers(c, signature, restType, restIndex, restSymbol)];
    if (!skipUnionExpanding && (restType.flags & TypeFlags.Union) !== 0) {
      const types = (restType as UnionType).types;
      for (const t of types) if (!isTupleType(t)) return [signature.parameters];
      const lists: Symbol[][] = [];
      for (const t of types)
        lists.push(expandSignatureParametersWithTupleMembers(c, signature, t, restIndex, restSymbol));
      return lists;
    }
  }
  return [signature.parameters];
}

function expandSignatureParametersWithTupleMembers(
  c: Checker,
  signature: Signature,
  restType: Type,
  restIndex: number,
  restSymbol: Symbol,
): Symbol[] {
  const elementTypes = getTypeArguments(c, restType);
  const tuple = (restType as TypeReference).target as TupleType;
  const names = getUniqueAssociatedNamesFromTupleType(c, tuple, restSymbol);
  const result = signature.parameters.slice(0, restIndex);
  for (let i = 0; i < elementTypes.length; i++) {
    const flags = tuple.elementInfos[i]!.flags;
    let checkFlags = CheckFlags.None;
    if ((flags & ElementFlags.Variable) !== 0) checkFlags = CheckFlags.RestParameter;
    else if ((flags & ElementFlags.Optional) !== 0) checkFlags = CheckFlags.OptionalParameter;
    const symbol = c.newSymbolWithCheckFlags(SymbolFlags.FunctionScopedVariable, names[i]!, checkFlags);
    const elementType = elementTypes[i]!;
    c.symbolTypes.set(
      getSymbolId(symbol),
      (flags & ElementFlags.Rest) !== 0 ? createArrayType(c, elementType) : elementType,
    );
    result.push(symbol);
  }
  return result;
}

function getUniqueAssociatedNamesFromTupleType(c: Checker, tuple: TupleType, restSymbol: Symbol): string[] {
  const names: string[] = [];
  for (let i = 0; i < tuple.elementInfos.length; i++) {
    const info = tuple.elementInfos[i]!;
    names.push(getTupleElementLabel(c, info.flags, info.labeledDeclaration, restSymbol, i));
  }
  if (names.length === 0) return names;
  const duplicates: number[] = [];
  const uniqueNames = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (uniqueNames.has(name)) duplicates.push(i);
    else uniqueNames.add(name);
  }
  const counters = new Map<string, number>();
  for (const i of duplicates) {
    const base = names[i]!;
    let counter = counters.get(base) ?? 1;
    let name: string;
    for (;;) {
      name = base + '_' + counter;
      if (uniqueNames.has(name)) {
        counter++;
        continue;
      }
      uniqueNames.add(name);
      break;
    }
    names[i] = name;
    counters.set(name, counter + 1);
  }
  return names;
}

/** The name a tuple element gets as a parameter. */
export function getTupleElementLabel(
  c: Checker,
  flags: ElementFlags,
  labeledDeclaration: Node | undefined,
  restSymbol: Symbol | undefined,
  index: number,
): string {
  if (labeledDeclaration !== undefined) return getText(getName(labeledDeclaration)!);
  if (restSymbol !== undefined && restSymbol.valueDeclaration instanceof ParameterDeclaration)
    return getTupleElementLabelFromBindingElement(restSymbol.valueDeclaration, index, flags);
  return (restSymbol !== undefined ? restSymbol.name : 'arg') + '_' + index;
}

function getTupleElementLabelFromBindingElement(node: Node, index: number, elementFlags: ElementFlags): string {
  const name = getName(node);
  const hasDotDotDot =
    (node instanceof ParameterDeclaration && node.dotDotDotToken !== undefined) ||
    (node instanceof BindingElement && node.dotDotDotToken !== undefined);
  if (name !== undefined) {
    if (name.kind === SyntaxKind.Identifier) {
      const text = getText(name);
      // `(...[x, y, ...z]: [number, number, ...number[]])` keeps `z`; fixed elements of a rest get suffixes.
      if (hasDotDotDot) return (elementFlags & ElementFlags.Variable) !== 0 ? text : text + '_' + index;
      return (elementFlags & ElementFlags.Fixed) !== 0 ? text : text + '_n';
    }
    if (name.kind === SyntaxKind.ArrayBindingPattern && hasDotDotDot) {
      const elements = (name as BindingPattern).elements.nodes;
      const lastElement = elements.length > 0 ? elements[elements.length - 1]! : undefined;
      const lastIsRest = lastElement instanceof BindingElement && lastElement.dotDotDotToken !== undefined;
      const elementCount = elements.length - (lastIsRest ? 1 : 0);
      if (index < elementCount) {
        const element = elements[index]!;
        if (element instanceof BindingElement)
          return getTupleElementLabelFromBindingElement(element, index, elementFlags);
      } else if (lastIsRest)
        return getTupleElementLabelFromBindingElement(lastElement!, index - elementCount, elementFlags);
    }
  }
  return 'arg_' + index;
}

// ---- Entry points

/**
 * The type node TypeScript would write for `type`. As in tsgo, the builder has a pseudochecker, so types
 * of declarations are written from what the source wrote where that denotes the type.
 */
export function typeToTypeNode(
  c: Checker,
  type: Type,
  enclosingDeclaration: Node | undefined,
  flags: number,
  internalFlags: NodeBuilderInternalFlags = NodeBuilderInternalFlags.None,
  tracker: SymbolTracker | undefined = undefined,
  idToSymbol: Map<Node, Symbol> | undefined = undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, internalFlags, tracker);
  b.pseudo = newPseudoChecker(c);
  b.idToSymbol = idToSymbol;
  return b.finish(b.typeToTypeNode(type));
}

/** The declaration of kind `kind` TypeScript would write for `signature`, with a pseudochecker as `typeToTypeNode`. */
export function signatureToSignatureDeclaration(
  c: Checker,
  signature: Signature,
  kind: SyntaxKind,
  enclosingDeclaration: Node | undefined,
  flags: number,
  internalFlags: NodeBuilderInternalFlags = NodeBuilderInternalFlags.None,
  tracker: SymbolTracker | undefined = undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, internalFlags, tracker);
  b.pseudo = newPseudoChecker(c);
  return b.finish(b.signatureToSignatureDeclaration(signature, kind, undefined));
}

/** The type format flags that are node builder flags. */
function toNodeBuilderFlags(typeFormatFlags: number): NodeBuilderFlags {
  return (
    typeFormatFlags &
    (NodeBuilderFlags.NoTruncation |
      NodeBuilderFlags.WriteArrayAsGenericType |
      NodeBuilderFlags.GenerateNamesForShadowedTypeParams |
      NodeBuilderFlags.UseStructuralFallback |
      NodeBuilderFlags.WriteTypeArgumentsOfSignature |
      NodeBuilderFlags.UseFullyQualifiedType |
      NodeBuilderFlags.SuppressAnyReturnType |
      NodeBuilderFlags.MultilineObjectLiterals |
      NodeBuilderFlags.WriteClassExpressionAsTypeLiteral |
      NodeBuilderFlags.UseTypeOfFunction |
      NodeBuilderFlags.OmitParameterModifiers |
      NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
      NodeBuilderFlags.AllowUniqueESSymbolType |
      NodeBuilderFlags.InTypeAlias |
      NodeBuilderFlags.UseInstantiationExpressions |
      NodeBuilderFlags.UseSingleQuotesForStringLiteralType |
      NodeBuilderFlags.NoTypeReduction |
      NodeBuilderFlags.OmitThisParameter)
  );
}

/**
 * `type` as text, printed from its type node as tsgo's `TypeToStringEx` does; `typeFormatFlags`
 * are `TypeFormatFlags`. Undefined if the builder fails.
 */
export function typeToStringFromTypeNode(
  c: Checker,
  type: Type,
  enclosingDeclaration: Node | undefined,
  typeFormatFlags: number,
): string | undefined {
  // Serializing can resolve members and report diagnostics needing serialization in turn.
  if (c.serializationLevel >= maxSerializationLevel) return '?';
  const multiline = (typeFormatFlags & NodeBuilderFlags.MultilineObjectLiterals) !== 0;
  const noTruncation =
    c.compilerOptions.noErrorTruncation === true || (typeFormatFlags & NodeBuilderFlags.NoTruncation) !== 0;
  let flags = toNodeBuilderFlags(typeFormatFlags) | NodeBuilderFlags.IgnoreErrors;
  if (noTruncation) flags |= NodeBuilderFlags.NoTruncation;
  const b = new NodeBuilder(c, enclosingDeclaration, flags, NodeBuilderInternalFlags.None, undefined);
  b.pseudo = newPseudoChecker(c);
  c.serializationLevel++;
  const typeNode = b.finish(b.typeToTypeNode(type));
  c.serializationLevel--;
  if (typeNode === undefined) return undefined;
  const options = new PrinterOptions();
  // Only the unresolved type keeps its comment, a hint that it isn't a plain `any`.
  options.removeComments = type !== c.unresolvedType;
  options.newLine = multiline ? '\n' : '';
  const writer = new TextWriter(options.newLine, 0);
  const sourceFile = enclosingDeclaration === undefined ? undefined : getSourceFileOfNode(enclosingDeclaration);
  new Printer(options, b.context).write(typeNode, sourceFile, writer, undefined);
  const result = writer.getText();
  const maxLength = noTruncation ? noTruncationMaximumTruncationLength * 2 : defaultMaximumTruncationLength * 2;
  if (result.length >= maxLength) return result.substring(0, maxLength - 3) + '...';
  return result;
}

/** The index signature TypeScript would write for `info`. */
export function indexInfoToIndexSignatureDeclaration(
  c: Checker,
  info: IndexInfo,
  enclosingDeclaration: Node | undefined,
  flags: number,
  tracker: SymbolTracker | undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, NodeBuilderInternalFlags.None, tracker);
  return b.finish(b.indexInfoToIndexSignatureDeclaration(info, undefined));
}

/** The type parameter declaration TypeScript would write for `parameter`. */
export function typeParameterToDeclaration(
  c: Checker,
  parameter: Type,
  enclosingDeclaration: Node | undefined,
  flags: number,
  tracker: SymbolTracker | undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, NodeBuilderInternalFlags.None, tracker);
  return b.finish(b.typeParameterToDeclaration(parameter));
}

/** The type predicate node TypeScript would write for `predicate`. */
export function typePredicateToTypePredicateNode(
  c: Checker,
  predicate: TypePredicate,
  enclosingDeclaration: Node | undefined,
  flags: number,
  tracker: SymbolTracker | undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, NodeBuilderInternalFlags.None, tracker);
  return b.finish(b.typePredicateToTypePredicateNode(predicate));
}

/** The entity name TypeScript would write for `symbol` with `meaning`. */
export function symbolToEntityName(
  c: Checker,
  symbol: Symbol,
  meaning: SymbolFlags,
  enclosingDeclaration: Node | undefined,
  flags: number,
  tracker: SymbolTracker | undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, NodeBuilderInternalFlags.None, tracker);
  return b.finish(symbolToName(b, symbol, meaning, false));
}

/** The expression TypeScript would write for `symbol` with `meaning`. */
export function symbolToExpressionNode(
  c: Checker,
  symbol: Symbol,
  meaning: SymbolFlags,
  enclosingDeclaration: Node | undefined,
  flags: number,
  tracker: SymbolTracker | undefined,
): Node | undefined {
  const b = new NodeBuilder(c, enclosingDeclaration, flags, NodeBuilderInternalFlags.None, tracker);
  return b.finish(symbolToExpression(b, symbol, meaning));
}

/** The UTF-8 offset of UTF-16 offset `pos` in `text`. */
function utf8Offset(text: string, pos: number): number {
  return pos <= 0 ? pos : utf8Length(text.slice(0, pos));
}
