// Expression checking: types of expressions and the errors they produce.
import {
  checkMetaProperty,
  getIsolatedModulesLikeFlagName,
  isValidTypeOnlyAliasUseSite,
  markIdentifierAliasReferencedInExpression,
} from './checker-modules.js';
import { checkDeprecatedIdentifier } from './checker-deprecation.js';
import { isWriteOnlyAccess } from './checker-unused.js';
import {
  type ArrayLiteralExpression,
  type CallExpression,
  BinaryExpression,
  type ComputedPropertyName,
  type ConditionalExpression,
  type ElementAccessExpression,
  type Identifier,
  type Node,
  type PrefixUnaryExpression,
  type PostfixUnaryExpression,
  type PropertyAccessExpression,
  type QualifiedName,
  type SpreadElement,
  type TemplateExpression,
  type TemplateSpan,
  type TypeReferenceNode,
  getExpression,
  getInitializer,
  getName,
  getText,
  SourceFile,
  ModifierFlags,
  NodeFlags,
  PropertyDeclaration,
  VariableDeclaration,
  ForInOrOfStatement,
  VariableDeclarationList,
  TypeQueryNode,
  type ImportEqualsDeclaration,
  getTagName,
  getType,
} from './ast.js';
import {
  getThisContainer,
  isEntityNameExpression,
  isStatic,
  skipParentheses,
  isClassLike,
  getNameOfDeclaration,
  getRootDeclaration,
  hasSyntacticModifier,
  isFunctionExpressionOrArrowFunction,
  isObjectLiteralOrClassExpressionMethodOrAccessor,
  isPartOfTypeQuery,
  isOptionalChain,
  isAssignmentTarget,
  getSourceFileOfNode,
} from './binder-utilities.js';
import { shouldCheckErasableSyntax } from './checker-declarations.js';
import { skipTrivia } from './scanner.js';
import { Diagnostic, Diagnostics } from './diagnostics.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  checkSuperExpression,
  checkThisBeforeSuper,
  checkThisInStaticClassFieldInitializerInDecoratedClass,
} from './checker-super.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  AccessFlags,
  NodeCheckFlags,
  CheckMode,
  ObjectFlags,
  SignatureKind,
  type Type,
  TypeFlags,
  UnionType,
  TypeParameter,
  type MappedType,
  type TypeReference,
  IndexFlags,
  type IndexedAccessType,
  type SubstitutionType,
} from './checker-types.js';
import {
  createTupleTypeEx,
  getBigIntLiteralType,
  getFreshTypeOfLiteralType,
  getNumberLiteralType,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  getUnionTypeEx,
  getWidenedLiteralType,
  getWidenedUniqueESSymbolType,
  isErrorType,
  isTupleType,
  someType,
  typesOf,
  UnionReduction,
  getBaseTypeOfLiteralType,
  cloneTypeReference,
  createArrayTypeEx,
  everyType,
  getTemplateLiteralType,
  isMutableArrayOrTuple,
} from './checker-type-factory.js';
import { ElementFlags, TupleElementInfo } from './checker-types.js';
import {
  getBaseConstraintOfType,
  getPropertyOfType,
  getIndexInfoOfType,
  getIndexInfosOfType,
  getIndexTypeOfType,
  getTypeOfPropertyOfType,
  isArrayLikeType,
  getBaseConstraintOrType,
  isApplicableIndexType,
  getDeclarationModifierFlagsFromSymbol,
  getApparentType,
  mapToBaseConstraintOrType,
} from './checker-members.js';
import {
  getExportSymbolOfValueSymbolIfExported,
  getMergedSymbol,
  getSymbolOfDeclaration,
  resolveEntityName,
  resolveName,
  getFirstIdentifier,
  getCannotFindNameDiagnosticForName,
  getDeclarationOfAliasSymbol,
  TypeSystemPropertyName,
  popTypeResolution,
  pushTypeResolution,
  reportCircularityError,
} from './checker-symbols.js';
import {
  getTypeOfSymbol,
  getWidenedType,
  isReadonlySymbol,
  getOptionalType,
  removeMissingType,
  addOptionality,
} from './checker-symbol-types.js';
import { getDeclaredTypeOfClassOrInterface } from './checker-declared-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  isGenericObjectType,
  getIndexedAccessTypeOrUndefinedEx,
  getHomomorphicTypeVariable,
  isGenericIndexType,
  isGenericMappedType,
  isGenericType,
  getIndexTypeEx,
  getMappedTypeModifiers,
  MappedTypeModifiers,
  getPropertyNameFromIndex,
  isNoInferType,
} from './checker-type-operators.js';
import { TypeFacts, getTypeFacts, getNonNullableType, getTypeWithFacts, hasTypeFacts } from './checker-flow.js';
import { checkTypeComparableTo, isTypeAssignableTo, isTypeComparableTo } from './relations.js';
import { isTypeAssignableToKindEx as isTypeAssignableToKind } from './checker-type-operators.js';
import { typeToString, symbolToString } from './type-printer.js';
import { isTypeUsableAsPropertyName, getPropertyNameFromType, maybeTypeOfKind } from './checker-utilities.js';
import {
  getApparentTypeOfContextualType,
  getContextualType,
  getContextualTypeEx,
  getContextualSignatureForFunctionLikeDeclaration,
} from './checker-contextual.js';
import {
  checkCallExpression,
  checkExpressionWithTypeArguments,
  checkNewExpression,
  checkTaggedTemplateExpression,
  getOptionalExpressionType,
  instantiateTypeWithSingleGenericCallSignature,
  isSymbolOrSymbolForCall,
  propagateOptionalTypeMarker,
} from './checker-calls.js';
import {
  checkAwaitExpression,
  checkFunctionExpressionOrObjectLiteralMethod,
  checkYieldExpression,
} from './checker-functions.js';
import {
  IterationUse,
  checkIteratedTypeOrElementType,
  getAwaitedType,
  getIteratedTypeOrElementType,
} from './checker-iteration.js';
import { checkClassExpression } from './checker-classes.js';
import { padParameterInitializerType } from './checker-destructuring.js';
import { checkNodeDeferred, checkTypeNodeIfPresent } from './checker-source-file.js';
import { isInPropertyInitializerOrClassStaticBlock } from './checker-declaration-order.js';
import { checkObjectLiteral } from './checker-object-literals.js';
import { EvaluatedKind, evaluate } from './checker-evaluator.js';
import {
  checkPrivateIdentifierExpression,
  checkPropertyAccessExpressionOrQualifiedName,
  isMethodAccessForCall,
} from './checker-property-access.js';
import {
  checkBinaryExpression,
  checkConditionalExpression,
  checkDeleteExpression,
  checkPostfixUnaryExpression,
  checkPrefixUnaryExpression,
  isTypeAssertion,
} from './checker-operators.js';
import { checkJsx } from './checker-jsx.js';
import { getRegularTypeOfObjectLiteral } from './checker-literals.js';
import {
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getSingleSignature,
  getThisTypeOfSignature,
} from './checker-signatures.js';
import { isFunctionLike, isImportCall, isInJSFile, isRequireCall } from './ast-utilities.js';
import { isLiteralKind } from './printer/utilities.js';
import {
  AssignmentKind,
  convertAutoToAny,
  isEvolvingArrayOperationTarget,
  getAssignmentTargetKind,
  getControlFlowContainer,
  isConstantVariable,
  isInCompoundLikeAssignment,
  isMutableLocalVariableDeclaration,
  isParameterOrMutableLocalVariable,
  isPastLastAssignment,
  isSymbolAssignedDefinitely,
  getFlowTypeOfReference,
  getNarrowedTypeOfSymbol,
} from './checker-narrowing.js';
import { getFlowTypeOfAutoTypedProperty, getThisTypeOfAssignedFunction } from './checker-javascript.js';
import { checkExpressionWithContextualType, getThisTypeOfObjectLiteralMember } from './checker-contextual.js';

import {
  ContextFlags,
  getInferenceContext,
  instantiateContextualType,
  popContextualType,
  pushCachedContextualType,
} from './checker-contextual.js';
import { addIntraExpressionInferenceSite, isConstTypeVariable } from './checker-inference.js';
import { isContextSensitiveFunctionOrObjectLiteralMethod } from './checker-contextual.js';
import { checkTypeRelatedToAndOptionallyElaborate } from './checker-elaboration.js';
import { isContextSensitive } from './checker-functions.js';
import { getSignatureOfFullSignatureType } from './checker-jsdoc.js';
export {
  getContextuallyTypedParameterType,
  isContextSensitiveFunctionOrObjectLiteralMethod,
} from './checker-contextual.js';

// ---- Entry points

export function checkExpression(c: Checker, node: Node): Type {
  return checkExpressionEx(c, node, CheckMode.Normal);
}

export function checkExpressionEx(c: Checker, node: Node, checkMode: CheckMode): Type {
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  c.instantiationCount = 0;
  const t = instantiateTypeWithSingleGenericCallSignature(
    c,
    node,
    checkExpressionWorker(c, node, checkMode),
    checkMode,
  );
  if (isConstEnumObjectTypeLocal(t)) checkConstEnumAccess(c, node, t);
  c.currentNode = saveCurrentNode;
  return t;
}

/**
 * A const enum object can only be accessed, imported, exported or queried. Under isolatedModules, an
 * ambient one can't be used at all outside types.
 */
