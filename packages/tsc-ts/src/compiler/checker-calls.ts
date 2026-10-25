// Calls, `new` and tagged templates: signature resolution with type argument inference and overload
// selection, argument checks and resolution errors.
import { checkDeprecatedSignature } from './checker-deprecation.js';
import {
  type CallExpression,
  type Decorator,
  type NewExpression,
  type ParameterDeclaration,
  type SpreadElement,
  NodeFlags,
  type TaggedTemplateExpression,
  type TemplateExpression,
  type TemplateSpan,
  NodeVisitor,
  type NoSubstitutionTemplateLiteral,
  type TemplateTail,
  Node,
  getArguments as getArgumentList,
  getExpression,
  getName,
  getParameters,
  getText,
  getTypeArguments as getTypeArgumentList,
  type BinaryExpression,
  getNodeId,
  getBody,
  getSymbol,
  callQuestionDotToken,
  callTypeArguments,
} from './ast.js';
import {
  canHaveDecorators,
  getEffectiveCheckNode,
  isFunctionLikeDeclarationKind,
  isImportCall,
  nodeIsPresent,
} from './ast-utilities.js';
import {
  getContainingClass,
  getSourceFileOfNode,
  isAccessExpression,
  isExpressionOfOptionalChainRoot,
  isOptionalChain,
  isOutermostOptionalChain,
  isDottedName,
} from './binder-utilities.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics, chainDiagnostic } from './diagnostics.js';
import { resolveInstanceofExpression } from './checker-operators.js';
import { skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { TokenFlags } from './types.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { checkSuperExpression } from './checker-super.js';
import { isConstructorAccessible } from './checker-classes.js';
import {
  getDecoratorArgumentCount,
  getDecoratorCallSignature,
  getDiagnosticHeadMessageForDecoratorResolution,
  getEffectiveDecoratorArgumentTypes,
  getUncalledDecoratorText,
  isPotentiallyUncalledDecorator,
} from './checker-decorators.js';
import {
  AccessFlags,
  CheckMode,
  ElementFlags,
  InstantiationExpressionType,
  ObjectFlags,
  type Signature,
  SignatureFlags,
  SignatureKind,
  TupleElementInfo,
  type Type,
  TypeFlags,
  newTypeMapper,
  type ObjectType,
  type TypeParameter,
} from './checker-types.js';
import { getGlobalTemplateStringsArrayType } from './checker-globals.js';
import {
  UnionReduction,
  createArrayType,
  createArrayTypeEx,
  createTupleTypeEx,
  filterType,
  getElementTypes,
  getIntersectionType,
  getNumberLiteralType,
  getRegularTypeOfLiteralType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isErrorType,
  isMutableArrayOrTuple,
  isTupleType,
  mapType,
  newObjectType,
  setStructuredTypeMembers,
  someType,
  tupleTargetOf,
  typesOf,
} from './checker-type-factory.js';
import {
  createSymbolWithType,
  getApparentType,
  getBaseConstraintOfType,
  resolveStructuredTypeMembers,
  getBaseConstraintOrType,
  getIndexTypeOfType,
  getReducedType,
  getSignaturesOfType,
  getTypeWithThisArgument,
  isArrayLikeType,
} from './checker-members.js';
import {
  createSignatureInstantiation,
  getMinArgumentCount,
  getNonArrayRestType,
  getOrCreateTypeFromSignature,
  getParameterCount,
  getReturnTypeOfSignature,
  getSignatureInstantiation,
  getSignatureInstantiationWithoutFillingInTypeArguments,
  getSingleCallOrConstructSignature,
  getSingleCallSignature,
  getSingleSignature,
  getThisTypeOfSignature,
  getTypeAtPosition,
  getTypeOfParameter,
  hasEffectiveRestParameter,
  cloneSignature,
  tryGetTypeAtPosition,
  getTypePredicateOfSignature,
  getSignatureFromDeclaration,
} from './checker-signatures.js';
import { getEffectsSignature } from './checker-narrowing.js';
import {
  addOptionalTypeMarker,
  getOptionalType,
  getTypeOfSymbol,
  removeOptionalTypeMarker,
} from './checker-symbol-types.js';
import { type Relation, checkTypeRelatedTo, getRegularTypeOfObjectLiteral, isTypeAssignableTo } from './relations.js';
import { getNonNullableType } from './checker-flow.js';
import {
  checkExpression,
  checkExpressionCached,
  checkNonNullType,
  checkNonNullTypeEx,
  checkTypeQueryExpression,
} from './checker-expressions.js';
import { IterationUse, checkIteratedTypeOrElementType } from './checker-iteration.js';
import { isContextSensitive } from './checker-functions.js';
import {
  getExtendsHeritageClauseElement,
  getInstantiatedConstructorsForTypeArguments,
  fillMissingTypeArguments,
  getConstraintOfTypeParameter,
  getDefaultFromTypeParameter,
  getMinTypeArgumentCount,
} from './checker-declared-types.js';
import { getESSymbolLikeTypeForNode, getTypeFromTypeNode } from './checker-type-nodes.js';
import { getIndexedAccessTypeEx, getRestTypeOfTupleType } from './checker-type-operators.js';
import { instantiateType, isNodeDescendantOf } from './instantiation.js';
import { maybeTypeOfKind } from './checker-utilities.js';
import { checkSourceElement, checkNodeDeferred } from './checker-source-file.js';
import {
  type InferenceContext,
  InferenceInfo,
  applyToParameterTypes,
  applyToReturnTypes,
  hasOverlappingInferences,
  instantiateSignatureInContextOf,
  mergeInferences,
  InferenceFlags,
  InferencePriority,
  cloneInferenceContext,
  cloneInferredPartOfContext,
  createInferenceContext,
  createOuterReturnMapper,
  getInferredTypes,
  getMapperFromContext,
  everyInferenceHasCandidates,
  someInferenceHasCandidates,
  inferTypes,
  isConstTypeVariable,
  isMutableArrayLikeType,
} from './checker-inference.js';
import {
  ContextFlags,
  checkExpressionWithContextualType,
  getApparentTypeOfContextualTypeEx,
  getContextualTypeEx,
  getContextualTypeForElementExpression,
  getInferenceContext,
} from './checker-contextual.js';
import { couldContainTypeVariables } from './instantiation.js';
import { typeToString } from './type-printer.js';
import { checkTypeRelatedToAndOptionallyElaborate } from './checker-elaboration.js';
import { getGlobalValueSymbol, getSymbolOfDeclaration, resolveName } from './checker-symbols.js';
import { checkImportCallExpression } from './checker-modules.js';
import {
  checkApplicableSignatureForJsxCallLikeElement,
  getAttributesOf,
  getEffectiveJsxArguments,
  inferJsxTypeArguments,
  isJsxOpeningLikeElement,
  resolveJsxOpeningLikeElement,
} from './checker-jsx.js';
import { isCommonJSRequire, resolveExternalModuleTypeByLiteral } from './checker-javascript.js';
import { declarationCount, getDeclarations, InternalSymbolName, type Symbol, SymbolFlags } from './symbol.js';

/** The type of an optional chain's expression with the chain's `undefined` removed. */
export function getOptionalExpressionType(c: Checker, exprType: Type, expression: Node): Type {
  if (isExpressionOfOptionalChainRoot(expression)) return getNonNullableType(c, exprType);
  if (isOptionalChain(expression)) return removeOptionalTypeMarker(c, exprType);
  return exprType;
}

export function propagateOptionalTypeMarker(c: Checker, t: Type, node: Node, wasOptional: boolean): Type {
  if (!wasOptional) return t;
  return isOutermostOptionalChain(node) ? getOptionalType(c, t, false) : addOptionalTypeMarker(c, t);
}

// ---- Entry points

export function checkCallExpression(c: Checker, node: Node, checkMode: CheckMode): Type {
  const call = node as CallExpression;
  const callee = call.expression;
  if (isImportCall(node)) return checkImportCallExpression(c, node);
  const signature = getResolvedSignature(c, node, checkMode);
  // A deferred call to a generic function returning a function, under SkipGenericFunctions.
  if (signature === c.resolvingSignature) return c.silentNeverType;
  checkDeprecatedSignature(c, signature, node);
  if (callee.kind === SyntaxKind.SuperKeyword) return c.voidType;
  if (isInJSFile(node) && isCommonJSRequire(c, node))
    return resolveExternalModuleTypeByLiteral(c, call.arguments.nodes[0]!);
  const returnType = getReturnTypeOfSignature(c, signature);
  // A call of the global `Symbol` in a const or readonly declaration is a fresh unique symbol.
  if ((returnType.flags & TypeFlags.ESSymbolLike) !== 0 && isSymbolOrSymbolForCall(c, call))
    return getESSymbolLikeTypeForNode(c, walkUpParenthesizedExpressions(node.parent!));
  // An assertion call must name its target through explicitly typed declarations.
  if (
    callQuestionDotToken(call) === undefined &&
    node.parent!.kind === SyntaxKind.ExpressionStatement &&
    (returnType.flags & TypeFlags.Void) !== 0 &&
    getTypePredicateOfSignature(c, signature) !== undefined
  ) {
    if (!isDottedName(callee))
      c.error(callee, Diagnostics.Assertions_require_the_call_target_to_be_an_identifier_or_qualified_name);
    else if (getEffectsSignature(c, node) === undefined)
      c.error(
        callee,
        Diagnostics.Assertions_require_every_name_in_the_call_target_to_be_declared_with_an_explicit_type_annotation,
      );
  }
  return returnType;
}

function walkUpParenthesizedExpressions(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.ParenthesizedExpression) current = current.parent!;
  return current;
}

/** Whether `node` calls the global `Symbol` or `Symbol.for`. */
export function isSymbolOrSymbolForCall(c: Checker, node: CallExpression): boolean {
  let left = node.expression;
  if (left.kind === SyntaxKind.PropertyAccessExpression && getText(getName(left)!) === 'for')
    left = getExpression(left)!;
  if (left.kind !== SyntaxKind.Identifier || getText(left) !== 'Symbol') return false;
  const globalESSymbol = getGlobalValueSymbol(c, 'Symbol', false);
  return (
    globalESSymbol !== undefined &&
    globalESSymbol === resolveName(c, left, 'Symbol', SymbolFlags.Value, undefined, false, false)
  );
}

export function checkNewExpression(c: Checker, node: Node, checkMode: CheckMode): Type {
  const signature = getResolvedSignature(c, node, checkMode);
  if (signature === c.resolvingSignature) return c.silentNeverType;
  checkDeprecatedSignature(c, signature, node);
  const declaration = signature.declaration;
  if (
    declaration !== undefined &&
    declaration.kind !== SyntaxKind.Constructor &&
    declaration.kind !== SyntaxKind.ConstructSignature &&
    declaration.kind !== SyntaxKind.ConstructorType
  ) {
    // A call signature resolved for `new` makes the result `any`.
    if (c.noImplicitAny)
      c.error(node, Diagnostics.X_new_expression_whose_target_lacks_a_construct_signature_implicitly_has_an_any_type);
    return c.anyType;
  }
  return getReturnTypeOfSignature(c, signature);
}

export function checkTaggedTemplateExpression(c: Checker, node: Node, checkMode: CheckMode): Type {
  const signature = getResolvedSignature(c, node, checkMode);
  if (signature === c.resolvingSignature) return c.silentNeverType;
  checkDeprecatedSignature(c, signature, node);
  return getReturnTypeOfSignature(c, signature);
}

