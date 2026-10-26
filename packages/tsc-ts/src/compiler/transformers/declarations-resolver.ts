// What declaration emit asks the checker. `DeclarationEmitResolver` lists every query of the
// declaration transform; `SyntacticDeclarationEmitResolver` answers them from syntax and the
// binder, and the checker answers them with types.
import type { ImportDeclaration, ModifierFlags, Node, SourceFile, FileReference } from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import type { Symbol, SymbolFlags } from '../symbol.js';
import { EmitResolver } from './emit-resolver.js';

export const enum SymbolAccessibility {
  Accessible,
  NotAccessible,
  CannotBeNamed,
  NotResolved,
}

export class SymbolAccessibilityResult {
  readonly accessibility: SymbolAccessibility;
  /** Unexported declarations (usually imports) to keep because the name refers to them. */
  readonly aliasesToMakeVisible: Node[];
  readonly errorSymbolName: string;
  readonly errorNode: Node | undefined;
  /** The module of an inaccessible symbol, or `''`. */
  readonly errorModuleName: string;

  constructor(
    accessibility: SymbolAccessibility,
    aliasesToMakeVisible: Node[],
    errorSymbolName: string,
    errorNode: Node | undefined,
    errorModuleName: string,
  ) {
    this.accessibility = accessibility;
    this.aliasesToMakeVisible = aliasesToMakeVisible;
    this.errorSymbolName = errorSymbolName;
    this.errorNode = errorNode;
    this.errorModuleName = errorModuleName;
  }
}

export function accessible(aliasesToMakeVisible: Node[]): SymbolAccessibilityResult {
  return new SymbolAccessibilityResult(SymbolAccessibility.Accessible, aliasesToMakeVisible, '', undefined, '');
}

/** Node builder options, as tsgo's `nodebuilder.Flags`; API clients send these values. */
export const enum NodeBuilderFlags {
  None = 0,
  // Options
  NoTruncation = 1 << 0,
  WriteArrayAsGenericType = 1 << 1,
  GenerateNamesForShadowedTypeParams = 1 << 2,
  UseStructuralFallback = 1 << 3,
  ForbidIndexedAccessSymbolReferences = 1 << 4,
  WriteTypeArgumentsOfSignature = 1 << 5,
  UseFullyQualifiedType = 1 << 6,
  UseOnlyExternalAliasing = 1 << 7,
  SuppressAnyReturnType = 1 << 8,
  WriteTypeParametersInQualifiedName = 1 << 9,
  MultilineObjectLiterals = 1 << 10,
  WriteClassExpressionAsTypeLiteral = 1 << 11,
  UseTypeOfFunction = 1 << 12,
  OmitParameterModifiers = 1 << 13,
  UseAliasDefinedOutsideCurrentScope = 1 << 14,
  UseSingleQuotesForStringLiteralType = 1 << 28,
  NoTypeReduction = 1 << 29,
  UseInstantiationExpressions = 1 << 30,
  OmitThisParameter = 1 << 25,
  WriteCallStyleSignature = 1 << 27,
  // Errors
  AllowThisInObjectLiteral = 1 << 15,
  AllowQualifiedNameInPlaceOfIdentifier = 1 << 16,
  AllowAnonymousIdentifier = 1 << 17,
  AllowEmptyUnionOrIntersection = 1 << 18,
  AllowEmptyTuple = 1 << 19,
  AllowUniqueESSymbolType = 1 << 20,
  AllowEmptyIndexInfoType = 1 << 21,
  AllowNodeModulesRelativePaths = 1 << 26,
  IgnoreErrors = AllowThisInObjectLiteral |
    AllowQualifiedNameInPlaceOfIdentifier |
    AllowAnonymousIdentifier |
    AllowEmptyUnionOrIntersection |
    AllowEmptyTuple |
    AllowEmptyIndexInfoType |
    AllowNodeModulesRelativePaths,
  // State
  InObjectTypeLiteral = 1 << 22,
  InTypeAlias = 1 << 23,
  InInitialEntityName = 1 << 24,

  DeclarationEmit = NoTruncation |
    GenerateNamesForShadowedTypeParams |
    UseStructuralFallback |
    MultilineObjectLiterals |
    WriteClassExpressionAsTypeLiteral |
    UseTypeOfFunction |
    AllowEmptyTuple,
}

/** Node builder options callers inside the compiler use, as tsgo's `nodebuilder.InternalFlags`. */
export const enum NodeBuilderInternalFlags {
  None = 0,
  WriteComputedProps = 1 << 0,
  NoSyntacticPrinter = 1 << 1,
  DoNotIncludeSymbolChain = 1 << 2,
  AllowUnresolvedNames = 1 << 3,
}

/**
 * Receives what the node builder finds while writing a type: symbols it names (to check
 * their visibility and keep their imports) and places it can't write without inference.
 */
export abstract class SymbolTracker {
  /** Checks that `symbol` can be named from `enclosingDeclaration`; true if an error was reported. */
  abstract trackSymbol(symbol: Symbol, enclosingDeclaration: Node, meaning: SymbolFlags): boolean;
  /** Reports a type that `isolatedDeclarations` can't write without inference. */
  abstract reportInferenceFallback(node: Node): boolean;
  abstract reportCyclicStructureError(): boolean;
  abstract reportInaccessibleThisError(): boolean;
  abstract reportInaccessibleUniqueSymbolError(): boolean;
  abstract reportLikelyUnsafeImportRequiredError(specifier: string, symbolName: string): boolean;
  abstract reportNonSerializableProperty(propertyName: string): boolean;
  abstract reportPrivateInBaseOfClassExpression(propertyName: string): boolean;
  abstract reportTruncationError(): boolean;
  /** Reports `augmentingSymbol`'s declarations outside `containingFile` that augment `parentSymbol`. */
  abstract reportNonlocalAugmentation(
    containingFile: SourceFile,
    parentSymbol: Symbol,
    augmentingSymbol: Symbol,
  ): boolean;
  /** The node errors are reported on while no declaration name applies. */
  abstract pushErrorFallbackNode(node: Node): boolean;
  abstract popErrorFallbackNode(): boolean;
}