function checkConstEnumAccess(c: Checker, node: Node, t: Type): void {
  const parent = node.parent!;
  const ok =
    ((parent.kind === SyntaxKind.PropertyAccessExpression || parent.kind === SyntaxKind.ElementAccessExpression) &&
      getExpression(parent) === node) ||
    ((node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName) &&
      isInRightSideOfImportOrExportAssignment(node)) ||
    (parent.kind === SyntaxKind.TypeQuery && (parent as TypeQueryNode).exprName === node) ||
    parent.kind === SyntaxKind.ExportSpecifier;
  if (!ok)
    c.error(
      node,
      Diagnostics.X_const_enums_can_only_be_used_in_property_or_index_access_expressions_or_the_right_hand_side_of_an_import_declaration_or_export_assignment_or_type_query,
    );
  // Under verbatimModuleSyntax, only uses that don't resolve to an import are checked here; imports of
  // ambient const enums are checked with the alias.
  if (
    c.compilerOptions.isolatedModules === true ||
    (c.compilerOptions.verbatimModuleSyntax === true &&
      ok &&
      resolveName(c, node, getText(getFirstIdentifier(node)), SymbolFlags.Alias, undefined, false, true) === undefined)
  ) {
    const constEnumDeclaration = t.symbol!.valueDeclaration!;
    if ((constEnumDeclaration.flags & NodeFlags.Ambient) !== 0 && !isValidTypeOnlyAliasUseSite(node))
      c.error(node, Diagnostics.Cannot_access_ambient_const_enums_when_0_is_enabled, getIsolatedModulesLikeFlagName(c));
  }
}

function isInRightSideOfImportOrExportAssignment(name: Node): boolean {
  let node = name;
  while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
  const parent = node.parent!;
  return (
    (parent.kind === SyntaxKind.ImportEqualsDeclaration &&
      (parent as ImportEqualsDeclaration).moduleReference === node) ||
    (parent.kind === SyntaxKind.ExportAssignment && getExpression(parent) === node)
  );
}

/** The type of `node`, computed once. */
export function checkExpressionCached(c: Checker, node: Node): Type {
  let type = c.resolvedTypes.get(node.id);
  if (type === undefined) {
    // A type that is cached is computed without the control flow analysis in progress, whose variables may
    // have transient types: loops being analyzed start over.
    const saveFlowLoopStack = c.flowLoopStack;
    const saveFlowTypeCache = c.flowTypeCache;
    if (saveFlowLoopStack.length !== 0) c.flowLoopStack = [];
    c.flowTypeCache = undefined;
    type = checkExpression(c, node);
    c.resolvedTypes.set(node.id, type);
    c.flowTypeCache = saveFlowTypeCache;
    c.flowLoopStack = saveFlowLoopStack;
  }
  return type;
}

/** The type of an expression, cached when computing it needed flow analysis; may skip some diagnostics. */
export function getTypeOfExpression(c: Checker, node: Node): Type {
  const quickType = getQuickTypeOfExpression(c, node);
  if (quickType !== undefined) return quickType;
  const cachedType = c.flowTypeCache?.get(node);
  if (cachedType !== undefined) return cachedType;
  const startInvocationCount = c.flowInvocationCount;
  const t = checkExpressionEx(c, node, CheckMode.TypeOnly);
  if (c.flowInvocationCount !== startInvocationCount) {
    if (c.flowTypeCache === undefined) c.flowTypeCache = new Map<Node, Type>();
    c.flowTypeCache.set(node, t);
  }
  return t;
}

/** The type of an initializer in a position where literals widen unless the context wants them. */
export function checkExpressionForMutableLocation(c: Checker, node: Node): Type {
  return checkExpressionForMutableLocationEx(c, node, CheckMode.Normal);
}

export function checkExpressionForMutableLocationEx(c: Checker, node: Node, checkMode: CheckMode): Type {
  const t = checkExpressionEx(c, node, checkMode);
  if (isConstContext(c, node)) return getRegularTypeOfLiteralType(c, t);
  // An asserted type is kept as written.
  if (isTypeAssertion(node)) return t;
  return getWidenedLiteralLikeTypeForContextualType(
    c,
    t,
    instantiateContextualType(c, getContextualType(c, node), node, ContextFlags.None),
  );
}

export function checkDeclarationInitializer(
  c: Checker,
  declaration: Node,
  checkMode: CheckMode = CheckMode.Normal,
  contextualType?: Type,
): Type {
  const initializer = getInitializer(declaration)!;
  const t =
    getQuickTypeOfExpression(c, initializer) ??
    (contextualType !== undefined
      ? checkExpressionWithContextualType(c, initializer, contextualType, undefined, checkMode)
      : checkMode === CheckMode.Normal
        ? checkExpressionCached(c, initializer)
        : checkExpressionEx(c, initializer, checkMode));
  return padParameterInitializerType(c, declaration, t);
}

/**
 * The type of an expression whose type doesn't need its arguments checked: a call or `new` of a single
 * non-generic signature, an assertion, or a literal.
 */
function getQuickTypeOfExpression(c: Checker, node: Node): Type | undefined {
  const expr = skipParentheses(node);
  switch (expr.kind) {
    case SyntaxKind.AwaitExpression: {
      const t = getQuickTypeOfExpression(c, getExpression(expr)!);
      return t !== undefined ? getAwaitedType(c, t) : undefined;
    }
    case SyntaxKind.CallExpression: {
      const call = expr as CallExpression;
      if (
        call.expression.kind === SyntaxKind.SuperKeyword ||
        isRequireCall(call, true) ||
        isSymbolOrSymbolForCall(c, call) ||
        isImportCall(call)
      )
        return undefined;
      if (isOptionalChain(call)) {
        const funcType = checkExpression(c, call.expression);
        const nonOptionalType = getOptionalExpressionType(c, funcType, call.expression);
        const returnType = getReturnTypeOfSingleNonGenericSignature(c, funcType, SignatureKind.Call);
        return returnType !== undefined
          ? propagateOptionalTypeMarker(c, returnType, call, nonOptionalType !== funcType)
          : undefined;
      }
      return getReturnTypeOfSingleNonGenericSignature(
        c,
        checkNonNullExpression(c, call.expression),
        SignatureKind.Call,
      );
    }
    case SyntaxKind.NewExpression:
      return getReturnTypeOfSingleNonGenericSignature(
        c,
        checkNonNullExpression(c, getExpression(expr)!),
        SignatureKind.Construct,
      );
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const typeNode = getType(expr)!;
      return isConstTypeReference(typeNode) ? undefined : getTypeFromTypeNode(c, typeNode);
    }
  }
  if (isLiteralKind(node.kind) || node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword)
    return checkExpression(c, node);
  return undefined;
}

function getReturnTypeOfSingleNonGenericSignature(c: Checker, funcType: Type, kind: SignatureKind): Type | undefined {
  const signature = getSingleSignature(c, funcType, kind, true);
  return signature !== undefined && signature.typeParameters.length === 0
    ? getReturnTypeOfSignature(c, signature)
    : undefined;
}

export function checkComputedPropertyName(c: Checker, node: Node): Type {
  const nodeId = (node as ComputedPropertyName).expression.id;
  if (c.resolvedTypes.get(nodeId) === undefined) {
    const expression = (node as ComputedPropertyName).expression;
    const container = node.parent!.parent!;
    // `[x in y]` in a type member is a mapped type written in the wrong place, reported by the parser.
    if (
      (container.kind === SyntaxKind.TypeLiteral ||
        isClassLike(container) ||
        container.kind === SyntaxKind.InterfaceDeclaration) &&
      expression.kind === SyntaxKind.BinaryExpression &&
      (expression as BinaryExpression).operatorToken.kind === SyntaxKind.InKeyword &&
      node.parent!.kind !== SyntaxKind.GetAccessor &&
      node.parent!.kind !== SyntaxKind.SetAccessor
    ) {
      c.resolvedTypes.set(nodeId, c.errorType);
      return c.resolvedTypes.get(nodeId)!;
    }
    const t = checkExpression(c, expression);
    c.resolvedTypes.set(nodeId, t);
    // Allows string, number, symbol and any, as well as enums, unknown and unions of them.
    if (
      (t.flags & TypeFlags.Nullable) !== 0 ||
      (!isTypeAssignableToKind(c, t, TypeFlags.StringLike | TypeFlags.NumberLike | TypeFlags.ESSymbolLike, false) &&
        !isTypeAssignableTo(c, t, c.stringNumberSymbolType))
    )
      c.error(node, Diagnostics.A_computed_property_name_must_be_of_type_string_number_symbol_or_any);
  }
  return c.resolvedTypes.get(nodeId)!;
}

/** A parameter's declared type without `undefined` when its initializer can't be `undefined`. */
function removeOptionalityFromDeclaredType(c: Checker, declaredType: Type, declaration: Node): Type {
  const removeUndefined =
    c.strictNullChecks &&
    declaration.kind === SyntaxKind.Parameter &&
    getInitializer(declaration) !== undefined &&
    hasTypeFacts(c, declaredType, TypeFacts.IsUndefined) &&
    !parameterInitializerContainsUndefined(c, declaration);
  return removeUndefined ? getTypeWithFacts(c, declaredType, TypeFacts.NEUndefined) : declaredType;
}

function parameterInitializerContainsUndefined(c: Checker, declaration: Node): boolean {
  const links = c.nodeLinks(declaration);
  if ((links.flags & NodeCheckFlags.InitializerIsUndefinedComputed) === 0) {
    if (!pushTypeResolution(c, declaration, TypeSystemPropertyName.InitializerIsUndefined)) {
      reportCircularityError(c, getSymbolOfDeclaration(c, declaration)!);
      return true;
    }
    const containsUndefined = hasTypeFacts(c, checkDeclarationInitializer(c, declaration), TypeFacts.IsUndefined);
    if (!popTypeResolution(c)) {
      reportCircularityError(c, getSymbolOfDeclaration(c, declaration)!);
      return true;
    }
    if ((links.flags & NodeCheckFlags.InitializerIsUndefinedComputed) === 0)
      links.flags |=
        NodeCheckFlags.InitializerIsUndefinedComputed | (containsUndefined ? NodeCheckFlags.InitializerIsUndefined : 0);
  }
  return (links.flags & NodeCheckFlags.InitializerIsUndefined) !== 0;
}