/** The signature `node` resolves to, computed once. */
export function getResolvedSignature(c: Checker, node: Node, checkMode: CheckMode): Signature {
  const cached = c.resolvedSignatures.get(node.id);
  if (cached !== undefined && cached !== c.resolvingSignature) return cached;
  const saveResolutionStart = c.resolutionStart;
  // Reset the resolution stack so inverted requests retry with the resolving marker in place.
  if (cached === undefined) c.resolutionStart = c.resolutionDepth;
  c.resolvedSignatures.set(node.id, c.resolvingSignature);
  let result = resolveSignature(c, node, checkMode);
  c.resolutionStart = saveResolutionStart;
  // resolvingSignature means resolution was deferred under SkipGenericFunctions.
  if (result !== c.resolvingSignature) {
    // A nested resolution may have cached the source-order result first; prefer it.
    if (c.resolvedSignatures.get(node.id) !== c.resolvingSignature) result = c.resolvedSignatures.get(node.id)!;
    // Results computed during loop analysis may rest on transient flow types.
    c.resolvedSignatures.set(node.id, c.flowLoopStack.length === 0 ? result : cached);
  }
  return result;
}

/** The signature argument contextual types come from while `call` is checked. */
export function resolveCallSignatureForContext(c: Checker, call: Node): Signature {
  return c.resolvedSignatures.get(call.id) === c.resolvingSignature
    ? c.resolvingSignature
    : getResolvedSignature(c, call, CheckMode.Normal);
}

function resolveSignature(c: Checker, node: Node, checkMode: CheckMode): Signature {
  switch (node.kind) {
    case SyntaxKind.CallExpression:
      return resolveCallExpression(c, node as CallExpression, checkMode);
    case SyntaxKind.NewExpression:
      return resolveNewExpression(c, node as NewExpression, checkMode);
    case SyntaxKind.TaggedTemplateExpression:
      return resolveTaggedTemplateExpression(c, node as TaggedTemplateExpression, checkMode);
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxOpeningFragment:
      return resolveJsxOpeningLikeElement(c, node, checkMode);
    case SyntaxKind.Decorator:
      return resolveDecorator(c, node as Decorator, checkMode);
    case SyntaxKind.BinaryExpression:
      return resolveInstanceofExpression(c, node as BinaryExpression, checkMode);
  }
  return resolveUntypedCall(c, node);
}

function resolveCallExpression(c: Checker, node: CallExpression, checkMode: CheckMode): Signature {
  const callee = node.expression;
  if (callee.kind === SyntaxKind.SuperKeyword) return resolveSuperCall(c, node, checkMode);
  let callChainFlags = SignatureFlags.None;
  let funcType = checkExpression(c, callee);
  if (isOptionalChain(node)) {
    const nonOptionalType = getOptionalExpressionType(c, funcType, callee);
    callChainFlags =
      nonOptionalType === funcType
        ? SignatureFlags.None
        : isOutermostOptionalChain(node)
          ? SignatureFlags.IsOuterCallChain
          : SignatureFlags.IsInnerCallChain;
    funcType = nonOptionalType;
  }
  funcType = checkNonNullTypeForCall(c, funcType, callee);
  if (funcType === c.silentNeverType) return c.silentNeverSignature;
  const apparentType = getApparentType(c, funcType);
  if (isErrorType(c, apparentType)) return resolveErrorCall(c, node);
  const callSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Call);
  const numConstructSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Construct).length;
  if (isUntypedFunctionCall(c, funcType, apparentType, callSignatures.length, numConstructSignatures)) {
    if (!isErrorType(c, funcType) && callTypeArguments(node) !== undefined)
      c.error(node, Diagnostics.Untyped_function_calls_may_not_accept_type_arguments);
    return resolveUntypedCall(c, node);
  }
  if (callSignatures.length === 0) {
    if (numConstructSignatures !== 0)
      c.error(node, Diagnostics.Value_of_type_0_is_not_callable_Did_you_mean_to_include_new, typeToString(c, funcType));
    else invocationError(c, callee, apparentType, SignatureKind.Call);
    return resolveErrorCall(c, node);
  }
  // An inner generic call returning a function is deferred while an outer call infers, so that
  // inferences can flow through function composition.
  if (
    (checkMode & CheckMode.SkipGenericFunctions) !== 0 &&
    callTypeArguments(node) === undefined &&
    someGenericFunctionReturningFunction(c, callSignatures)
  ) {
    skippedGenericFunction(c, node, checkMode);
    return c.resolvingSignature;
  }
  return resolveCall(c, node, callSignatures, checkMode, callChainFlags, undefined);
}

/** A `super(...)` call resolves against the base constructors instantiated with the `extends` type arguments. */
function resolveSuperCall(c: Checker, node: CallExpression, checkMode: CheckMode): Signature {
  const superType = checkSuperExpression(c, node.expression);
  if ((superType.flags & TypeFlags.Any) !== 0) {
    // Arguments are still checked.
    for (const arg of node.arguments.nodes) checkExpression(c, arg);
    return c.anySignature;
  }
  if (!isErrorType(c, superType)) {
    const classDeclaration = getContainingClass(node);
    const baseTypeNode = classDeclaration !== undefined ? getExtendsHeritageClauseElement(classDeclaration) : undefined;
    if (baseTypeNode !== undefined) {
      const typeArguments = getTypeArgumentList(baseTypeNode);
      const baseConstructors = getInstantiatedConstructorsForTypeArguments(
        c,
        superType,
        typeArguments !== undefined ? typeArguments.nodes : undefined,
        baseTypeNode,
      );
      return resolveCall(c, node, baseConstructors, checkMode, SignatureFlags.None, undefined);
    }
  }
  return resolveUntypedCall(c, node);
}

function resolveNewExpression(c: Checker, node: NewExpression, checkMode: CheckMode): Signature {
  let expressionType = checkNonNullType(c, checkExpression(c, node.expression), node.expression);
  if (expressionType === c.silentNeverType) return c.silentNeverSignature;
  expressionType = getApparentType(c, expressionType);
  if (isErrorType(c, expressionType)) return resolveErrorCall(c, node);
  if ((expressionType.flags & TypeFlags.Any) !== 0) {
    if (node.typeArguments !== undefined && node.typeArguments.nodes.length !== 0)
      c.error(node, Diagnostics.Untyped_function_calls_may_not_accept_type_arguments);
    return resolveUntypedCall(c, node);
  }
  const constructSignatures = getSignaturesOfType(c, expressionType, SignatureKind.Construct);
  if (constructSignatures.length !== 0) {
    if (!isConstructorAccessible(c, node, constructSignatures[0]!)) return resolveErrorCall(c, node);
    if (someSignature(constructSignatures, (s) => (s.flags & SignatureFlags.Abstract) !== 0)) {
      c.error(node, Diagnostics.Cannot_create_an_instance_of_an_abstract_class);
      return resolveErrorCall(c, node);
    }
    return resolveCall(c, node, constructSignatures, checkMode, SignatureFlags.None, undefined);
  }
  // A function without construct signatures is called as a function.
  const callSignatures = getSignaturesOfType(c, expressionType, SignatureKind.Call);
  if (callSignatures.length !== 0) {
    const signature = resolveCall(c, node, callSignatures, checkMode, SignatureFlags.None, undefined);
    if (!c.noImplicitAny) {
      if (signature.declaration !== undefined && getReturnTypeOfSignature(c, signature) !== c.voidType)
        c.error(node, Diagnostics.Only_a_void_function_can_be_called_with_the_new_keyword);
      if (getThisTypeOfSignature(c, signature) === c.voidType)
        c.error(node, Diagnostics.A_function_that_is_called_with_the_new_keyword_cannot_have_a_this_type_that_is_void);
    }
    return signature;
  }
  invocationError(c, node.expression, expressionType, SignatureKind.Construct);
  return resolveErrorCall(c, node);
}

function someSignature(signatures: Signature[], f: (s: Signature) => boolean): boolean {
  for (const sig of signatures) {
    const composite = sig.composite;
    if (composite === undefined) {
      if (f(sig)) return true;
    } else if (composite.isUnion) {
      for (const s of composite.signatures) if (f(s)) return true;
    }
  }
  return false;
}

function someGenericFunctionReturningFunction(c: Checker, signatures: Signature[]): boolean {
  for (const s of signatures) if (isGenericFunctionReturningFunction(c, s)) return true;
  return false;
}

function someContextSensitive(c: Checker, nodes: Node[]): boolean {
  for (const n of nodes) if (isContextSensitive(c, n)) return true;
  return false;
}

function resolveTaggedTemplateExpression(c: Checker, node: TaggedTemplateExpression, checkMode: CheckMode): Signature {
  const tag = node.tag;
  const tagType = checkExpression(c, tag);
  const apparentType = getApparentType(c, tagType);
  if (isErrorType(c, apparentType)) return resolveErrorCall(c, node);
  const callSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Call);
  const numConstructSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Construct).length;
  if (isUntypedFunctionCall(c, tagType, apparentType, callSignatures.length, numConstructSignatures))
    return resolveUntypedCall(c, node);
  if (callSignatures.length === 0) {
    if (node.parent !== undefined && node.parent.kind === SyntaxKind.ArrayLiteralExpression) {
      c.error(
        tag,
        Diagnostics.It_is_likely_that_you_are_missing_a_comma_to_separate_these_two_template_expressions_They_form_a_tagged_template_expression_which_cannot_be_invoked,
      );
      return resolveErrorCall(c, node);
    }
    invocationError(c, tag, apparentType, SignatureKind.Call);
    return resolveErrorCall(c, node);
  }
  return resolveCall(c, node, callSignatures, checkMode, SignatureFlags.None, undefined);
}

/** A decorator is called with the arguments the runtime passes for its declaration. */
function resolveDecorator(c: Checker, node: Decorator, checkMode: CheckMode): Signature {
  if (!canHaveDecorators(node.parent!)) return resolveErrorCall(c, node);
  const expression = node.expression;
  const funcType = checkExpression(c, expression);
  const apparentType = getApparentType(c, funcType);
  if (isErrorType(c, apparentType)) return resolveErrorCall(c, node);
  const callSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Call);
  const numConstructSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Construct).length;
  if (isUntypedFunctionCall(c, funcType, apparentType, callSignatures.length, numConstructSignatures))
    return resolveUntypedCall(c, node);
  if (
    isPotentiallyUncalledDecorator(c, node, callSignatures) &&
    expression.kind !== SyntaxKind.ParenthesizedExpression
  ) {
    c.error(
      node,
      Diagnostics.X_0_accepts_too_few_arguments_to_be_used_as_a_decorator_here_Did_you_mean_to_call_it_first_and_write_0,
      getUncalledDecoratorText(node),
    );
    return resolveErrorCall(c, node);
  }
  const headMessage = getDiagnosticHeadMessageForDecoratorResolution(node);
  if (callSignatures.length === 0) {
    c.addDiagnostic(chainDiagnostic(getInvocationErrorDetails(c, expression, apparentType, true), headMessage));
    return resolveErrorCall(c, node);
  }
  if (getDecoratorCallSignature(c, node) === undefined) return resolveErrorCall(c, node);
  return resolveCall(c, node, callSignatures, checkMode, SignatureFlags.None, headMessage);
}

/** Whether a call is untyped: to `any`, or to a `Function` without signatures. */
export function isUntypedFunctionCall(
  c: Checker,
  funcType: Type,
  apparentFuncType: Type,
  numCallSignatures: number,
  numConstructSignatures: number,
): boolean {
  return (
    (funcType.flags & TypeFlags.Any) !== 0 ||
    ((apparentFuncType.flags & TypeFlags.Any) !== 0 && (funcType.flags & TypeFlags.TypeParameter) !== 0) ||
    (numCallSignatures === 0 &&
      numConstructSignatures === 0 &&
      (apparentFuncType.flags & TypeFlags.Union) === 0 &&
      (getReducedType(c, apparentFuncType).flags & TypeFlags.Never) === 0 &&
      isTypeAssignableTo(c, funcType, c.globalFunctionType))
  );
}