/**
 * Every query of declaration emit. The checker extends this class; the queries it answers with
 * types (marked "Types:") are approximated by `SyntacticDeclarationEmitResolver`.
 *
 * Nodes passed in are parse tree nodes unless noted. `create*` methods return synthesized type
 * nodes, or undefined for `any`, and report names they use to `tracker`.
 */
export abstract class DeclarationEmitResolver extends EmitResolver {
  // Visibility

  /** Marks the declarations named by `export =`, `export default` and `export {}` visible. Once per file. */
  abstract precalculateDeclarationEmitVisibility(file: SourceFile): boolean;
  /** Whether a declaration is visible outside its file (exported, global, or marked visible). */
  abstract isDeclarationVisible(node: Node): boolean;
  /** Whether the first identifier of an entity name can be named from `enclosingDeclaration`. */
  abstract isEntityNameVisible(entityName: Node, enclosingDeclaration: Node): SymbolAccessibilityResult;
  /** Whether `symbol` can be named from `enclosingDeclaration`; aliases to keep are marked visible. */
  abstract isSymbolAccessible(
    symbol: Symbol,
    enclosingDeclaration: Node,
    meaning: SymbolFlags,
    shouldComputeAliasesToMakeVisible: boolean,
  ): SymbolAccessibilityResult;
  /** Whether `name` resolves to anything at `location`. */
  abstract isNameResolvable(location: Node, name: string): boolean;
  /** Whether an import with no visible bindings must stay because a module augmentation needs it. */
  abstract isImportRequiredByAugmentation(node: ImportDeclaration): boolean;

  // Declarations

  /** Modifier flags of `node` in `flags`, with the implicit `export` and `declare` of ambient contexts. */
  abstract getEffectiveDeclarationFlags(node: Node, flags: ModifierFlags): ModifierFlags;
  /** Whether a function-like with a body is the implementation of an overload set. */
  abstract isImplementationOfOverload(node: Node): boolean;
  /** Types: whether a declaration with a computed name has a late-bound (unique symbol or literal) name. */
  abstract isLateBound(node: Node): boolean;
  /** Whether `node` is `Symbol.x` or `globalThis.Symbol.x` for the global `Symbol`. */
  abstract isDefinitelyReferenceToGlobalSymbolObject(node: Node): boolean;
  /** Types: whether a `const` or `readonly` declaration has a fresh literal type, printed as its initializer. */
  abstract isLiteralConstDeclaration(node: Node): boolean;
  /** Types: whether a parameter is optional in its signature. */
  abstract isOptionalParameter(node: Node): boolean;
  /** Types: whether a parameter's type needs `| undefined` added (initialized before a required one). */
  abstract requiresAddingImplicitUndefined(node: Node, enclosingDeclaration: Node | undefined): boolean;
  /** Types: whether a function has properties assigned to it (`f.x = 1`). */
  abstract isExpandoFunctionDeclaration(node: Node): boolean;
  /** Types: the declarations of properties assigned to a function. */
  abstract getExpandoPropertyDeclarations(node: Node): Node[];
  /** The program file a `/// <reference path>` names. */
  abstract getSourceFileFromReference(file: SourceFile, reference: FileReference): SourceFile | undefined;

  // JavaScript

  /** The class member a JavaScript `this.x = …` assignment declares. */
  abstract getReferencedMemberValueDeclaration(node: Node): Node | undefined;
  /** Types: whether a `this.x = …` member is already provided by the base class. */
  abstract isThisPropertyAssignmentDeclarationRedundant(node: Node): boolean;
  /** The constant property name of an element access, or `''`. */
  abstract getElementAccessExpressionName(node: Node): string;

  // Type nodes

  /** Types: the type of a variable, parameter, property, accessor or export assignment. */
  abstract createTypeOfDeclaration(
    context: EmitContext,
    declaration: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined;
  /** Types: the return type of a signature. */
  abstract createReturnTypeOfSignatureDeclaration(
    context: EmitContext,
    signature: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined;
  /** Types: the type parameters of a signature declared by a JSDoc `@type`. */
  abstract createTypeParametersOfSignatureDeclaration(
    context: EmitContext,
    signature: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node[] | undefined;
  /** Types: the initializer of a literal const declaration (see `isLiteralConstDeclaration`). */
  abstract createLiteralConstValue(context: EmitContext, node: Node, tracker: SymbolTracker): Node | undefined;
  /** Types: the type of an expression, such as a class's `extends` expression. */
  abstract createTypeOfExpression(
    context: EmitContext,
    expression: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined;
  /** Types: index signatures of a class that come from late-bound computed names. */
  abstract createLateBoundIndexSignatures(
    context: EmitContext,
    container: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node[];
  /** Types: a JSDoc type rewritten as TypeScript, or undefined to fall back to `createTypeOfDeclaration`. */
  abstract tryJSTypeNodeToTypeNode(
    context: EmitContext,
    typeNode: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined;
}