/** Whether `node` is the operand of a spread in an object destructuring assignment, as in `({ ...x } = obj)`. */
function isSpreadDestructuringAssignmentTarget(node: Node): boolean {
  const parent = node.parent!;
  if (parent.kind !== SyntaxKind.SpreadAssignment || parent.parent === undefined) return false;
  const pattern = parent.parent;
  const grandparent = pattern.parent!;
  return (
    (grandparent.kind === SyntaxKind.BinaryExpression && (grandparent as BinaryExpression).left === pattern) ||
    (grandparent.kind === SyntaxKind.ForOfStatement && (grandparent as ForInOrOfStatement).initializer === pattern)
  );
}

/** Whether `node` is in a binding element of the same declaration as the binding element `declaration`. */
function isSameScopedBindingElement(node: Node, declaration: Node): boolean {
  if (declaration.kind !== SyntaxKind.BindingElement) return false;
  let bindingElement = node.parent;
  while (bindingElement !== undefined && bindingElement.kind !== SyntaxKind.BindingElement)
    bindingElement = bindingElement.parent;
  return bindingElement !== undefined && getRootDeclaration(bindingElement) === getRootDeclaration(declaration);
}

/** Whether `node` is the `this` of `typeof this` or `typeof this.x`, which parses as an identifier. */
export function isThisInTypeQuery(node: Node): boolean {
  if (node.kind !== SyntaxKind.Identifier || getText(node) !== 'this') return false;
  let current = node;
  while (current.parent!.kind === SyntaxKind.QualifiedName && (current.parent as QualifiedName).left === current)
    current = current.parent!;
  return current.parent!.kind === SyntaxKind.TypeQuery;
}

/** The type of the expression in a `typeof` type query. */
export function checkTypeQueryExpression(c: Checker, node: Node): Type {
  const exprName = (node as TypeQueryNode).exprName;
  if (exprName.kind === SyntaxKind.Identifier) return checkIdentifier(c, exprName as Identifier);
  if (exprName.kind === SyntaxKind.QualifiedName) return checkQualifiedName(c, exprName as QualifiedName);
  if (exprName.kind === SyntaxKind.ThisKeyword) return checkThisExpression(c, exprName);
  return c.errorType;
}

/** The symbol an identifier refers to as a value; reports unresolved names. */
export function getResolvedSymbol(c: Checker, node: Node): Symbol {
  const cached = c.resolvedSymbols.get(node.id);
  if (cached !== undefined) return cached;
  let symbol = c.unknownSymbol;
  if (getText(node) !== '') {
    const text = getText(node);
    const found = resolveName(
      c,
      node,
      text,
      SymbolFlags.Value | SymbolFlags.ExportValue,
      getCannotFindNameDiagnosticForName(c, node),
      !isWriteOnlyAccess(node),
      false,
    );
    if (found !== undefined) symbol = found;
  }
  c.resolvedSymbols.set(node.id, symbol);
  return symbol;
}

// ---- Dispatch

function checkExpressionWorker(c: Checker, node: Node, checkMode: CheckMode): Type {
  switch (node.kind) {
    case SyntaxKind.Identifier:
      return checkIdentifier(c, node as Identifier, checkMode);
    case SyntaxKind.PrivateIdentifier:
      return checkPrivateIdentifierExpression(c, node);
    case SyntaxKind.ThisKeyword:
      return checkThisExpression(c, node);
    case SyntaxKind.SuperKeyword:
      return checkSuperExpression(c, node);
    case SyntaxKind.NullKeyword:
      return c.nullWideningType;
    case SyntaxKind.TrueKeyword:
      return c.trueType;
    case SyntaxKind.FalseKeyword:
      return c.falseType;
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getFreshTypeOfLiteralType(c, getStringLiteralType(c, getText(node)));
    case SyntaxKind.NumericLiteral:
      return getFreshTypeOfLiteralType(c, getNumberLiteralType(c, Number(getText(node))));
    case SyntaxKind.BigIntLiteral:
      return getFreshTypeOfLiteralType(c, getBigIntLiteralType(c, parseBigIntText(getText(node))));
    case SyntaxKind.TemplateExpression:
      return checkTemplateExpression(c, node as TemplateExpression);
    case SyntaxKind.RegularExpressionLiteral:
      return c.globalRegExpType;
    case SyntaxKind.ArrayLiteralExpression:
      return checkArrayLiteral(c, node as ArrayLiteralExpression, checkMode);
    case SyntaxKind.ObjectLiteralExpression:
      return checkObjectLiteral(c, node, checkMode);
    case SyntaxKind.PropertyAccessExpression:
      return checkPropertyAccessExpression(c, node as PropertyAccessExpression, false, checkMode);
    case SyntaxKind.QualifiedName:
      return checkQualifiedName(c, node as QualifiedName);
    case SyntaxKind.ElementAccessExpression:
      return checkElementAccessExpression(c, node as ElementAccessExpression, checkMode);
    case SyntaxKind.CallExpression:
      return checkCallExpression(c, node, checkMode);
    case SyntaxKind.NewExpression:
      return checkNewExpression(c, node, checkMode);
    case SyntaxKind.TaggedTemplateExpression:
      return checkTaggedTemplateExpression(c, node, checkMode);
    case SyntaxKind.ParenthesizedExpression:
      return checkExpressionEx(c, getExpression(node)!, checkMode);
    case SyntaxKind.ClassExpression:
      return checkClassExpression(c, node);
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return checkFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
    case SyntaxKind.TypeOfExpression:
      checkExpression(c, getExpression(node)!);
      return c.typeofType;
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.AsExpression:
      return checkAssertion(c, node, checkMode);
    case SyntaxKind.NonNullExpression: {
      const leftType = checkExpressionEx(c, getExpression(node)!, checkMode);
      if ((node.flags & NodeFlags.OptionalChain) === 0) return getNonNullableType(c, leftType);
      // In an optional chain, the chain's undefined stays.
      const nonOptionalType = getOptionalExpressionType(c, leftType, getExpression(node)!);
      return propagateOptionalTypeMarker(c, getNonNullableType(c, nonOptionalType), node, nonOptionalType !== leftType);
    }
    case SyntaxKind.ExpressionWithTypeArguments:
      return checkExpressionWithTypeArguments(c, node);
    case SyntaxKind.SatisfiesExpression:
      return checkSatisfiesExpression(c, node, checkMode);
    case SyntaxKind.MetaProperty:
      return checkMetaProperty(c, node);
    case SyntaxKind.DeleteExpression:
      return checkDeleteExpression(c, node);
    case SyntaxKind.VoidExpression:
      // The operand is checked deferred.
      checkNodeDeferred(c, node);
      return c.undefinedWideningType;
    case SyntaxKind.AwaitExpression:
      return checkAwaitExpression(c, node);
    case SyntaxKind.PrefixUnaryExpression:
      return checkPrefixUnaryExpression(c, node as PrefixUnaryExpression);
    case SyntaxKind.PostfixUnaryExpression:
      return checkPostfixUnaryExpression(c, node as PostfixUnaryExpression);
    case SyntaxKind.BinaryExpression:
      return checkBinaryExpression(c, node as BinaryExpression, checkMode);
    case SyntaxKind.ConditionalExpression:
      return checkConditionalExpression(c, node as ConditionalExpression, checkMode);
    case SyntaxKind.SpreadElement:
      return checkSpreadExpression(c, node as SpreadElement, checkMode);
    case SyntaxKind.OmittedExpression:
      return c.undefinedWideningType;
    case SyntaxKind.YieldExpression:
      return checkYieldExpression(c, node);
    case SyntaxKind.SyntheticExpression:
      return c.anyType;
    case SyntaxKind.JsxExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.JsxAttributes:
      return checkJsx(c, node, checkMode);
  }
  return c.errorType;
}

export function parseBigIntText(text: string): string {
  let digits = text.endsWith('n') ? text.substring(0, text.length - 1) : text;
  digits = digits.split('_').join('');
  if (digits.length > 2 && digits.charCodeAt(0) === 0x30) {
    const radix = digits.charCodeAt(1) | 0x20;
    if (radix === 0x78 || radix === 0x6f || radix === 0x62) return BigInt(digits).toString();
  }
  let i = 0;
  while (i < digits.length - 1 && digits.charCodeAt(i) === 0x30) i++;
  return digits.substring(i);
}

// ---- Identifiers and `this`