export function resolveUntypedCall(c: Checker, node: Node): Signature {
  // Type arguments are checked even though untyped calls can't accept them.
  if (
    node.kind === SyntaxKind.CallExpression ||
    node.kind === SyntaxKind.NewExpression ||
    node.kind === SyntaxKind.TaggedTemplateExpression ||
    isJsxOpeningLikeElement(node)
  )
    for (const t of getCallTypeArguments(node)) checkSourceElement(c, t);
  if (node.kind === SyntaxKind.TaggedTemplateExpression) {
    const template = (node as TaggedTemplateExpression).template;
    if (template.kind === SyntaxKind.TemplateExpression)
      for (const span of (template as TemplateExpression).templateSpans.nodes) checkExpression(c, getExpression(span)!);
  } else for (const arg of getCallArgumentNodes(node)) checkExpression(c, arg);
  return c.anySignature;
}

export function resolveErrorCall(c: Checker, node: Node): Signature {
  resolveUntypedCall(c, node);
  return c.unknownSignature;
}

function invocationError(c: Checker, errorTarget: Node, apparentType: Type, kind: SignatureKind): void {
  const isCall = kind === SignatureKind.Call;
  const parent = errorTarget.parent;
  const target =
    errorTarget.kind === SyntaxKind.PropertyAccessExpression &&
    parent !== undefined &&
    parent.kind === SyntaxKind.CallExpression
      ? getName(errorTarget)!
      : errorTarget;
  let headMessage = isCall
    ? Diagnostics.This_expression_is_not_callable
    : Diagnostics.This_expression_is_not_constructable;
  // A get accessor called as a function.
  if (
    parent !== undefined &&
    parent.kind === SyntaxKind.CallExpression &&
    (parent as CallExpression).arguments.nodes.length === 0
  ) {
    const resolvedSymbol = c.resolvedSymbols.get(errorTarget.id);
    if (resolvedSymbol !== undefined && (resolvedSymbol.flags & SymbolFlags.GetAccessor) !== 0)
      headMessage =
        Diagnostics.This_expression_is_not_callable_because_it_is_a_get_accessor_Did_you_mean_to_use_it_without;
  }
  c.addDiagnostic(chainDiagnostic(getInvocationErrorDetails(c, target, apparentType, isCall), headMessage));
}

function getInvocationErrorDetails(c: Checker, target: Node, apparentType: Type, isCall: boolean): Diagnostic {
  const kind = isCall ? SignatureKind.Call : SignatureKind.Construct;
  if ((apparentType.flags & TypeFlags.Union) === 0)
    return createDiagnosticForNode(
      target,
      isCall ? Diagnostics.Type_0_has_no_call_signatures : Diagnostics.Type_0_has_no_construct_signatures,
      [typeToString(c, apparentType)],
    );
  let diagnostic: Diagnostic | undefined = undefined;
  let hasSignatures = false;
  for (const constituent of typesOf(apparentType)) {
    if (getSignaturesOfType(c, constituent, kind).length !== 0) {
      hasSignatures = true;
      // With an error already found, "no constituent is callable" can't apply.
      if (diagnostic !== undefined) break;
    } else if (diagnostic === undefined) {
      // The first non-callable constituent.
      diagnostic = chainDiagnostic(
        createDiagnosticForNode(
          target,
          isCall ? Diagnostics.Type_0_has_no_call_signatures : Diagnostics.Type_0_has_no_construct_signatures,
          [typeToString(c, constituent)],
        ),
        isCall
          ? Diagnostics.Not_all_constituents_of_type_0_are_callable
          : Diagnostics.Not_all_constituents_of_type_0_are_constructable,
        typeToString(c, apparentType),
      );
      if (hasSignatures) break;
    }
  }
  if (!hasSignatures)
    return createDiagnosticForNode(
      target,
      isCall ? Diagnostics.No_constituent_of_type_0_is_callable : Diagnostics.No_constituent_of_type_0_is_constructable,
      [typeToString(c, apparentType)],
    );
  return (
    diagnostic ??
    createDiagnosticForNode(
      target,
      isCall
        ? Diagnostics.Each_member_of_the_union_type_0_has_signatures_but_none_of_those_signatures_are_compatible_with_each_other
        : Diagnostics.Each_member_of_the_union_type_0_has_construct_signatures_but_none_of_those_signatures_are_compatible_with_each_other,
      [typeToString(c, apparentType)],
    )
  );
}

function checkNonNullTypeForCall(c: Checker, t: Type, node: Node): Type {
  return checkNonNullTypeEx(c, t, node, true);
}

function skippedGenericFunction(c: Checker, node: Node, checkMode: CheckMode): void {
  if ((checkMode & CheckMode.Inferential) !== 0) {
    // Mark the inference context so the caller knows to retry with SkipGenericFunctions.
    const context = getInferenceContext(c, node);
    if (context !== undefined) context.flags |= InferenceFlags.SkippedGenericFunction;
  }
}

function isGenericFunctionReturningFunction(c: Checker, signature: Signature): boolean {
  return signature.typeParameters.length !== 0 && isFunctionType(c, getReturnTypeOfSignature(c, signature));
}

function isFunctionType(c: Checker, t: Type): boolean {
  return (t.flags & TypeFlags.Object) !== 0 && getSignaturesOfType(c, t, SignatureKind.Call).length > 0;
}

// ---- Arguments

/** An argument with a known type: a tagged template's strings, or an element of a spread tuple. */
export class SyntheticExpression extends Node {
  readonly type: Type;
  readonly isSpread: boolean;
  readonly tupleNameSource: Node | undefined;

  constructor(parent: Node, type: Type, isSpread: boolean, tupleNameSource: Node | undefined) {
    super(SyntaxKind.SyntheticExpression);
    this.parent = parent;
    this.pos = parent.pos;
    this.end = parent.end;
    this.type = type;
    this.isSpread = isSpread;
    this.tupleNameSource = tupleNameSource;
  }

  forEachChild(_visitor: NodeVisitor): boolean {
    return false;
  }

  setParentOfChildren(): void {}

  deepClone(): Node {
    return new SyntheticExpression(this.parent!, this.type, this.isSpread, this.tupleNameSource);
  }
}

function getCallArgumentNodes(node: Node): Node[] {
  if (node.kind === SyntaxKind.BinaryExpression) return [(node as BinaryExpression).left];
  if (node.kind === SyntaxKind.TaggedTemplateExpression) {
    const template = (node as TaggedTemplateExpression).template;
    const args: Node[] = [template];
    if (template.kind === SyntaxKind.TemplateExpression)
      for (const span of (template as TemplateExpression).templateSpans.nodes) args.push(getExpression(span)!);
    return args;
  }
  const list = getArgumentList(node);
  return list !== undefined ? list.nodes : [];
}

/** The arguments of a call, with spreads of tuples expanded and a tagged template's strings first. */
export function getEffectiveCallArguments(c: Checker, node: Node): Node[] {
  // A fragment's attributes have no `children` yet, like those of `<React.Fragment>`.
  if (node.kind === SyntaxKind.JsxOpeningFragment)
    return [new SyntheticExpression(node, c.emptyFreshJsxObjectType, false, undefined)];
  if (isJsxOpeningLikeElement(node)) return getEffectiveJsxArguments(node);
  if (node.kind === SyntaxKind.Decorator) {
    // One synthetic argument per parameter of the decorator's call signature.
    const expression = (node as Decorator).expression;
    const args: Node[] = [];
    for (const t of getEffectiveDecoratorArgumentTypes(c, node))
      args.push(new SyntheticExpression(expression, t, false, undefined));
    return args;
  }
  if (node.kind === SyntaxKind.TaggedTemplateExpression) {
    const template = (node as TaggedTemplateExpression).template;
    const args: Node[] = [new SyntheticExpression(template, getGlobalTemplateStringsArrayType(c), false, undefined)];
    if (template.kind === SyntaxKind.TemplateExpression)
      for (const span of (template as TemplateExpression).templateSpans.nodes) args.push(getExpression(span)!);
    return args;
  }
  const args = getCallArgumentNodes(node);
  const spreadIndex = getSpreadArgumentIndex(args);
  if (spreadIndex < 0) return args;
  // Spreads of tuple types become synthetic arguments, one per element.
  const effectiveArgs = args.slice(0, spreadIndex);
  for (let i = spreadIndex; i < args.length; i++) {
    const arg = args[i]!;
    // Spread expressions never have a contextual type, so caching is safe.
    const spreadType =
      arg.kind === SyntaxKind.SpreadElement
        ? c.flowLoopStack.length !== 0
          ? checkExpression(c, (arg as SpreadElement).expression)
          : checkExpressionCached(c, (arg as SpreadElement).expression)
        : undefined;
    if (spreadType !== undefined && isTupleType(spreadType)) {
      const elementTypes = getElementTypes(c, spreadType);
      const elementInfos = tupleTargetOf(spreadType).elementInfos;
      for (let j = 0; j < elementTypes.length; j++) {
        const flags = elementInfos[j]!.flags;
        effectiveArgs.push(
          new SyntheticExpression(
            arg,
            (flags & ElementFlags.Rest) !== 0 ? createArrayType(c, elementTypes[j]!) : elementTypes[j]!,
            (flags & ElementFlags.Variable) !== 0,
            elementInfos[j]!.labeledDeclaration,
          ),
        );
      }
    } else effectiveArgs.push(arg);
  }
  return effectiveArgs;
}

/** Checks an argument with the parameter type as its contextual type. */
function checkArgument(
  c: Checker,
  arg: Node,
  paramType: Type,
  context: InferenceContext | undefined,
  checkMode: CheckMode,
): Type {
  if (arg.kind === SyntaxKind.SyntheticExpression) return checkSyntheticExpression(c, arg as SyntheticExpression);
  return checkExpressionWithContextualType(c, arg, paramType, context, checkMode);
}

/** A synthetic argument's type; a spread one stands for its elements. */
function checkSyntheticExpression(c: Checker, node: SyntheticExpression): Type {
  return node.isSpread
    ? getIndexedAccessTypeEx(c, node.type, c.numberType, AccessFlags.None, undefined, undefined)
    : node.type;
}

function getSpreadArgumentIndex(args: Node[]): number {
  for (let i = 0; i < args.length; i++) if (isSpreadArgument(args[i]!)) return i;
  return -1;
}

function isSpreadArgument(arg: Node): boolean {
  return (
    arg.kind === SyntaxKind.SpreadElement ||
    (arg.kind === SyntaxKind.SyntheticExpression && (arg as SyntheticExpression).isSpread)
  );
}