export function checkIdentifier(c: Checker, node: Identifier, checkMode: CheckMode = CheckMode.Normal): Type {
  if (isThisInTypeQuery(node)) return checkThisExpression(c, node);
  const symbol = getResolvedSymbol(c, node);
  if (symbol === c.unknownSymbol) return c.errorType;
  if (symbol === c.argumentsSymbol) {
    if (isInPropertyInitializerOrClassStaticBlock(node, true)) {
      c.error(
        node,
        Diagnostics.X_arguments_cannot_be_referenced_in_property_initializers_or_class_static_initialization_blocks,
      );
      return c.errorType;
    }
    return getTypeOfSymbol(c, symbol);
  }
  markIdentifierAliasReferencedInExpression(c, node);
  const localOrExportSymbol = getExportSymbolOfValueSymbolIfExported(c, symbol);
  checkDeprecatedIdentifier(c, node, localOrExportSymbol);
  let declaration = localOrExportSymbol.valueDeclaration;
  const immediateDeclaration = declaration;
  // In `const [a, b = a + 1] = [2]`, `a` is `any` while computing the contextual type of `[2]`.
  if (
    declaration !== undefined &&
    declaration.kind === SyntaxKind.BindingElement &&
    c.contextualBindingPatterns.includes(declaration.parent!) &&
    isDescendantOf(node, declaration.parent!)
  )
    return c.nonInferrableAnyType;
  let t = getNarrowableTypeForReference(c, getNarrowedTypeOfSymbol(c, localOrExportSymbol, node), node, checkMode);
  const assignmentKind = getAssignmentTargetKind(node);
  if (assignmentKind !== AssignmentKind.None) {
    if ((localOrExportSymbol.flags & SymbolFlags.Variable) === 0) {
      let message = Diagnostics.Cannot_assign_to_0_because_it_is_not_a_variable;
      if ((localOrExportSymbol.flags & SymbolFlags.Enum) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_an_enum;
      else if ((localOrExportSymbol.flags & SymbolFlags.Class) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_a_class;
      else if ((localOrExportSymbol.flags & SymbolFlags.Module) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_a_namespace;
      else if ((localOrExportSymbol.flags & SymbolFlags.Function) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_a_function;
      else if ((localOrExportSymbol.flags & SymbolFlags.Alias) !== 0)
        message = Diagnostics.Cannot_assign_to_0_because_it_is_an_import;
      c.error(node, message, symbolToString(c, symbol));
      return c.errorType;
    }
    if (isReadonlySymbol(c, localOrExportSymbol)) {
      c.error(node, Diagnostics.Cannot_assign_to_0_because_it_is_a_constant, symbolToString(c, symbol));
      return c.errorType;
    }
  }
  const isAlias = (localOrExportSymbol.flags & SymbolFlags.Alias) !== 0;
  // Only variables and parameters outside assignment targets are narrowed.
  if ((localOrExportSymbol.flags & SymbolFlags.Variable) !== 0) {
    if (assignmentKind === AssignmentKind.Definite)
      return isInCompoundLikeAssignment(node) ? getBaseTypeOfLiteralType(c, t) : t;
  } else if (isAlias) declaration = getDeclarationOfAliasSymbol(symbol);
  else return t;
  if (declaration === undefined) return t;
  const isParameter = getRootDeclaration(declaration).kind === SyntaxKind.Parameter;
  // The CommonJS `module` symbol is declared by its source file.
  const declarationContainer = declaration.parent !== undefined ? getControlFlowContainer(declaration) : undefined;
  let flowContainer = getControlFlowContainer(node);
  const isOuterVariable = flowContainer !== declarationContainer;
  const isModuleExports = (symbol.flags & SymbolFlags.ModuleExports) !== 0;
  const typeIsAutomatic = t === c.autoType || t === c.autoArrayType;
  const isAutomaticTypeInNonNull = typeIsAutomatic && node.parent!.kind === SyntaxKind.NonNullExpression;
  // Closures see narrowings of constants, and of variables past their last assignment.
  while (
    flowContainer !== declarationContainer &&
    (isFunctionExpressionOrArrowFunction(flowContainer) ||
      isObjectLiteralOrClassExpressionMethodOrAccessor(flowContainer)) &&
    ((isConstantVariable(c, localOrExportSymbol) && t !== c.autoArrayType) ||
      (isParameterOrMutableLocalVariable(c, localOrExportSymbol) && isPastLastAssignment(c, localOrExportSymbol, node)))
  )
    flowContainer = getControlFlowContainer(flowContainer);
  const isNeverInitialized =
    immediateDeclaration !== undefined &&
    immediateDeclaration.kind === SyntaxKind.VariableDeclaration &&
    immediateDeclaration.parent!.parent!.kind !== SyntaxKind.ForInStatement &&
    immediateDeclaration.parent!.parent!.kind !== SyntaxKind.ForOfStatement &&
    getInitializer(immediateDeclaration) === undefined &&
    (immediateDeclaration as VariableDeclaration).exclamationToken === undefined &&
    isMutableLocalVariableDeclaration(immediateDeclaration) &&
    !isSymbolAssignedDefinitely(c, localOrExportSymbol);
  const assumeInitialized =
    isParameter ||
    isAlias ||
    (isOuterVariable && !isNeverInitialized) ||
    isSpreadDestructuringAssignmentTarget(node) ||
    isModuleExports ||
    isSameScopedBindingElement(node, declaration) ||
    (t !== c.autoType &&
      t !== c.autoArrayType &&
      (!c.strictNullChecks ||
        (t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void)) !== 0 ||
        isPartOfTypeQuery(node) ||
        isInAmbientOrTypeNode(node) ||
        node.parent!.kind === SyntaxKind.ExportSpecifier)) ||
    node.parent!.kind === SyntaxKind.NonNullExpression ||
    (declaration.kind === SyntaxKind.VariableDeclaration &&
      (declaration as VariableDeclaration).exclamationToken !== undefined) ||
    (declaration.flags & NodeFlags.Ambient) !== 0;
  let initialType: Type;
  if (isAutomaticTypeInNonNull) initialType = c.undefinedType;
  else if (assumeInitialized && isParameter) initialType = removeOptionalityFromDeclaredType(c, t, declaration);
  else if (assumeInitialized) initialType = t;
  else if (typeIsAutomatic) initialType = c.undefinedType;
  else initialType = getOptionalType(c, t, false);
  let flowType = getFlowTypeOfReference(c, node, t, initialType, flowContainer);
  if (isAutomaticTypeInNonNull) flowType = getNonNullableType(c, flowType);
  if (!isEvolvingArrayOperationTarget(c, node) && typeIsAutomatic) {
    if (flowType === c.autoType || flowType === c.autoArrayType) {
      if (c.noImplicitAny) {
        c.error(
          getNameOfDeclaration(declaration),
          Diagnostics.Variable_0_implicitly_has_type_1_in_some_locations_where_its_type_cannot_be_determined,
          symbolToString(c, symbol),
          typeToString(c, flowType),
        );
        c.error(
          node,
          Diagnostics.Variable_0_implicitly_has_an_1_type,
          symbolToString(c, symbol),
          typeToString(c, flowType),
        );
      }
      return convertAutoToAny(c, flowType);
    }
  } else if (!assumeInitialized && !containsUndefinedType(t) && containsUndefinedType(flowType)) {
    c.error(node, Diagnostics.Variable_0_is_used_before_being_assigned, symbolToString(c, symbol));
    return t;
  }
  return assignmentKind !== AssignmentKind.None ? getBaseTypeOfLiteralType(c, flowType) : flowType;
}

/**
 * A reference's type with union constraints substituted for generic types where only the
 * constraint matters, so narrowing can apply: in constraint positions like `x.p`, or with a
 * non-generic contextual type.
 */
export function getNarrowableTypeForReference(
  c: Checker,
  t: Type,
  reference: Node,
  checkMode: CheckMode = CheckMode.Normal,
): Type {
  if (isNoInferType(c, t)) t = (t as SubstitutionType).baseType;
  const substituteConstraints =
    (checkMode & CheckMode.Inferential) === 0 &&
    someTypeIsGenericWithUnionConstraint(c, t) &&
    (isConstraintPosition(c, t, reference) || hasContextualTypeWithNoGenericTypes(c, reference, checkMode));
  return substituteConstraints ? mapToBaseConstraintOrType(c, t) : t;
}

export function someTypeIsGenericWithUnionConstraint(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Union) === 0) return isGenericTypeWithUnionConstraint(c, t);
  for (const u of typesOf(t)) if (isGenericTypeWithUnionConstraint(c, u)) return true;
  return false;
}

function isConstraintPosition(c: Checker, t: Type, node: Node): boolean {
  const parent = node.parent!;
  // `obj[x]` keeps `T[K]` when both are generic and obj's constraint isn't nullable.
  return (
    parent.kind === SyntaxKind.PropertyAccessExpression ||
    parent.kind === SyntaxKind.QualifiedName ||
    ((parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) &&
      getExpression(parent) === node) ||
    (parent.kind === SyntaxKind.ElementAccessExpression &&
      getExpression(parent) === node &&
      !(
        someType(t, (u) => isGenericTypeWithoutNullableConstraint(c, u)) &&
        isGenericIndexType(c, getTypeOfExpression(c, (parent as ElementAccessExpression).argumentExpression))
      ))
  );
}

function isGenericTypeWithUnionConstraint(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (isGenericTypeWithUnionConstraint(c, u)) return true;
    return false;
  }
  return (
    (t.flags & TypeFlags.Instantiable) !== 0 &&
    (getBaseConstraintOrType(c, t).flags & (TypeFlags.Nullable | TypeFlags.Union)) !== 0
  );
}

function isGenericTypeWithoutNullableConstraint(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (isGenericTypeWithoutNullableConstraint(c, u)) return true;
    return false;
  }
  return (
    (t.flags & TypeFlags.Instantiable) !== 0 && !maybeTypeOfKind(getBaseConstraintOrType(c, t), TypeFlags.Nullable)
  );
}

function hasContextualTypeWithNoGenericTypes(c: Checker, node: Node, checkMode: CheckMode): boolean {
  // JSX tag names are excluded: their contextual type resolves the tag itself.
  if (
    node.kind !== SyntaxKind.Identifier &&
    node.kind !== SyntaxKind.PropertyAccessExpression &&
    node.kind !== SyntaxKind.ElementAccessExpression
  )
    return false;
  const parent = node.parent!;
  if (
    (parent.kind === SyntaxKind.JsxOpeningElement || parent.kind === SyntaxKind.JsxSelfClosingElement) &&
    getTagName(parent) === node
  )
    return false;
  // Rest elements skip binding pattern contextual types, so their type stays generic when possible.
  const contextualType = getContextualTypeEx(
    c,
    node,
    (checkMode & CheckMode.RestBindingElement) !== 0 ? ContextFlags.SkipBindingPatterns : ContextFlags.None,
  );
  return contextualType !== undefined && !isGenericType(c, contextualType);
}

/** Whether `t` is or includes undefined, which includes the missing type of an optional property or element. */
function containsUndefinedType(t: Type): boolean {
  const u = (t.flags & TypeFlags.Union) !== 0 ? (t as UnionType).types[0]! : t;
  return (u.flags & TypeFlags.Undefined) !== 0;
}