/** The rest arguments from `index` as a tuple, or an array for a trailing spread to a rest parameter. */
function getSpreadArgumentType(
  c: Checker,
  call: Node,
  args: Node[],
  index: number,
  argCount: number,
  restType: Type,
  context: InferenceContext | undefined,
  checkMode: CheckMode,
): Type {
  const inConstContext = isConstTypeVariable(c, restType, 0);
  if (argCount > 0 && index >= argCount - 1) {
    const arg = args[argCount - 1]!;
    if (isSpreadArgument(arg)) {
      // A spread in the last position to a rest parameter: both are `...x` forms.
      const spreadType =
        arg.kind === SyntaxKind.SyntheticExpression
          ? (arg as SyntheticExpression).type
          : checkExpressionWithContextualType(c, (arg as SpreadElement).expression, restType, context, checkMode);
      if (isArrayLikeType(c, spreadType)) return getMutableArrayOrTupleType(c, spreadType);
      const errorNode = arg.kind === SyntaxKind.SpreadElement ? (arg as SpreadElement).expression : arg;
      return createArrayTypeEx(
        c,
        checkIteratedTypeOrElementType(c, IterationUse.Spread, spreadType, c.undefinedType, errorNode),
        inConstContext,
      );
    }
  }
  const types: Type[] = [];
  const infos: TupleElementInfo[] = [];
  for (let i = index; i < argCount; i++) {
    const arg = args[i]!;
    if (isSpreadArgument(arg)) {
      const spreadType =
        arg.kind === SyntaxKind.SyntheticExpression
          ? (arg as SyntheticExpression).type
          : checkExpression(c, (arg as SpreadElement).expression);
      if (isArrayLikeType(c, spreadType)) {
        types.push(spreadType);
        infos.push(new TupleElementInfo(ElementFlags.Variadic, undefined));
      } else {
        const errorNode = arg.kind === SyntaxKind.SpreadElement ? (arg as SpreadElement).expression : arg;
        types.push(checkIteratedTypeOrElementType(c, IterationUse.Spread, spreadType, c.undefinedType, errorNode));
        infos.push(new TupleElementInfo(ElementFlags.Rest, undefined));
      }
      continue;
    }
    const contextualType = isTupleType(restType)
      ? (getContextualTypeForElementExpression(c, restType, i - index, argCount - index, -1, -1) ?? c.unknownType)
      : getIndexedAccessTypeEx(
          c,
          restType,
          getNumberLiteralType(c, i - index),
          AccessFlags.Contextual,
          undefined,
          undefined,
        );
    const argType = checkArgument(c, arg, contextualType, context, checkMode);
    const hasPrimitiveContextualType =
      inConstContext ||
      maybeTypeOfKind(
        contextualType,
        TypeFlags.Primitive | TypeFlags.Index | TypeFlags.TemplateLiteral | TypeFlags.StringMapping,
      );
    types.push(
      hasPrimitiveContextualType ? getRegularTypeOfLiteralType(c, argType) : getWidenedLiteralType(c, argType),
    );
    infos.push(
      new TupleElementInfo(
        ElementFlags.Required,
        arg.kind === SyntaxKind.SyntheticExpression ? (arg as SyntheticExpression).tupleNameSource : undefined,
      ),
    );
  }
  return createTupleTypeEx(c, types, infos, inConstContext && !someType(restType, (t) => isMutableArrayLikeType(c, t)));
}

/** The type of the arguments from `index` on, for the rest parameter of an immediately invoked function. */
export function getRestArgumentsType(c: Checker, call: Node, args: Node[], index: number): Type {
  return getSpreadArgumentType(c, call, args, index, args.length, c.anyType, undefined, CheckMode.Normal);
}

function getMutableArrayOrTupleType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Union) !== 0) return mapType(c, t, (u) => getMutableArrayOrTupleType(c, u));
  if ((t.flags & TypeFlags.Any) !== 0 || isMutableArrayOrTuple(c, getBaseConstraintOrType(c, t))) return t;
  if (isTupleType(t)) return createTupleTypeEx(c, getElementTypes(c, t), tupleTargetOf(t).elementInfos, false);
  return createTupleTypeEx(c, [t], [new TupleElementInfo(ElementFlags.Variadic, undefined)], false);
}

// ---- Overload resolution

/** The state of one `resolveCall`, shared by its `chooseOverload` passes. */
class CallState {
  readonly node: Node;
  readonly typeArguments: Node[];
  readonly args: Node[];
  candidates: Signature[];
  argCheckMode: CheckMode = CheckMode.Normal;
  isSingleNonGenericCandidate = false;
  candidatesForArgumentError: Signature[] = [];
  candidateForArgumentArityError: Signature | undefined = undefined;
  candidateForTypeArgumentError: Signature | undefined = undefined;

  constructor(node: Node, typeArguments: Node[], args: Node[], candidates: Signature[]) {
    this.node = node;
    this.typeArguments = typeArguments;
    this.args = args;
    this.candidates = candidates;
  }
}

function getCallTypeArguments(node: Node): Node[] {
  if (node.kind === SyntaxKind.JsxOpeningFragment || node.kind === SyntaxKind.Decorator) return [];
  if (node.kind === SyntaxKind.CallExpression && (node as CallExpression).expression.kind === SyntaxKind.SuperKeyword)
    return [];
  const list = getTypeArgumentList(node);
  return list !== undefined ? list.nodes : [];
}

export function resolveCall(
  c: Checker,
  node: Node,
  signatures: Signature[],
  checkMode: CheckMode,
  callChainFlags: SignatureFlags,
  headMessage: DiagnosticMessage | undefined,
): Signature {
  const typeArguments = getCallTypeArguments(node);
  for (const t of typeArguments) checkSourceElement(c, t);
  const candidates = reorderCandidates(c, signatures, callChainFlags);
  if (candidates.length === 0) return c.unknownSignature;
  const s = new CallState(node, typeArguments, getEffectiveCallArguments(c, node), candidates);
  // Context-sensitive arguments are excluded from a first inference and applicability pass, then
  // included in a second pass with their contextual types fixed.
  s.isSingleNonGenericCandidate = candidates.length === 1 && candidates[0]!.typeParameters.length === 0;
  // Decorator arguments are synthetic, so never context sensitive.
  if (node.kind !== SyntaxKind.Decorator && !s.isSingleNonGenericCandidate && someContextSensitive(c, s.args))
    s.argCheckMode = CheckMode.SkipContextSensitive;
  // A subtype pass picks the best overload; assignability decides whether the call is an error.
  let result: Signature | undefined = undefined;
  if (candidates.length > 1) result = chooseOverload(c, s, c.subtypeRelation);
  if (result === undefined) result = chooseOverload(c, s, c.assignableRelation);
  if (result !== undefined) return result;
  result = getCandidateForOverloadFailure(c, node, s.candidates, s.args, checkMode);
  // Cache now so that error reporting below handles circularities like getResolvedSignature would.
  c.resolvedSignatures.set(node.id, result);
  reportCallResolutionErrors(c, s, signatures, headMessage);
  return result;
}

export function reorderCandidates(c: Checker, signatures: Signature[], callChainFlags: SignatureFlags): Signature[] {
  let lastParent: Node | undefined = undefined;
  let lastSymbol: Symbol | undefined = undefined;
  let index = 0;
  let cutoffIndex = 0;
  let spliceIndex: number;
  let specializedIndex = -1;
  const result: Signature[] = [];
  for (let signature of signatures) {
    const declaration = signature.declaration;
    const symbol = declaration !== undefined ? getSymbolOfDeclaration(c, declaration) : undefined;
    const parent = declaration !== undefined ? declaration.parent : undefined;
    if (lastSymbol === undefined || symbol === lastSymbol) {
      if (lastParent !== undefined && parent === lastParent) index = index + 1;
      else {
        lastParent = parent;
        index = cutoffIndex;
      }
    } else {
      // A different symbol: later reorderings must not move signatures before the cutoff.
      index = result.length;
      cutoffIndex = result.length;
      lastParent = parent;
    }
    lastSymbol = symbol;
    // Specialized signatures go before non-specialized ones regardless of the cutoff.
    if ((signature.flags & SignatureFlags.HasLiteralTypes) !== 0) {
      specializedIndex++;
      spliceIndex = specializedIndex;
      cutoffIndex++;
    } else spliceIndex = index;
    if (callChainFlags !== 0) signature = getOptionalCallSignature(c, signature, callChainFlags);
    // Most signatures go at the end, where a push is cheaper than an inserting splice.
    if (spliceIndex === result.length) result.push(signature);
    else result.splice(spliceIndex, 0, signature);
  }
  return result;
}

function getOptionalCallSignature(c: Checker, signature: Signature, callChainFlags: SignatureFlags): Signature {
  if ((signature.flags & SignatureFlags.CallChainFlags) === callChainFlags) return signature;
  const key = callChainFlags === SignatureFlags.IsInnerCallChain ? 'inner' : 'outer';
  let cache = c.inferenceCaches.optionalCallSignatures.get(signature);
  if (cache === undefined) {
    cache = new Map<string, Signature>();
    c.inferenceCaches.optionalCallSignatures.set(signature, cache);
  }
  let result = cache.get(key);
  if (result === undefined) {
    result = cloneSignature(c, signature);
    result.flags |= callChainFlags;
    cache.set(key, result);
  }
  return result;
}

function chooseOverload(c: Checker, s: CallState, relation: Relation): Signature | undefined {
  s.candidatesForArgumentError = [];
  s.candidateForArgumentArityError = undefined;
  s.candidateForTypeArgumentError = undefined;
  if (s.isSingleNonGenericCandidate) {
    const candidate = s.candidates[0]!;
    if (s.typeArguments.length !== 0 || !hasCorrectArity(c, s.node, s.args, candidate)) return undefined;
    if (!isSignatureApplicable(c, s.node, s.args, candidate, relation, CheckMode.Normal, false, undefined)) {
      s.candidatesForArgumentError = [candidate];
      return undefined;
    }
    return candidate;
  }
  for (let candidateIndex = 0; candidateIndex < s.candidates.length; candidateIndex++) {
    const candidate = s.candidates[candidateIndex]!;
    if (!hasCorrectTypeArgumentArity(c, candidate, s.typeArguments) || !hasCorrectArity(c, s.node, s.args, candidate))
      continue;
    let checkCandidate: Signature;
    let inferenceContext: InferenceContext | undefined = undefined;
    if (candidate.typeParameters.length !== 0) {
      let typeArgumentTypes: Type[] | undefined;
      if (s.typeArguments.length !== 0) {
        typeArgumentTypes = checkTypeArguments(c, candidate, s.typeArguments, false, undefined);
        if (typeArgumentTypes === undefined) {
          s.candidateForTypeArgumentError = candidate;
          continue;
        }
      } else {
        inferenceContext = createInferenceContext(
          c,
          candidate.typeParameters,
          candidate,
          isInJSFile(s.node) ? InferenceFlags.AnyDefault : InferenceFlags.None,
          undefined,
        );
        typeArgumentTypes = inferTypeArguments(
          c,
          s.node,
          candidate,
          s.args,
          s.argCheckMode | CheckMode.SkipGenericFunctions,
          inferenceContext,
        );
        if ((inferenceContext.flags & InferenceFlags.SkippedGenericFunction) !== 0)
          s.argCheckMode |= CheckMode.SkipGenericFunctions;
      }
      checkCandidate = getSignatureInstantiationWithInferredTypeParameters(
        c,
        candidate,
        typeArgumentTypes,
        isInJSFile(candidate.declaration),
        inferenceContext !== undefined ? inferenceContext.inferredTypeParameters : undefined,
      );
      // A generic rest type may instantiate to a different arity.
      if (getNonArrayRestType(c, candidate) !== undefined && !hasCorrectArity(c, s.node, s.args, checkCandidate)) {
        s.candidateForArgumentArityError = checkCandidate;
        continue;
      }
    } else checkCandidate = candidate;
    if (!isSignatureApplicable(c, s.node, s.args, checkCandidate, relation, s.argCheckMode, false, undefined)) {
      s.candidatesForArgumentError.push(checkCandidate);
      continue;
    }
    if (s.argCheckMode !== CheckMode.Normal) {
      // Include the excluded context-sensitive arguments from now on, with a second round of
      // inference and applicability checking for this candidate.
      s.argCheckMode = CheckMode.Normal;
      if (inferenceContext !== undefined) {
        const typeArgumentTypes = inferTypeArguments(c, s.node, candidate, s.args, s.argCheckMode, inferenceContext);
        checkCandidate = getSignatureInstantiationWithInferredTypeParameters(
          c,
          candidate,
          typeArgumentTypes,
          isInJSFile(candidate.declaration),
          inferenceContext.inferredTypeParameters,
        );
        if (getNonArrayRestType(c, candidate) !== undefined && !hasCorrectArity(c, s.node, s.args, checkCandidate)) {
          s.candidateForArgumentArityError = checkCandidate;
          continue;
        }
      }
      if (!isSignatureApplicable(c, s.node, s.args, checkCandidate, relation, s.argCheckMode, false, undefined)) {
        s.candidatesForArgumentError.push(checkCandidate);
        continue;
      }
    }
    s.candidates[candidateIndex] = checkCandidate;
    return checkCandidate;
  }
  return undefined;
}

function isInJSFile(node: Node | undefined): boolean {
  return node !== undefined && (node.flags & NodeFlags.JavaScriptFile) !== 0;
}

function hasCorrectArity(c: Checker, node: Node, args: Node[], signature: Signature): boolean {
  if (node.kind === SyntaxKind.JsxOpeningFragment) return true;
  let argCount: number;
  let callIsIncomplete = false;
  let effectiveParameterCount = getParameterCount(c, signature);
  let effectiveMinimumArguments = getMinArgumentCount(c, signature);
  if (isJsxOpeningLikeElement(node)) {
    // An incomplete element is lenient.
    if (getAttributesOf(node).end === node.end) return true;
    argCount = effectiveMinimumArguments === 0 ? args.length : 1;
    // Class components may have argumentless constructors; their props come from the instance.
    if (args.length !== 0) effectiveParameterCount = 1;
    // A component's extra parameters, such as a legacy context, are provided by the library.
    effectiveMinimumArguments = Math.min(effectiveMinimumArguments, 1);
  } else if (node.kind === SyntaxKind.TaggedTemplateExpression) {
    argCount = args.length;
    const template = (node as TaggedTemplateExpression).template;
    if (template.kind === SyntaxKind.TemplateExpression) {
      // A template without a tail literal makes the call incomplete.
      const spans = (template as TemplateExpression).templateSpans.nodes;
      const literal = (spans[spans.length - 1]! as TemplateSpan).literal;
      callIsIncomplete = literal.end === literal.pos || isUnterminatedLiteral(literal);
    } else callIsIncomplete = isUnterminatedLiteral(template);
  } else if (node.kind === SyntaxKind.Decorator) {
    argCount = getDecoratorArgumentCount(c, node, signature);
  } else if (node.kind === SyntaxKind.NewExpression && (node as NewExpression).arguments === undefined) {
    // `new C`
    return getMinArgumentCount(c, signature) === 0;
  } else {
    argCount = args.length;
    // Without the close parenthesis, the call is incomplete.
    const list = getArgumentList(node);
    callIsIncomplete = list !== undefined && list.end === node.end;
    // A spread argument must correspond to a rest parameter or be within range.
    const spreadArgIndex = getSpreadArgumentIndex(args);
    if (spreadArgIndex >= 0)
      return (
        spreadArgIndex >= getMinArgumentCount(c, signature) &&
        (hasEffectiveRestParameter(c, signature) || spreadArgIndex < getParameterCount(c, signature))
      );
  }
  if (!hasEffectiveRestParameter(c, signature) && argCount > effectiveParameterCount) return false;
  if (callIsIncomplete || argCount >= effectiveMinimumArguments) return true;
  // Missing arguments are allowed for parameters accepting `void`.
  for (let i = argCount; i < effectiveMinimumArguments; i++) {
    const t = getTypeAtPosition(c, signature, i);
    if ((filterType(c, t, (u) => (u.flags & TypeFlags.Void) !== 0).flags & TypeFlags.Never) !== 0) return false;
  }
  return true;
}

function hasCorrectTypeArgumentArity(c: Checker, signature: Signature, typeArguments: Node[]): boolean {
  const numTypeParameters = signature.typeParameters.length;
  const minTypeArgumentCount = getMinTypeArgumentCount(c, signature.typeParameters);
  return (
    typeArguments.length === 0 ||
    (typeArguments.length >= minTypeArgumentCount && typeArguments.length <= numTypeParameters)
  );
}

function checkTypeArguments(
  c: Checker,
  signature: Signature,
  typeArgumentNodes: Node[],
  reportErrors: boolean,
  headMessage: DiagnosticMessage | undefined,
): Type[] | undefined {
  const typeParameters = signature.typeParameters;
  const typeArguments: Type[] = [];
  for (const n of typeArgumentNodes) typeArguments.push(getTypeFromTypeNode(c, n));
  const typeArgumentTypes = fillMissingTypeArguments(
    c,
    typeArguments,
    typeParameters,
    getMinTypeArgumentCount(c, typeParameters),
    isInJSFile(signature.declaration),
  );
  const mapper = newTypeMapper(typeParameters, typeArgumentTypes);
  for (let i = 0; i < typeArgumentNodes.length; i++) {
    const constraint = getConstraintOfTypeParameter(c, typeParameters[i]!);
    if (constraint === undefined) continue;
    const typeArgument = typeArgumentTypes[i]!;
    const diagnostics: Diagnostic[] = [];
    if (
      !checkTypeRelatedTo(
        c,
        typeArgument,
        getTypeWithThisArgument(c, instantiateType(c, constraint, mapper), typeArgument, false),
        c.assignableRelation,
        reportErrors ? typeArgumentNodes[i]! : undefined,
        headMessage ?? Diagnostics.Type_0_does_not_satisfy_the_constraint_1,
        diagnostics,
      )
    ) {
      if (diagnostics.length !== 0) c.addDiagnostic(diagnostics[0]!);
      return undefined;
    }
  }
  return typeArgumentTypes;
}

function isSignatureApplicable(
  c: Checker,
  node: Node,
  args: Node[],
  signature: Signature,
  relation: Relation,
  checkMode: CheckMode,
  reportErrors: boolean,
  diagnosticOutput: Diagnostic[] | undefined,
): boolean {
  if (isJsxOpeningLikeElement(node) || node.kind === SyntaxKind.JsxOpeningFragment)
    return checkApplicableSignatureForJsxCallLikeElement(
      c,
      node,
      signature,
      relation,
      checkMode,
      reportErrors,
      diagnosticOutput,
    );
  const thisType = getThisTypeOfSignature(c, signature);
  if (
    thisType !== undefined &&
    thisType !== c.voidType &&
    !(
      node.kind === SyntaxKind.NewExpression ||
      (node.kind === SyntaxKind.CallExpression && isSuperProperty(getExpression(node)!))
    )
  ) {
    // Without an `x.f` callee the `this` argument is `void`.
    const thisArgumentNode = getThisArgumentOfCall(c, node);
    const thisArgumentType = getThisArgumentType(c, thisArgumentNode);
    const errorNode = reportErrors ? (thisArgumentNode ?? node) : undefined;
    if (
      !checkTypeRelatedTo(
        c,
        thisArgumentType,
        thisType,
        relation,
        errorNode,
        Diagnostics.The_this_context_of_type_0_is_not_assignable_to_method_s_this_of_type_1,
        diagnosticOutput,
      )
    )
      return false;
  }
  const headMessage = Diagnostics.Argument_of_type_0_is_not_assignable_to_parameter_of_type_1;
  const restType = getNonArrayRestType(c, signature);
  const argCount = restType !== undefined ? Math.min(getParameterCount(c, signature) - 1, args.length) : args.length;
  for (let i = 0; i < argCount; i++) {
    const arg = args[i]!;
    if (arg.kind === SyntaxKind.OmittedExpression) continue;
    const paramType = getTypeAtPosition(c, signature, i);
    const argType = checkArgument(c, arg, paramType, undefined, checkMode);
    // While context-sensitive arguments are excluded, excess property checks could be false positives.
    const checkArgType =
      (checkMode & CheckMode.SkipContextSensitive) !== 0 ? getRegularTypeOfObjectLiteral(c, argType) : argType;
    const effectiveCheckArgumentNode = getEffectiveCheckNode(arg);
    if (
      !checkTypeRelatedToAndOptionallyElaborate(
        c,
        checkArgType,
        paramType,
        relation,
        reportErrors ? effectiveCheckArgumentNode : undefined,
        effectiveCheckArgumentNode,
        headMessage,
        diagnosticOutput,
      )
    )
      return false;
  }
  if (restType !== undefined) {
    const spreadType = getSpreadArgumentType(c, node, args, argCount, args.length, restType, undefined, checkMode);
    const restArgCount = args.length - argCount;
    let errorNode: Node | undefined = undefined;
    if (reportErrors)
      errorNode = restArgCount === 0 ? node : restArgCount === 1 ? getEffectiveCheckNode(args[argCount]!) : node;
    const diagnostics: Diagnostic[] = [];
    const related = checkTypeRelatedTo(
      c,
      spreadType,
      restType,
      relation,
      restArgCount > 1 && reportErrors ? node : errorNode,
      headMessage,
      restArgCount > 1 && reportErrors ? diagnostics : diagnosticOutput,
    );
    if (!related) {
      if (restArgCount > 1 && reportErrors) {
        // Several rest arguments: report over their combined range.
        const file = getSourceFileOfNode(node);
        const pos = skipTrivia(file.text, args[argCount]!.pos);
        const end = args[args.length - 1]!.end;
        for (const d of diagnostics) {
          const moved = new Diagnostic(file.diagnosticFile(), pos, end, d.message, d.args.slice());
          moved.messageChain = d.messageChain;
          if (diagnosticOutput !== undefined) diagnosticOutput.push(moved);
          else c.addDiagnostic(moved);
        }
      }
      return false;
    }
  }
  return true;
}