function isDescendantOf(node: Node, ancestor: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

export function isInAmbientOrTypeNode(node: Node): boolean {
  if ((node.flags & NodeFlags.Ambient) !== 0) return true;
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    if (
      current.kind === SyntaxKind.InterfaceDeclaration ||
      current.kind === SyntaxKind.TypeAliasDeclaration ||
      current.kind === SyntaxKind.TypeLiteral
    )
      return true;
  }
  return false;
}

export function checkThisExpression(c: Checker, node: Node): Type {
  // Stop at the first arrow function to tell whether `this` is captured.
  let container = getThisContainer(node, true, true);
  let capturedByArrowFunction = false;
  let thisInComputedPropertyName = false;
  if (container.kind === SyntaxKind.Constructor)
    checkThisBeforeSuper(
      c,
      node,
      container,
      Diagnostics.X_super_must_be_called_before_accessing_this_in_the_constructor_of_a_derived_class,
    );
  for (;;) {
    // Skip arrow functions to the real owner of `this`.
    if (container.kind === SyntaxKind.ArrowFunction) {
      container = getThisContainer(container, false, !thisInComputedPropertyName);
      capturedByArrowFunction = true;
    }
    if (container.kind === SyntaxKind.ComputedPropertyName) {
      container = getThisContainer(container, !capturedByArrowFunction, false);
      thisInComputedPropertyName = true;
      continue;
    }
    break;
  }
  checkThisInStaticClassFieldInitializerInDecoratedClass(c, node, container);
  if (thisInComputedPropertyName) c.error(node, Diagnostics.X_this_cannot_be_referenced_in_a_computed_property_name);
  else if (container.kind === SyntaxKind.ModuleDeclaration)
    c.error(node, Diagnostics.X_this_cannot_be_referenced_in_a_module_or_namespace_body);
  else if (container.kind === SyntaxKind.EnumDeclaration)
    c.error(node, Diagnostics.X_this_cannot_be_referenced_in_current_location);
  const t = tryGetThisTypeAt(c, node, container);
  if (c.noImplicitThis) {
    const globalThisType = getTypeOfSymbol(c, c.globalThisSymbol);
    if (t === globalThisType && capturedByArrowFunction)
      c.error(node, Diagnostics.The_containing_arrow_function_captures_the_global_value_of_this);
    else if (t === undefined) {
      // The related information goes on the reported diagnostic after it is added, as tsgo attaches it,
      // so a later equal report compares unequal to it and is kept.
      const diagnostic = c.error(
        node,
        Diagnostics.X_this_implicitly_has_type_any_because_it_does_not_have_a_type_annotation,
      );
      if (container.kind !== SyntaxKind.SourceFile) {
        const outsideThis = tryGetThisTypeAt(c, container, getThisContainer(container, false, false));
        if (outsideThis !== undefined && outsideThis !== globalThisType)
          diagnostic.addRelatedInfo(
            createDiagnosticForNode(container, Diagnostics.An_outer_value_of_this_is_shadowed_by_this_container, []),
          );
      }
    }
  }
  return t ?? c.anyType;
}

function tryGetThisTypeAt(c: Checker, node: Node, container: Node): Type | undefined {
  if (isFunctionLike(container) && container.kind !== SyntaxKind.Constructor) {
    const thisType =
      getThisTypeOfSignature(
        c,
        getSignatureOfFullSignatureType(c, container) ?? getSignatureFromDeclaration(c, container),
      ) ?? getContextualThisParameterType(c, container);
    if (thisType !== undefined) return getFlowTypeOfReference(c, node, thisType, thisType, undefined);
  }
  const parent = container.parent;
  if (parent !== undefined && isClassLike(parent)) {
    const classSymbol = getSymbolOfDeclaration(c, parent);
    if (classSymbol === undefined) return c.anyType;
    const t =
      isStatic(container) || container.kind === SyntaxKind.ClassStaticBlockDeclaration
        ? getTypeOfSymbol(c, classSymbol)
        : getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, classSymbol)).thisType;
    return t !== undefined ? getFlowTypeOfReference(c, node, t, t, undefined) : c.anyType;
  }
  if (container.kind === SyntaxKind.SourceFile) {
    if ((container as SourceFile).externalModuleIndicator !== undefined) return c.undefinedType;
    return getTypeOfSymbol(c, c.globalThisSymbol);
  }
  return undefined;
}

/** The `this` type of a function expression or method from its context, such as its object literal. */
export function getContextualThisParameterType(c: Checker, func: Node): Type | undefined {
  if (func.kind === SyntaxKind.ArrowFunction) return undefined;
  if (isContextSensitiveFunctionOrObjectLiteralMethod(c, func)) {
    const signature = getContextualSignatureForFunctionLikeDeclaration(c, func);
    if (signature !== undefined && signature.thisParameter !== undefined)
      return getTypeOfSymbol(c, signature.thisParameter);
  }
  if (!c.noImplicitThis && !isInJSFile(func)) return undefined;
  const literal = getContainingObjectLiteral(func);
  if (literal !== undefined) return getThisTypeOfObjectLiteralMember(c, literal);
  return getThisTypeOfAssignedFunction(c, func);
}

function getContainingObjectLiteral(func: Node): Node | undefined {
  const parent = func.parent!;
  if (
    (func.kind === SyntaxKind.MethodDeclaration ||
      func.kind === SyntaxKind.GetAccessor ||
      func.kind === SyntaxKind.SetAccessor) &&
    parent.kind === SyntaxKind.ObjectLiteralExpression
  )
    return parent;
  if (func.kind === SyntaxKind.FunctionExpression && parent.kind === SyntaxKind.PropertyAssignment)
    return parent.parent;
  return undefined;
}

// ---- Literals

function checkTemplateExpression(c: Checker, node: TemplateExpression): Type {
  const texts = [getText(node.head)];
  const types: Type[] = [];
  for (const span of node.templateSpans.nodes) {
    const expression = getExpression(span)!;
    const t = checkExpression(c, expression);
    if (
      maybeTypeOfKind(t, TypeFlags.ESSymbolLike) ||
      maybeTypeOfKind(getBaseConstraintOrType(c, t), TypeFlags.ESSymbolLike)
    )
      c.error(
        expression,
        Diagnostics.Implicit_conversion_of_a_symbol_to_a_string_will_fail_at_runtime_Consider_wrapping_this_expression_in_String,
      );
    texts.push(getText((span as TemplateSpan).literal));
    types.push(isTypeAssignableTo(c, t, c.templateConstraintType) ? t : c.stringType);
  }
  if (node.parent!.kind !== SyntaxKind.TaggedTemplateExpression) {
    const evaluated = evaluate(c, node, node);
    if (evaluated.kind === EvaluatedKind.String)
      return getFreshTypeOfLiteralType(c, getStringLiteralType(c, evaluated.stringValue));
  }
  if (
    isConstContext(c, node) ||
    isTemplateLiteralContext(node) ||
    someType(getContextualType(c, node) ?? c.unknownType, (t) => isTemplateLiteralContextualType(c, t))
  )
    return getTemplateLiteralType(c, texts, types);
  return c.stringType;
}

function isTemplateLiteralContext(node: Node): boolean {
  const parent = node.parent!;
  return (
    (parent.kind === SyntaxKind.ParenthesizedExpression && isTemplateLiteralContext(parent)) ||
    (parent.kind === SyntaxKind.ElementAccessExpression &&
      (parent as ElementAccessExpression).argumentExpression === node)
  );
}

function isTemplateLiteralContextualType(c: Checker, t: Type): boolean {
  return (
    (t.flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral)) !== 0 ||
    ((t.flags & TypeFlags.InstantiableNonPrimitive) !== 0 &&
      maybeTypeOfKind(getBaseConstraintOfType(c, t) ?? c.unknownType, TypeFlags.StringLike))
  );
}

function checkSpreadExpression(c: Checker, node: SpreadElement, checkMode: CheckMode): Type {
  const arrayOrIterableType = checkExpressionEx(c, node.expression, checkMode);
  return checkIteratedTypeOrElementType(c, IterationUse.Spread, arrayOrIterableType, c.undefinedType, node.expression);
}