function isUnterminatedLiteral(node: Node): boolean {
  if (node.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    return ((node as NoSubstitutionTemplateLiteral).templateFlags & TokenFlags.Unterminated) !== 0;
  if (node.kind === SyntaxKind.TemplateTail)
    return ((node as TemplateTail).templateFlags & TokenFlags.Unterminated) !== 0;
  return false;
}

function isSuperProperty(node: Node): boolean {
  return (
    (node.kind === SyntaxKind.PropertyAccessExpression || node.kind === SyntaxKind.ElementAccessExpression) &&
    getExpression(node)!.kind === SyntaxKind.SuperKeyword
  );
}

/** The `this` argument of `x.f(...)` and `x[f](...)`. */
function getThisArgumentOfCall(c: Checker, node: Node): Node | undefined {
  // `x instanceof C` calls `C[Symbol.hasInstance](x)`.
  if (node.kind === SyntaxKind.BinaryExpression) return (node as BinaryExpression).right;
  let expression: Node | undefined = undefined;
  if (node.kind === SyntaxKind.CallExpression) expression = (node as CallExpression).expression;
  else if (node.kind === SyntaxKind.TaggedTemplateExpression) expression = (node as TaggedTemplateExpression).tag;
  else if (node.kind === SyntaxKind.Decorator && !c.legacyDecorators) expression = (node as Decorator).expression;
  if (expression === undefined) return undefined;
  const callee = skipOuterExpressionsForCall(expression);
  return isAccessExpression(callee) ? getExpression(callee) : undefined;
}

function skipOuterExpressionsForCall(node: Node): Node {
  for (;;) {
    switch (node.kind) {
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.AsExpression:
      case SyntaxKind.TypeAssertionExpression:
      case SyntaxKind.SatisfiesExpression:
      case SyntaxKind.NonNullExpression:
      case SyntaxKind.ExpressionWithTypeArguments:
      case SyntaxKind.PartiallyEmittedExpression:
        node = getExpression(node)!;
        continue;
    }
    return node;
  }
}

function getThisArgumentType(c: Checker, node: Node | undefined): Type {
  if (node === undefined) return c.voidType;
  const thisArgumentType = checkExpression(c, node);
  if (isExpressionOfOptionalChainRoot(node)) return getNonNullableType(c, thisArgumentType);
  if (node.parent !== undefined && isOptionalChain(node.parent)) return removeOptionalTypeMarker(c, thisArgumentType);
  return thisArgumentType;
}

// ---- Type argument inference

function inferTypeArguments(
  c: Checker,
  node: Node,
  signature: Signature,
  args: Node[],
  checkMode: CheckMode,
  context: InferenceContext,
): Type[] {
  // Infer from the contextual type to the return type, e.g. from the declared type of `f` in
  // `let f: (x: string) => number = wrap(s => s.length)`.
  let skipBindingPatterns = true;
  for (const p of signature.typeParameters) {
    if (getDefaultFromTypeParameter(c, p) === undefined) {
      skipBindingPatterns = false;
      break;
    }
  }
  // Decorators have no contextual type.
  const contextualType =
    node.kind === SyntaxKind.Decorator
      ? undefined
      : getContextualTypeEx(c, node, skipBindingPatterns ? ContextFlags.SkipBindingPatterns : ContextFlags.None);
  if (contextualType !== undefined) {
    const inferenceTargetType = getReturnTypeOfSignature(c, signature);
    if (couldContainTypeVariables(c, inferenceTargetType)) {
      const outerContext = getInferenceContext(c, node);
      const isFromBindingPattern =
        !skipBindingPatterns && getContextualTypeEx(c, node, ContextFlags.SkipBindingPatterns) !== contextualType;
      // A return type inference from a binding pattern only feeds `returnMapper`.
      if (!isFromBindingPattern) {
        // Snapshot what has been inferred for an outer call so far, without disturbing it.
        const outerMapper = getMapperFromContext(
          outerContext !== undefined ? cloneInferenceContext(c, outerContext, InferenceFlags.NoDefault) : undefined,
        );
        const instantiatedType = instantiateType(c, contextualType, outerMapper);
        // A generic contextual signature is instantiated with its own type parameters so that they
        // are inferred rather than erased.
        const contextualSignature = getSingleCallSignature(c, instantiatedType);
        const inferenceSourceType =
          contextualSignature !== undefined && contextualSignature.typeParameters.length !== 0
            ? getOrCreateTypeFromSignature(
                c,
                getSignatureInstantiationWithoutFillingInTypeArguments(
                  c,
                  contextualSignature,
                  contextualSignature.typeParameters,
                ),
              )
            : instantiatedType;
        // Return type inferences have the lowest priority.
        inferTypes(
          c,
          context.inferences,
          inferenceSourceType,
          inferenceTargetType,
          InferencePriority.ReturnType,
          false,
        );
      }
      // A separate pass for the mapper used to instantiate generic contextual types, from the outer
      // return mapper so that inferences can't reference the type parameters being inferred.
      const returnContext = createInferenceContext(c, signature.typeParameters, signature, context.flags, undefined);
      const outerReturnMapper = outerContext !== undefined ? createOuterReturnMapper(c, outerContext) : undefined;
      const returnSourceType = instantiateType(c, contextualType, outerReturnMapper);
      inferTypes(c, returnContext.inferences, returnSourceType, inferenceTargetType, InferencePriority.None, false);
      context.returnMapper = someInferenceHasCandidates(returnContext.inferences)
        ? getMapperFromContext(cloneInferredPartOfContext(c, returnContext))
        : undefined;
    }
  }
  if (isJsxOpeningLikeElement(node)) return inferJsxTypeArguments(c, node, signature, checkMode, context);
  const restType = getNonArrayRestType(c, signature);
  const argCount = restType !== undefined ? Math.min(getParameterCount(c, signature) - 1, args.length) : args.length;
  if (restType !== undefined && (restType.flags & TypeFlags.TypeParameter) !== 0) {
    const info = context.inferences.find((i) => i.typeParameter === restType);
    if (info !== undefined && !hasSpreadArgumentFrom(args, argCount)) info.impliedArity = args.length - argCount;
  }
  const thisType = getThisTypeOfSignature(c, signature);
  if (thisType !== undefined && couldContainTypeVariables(c, thisType))
    inferTypes(
      c,
      context.inferences,
      getThisArgumentType(c, getThisArgumentOfCall(c, node)),
      thisType,
      InferencePriority.None,
      false,
    );
  for (let i = 0; i < argCount; i++) {
    const arg = args[i]!;
    if (arg.kind === SyntaxKind.OmittedExpression) continue;
    const paramType = getTypeAtPosition(c, signature, i);
    if (couldContainTypeVariables(c, paramType)) {
      const argType = checkArgument(c, arg, paramType, context, checkMode);
      inferTypes(c, context.inferences, argType, paramType, InferencePriority.None, false);
    }
  }
  if (restType !== undefined && couldContainTypeVariables(c, restType)) {
    const spreadType = getSpreadArgumentType(c, node, args, argCount, args.length, restType, context, checkMode);
    inferTypes(c, context.inferences, spreadType, restType, InferencePriority.None, false);
  }
  return getInferredTypes(c, context);
}

// ---- Overload failure

/** The signature to continue with when no candidate applies; errors are already reported. */
function getCandidateForOverloadFailure(
  c: Checker,
  node: Node,
  candidates: Signature[],
  args: Node[],
  checkMode: CheckMode,
): Signature {
  checkNodeDeferred(c, node);
  // Overloads combine unless they're generic, which is hard to combine.
  if (candidates.length === 1 || candidates.some((s) => s.typeParameters.length !== 0))
    return pickLongestCandidateSignature(c, node, candidates, args, checkMode);
  return createUnionOfSignaturesForOverloadFailure(c, candidates);
}

function pickLongestCandidateSignature(
  c: Checker,
  node: Node,
  candidates: Signature[],
  args: Node[],
  checkMode: CheckMode,
): Signature {
  // The longest signature gives contextual types to the most arguments.
  const bestIndex = getLongestCandidateIndex(c, candidates, args.length);
  const candidate = candidates[bestIndex]!;
  const typeParameters = candidate.typeParameters;
  if (typeParameters.length === 0) return candidate;
  const typeArgumentNodes = getCallTypeArguments(node);
  let instantiated: Signature;
  if (typeArgumentNodes.length !== 0)
    instantiated = createSignatureInstantiation(
      c,
      candidate,
      getTypeArgumentsFromNodes(c, typeArgumentNodes, typeParameters),
    );
  else {
    const inferenceContext = createInferenceContext(
      c,
      typeParameters,
      candidate,
      isInJSFile(node) ? InferenceFlags.AnyDefault : InferenceFlags.None,
      undefined,
    );
    const typeArgumentTypes = inferTypeArguments(
      c,
      node,
      candidate,
      args,
      checkMode | CheckMode.SkipContextSensitive | CheckMode.SkipGenericFunctions,
      inferenceContext,
    );
    instantiated = createSignatureInstantiation(c, candidate, typeArgumentTypes);
  }
  candidates[bestIndex] = instantiated;
  return instantiated;
}

function getLongestCandidateIndex(c: Checker, candidates: Signature[], argsCount: number): number {
  let maxParamsIndex = -1;
  let maxParams = -1;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const paramCount = getParameterCount(c, candidate);
    if (hasEffectiveRestParameter(c, candidate) || paramCount >= argsCount) return i;
    if (paramCount > maxParams) {
      maxParams = paramCount;
      maxParamsIndex = i;
    }
  }
  return maxParamsIndex;
}

function hasSpreadArgumentFrom(args: Node[], start: number): boolean {
  for (let i = start; i < args.length; i++) if (isSpreadArgument(args[i]!)) return true;
  return false;
}

function getTypeArgumentsFromNodes(c: Checker, typeArgumentNodes: Node[], typeParameters: Type[]): Type[] {
  const typeArguments: Type[] = [];
  for (const n of typeArgumentNodes) {
    if (typeArguments.length === typeParameters.length) break;
    typeArguments.push(getTypeFromTypeNode(c, n));
  }
  while (typeArguments.length < typeParameters.length) {
    const tp = typeParameters[typeArguments.length]!;
    typeArguments.push(getDefaultFromTypeParameter(c, tp) ?? getConstraintOfTypeParameter(c, tp) ?? c.unknownType);
  }
  return typeArguments;
}

function createUnionOfSignaturesForOverloadFailure(c: Checker, candidates: Signature[]): Signature {
  const thisParameters: Symbol[] = [];
  const thisTypes: Type[] = [];
  for (const s of candidates) {
    if (s.thisParameter !== undefined) {
      thisParameters.push(s.thisParameter);
      thisTypes.push(getTypeOfParameter(c, s.thisParameter));
    }
  }
  const thisParameter =
    thisParameters.length !== 0 ? createCombinedSymbolFromTypes(c, thisParameters, thisTypes) : undefined;
  let minArgumentCount = Number.MAX_SAFE_INTEGER;
  let maxNonRestParam = 0;
  for (const s of candidates) {
    const count = s.hasRestParameter() ? s.parameters.length - 1 : s.parameters.length;
    minArgumentCount = Math.min(minArgumentCount, count);
    maxNonRestParam = Math.max(maxNonRestParam, count);
  }
  const parameters: Symbol[] = [];
  for (let i = 0; i < maxNonRestParam; i++) {
    const symbols: Symbol[] = [];
    const types: Type[] = [];
    for (const s of candidates) {
      const p = s.hasRestParameter()
        ? i < s.parameters.length - 1
          ? s.parameters[i]!
          : s.parameters[s.parameters.length - 1]!
        : i < s.parameters.length
          ? s.parameters[i]!
          : undefined;
      if (p !== undefined) symbols.push(p);
      const t = tryGetTypeAtPosition(c, s, i);
      if (t !== undefined) types.push(t);
    }
    parameters.push(createCombinedSymbolFromTypes(c, symbols, types));
  }
  const restParameterSymbols: Symbol[] = [];
  const restTypes: Type[] = [];
  for (const s of candidates)
    if (s.hasRestParameter()) {
      restParameterSymbols.push(s.parameters[s.parameters.length - 1]!);
      const t = tryGetRestTypeOfSignature(c, s);
      if (t !== undefined) restTypes.push(t);
    }
  let flags = SignatureFlags.IsSignatureCandidateForOverloadFailure;
  if (restParameterSymbols.length !== 0) {
    const t = createArrayType(c, getUnionTypeEx(c, restTypes, UnionReduction.Subtype, undefined, undefined));
    parameters.push(createSymbolWithType(c, restParameterSymbols[0]!, t));
    flags |= SignatureFlags.HasRestParameter;
  }
  if (candidates.some((s) => (s.flags & SignatureFlags.HasLiteralTypes) !== 0)) flags |= SignatureFlags.HasLiteralTypes;
  const returnTypes: Type[] = [];
  for (const s of candidates) returnTypes.push(getReturnTypeOfSignature(c, s));
  return c.newSignature(
    flags,
    candidates[0]!.declaration,
    [],
    thisParameter,
    parameters,
    getIntersectionType(c, returnTypes),
    minArgumentCount,
  );
}

function createCombinedSymbolFromTypes(c: Checker, sources: Symbol[], types: Type[]): Symbol {
  return createSymbolWithType(c, sources[0]!, getUnionTypeEx(c, types, UnionReduction.Subtype, undefined, undefined));
}

export function tryGetRestTypeOfSignature(c: Checker, signature: Signature): Type | undefined {
  if (!signature.hasRestParameter()) return undefined;
  let restType: Type | undefined = getTypeOfSymbol(c, signature.parameters[signature.parameters.length - 1]!);
  if (isTupleType(restType)) {
    restType = getRestTypeOfTupleType(c, restType);
    if (restType === undefined) return undefined;
  }
  return getIndexTypeOfType(c, restType, c.numberType);
}

// ---- Resolution errors

function reportCallResolutionErrors(
  c: Checker,
  s: CallState,
  signatures: Signature[],
  headMessage: DiagnosticMessage | undefined,
): void {
  if (s.candidatesForArgumentError.length !== 0) {
    const last = s.candidatesForArgumentError[s.candidatesForArgumentError.length - 1]!;
    const diagnostics: Diagnostic[] = [];
    isSignatureApplicable(c, s.node, s.args, last, c.assignableRelation, CheckMode.Normal, true, diagnostics);
    for (let diagnostic of diagnostics) {
      if (s.candidatesForArgumentError.length > 1) {
        diagnostic = chainDiagnostic(diagnostic, Diagnostics.The_last_overload_gave_the_following_error);
        diagnostic = chainDiagnostic(diagnostic, Diagnostics.No_overload_matches_this_call);
      }
      if (headMessage !== undefined) diagnostic = chainDiagnostic(diagnostic, headMessage);
      if (last.declaration !== undefined && s.candidatesForArgumentError.length > 1)
        diagnostic.addRelatedInfo(
          createDiagnosticForNode(last.declaration, Diagnostics.The_last_overload_is_declared_here, []),
        );
      addImplementationSuccessElaboration(c, s, last, diagnostic);
      c.addDiagnostic(diagnostic);
    }
  } else if (s.candidateForArgumentArityError !== undefined)
    c.addDiagnostic(getArgumentArityError(c, s.node, [s.candidateForArgumentArityError], s.args, headMessage));
  else if (s.candidateForTypeArgumentError !== undefined)
    checkTypeArguments(c, s.candidateForTypeArgumentError, getCallTypeArguments(s.node), true, headMessage);
  else if (s.node.kind !== SyntaxKind.JsxOpeningFragment) {
    const withCorrectTypeArgumentArity: Signature[] = [];
    for (const sig of signatures)
      if (hasCorrectTypeArgumentArity(c, sig, s.typeArguments)) withCorrectTypeArgumentArity.push(sig);
    if (withCorrectTypeArgumentArity.length === 0)
      c.addDiagnostic(getTypeArgumentArityError(c, s.node, signatures, s.typeArguments, headMessage));
    else c.addDiagnostic(getArgumentArityError(c, s.node, withCorrectTypeArgumentArity, s.args, headMessage));
  }
}

/** Notes when the call would have resolved to the implementation signature of the overloads. */
function addImplementationSuccessElaboration(
  c: Checker,
  s: CallState,
  failed: Signature,
  diagnostic: Diagnostic,
): void {
  const symbol = failed.declaration !== undefined ? getSymbol(failed.declaration) : undefined;
  if (symbol === undefined || declarationCount(symbol) <= 1) return;
  let implementation: Node | undefined;
  for (const d of getDeclarations(symbol)) {
    if (isFunctionLikeDeclarationKind(d.kind) && nodeIsPresent(getBody(d))) {
      implementation = d;
      break;
    }
  }
  if (implementation === undefined) return;
  const candidate = getSignatureFromDeclaration(c, implementation);
  const localState = new CallState(s.node, s.typeArguments, s.args, [candidate]);
  localState.argCheckMode = s.argCheckMode;
  localState.isSingleNonGenericCandidate = candidate.typeParameters.length === 0;
  localState.candidatesForArgumentError = s.candidatesForArgumentError.slice();
  localState.candidateForArgumentArityError = s.candidateForArgumentArityError;
  localState.candidateForTypeArgumentError = s.candidateForTypeArgumentError;
  if (chooseOverload(c, localState, c.assignableRelation) !== undefined)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(
        implementation,
        Diagnostics.The_call_would_have_succeeded_against_this_implementation_but_implementation_signatures_of_overloads_are_not_externally_visible,
        [],
      ),
    );
}

function withHeadMessage(diagnostic: Diagnostic, headMessage: DiagnosticMessage | undefined): Diagnostic {
  return headMessage !== undefined ? chainDiagnostic(diagnostic, headMessage) : diagnostic;
}

function getArgumentArityError(
  c: Checker,
  node: Node,
  signatures: Signature[],
  args: Node[],
  headMessage: DiagnosticMessage | undefined,
): Diagnostic {
  const spreadIndex = getSpreadArgumentIndex(args);
  if (spreadIndex > -1)
    return createDiagnosticForNode(
      args[spreadIndex]!,
      Diagnostics.A_spread_argument_must_either_have_a_tuple_type_or_be_passed_to_a_rest_parameter,
      [],
    );
  let minCount = Number.MAX_SAFE_INTEGER;
  let maxCount = Number.MIN_SAFE_INTEGER;
  let maxBelow = Number.MIN_SAFE_INTEGER;
  let minAbove = Number.MAX_SAFE_INTEGER;
  let closestSignature: Signature | undefined = undefined;
  for (const sig of signatures) {
    const minParameter = getMinArgumentCount(c, sig);
    const maxParameter = getParameterCount(c, sig);
    if (minParameter < minCount) {
      minCount = minParameter;
      closestSignature = sig;
    }
    maxCount = Math.max(maxCount, maxParameter);
    if (minParameter < args.length && minParameter > maxBelow) maxBelow = minParameter;
    if (args.length < maxParameter && maxParameter < minAbove) minAbove = maxParameter;
  }
  let hasRestParameter = false;
  for (const sig of signatures) {
    if (hasEffectiveRestParameter(c, sig)) {
      hasRestParameter = true;
      break;
    }
  }
  const parameterRange = hasRestParameter
    ? String(minCount)
    : minCount < maxCount
      ? minCount + '-' + maxCount
      : String(minCount);
  const errorNode = getErrorNodeForCallNode(node);
  const message =
    node.kind === SyntaxKind.Decorator
      ? hasRestParameter
        ? Diagnostics.The_runtime_will_invoke_the_decorator_with_1_arguments_but_the_decorator_expects_at_least_0
        : Diagnostics.The_runtime_will_invoke_the_decorator_with_1_arguments_but_the_decorator_expects_0
      : hasRestParameter
        ? Diagnostics.Expected_at_least_0_arguments_but_got_1
        : Diagnostics.Expected_0_arguments_but_got_1;
  if (minCount < args.length && args.length < maxCount)
    // Between min and max, but no overload matches.
    return withHeadMessage(
      createDiagnosticForNode(
        errorNode,
        Diagnostics.No_overload_expects_0_arguments_but_overloads_do_exist_that_expect_either_1_or_2_arguments,
        [String(args.length), String(maxBelow), String(minAbove)],
      ),
      headMessage,
    );
  if (args.length < minCount) {
    // Too short: the error spans the callee.
    const diagnostic = withHeadMessage(
      createDiagnosticForNode(errorNode, message, [parameterRange, String(args.length)]),
      headMessage,
    );
    const declaration = closestSignature !== undefined ? closestSignature.declaration : undefined;
    const params = declaration !== undefined ? getParameters(declaration) : undefined;
    const index = args.length + (closestSignature!.thisParameter !== undefined ? 1 : 0);
    const parameter = params !== undefined && index < params.nodes.length ? params.nodes[index]! : undefined;
    if (parameter !== undefined) {
      const name = getName(parameter)!;
      if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
        diagnostic.addRelatedInfo(
          createDiagnosticForNode(
            parameter,
            Diagnostics.An_argument_matching_this_binding_pattern_was_not_provided,
            [],
          ),
        );
      else if ((parameter as ParameterDeclaration).dotDotDotToken !== undefined)
        diagnostic.addRelatedInfo(
          createDiagnosticForNode(parameter, Diagnostics.Arguments_for_the_rest_parameter_0_were_not_provided, [
            getTextOfName(name),
          ]),
        );
      else
        diagnostic.addRelatedInfo(
          createDiagnosticForNode(parameter, Diagnostics.An_argument_for_0_was_not_provided, [getTextOfName(name)]),
        );
    }
    return diagnostic;
  }
  if (maxCount >= args.length)
    return withHeadMessage(
      createDiagnosticForNode(errorNode, message, [parameterRange, String(args.length)]),
      headMessage,
    );
  // Too long: the error spans the excess arguments.
  const file = getSourceFileOfNode(node);
  let pos = args[maxCount]!.pos;
  let end = args[args.length - 1]!.end;
  if (end === pos) end++;
  pos = skipTrivia(file.text, pos);
  if (end < pos) end = pos;
  return withHeadMessage(
    new Diagnostic(file.diagnosticFile(), pos, end, message, [parameterRange, String(args.length)]),
    headMessage,
  );
}

function getTypeArgumentArityError(
  c: Checker,
  node: Node,
  signatures: Signature[],
  typeArguments: Node[],
  headMessage: DiagnosticMessage | undefined,
): Diagnostic {
  const argCount = typeArguments.length;
  const file = getSourceFileOfNode(node);
  const list = getTypeArgumentList(node)!;
  const pos = skipTrivia(file.text, list.pos);
  const end = list.end;
  let diagnostic: Diagnostic;
  if (signatures.length === 1) {
    // No overloads.
    const sig = signatures[0]!;
    const minCount = getMinTypeArgumentCount(c, sig.typeParameters);
    const maxCount = sig.typeParameters.length;
    const expected = minCount < maxCount ? minCount + '-' + maxCount : String(minCount);
    diagnostic = new Diagnostic(file.diagnosticFile(), pos, end, Diagnostics.Expected_0_type_arguments_but_got_1, [
      expected,
      String(argCount),
    ]);
  } else {
    let belowArgCount = Number.MIN_SAFE_INTEGER;
    let aboveArgCount = Number.MAX_SAFE_INTEGER;
    for (const sig of signatures) {
      const minCount = getMinTypeArgumentCount(c, sig.typeParameters);
      const maxCount = sig.typeParameters.length;
      if (minCount > argCount) aboveArgCount = Math.min(aboveArgCount, minCount);
      else if (maxCount < argCount) belowArgCount = Math.max(belowArgCount, maxCount);
    }
    diagnostic =
      belowArgCount !== Number.MIN_SAFE_INTEGER && aboveArgCount !== Number.MAX_SAFE_INTEGER
        ? new Diagnostic(
            file.diagnosticFile(),
            pos,
            end,
            Diagnostics.No_overload_expects_0_type_arguments_but_overloads_do_exist_that_expect_either_1_or_2_type_arguments,
            [String(argCount), String(belowArgCount), String(aboveArgCount)],
          )
        : new Diagnostic(file.diagnosticFile(), pos, end, Diagnostics.Expected_0_type_arguments_but_got_1, [
            String(belowArgCount === Number.MIN_SAFE_INTEGER ? aboveArgCount : belowArgCount),
            String(argCount),
          ]);
  }
  return withHeadMessage(diagnostic, headMessage);
}

function getTextOfName(name: Node): string {
  return name.kind === SyntaxKind.Identifier ? getText(name) : '';
}

function getErrorNodeForCallNode(node: Node): Node {
  if (node.kind === SyntaxKind.CallExpression) {
    const callee = (node as CallExpression).expression;
    if (callee.kind === SyntaxKind.PropertyAccessExpression) return getName(callee)!;
    return callee;
  }
  return node;
}

// ---- Generic function arguments

/**
 * Under inferential typing, a generic function argument whose contextual type is a non-generic
 * function is instantiated in the context of that function type.
 */