function checkArrayLiteral(c: Checker, node: ArrayLiteralExpression, checkMode: CheckMode): Type {
  const elements = node.elements.nodes;
  const elementTypes: Type[] = [];
  const elementInfos: TupleElementInfo[] = [];
  // The elements' contextual types come from the literal's, computed once.
  pushCachedContextualType(c, node);
  const inDestructuringPattern = isAssignmentTarget(node);
  const inConstContext = isConstContext(c, node);
  const contextualType = getApparentTypeOfContextualType(c, node);
  const inTupleContext =
    isSpreadIntoCallOrNew(node) ||
    (contextualType !== undefined && someType(contextualType, (t) => isTupleLikeContext(c, t)));
  let hasOmittedExpression = false;
  for (const e of elements) {
    if (e.kind === SyntaxKind.SpreadElement) {
      const spreadType = checkExpressionEx(c, (e as SpreadElement).expression, checkMode);
      if (isArrayLikeType(c, spreadType)) {
        elementTypes.push(spreadType);
        elementInfos.push(new TupleElementInfo(ElementFlags.Variadic, undefined));
      } else if (inDestructuringPattern) {
        // `[...c] = ...` makes `c` a rest target that only provides a contextual type, so it's not
        // checked as iterable.
        const restElementType =
          getIndexTypeOfType(c, spreadType, c.numberType) ??
          getIteratedTypeOrElementType(c, IterationUse.Destructuring, spreadType, c.undefinedType, undefined, false) ??
          c.unknownType;
        elementTypes.push(restElementType);
        elementInfos.push(new TupleElementInfo(ElementFlags.Rest, undefined));
      } else {
        elementTypes.push(
          checkIteratedTypeOrElementType(
            c,
            IterationUse.Spread,
            spreadType,
            c.undefinedType,
            (e as SpreadElement).expression,
          ),
        );
        elementInfos.push(new TupleElementInfo(ElementFlags.Rest, undefined));
      }
    } else if (c.exactOptionalPropertyTypes && e.kind === SyntaxKind.OmittedExpression) {
      hasOmittedExpression = true;
      elementTypes.push(c.undefinedOrMissingType);
      elementInfos.push(new TupleElementInfo(ElementFlags.Optional, undefined));
    } else {
      const t =
        e.kind === SyntaxKind.OmittedExpression
          ? c.undefinedWideningType
          : checkExpressionForMutableLocationEx(c, e, checkMode);
      if (
        inTupleContext &&
        (checkMode & CheckMode.Inferential) !== 0 &&
        (checkMode & CheckMode.SkipContextSensitive) === 0 &&
        isContextSensitive(c, e)
      ) {
        // Inferences flowing between context-sensitive tuple elements are made before fixing.
        const inferenceContext = getInferenceContext(c, node);
        if (inferenceContext !== undefined) addIntraExpressionInferenceSite(inferenceContext, e, t);
      }
      elementTypes.push(addOptionality(c, t, true, hasOmittedExpression));
      elementInfos.push(
        new TupleElementInfo(hasOmittedExpression ? ElementFlags.Optional : ElementFlags.Required, undefined),
      );
    }
  }
  popContextualType(c);
  if (inDestructuringPattern) return createTupleTypeEx(c, elementTypes, elementInfos, false);
  if (inConstContext || inTupleContext || (checkMode & CheckMode.ForceTuple) !== 0)
    return createArrayLiteralType(
      c,
      createTupleTypeEx(
        c,
        elementTypes,
        elementInfos,
        inConstContext &&
          !(contextualType !== undefined && someType(contextualType, (t) => isMutableArrayLikeType(c, t))),
      ),
    );
  let elementType: Type;
  if (elementTypes.length > 0) {
    for (let i = 0; i < elementTypes.length; i++)
      if ((elementInfos[i]!.flags & ElementFlags.Variadic) !== 0)
        elementTypes[i] =
          getIndexedAccessTypeOrUndefinedEx(
            c,
            elementTypes[i]!,
            c.numberType,
            AccessFlags.None,
            undefined,
            undefined,
          ) ?? c.anyType;
    elementType = getUnionTypeEx(c, elementTypes, UnionReduction.Subtype, undefined, undefined);
  } else elementType = c.strictNullChecks ? c.implicitNeverType : c.undefinedWideningType;
  return createArrayLiteralType(c, createArrayTypeEx(c, elementType, inConstContext));
}

function isSpreadIntoCallOrNew(node: Node): boolean {
  let parent = node.parent!;
  while (parent.kind === SyntaxKind.ParenthesizedExpression) parent = parent.parent!;
  return (
    parent.kind === SyntaxKind.SpreadElement &&
    (parent.parent!.kind === SyntaxKind.CallExpression || parent.parent!.kind === SyntaxKind.NewExpression)
  );
}

function isTupleLikeContext(c: Checker, t: Type): boolean {
  if (isTupleLikeType(c, t)) return true;
  if (!isGenericMappedType(c, t)) return false;
  const mapped = t as MappedType;
  if (mapped.nameType !== undefined) return false;
  const target = mapped.target;
  return getHomomorphicTypeVariable(c, target !== undefined ? (target as MappedType) : mapped) !== undefined;
}

export function isTupleLikeType(c: Checker, t: Type): boolean {
  if (isTupleType(t) || getPropertyOfType(c, t, '0') !== undefined) return true;
  if (!isArrayLikeType(c, t)) return false;
  const lengthType = getTypeOfPropertyOfType(c, t, 'length');
  return lengthType !== undefined && everyType(lengthType, (u) => (u.flags & TypeFlags.NumberLiteral) !== 0);
}

/** Whether `t` is a mutable array, a mutable tuple, or assignable to `any[]`. */
export function isMutableArrayLikeType(c: Checker, t: Type): boolean {
  return (
    isMutableArrayOrTuple(c, t) ||
    ((t.flags & (TypeFlags.Any | TypeFlags.Nullable | TypeFlags.Never)) === 0 &&
      isTypeAssignableTo(c, t, c.anyArrayType))
  );
}

function createArrayLiteralType(c: Checker, t: Type): Type {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return t;
  const key = cachedTypeKey(CachedTypeKind.ArrayLiteral, t.id);
  let literal = c.cachedTypesById.get(key);
  if (literal === undefined) {
    literal = cloneTypeReference(c, t as TypeReference);
    literal.objectFlags |= ObjectFlags.ArrayLiteral | ObjectFlags.ContainsObjectOrArrayLiteral;
    c.cachedTypesById.set(key, literal);
  }
  return literal;
}

/** The name of an object literal element, or undefined when it's computed and not a literal. */
export function getPropertyNameOfObjectLiteralElement(c: Checker, element: Node): string | undefined {
  const name = getName(element);
  if (name === undefined) return undefined;
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getText(name);
    case SyntaxKind.NumericLiteral:
      return String(Number(getText(name)));
    case SyntaxKind.BigIntLiteral:
      return parseBigIntText(getText(name));
    case SyntaxKind.ComputedPropertyName: {
      const t = checkComputedPropertyName(c, name);
      return isTypeUsableAsPropertyName(t) ? getPropertyNameFromType(t) : undefined;
    }
  }
  return undefined;
}

/** Whether `node` is in an `as const` context, where literals keep their types. */
export function isConstContext(c: Checker, node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  // Literals contextually typed by a `const` type parameter are in a const context.
  if (isValidConstAssertionArgument(c, node) && isConstTypeVariable(c, getContextualType(c, node), 0)) return true;
  switch (parent.kind) {
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      return isConstTypeReference(getType(parent)!);
    // As in tsgo, a const context does not reach through `satisfies` or into the branches of a
    // conditional expression: those are in one only when their own contextual type is a `const`
    // type parameter (above).
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.SpreadElement:
      return isConstContext(c, parent);
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
      return isConstContext(c, parent.parent!);
    case SyntaxKind.TemplateSpan:
      return isConstContext(c, parent.parent!);
  }
  return false;
}

/** Whether `as const` applies to the expression: a literal, or a reference to an enum member. */
function isValidConstAssertionArgument(c: Checker, node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.TemplateExpression:
      return true;
    case SyntaxKind.ParenthesizedExpression:
      return isValidConstAssertionArgument(c, getExpression(node)!);
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = node as PrefixUnaryExpression;
      const kind = unary.operand.kind;
      return (
        (unary.operator === SyntaxKind.MinusToken &&
          (kind === SyntaxKind.NumericLiteral || kind === SyntaxKind.BigIntLiteral)) ||
        (unary.operator === SyntaxKind.PlusToken && kind === SyntaxKind.NumericLiteral)
      );
    }
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression: {
      const expr = skipParentheses(getExpression(node)!);
      const symbol = isEntityNameExpression(expr, false)
        ? resolveEntityName(c, expr, SymbolFlags.Value, true, false, undefined)
        : undefined;
      return symbol !== undefined && (symbol.flags & SymbolFlags.Enum) !== 0;
    }
  }
  return false;
}

export function isConstTypeReference(node: Node): boolean {
  if (node.kind !== SyntaxKind.TypeReference) return false;
  const ref = node as TypeReferenceNode;
  return (
    ref.typeName.kind === SyntaxKind.Identifier && getText(ref.typeName) === 'const' && ref.typeArguments === undefined
  );
}

/** Widens a literal type unless the contextual type calls for literals of its kind. */
export function getWidenedLiteralLikeTypeForContextualType(
  c: Checker,
  t: Type,
  contextualType: Type | undefined,
): Type {
  if (!isLiteralOfContextualType(c, t, contextualType))
    return getWidenedUniqueESSymbolType(c, getWidenedLiteralType(c, t));
  return getRegularTypeOfLiteralType(c, t);
}

export function isLiteralOfContextualType(c: Checker, candidate: Type, contextualType: Type | undefined): boolean {
  if (contextualType === undefined) return false;
  if ((contextualType.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const t of typesOf(contextualType)) if (isLiteralOfContextualType(c, candidate, t)) return true;
    return false;
  }
  if ((contextualType.flags & TypeFlags.InstantiableNonPrimitive) !== 0) {
    const constraint = getBaseConstraintOfType(c, contextualType) ?? c.unknownType;
    return (
      (maybeTypeOfKind(constraint, TypeFlags.String) && maybeTypeOfKind(candidate, TypeFlags.StringLiteral)) ||
      (maybeTypeOfKind(constraint, TypeFlags.Number) && maybeTypeOfKind(candidate, TypeFlags.NumberLiteral)) ||
      (maybeTypeOfKind(constraint, TypeFlags.BigInt) && maybeTypeOfKind(candidate, TypeFlags.BigIntLiteral)) ||
      (maybeTypeOfKind(constraint, TypeFlags.ESSymbol) && maybeTypeOfKind(candidate, TypeFlags.UniqueESSymbol)) ||
      isLiteralOfContextualType(c, candidate, constraint)
    );
  }
  return (
    ((contextualType.flags &
      (TypeFlags.StringLiteral | TypeFlags.Index | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)) !==
      0 &&
      maybeTypeOfKind(candidate, TypeFlags.StringLiteral)) ||
    ((contextualType.flags & TypeFlags.NumberLiteral) !== 0 && maybeTypeOfKind(candidate, TypeFlags.NumberLiteral)) ||
    ((contextualType.flags & TypeFlags.BigIntLiteral) !== 0 && maybeTypeOfKind(candidate, TypeFlags.BigIntLiteral)) ||
    ((contextualType.flags & TypeFlags.BooleanLiteral) !== 0 && maybeTypeOfKind(candidate, TypeFlags.BooleanLiteral)) ||
    ((contextualType.flags & TypeFlags.UniqueESSymbol) !== 0 && maybeTypeOfKind(candidate, TypeFlags.UniqueESSymbol))
  );
}

// ---- Property and element access

/**
 * The type of an expression used as an object, with `null` and `undefined` removed. Without
 * narrowing, nullability errors are only reported where no narrowing could apply.
 */
export function checkNonNullExpression(c: Checker, node: Node): Type {
  return checkNonNullType(c, checkExpression(c, node), node);
}

export function checkNonNullType(c: Checker, t: Type, node: Node): Type {
  return checkNonNullTypeEx(c, t, node, false);
}

/** `checkNonNullType`, reporting a possibly nullish callee of a call when `isCallee`. */
export function checkNonNullTypeEx(c: Checker, t: Type, node: Node, isCallee: boolean): Type {
  if (c.strictNullChecks && (t.flags & TypeFlags.Unknown) !== 0) {
    if (isEntityNameExpression(node, false)) {
      const nodeText = entityNameToString(node);
      if (nodeText.length < 100) {
        c.error(node, Diagnostics.X_0_is_of_type_unknown, nodeText);
        return c.errorType;
      }
    }
    c.error(node, Diagnostics.Object_is_of_type_unknown);
    return c.errorType;
  }
  const facts = getTypeFacts(c, t, TypeFacts.IsUndefinedOrNull);
  if ((facts & TypeFacts.IsUndefinedOrNull) !== 0) {
    if (isCallee) reportCannotInvokePossiblyNullOrUndefinedError(c, node, facts);
    else reportObjectPossiblyNullOrUndefinedError(c, node, facts);
    const nonNullable = getNonNullableType(c, t);
    return (nonNullable.flags & (TypeFlags.Nullable | TypeFlags.Never)) !== 0 ? c.errorType : nonNullable;
  }
  return t;
}

function reportCannotInvokePossiblyNullOrUndefinedError(c: Checker, node: Node, facts: TypeFacts): void {
  c.error(
    node,
    (facts & TypeFacts.IsUndefined) !== 0
      ? (facts & TypeFacts.IsNull) !== 0
        ? Diagnostics.Cannot_invoke_an_object_which_is_possibly_null_or_undefined
        : Diagnostics.Cannot_invoke_an_object_which_is_possibly_undefined
      : Diagnostics.Cannot_invoke_an_object_which_is_possibly_null,
  );
}

function reportObjectPossiblyNullOrUndefinedError(c: Checker, node: Node, facts: TypeFacts): void {
  if (node.kind === SyntaxKind.NullKeyword) {
    c.error(node, Diagnostics.The_value_0_cannot_be_used_here, 'null');
    return;
  }
  const nodeText = isEntityNameExpression(node, false) ? entityNameToString(node) : '';
  if (nodeText !== '' && nodeText.length < 100) {
    if (node.kind === SyntaxKind.Identifier && nodeText === 'undefined') {
      c.error(node, Diagnostics.The_value_0_cannot_be_used_here, 'undefined');
      return;
    }
    c.error(
      node,
      (facts & TypeFacts.IsUndefined) !== 0
        ? (facts & TypeFacts.IsNull) !== 0
          ? Diagnostics.X_0_is_possibly_null_or_undefined
          : Diagnostics.X_0_is_possibly_undefined
        : Diagnostics.X_0_is_possibly_null,
      nodeText,
    );
  } else {
    c.error(
      node,
      (facts & TypeFacts.IsUndefined) !== 0
        ? (facts & TypeFacts.IsNull) !== 0
          ? Diagnostics.Object_is_possibly_null_or_undefined
          : Diagnostics.Object_is_possibly_undefined
        : Diagnostics.Object_is_possibly_null,
    );
  }
}

/** `checkNonNullType`, also reporting a `void` type as possibly undefined. */
export function checkNonNullNonVoidType(c: Checker, t: Type, node: Node): Type {
  const nonNullType = checkNonNullType(c, t, node);
  if ((nonNullType.flags & TypeFlags.Void) === 0) return nonNullType;
  if (isEntityNameExpression(node, false)) {
    const nodeText = entityNameToString(node);
    if (node.kind === SyntaxKind.Identifier && nodeText === 'undefined') {
      c.error(node, Diagnostics.The_value_0_cannot_be_used_here, nodeText);
      return nonNullType;
    }
    if (nodeText.length < 100) {
      c.error(node, Diagnostics.X_0_is_possibly_undefined, nodeText);
      return nonNullType;
    }
  }
  c.error(node, Diagnostics.Object_is_possibly_undefined);
  return nonNullType;
}

export function entityNameToString(node: Node): string {
  switch (node.kind) {
    case SyntaxKind.Identifier:
      return getText(node);
    case SyntaxKind.ThisKeyword:
      return 'this';
    case SyntaxKind.PropertyAccessExpression: {
      const access = node as PropertyAccessExpression;
      return entityNameToString(access.expression) + '.' + entityNameToString(access.name);
    }
    case SyntaxKind.QualifiedName: {
      const q = node as QualifiedName;
      return entityNameToString(q.left) + '.' + q.right.text;
    }
  }
  return getText(node);
}

/** The type of `obj.name`; `writeOnly` gives the type it can be assigned, as for compound assignments. */
export function checkPropertyAccessExpression(
  c: Checker,
  node: PropertyAccessExpression,
  writeOnly: boolean,
  checkMode: CheckMode = CheckMode.Normal,
): Type {
  if (!isOptionalChain(node))
    return checkPropertyAccessExpressionOrQualifiedName(
      c,
      node,
      node.expression,
      checkNonNullExpression(c, node.expression),
      node.name,
      writeOnly,
      checkMode,
    );
  const leftType = checkExpression(c, node.expression);
  const nonOptional = getOptionalExpressionType(c, leftType, node.expression);
  const t = checkPropertyAccessExpressionOrQualifiedName(
    c,
    node,
    node.expression,
    checkNonNullType(c, nonOptional, node.expression),
    node.name,
    writeOnly,
    checkMode,
  );
  return propagateOptionalTypeMarker(c, t, node, nonOptional !== leftType);
}

export function checkQualifiedName(c: Checker, node: QualifiedName): Type {
  const leftType = checkNonNullExpressionOfEntity(c, node.left);
  return checkPropertyAccessExpressionOrQualifiedName(c, node, node.left, leftType, node.right, false);
}

function checkNonNullExpressionOfEntity(c: Checker, node: Node): Type {
  if (node.kind === SyntaxKind.Identifier) return checkNonNullType(c, checkIdentifier(c, node as Identifier), node);
  return checkNonNullType(c, checkQualifiedName(c, node as QualifiedName), node);
}

export function getFlowTypeOfAccessExpression(
  c: Checker,
  node: Node,
  prop: Symbol | undefined,
  propTypeIn: Type,
  errorNode: Node,
  checkMode: CheckMode = CheckMode.Normal,
): Type {
  let propType = propTypeIn;
  const assignmentKind = getAssignmentTargetKind(node);
  if (assignmentKind === AssignmentKind.Definite)
    return removeMissingType(c, propType, prop !== undefined && (prop.flags & SymbolFlags.Optional) !== 0);
  if (
    prop !== undefined &&
    (prop.flags & (SymbolFlags.Variable | SymbolFlags.Property | SymbolFlags.Accessor)) === 0 &&
    !((prop.flags & SymbolFlags.Method) !== 0 && (propType.flags & TypeFlags.Union) !== 0)
  )
    return propType;
  if (propType === c.autoType) return getFlowTypeOfAutoTypedProperty(c, node, prop);
  propType = getNarrowableTypeForReference(c, propType, node, checkMode);
  // `this.x` in the constructor of x's class starts out uninitialized under strictPropertyInitialization.
  let assumeUninitialized = false;
  const expression = getExpression(node);
  if (
    c.strictNullChecks &&
    c.strictPropertyInitialization &&
    expression !== undefined &&
    expression.kind === SyntaxKind.ThisKeyword &&
    prop !== undefined
  ) {
    const declaration = prop.valueDeclaration;
    if (declaration !== undefined && isPropertyWithoutInitializer(declaration) && !isStatic(declaration)) {
      const flowContainer = getControlFlowContainer(node);
      assumeUninitialized =
        flowContainer.kind === SyntaxKind.Constructor &&
        flowContainer.parent === declaration.parent &&
        (declaration.flags & NodeFlags.Ambient) === 0;
    }
  }
  // A JavaScript `this.x = …` declaration is unassigned before it in its own function.
  if (c.strictNullChecks && prop !== undefined && !assumeUninitialized) {
    const declaration = prop.valueDeclaration;
    assumeUninitialized =
      declaration instanceof BinaryExpression &&
      declaration.left.kind === SyntaxKind.PropertyAccessExpression &&
      getControlFlowContainer(node) === getControlFlowContainer(declaration);
  }
  const initialType = assumeUninitialized ? getOptionalType(c, propType, false) : propType;
  const flowType = getFlowTypeOfReference(c, node, propType, initialType, undefined);
  if (assumeUninitialized && !containsUndefinedType(propType) && containsUndefinedType(flowType)) {
    c.error(errorNode, Diagnostics.Property_0_is_used_before_being_assigned, symbolToString(c, prop!));
    return propType;
  }
  return assignmentKind !== AssignmentKind.None ? getBaseTypeOfLiteralType(c, flowType) : flowType;
}

function isPropertyWithoutInitializer(node: Node): boolean {
  return (
    node.kind === SyntaxKind.PropertyDeclaration &&
    !hasSyntacticModifier(node, ModifierFlags.Abstract) &&
    (node as PropertyDeclaration).postfixToken === undefined &&
    getInitializer(node) === undefined
  );
}