export function instantiateTypeWithSingleGenericCallSignature(
  c: Checker,
  node: Node,
  t: Type,
  checkMode: CheckMode,
): Type {
  if ((checkMode & (CheckMode.Inferential | CheckMode.SkipGenericFunctions)) === 0) return t;
  const callSignature = getSingleSignature(c, t, SignatureKind.Call, true);
  const constructSignature = getSingleSignature(c, t, SignatureKind.Construct, true);
  const signature = callSignature ?? constructSignature;
  if (signature === undefined || signature.typeParameters.length === 0) return t;
  const contextualType = getApparentTypeOfContextualTypeEx(c, node, ContextFlags.NoConstraints);
  if (contextualType === undefined) return t;
  const contextualSignature = getSingleSignature(
    c,
    getNonNullableType(c, contextualType),
    callSignature !== undefined ? SignatureKind.Call : SignatureKind.Construct,
    false,
  );
  if (contextualSignature === undefined || contextualSignature.typeParameters.length !== 0) return t;
  if ((checkMode & CheckMode.SkipGenericFunctions) !== 0) {
    skippedGenericFunction(c, node, checkMode);
    return c.anyFunctionType;
  }
  const context = getInferenceContext(c, node)!;
  // When the outer function returns a non-generic function and some of its type parameters have no
  // inferences yet, the argument's type parameters may become type parameters of that result.
  const returnType = context.signature !== undefined ? getReturnTypeOfSignature(c, context.signature) : undefined;
  const returnSignature = returnType !== undefined ? getSingleCallOrConstructSignature(c, returnType) : undefined;
  if (
    returnSignature !== undefined &&
    returnSignature.typeParameters.length === 0 &&
    !everyInferenceHasCandidates(context.inferences)
  ) {
    // Instantiate with its own type parameters, renamed to be unique where needed.
    const uniqueTypeParameters = getUniqueTypeParameters(c, context, signature.typeParameters);
    const instantiatedSignature = getSignatureInstantiationWithoutFillingInTypeArguments(
      c,
      signature,
      uniqueTypeParameters,
    );
    // Infer from its parameters to the contextual signature's, from no candidates.
    const inferences = context.inferences.map((info) => new InferenceInfo(info.typeParameter));
    applyToParameterTypes(c, instantiatedSignature, contextualSignature, (source, target) =>
      inferTypes(c, inferences, source, target, InferencePriority.None, true),
    );
    if (someInferenceHasCandidates(inferences)) {
      // Type parameters are referenced by the contextual parameters; also infer from the return type.
      applyToReturnTypes(c, instantiatedSignature, contextualSignature, (source, target) =>
        inferTypes(c, inferences, source, target, InferencePriority.None, false),
      );
      // Without overlapping inferences, adopt the new candidates and the argument's type parameters.
      if (!hasOverlappingInferences(context.inferences, inferences)) {
        mergeInferences(context.inferences, inferences);
        context.inferredTypeParameters =
          context.inferredTypeParameters !== undefined
            ? context.inferredTypeParameters.concat(uniqueTypeParameters)
            : uniqueTypeParameters;
        return getOrCreateTypeFromSignature(c, instantiatedSignature);
      }
    }
  }
  return getOrCreateTypeFromSignature(
    c,
    instantiateSignatureInContextOf(c, signature, contextualSignature, context, undefined),
  );
}

function getUniqueTypeParameters(c: Checker, context: InferenceContext, typeParameters: Type[]): Type[] {
  const oldTypeParameters: Type[] = [];
  const newTypeParameters: TypeParameter[] = [];
  const result: Type[] = [];
  const inferred = context.inferredTypeParameters ?? [];
  for (const tp of typeParameters) {
    const name = tp.symbol!.name;
    if (hasTypeParameterByName(inferred, name) || hasTypeParameterByName(result, name)) {
      const newName = getUniqueTypeParameterName(inferred.concat(result), name);
      const newTypeParameter = c.newTypeParameter(c.newSymbol(SymbolFlags.TypeParameter, newName));
      newTypeParameter.target = tp;
      oldTypeParameters.push(tp);
      newTypeParameters.push(newTypeParameter);
      result.push(newTypeParameter);
    } else result.push(tp);
  }
  if (newTypeParameters.length !== 0) {
    const mapper = newTypeMapper(oldTypeParameters, newTypeParameters);
    for (const tp of newTypeParameters) tp.mapper = mapper;
  }
  return result;
}

function hasTypeParameterByName(typeParameters: Type[], name: string): boolean {
  return typeParameters.some((tp) => tp.symbol!.name === name);
}

function getUniqueTypeParameterName(typeParameters: Type[], baseName: string): string {
  while (
    baseName.length > 1 &&
    baseName.charCodeAt(baseName.length - 1) >= 0x30 &&
    baseName.charCodeAt(baseName.length - 1) <= 0x39
  )
    baseName = baseName.substring(0, baseName.length - 1);
  for (let index = 1; ; index++) {
    const augmentedName = baseName + index;
    if (!hasTypeParameterByName(typeParameters, augmentedName)) return augmentedName;
  }
}

/** A signature instantiation whose function return type takes the inferred type parameters. */
function getSignatureInstantiationWithInferredTypeParameters(
  c: Checker,
  sig: Signature,
  typeArguments: Type[],
  isJavaScript: boolean,
  inferredTypeParameters: Type[] | undefined,
): Signature {
  const instantiatedSignature = getSignatureInstantiation(c, sig, typeArguments, isJavaScript);
  if (inferredTypeParameters === undefined || inferredTypeParameters.length === 0) return instantiatedSignature;
  const returnSignature = getSingleCallOrConstructSignature(c, getReturnTypeOfSignature(c, instantiatedSignature));
  if (returnSignature === undefined) return instantiatedSignature;
  const newReturnSignature = cloneSignature(c, returnSignature);
  newReturnSignature.typeParameters = inferredTypeParameters;
  const newReturnType = getOrCreateTypeFromSignature(c, newReturnSignature) as ObjectType;
  newReturnType.mapper = instantiatedSignature.mapper;
  const newInstantiatedSignature = cloneSignature(c, instantiatedSignature);
  newInstantiatedSignature.resolvedReturnType = newReturnType;
  return newInstantiatedSignature;
}

// ---- Instantiation expressions

/** Checks `f<T>` in an expression, or `typeof f<T>`. */
export function checkExpressionWithTypeArguments(c: Checker, node: Node): Type {
  const typeArguments = getTypeArgumentList(node);
  if (typeArguments !== undefined) for (const a of typeArguments.nodes) checkSourceElement(c, a);
  let exprType: Type;
  if (node.kind === SyntaxKind.ExpressionWithTypeArguments) {
    let parent = node.parent!;
    while (parent.kind === SyntaxKind.ParenthesizedExpression) parent = parent.parent!;
    if (
      parent.kind === SyntaxKind.BinaryExpression &&
      (parent as BinaryExpression).operatorToken.kind === SyntaxKind.InstanceOfKeyword &&
      isNodeDescendantOf(node, (parent as BinaryExpression).right)
    )
      c.error(
        node,
        Diagnostics.The_right_hand_side_of_an_instanceof_expression_must_not_be_an_instantiation_expression,
      );
    exprType = checkExpression(c, getExpression(node)!);
  } else exprType = checkTypeQueryExpression(c, node);
  return getInstantiationExpressionType(c, exprType, node);
}

/** The type of an expression with type arguments: its generic signatures instantiated with them. */
export function getInstantiationExpressionType(c: Checker, exprType: Type, node: Node): Type {
  const typeArgumentList = getTypeArgumentList(node);
  if (exprType === c.silentNeverType || isErrorType(c, exprType) || typeArgumentList === undefined) return exprType;
  const key = `${getNodeId(node)},${exprType.id}`;
  const cached = c.instantiationExpressionTypes.get(key);
  if (cached !== undefined) return cached;
  const instantiator = new InstantiationExpressionInstantiator(c, node, typeArgumentList.nodes);
  const result = instantiator.instantiateType(exprType);
  c.instantiationExpressionTypes.set(key, result);
  const errorType = instantiator.hasSomeApplicableSignature ? instantiator.nonApplicableType : exprType;
  if (errorType !== undefined) {
    const file = getSourceFileOfNode(node);
    c.addDiagnostic(
      new Diagnostic(
        file.diagnosticFile(),
        skipTrivia(file.text, typeArgumentList.pos),
        typeArgumentList.end,
        Diagnostics.Type_0_has_no_signatures_for_which_the_type_argument_list_is_applicable,
        [typeToString(c, errorType)],
      ),
    );
  }
  return result;
}

/** Instantiates the generic signatures of a type and its constituents with explicit type arguments. */
class InstantiationExpressionInstantiator {
  readonly c: Checker;
  readonly node: Node;
  readonly typeArguments: Node[];
  hasSomeApplicableSignature = false;
  nonApplicableType: Type | undefined = undefined;
  hasSignatures = false;
  hasApplicableSignature = false;

  constructor(c: Checker, node: Node, typeArguments: Node[]) {
    this.c = c;
    this.node = node;
    this.typeArguments = typeArguments;
  }

  instantiateType(t: Type): Type {
    const saveHasSignatures = this.hasSignatures;
    const saveHasApplicableSignature = this.hasApplicableSignature;
    this.hasSignatures = false;
    this.hasApplicableSignature = false;
    const result = this.instantiateTypePart(t);
    if (this.hasApplicableSignature) this.hasSomeApplicableSignature = true;
    if (this.hasSignatures && !this.hasApplicableSignature && this.nonApplicableType === undefined)
      this.nonApplicableType = t;
    this.hasSignatures = saveHasSignatures;
    this.hasApplicableSignature = saveHasApplicableSignature;
    return result;
  }

  instantiateTypePart(t: Type): Type {
    const c = this.c;
    if ((t.flags & TypeFlags.Object) !== 0) {
      const resolved = resolveStructuredTypeMembers(c, t);
      const callSignatures = this.instantiateSignatures(resolved.callSignatures);
      const constructSignatures = this.instantiateSignatures(resolved.constructSignatures);
      if (resolved.callSignatures.length !== 0 || resolved.constructSignatures.length !== 0) this.hasSignatures = true;
      if (callSignatures.length !== 0 || constructSignatures.length !== 0) this.hasApplicableSignature = true;
      if (callSignatures !== resolved.callSignatures || constructSignatures !== resolved.constructSignatures) {
        const result = newObjectType(
          c,
          ObjectFlags.Anonymous | ObjectFlags.InstantiationExpressionType,
          c.newSymbol(SymbolFlags.None, InternalSymbolName.InstantiationExpression),
        ) as InstantiationExpressionType;
        setStructuredTypeMembers(c, result, resolved.members, callSignatures, constructSignatures, resolved.indexInfos);
        result.node = this.node;
        return result;
      }
    } else if ((t.flags & TypeFlags.InstantiableNonPrimitive) !== 0) {
      const constraint = getBaseConstraintOfType(c, t);
      if (constraint !== undefined) {
        const instantiated = this.instantiateTypePart(constraint);
        if (instantiated !== constraint) return instantiated;
      }
    } else if ((t.flags & TypeFlags.Union) !== 0) return mapType(c, t, (u) => this.instantiateType(u));
    else if ((t.flags & TypeFlags.Intersection) !== 0) {
      const types = typesOf(t);
      const instantiated: Type[] = [];
      let changed = false;
      for (const u of types) {
        const v = this.instantiateTypePart(u);
        if (v !== u) changed = true;
        instantiated.push(v);
      }
      return changed ? getIntersectionType(c, instantiated) : t;
    }
    return t;
  }

  /** The applicable signatures, instantiated; the same array when nothing changes. */
  instantiateSignatures(signatures: Signature[]): Signature[] {
    const c = this.c;
    const result: Signature[] = [];
    let changed = false;
    for (const sig of signatures) {
      if (sig.typeParameters.length === 0 || !hasCorrectTypeArgumentArity(c, sig, this.typeArguments)) {
        changed = true;
        continue;
      }
      const typeArgumentTypes = checkTypeArguments(c, sig, this.typeArguments, true, undefined);
      if (typeArgumentTypes === undefined) {
        result.push(sig);
        continue;
      }
      result.push(getSignatureInstantiation(c, sig, typeArgumentTypes, isInJSFile(sig.declaration)));
      changed = true;
    }
    return changed ? result : signatures;
  }
}