function checkElementAccessExpression(c: Checker, node: ElementAccessExpression, _checkMode: CheckMode): Type {
  let exprType = checkExpression(c, node.expression);
  let wasOptional = false;
  if (isOptionalChain(node)) {
    const nonOptional = getOptionalExpressionType(c, exprType, node.expression);
    wasOptional = nonOptional !== exprType;
    exprType = checkNonNullType(c, nonOptional, node.expression);
  } else exprType = checkNonNullType(c, exprType, node.expression);
  const indexExpression = node.argumentExpression;
  const indexType = checkExpression(c, indexExpression);
  if (isErrorType(c, exprType) || exprType === c.silentNeverType) return exprType;
  const assignmentKind = getAssignmentTargetKind(node);
  const isAssignment = assignmentKind !== AssignmentKind.None;
  const objectType = isAssignment || isMethodAccessForCall(node) ? getWidenedType(c, exprType) : exprType;
  if (isConstEnumObjectTypeLocal(objectType) && !isStringLiteralLike(indexExpression)) {
    c.error(indexExpression, Diagnostics.A_const_enum_member_can_only_be_accessed_using_a_string_literal);
    return c.errorType;
  }
  const effectiveIndexType = isForInVariableForNumericPropertyNames(c, indexExpression) ? c.numberType : indexType;
  // A compound assignment (`a[i] += 1`, `a[i]++`) also reads the element.
  const accessFlags = isAssignment
    ? AccessFlags.Writing |
      (assignmentKind === AssignmentKind.Compound ? AccessFlags.ExpressionPosition : 0) |
      (isGenericObjectType(c, objectType) && !isThisTypeParameter(objectType) ? AccessFlags.NoIndexSignatures : 0)
    : AccessFlags.ExpressionPosition;
  const indexedAccessType =
    getIndexedAccessTypeOrUndefinedEx(c, objectType, effectiveIndexType, accessFlags, node, undefined) ?? c.errorType;
  const t = checkIndexedAccessIndexType(
    c,
    getFlowTypeOfAccessExpression(c, node, c.resolvedSymbols.get(node.id), indexedAccessType, indexExpression),
    node,
  );
  return propagateOptionalTypeMarker(c, t, node, wasOptional);
}

/** Checks that the index of a generic indexed access is assignable to `keyof` its object type. */
export function checkIndexedAccessIndexType(c: Checker, t: Type, accessNode: Node): Type {
  if ((t.flags & TypeFlags.IndexedAccess) === 0) return t;
  const objectType = (t as IndexedAccessType).objectType;
  const indexType = (t as IndexedAccessType).indexType;
  const hasNumberIndexInfo = getIndexInfoOfType(c, objectType, c.numberType) !== undefined;
  if (
    everyType(
      indexType,
      (u) =>
        isTypeAssignableTo(c, u, getIndexTypeEx(c, objectType, IndexFlags.None)) ||
        (hasNumberIndexInfo && isApplicableIndexType(c, u, c.numberType)),
    )
  ) {
    if (
      accessNode.kind === SyntaxKind.ElementAccessExpression &&
      isAssignmentTarget(accessNode) &&
      (objectType.objectFlags & ObjectFlags.Mapped) !== 0 &&
      (getMappedTypeModifiers(objectType as MappedType) & MappedTypeModifiers.IncludeReadonly) !== 0
    )
      c.error(accessNode, Diagnostics.Index_signature_in_type_0_only_permits_reading, typeToString(c, objectType));
    return t;
  }
  if (isGenericObjectType(c, objectType)) {
    const propertyName = getPropertyNameFromIndex(indexType);
    if (propertyName !== undefined) {
      const propertySymbol = getConstituentProperty(c, objectType, propertyName);
      if (
        propertySymbol !== undefined &&
        (getDeclarationModifierFlagsFromSymbol(c, propertySymbol, false) &
          ModifierFlags.NonPublicAccessibilityModifier) !==
          0
      ) {
        c.error(
          accessNode,
          Diagnostics.Private_or_protected_member_0_cannot_be_accessed_on_a_type_parameter,
          propertyName,
        );
        return c.errorType;
      }
    }
  }
  c.error(
    accessNode,
    Diagnostics.Type_0_cannot_be_used_to_index_type_1,
    typeToString(c, indexType),
    typeToString(c, objectType),
  );
  return c.errorType;
}

function getConstituentProperty(c: Checker, objectType: Type, propertyName: string): Symbol | undefined {
  const apparentType = getApparentType(c, objectType);
  const constituents =
    (apparentType.flags & TypeFlags.UnionOrIntersection) !== 0 ? typesOf(apparentType) : [apparentType];
  for (const t of constituents) {
    const prop = getPropertyOfType(c, t, propertyName);
    if (prop !== undefined) return prop;
  }
  return undefined;
}

function isStringLiteralLike(node: Node): boolean {
  return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

function isConstEnumObjectTypeLocal(t: Type): boolean {
  return (
    (t.objectFlags & ObjectFlags.Anonymous) !== 0 &&
    t.symbol !== undefined &&
    (t.symbol.flags & SymbolFlags.ConstEnum) !== 0
  );
}

function isThisTypeParameter(t: Type): boolean {
  return (t.flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isThisType;
}

function isForInVariableForNumericPropertyNames(c: Checker, expr: Node): boolean {
  const e = skipParentheses(expr);
  if (e.kind !== SyntaxKind.Identifier) return false;
  const symbol = getResolvedSymbol(c, e);
  if ((symbol.flags & SymbolFlags.Variable) === 0) return false;
  let child = expr;
  let node = expr.parent;
  while (node !== undefined) {
    if (node.kind === SyntaxKind.ForInStatement) {
      const statement = node as ForInOrOfStatement;
      if (
        child === statement.statement &&
        getForInVariableSymbol(c, statement) === symbol &&
        hasNumericPropertyNames(c, getTypeOfExpression(c, statement.expression))
      )
        return true;
    }
    child = node;
    node = node.parent;
  }
  return false;
}

function getForInVariableSymbol(c: Checker, node: ForInOrOfStatement): Symbol | undefined {
  const initializer = node.initializer;
  if (initializer.kind === SyntaxKind.VariableDeclarationList) {
    const declarations = (initializer as VariableDeclarationList).declarations.nodes;
    return declarations.length > 0 ? getSymbolOfDeclaration(c, declarations[0]!) : undefined;
  }
  return initializer.kind === SyntaxKind.Identifier ? getResolvedSymbol(c, initializer) : undefined;
}

function hasNumericPropertyNames(c: Checker, t: Type): boolean {
  return getIndexInfosOfType(c, t).length === 1 && getIndexInfoOfType(c, t, c.numberType) !== undefined;
}

// ---- Assertions

function checkAssertion(c: Checker, node: Node, checkMode: CheckMode): Type {
  // `<T>expr`, over `<T>`.
  if (node.kind === SyntaxKind.TypeAssertionExpression && shouldCheckErasableSyntax(c, node)) {
    const file = getSourceFileOfNode(node);
    c.addDiagnostic(
      new Diagnostic(
        file.diagnosticFile(),
        skipTrivia(file.text, node.pos),
        getExpression(node)!.pos,
        Diagnostics.This_syntax_is_not_allowed_when_erasableSyntaxOnly_is_enabled,
        [],
      ),
    );
  }
  if (isConstTypeReference(getType(node)!)) {
    const exprType = checkExpressionEx(c, getExpression(node)!, checkMode);
    if (!isValidConstAssertionArgument(c, getExpression(node)!))
      c.error(
        getExpression(node)!,
        Diagnostics.A_const_assertion_can_only_be_applied_to_references_to_enum_members_or_string_number_boolean_array_or_object_literals,
      );
    return getRegularTypeOfLiteralType(c, exprType);
  }
  const exprType = checkExpressionEx(c, getExpression(node)!, checkMode);
  // The operand is compared with the asserted type once, after the last check of the operand.
  c.nodeLinks(node).assertionExpressionType = exprType;
  checkTypeNodeIfPresent(c, getType(node));
  checkNodeDeferred(c, node);
  return getTypeFromTypeNode(c, getType(node)!);
}

/** Checks that an assertion's operand type and asserted type are comparable. */
export function checkAssertionDeferred(c: Checker, node: Node): void {
  const typeNode = getType(node)!;
  const targetType = getTypeFromTypeNode(c, typeNode);
  // A JSDoc cast reports on its type.
  const errorNode = (typeNode.flags & NodeFlags.Reparsed) !== 0 ? typeNode : node;
  if (!isErrorType(c, targetType))
    checkAssertionCompatibility(c, errorNode, c.nodeLinks(node).assertionExpressionType!, targetType);
}

function checkAssertionCompatibility(c: Checker, node: Node, rawExprType: Type, targetType: Type): void {
  const exprType = getRegularTypeOfObjectLiteral(c, getBaseTypeOfLiteralType(c, rawExprType));
  if (isErrorType(c, targetType)) return;
  if (!isTypeComparableTo(c, targetType, getWidenedType(c, exprType)))
    checkTypeComparableTo(
      c,
      exprType,
      targetType,
      node,
      Diagnostics.Conversion_of_type_0_to_type_1_may_be_a_mistake_because_neither_type_sufficiently_overlaps_with_the_other_If_this_was_intentional_convert_the_expression_to_unknown_first,
    );
}

function checkSatisfiesExpression(c: Checker, node: Node, checkMode: CheckMode): Type {
  const expr = getExpression(node)!;
  const typeNode = getType(node)!;
  checkTypeNodeIfPresent(c, typeNode);
  const exprType = checkExpressionEx(c, expr, checkMode);
  const targetType = getTypeFromTypeNode(c, typeNode);
  if (isErrorType(c, targetType)) return targetType;
  checkTypeRelatedToAndOptionallyElaborate(
    c,
    exprType,
    targetType,
    c.assignableRelation,
    node,
    expr,
    Diagnostics.Type_0_does_not_satisfy_the_expected_type_1,
    undefined,
  );
  return exprType;
}

/** Reports `source` not assignable to `target` at `errorNode`. */
export function checkTypeAssignableToAndOptionallyElaborate(
  c: Checker,
  source: Type,
  target: Type,
  errorNode: Node,
  expr: Node | undefined,
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
