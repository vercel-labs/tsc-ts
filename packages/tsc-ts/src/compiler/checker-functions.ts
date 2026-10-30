// Functions: function expressions and arrows, bodies, inferred return types, generators, `await`.
import { checkCollisionsForDeclarationName } from './checker-generated-code.js';
import { ScriptTarget } from './options.js';
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import { resolvedReturnTypeOf, signatureSideOf } from './side-state.js';
import { isJsxAttributesContextSensitive } from './checker-jsx.js';
import {
  type Block,
  type ConditionalExpression,
  type BinaryExpression,
  type ForStatement,
  type Node,
  NodeVisitor,
  NodeFlags,
  type ReturnStatement,
  type YieldExpression,
  getBody,
  getDotDotDotToken,
  getEndFlowNode,
  getFlowNode,
  getText,
  getExpression,
  getInitializer,
  getParameters,
  getProperties,
  getElements,
  getStatements,
  getSymbol,
  getType,
  getTypeParameters,
  getName,
  type BindingElement,
} from './ast.js';
import { isFunctionExpressionOrArrowFunction, isObjectLiteralMethod, skipParentheses } from './binder-utilities.js';
import { isPartOfTypeNode } from './transformers/alias-references.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { type Type, TypeFlags, NodeCheckFlags, TypePredicate, TypePredicateKind } from './checker-types.js';
import {
  filterType,
  getIntersectionType,
  getRegularTypeOfLiteralType,
  getUnionTypeEx,
  isErrorType,
  isUnitType,
  someType,
  UnionReduction,
} from './checker-type-factory.js';
import {
  getTypeOfSymbol,
  getWidenedType,
  isPrivateWithinAmbient,
  reportErrorsFromWidening,
  reportImplicitAny,
  WideningKind,
  getWidenedTypeForVariableLikeDeclaration,
} from './checker-symbol-types.js';
import { getMergedSymbol, getSymbolOfDeclaration } from './checker-symbols.js';
import {
  getReturnTypeFromAnnotation,
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
} from './checker-signatures.js';
import {
  checkExpression,
  checkExpressionCached,
  getWidenedLiteralLikeTypeForContextualType,
  isConstContext,
} from './checker-expressions.js';
import {
  getContextualIterationType,
  getContextualReturnType,
  getContextualType,
  hasContextSensitiveParameters,
} from './checker-contextual.js';
import { checkNodeDeferred, checkSourceElement, checkTypeNodeIfPresent } from './checker-source-file.js';
import { checkTypeParameters, checkVariableLikeDeclaration } from './checker-declarations.js';
import { getFunctionFlags, FunctionFlags, maybeTypeOfKind } from './checker-utilities.js';
import { CheckMode, ObjectFlags, type Signature, SignatureFlags, SignatureKind } from './checker-types.js';
import { type Symbol, getSymbolId } from './symbol.js';
import { createAnonymousType, getWidenedLiteralType } from './checker-type-factory.js';
import { isGenericType } from './checker-type-operators.js';
import { createSymbolWithType, getReducedType, getSignaturesOfType } from './checker-members.js';
import {
  getEffectiveRestType,
  getRestTypeAtPosition,
  getTypeAtPosition,
  isOptionalDeclaration,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import { addOptionality } from './checker-symbol-types.js';
import { getBindingElementTypeFromParentType, getTypeFromBindingPattern } from './checker-destructuring.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  checkDeclarationInitializer,
  checkExpressionEx,
  checkTypeAssignableToAndOptionallyElaborate,
} from './checker-expressions.js';
import { isTypeAssignableTo } from './relations.js';
import { type InferenceContext, InferencePriority, inferTypes } from './checker-inference.js';
import { couldContainTypeVariables, instantiateSignature } from './instantiation.js';
import {
  ContextFlags,
  getContextualSignatureForFunctionLikeDeclaration,
  getInferenceContext,
  instantiateContextualType,
} from './checker-contextual.js';
import {
  checkJSDocFullSignature,
  checkJSDocFullSignatureType,
  checkUnmatchedJSDocParameters,
  getFullSignatureTypeNode,
} from './checker-jsdoc.js';
import { getEffectiveCheckNode, isFunctionLike, nodeIsMissing } from './ast-utilities.js';
import {
  getFlowTypeOfReferenceAt,
  isConstantReference,
  isReachableFlowNode,
  isSymbolAssigned,
} from './checker-narrowing.js';
import { FlowFlags, FlowNode } from './flow.js';
import {
  IterationTypeKind,
  IterationUse,
  checkAwaitedType,
  checkGeneratorInstantiationAssignabilityToReturnType,
  checkIteratedTypeOrElementType,
  createGeneratorType,
  createPromiseReturnType,
  createPromiseType,
  getAwaitedTypeEx,
  getAwaitedTypeNoAlias,
  getGlobalPromiseTypeChecked,
  getIterationTypeOfGeneratorFunctionReturnType,
  getIterationTypeOfIterable,
  getIterationTypesOfGeneratorFunctionReturnType,
  getIterationTypesOfIterable,
  getPromisedTypeOfPromise,
  isReferenceToType,
  unwrapAwaitedType,
  unwrapReturnType,
} from './checker-iteration.js';
import { typeToString } from './type-printer.js';
import {
  checkGrammarAwaitExpression,
  checkGrammarFunctionExpression,
  checkGrammarYieldOfExpression,
} from './checker-grammar.js';

export function checkFunctionExpressionOrObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): Type {
  checkNodeDeferred(c, node);
  checkJSDocFullSignatureType(c, node);
  if (node.kind === SyntaxKind.FunctionExpression) checkCollisionsForDeclarationName(c, node, getName(node));
  if (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor) return c.anyType;
  if ((checkMode & CheckMode.SkipContextSensitive) !== 0 && isContextSensitive(c, node)) {
    // Skip parameters, but keep a return type with the non-contextual parts so that inferences can
    // be drawn early.
    if (getType(node) === undefined && !hasContextSensitiveParameters(node)) {
      const contextualSignature = getContextualSignatureForFunctionLikeDeclaration(c, node);
      if (
        contextualSignature !== undefined &&
        couldContainTypeVariables(c, getReturnTypeOfSignature(c, contextualSignature))
      ) {
        const links = c.nodeLinks(node);
        if (links.contextFreeType !== undefined) return links.contextFreeType;
        const returnType = getReturnTypeFromBodyEx(c, node, checkMode);
        const returnOnlySignature = c.newSignature(
          SignatureFlags.IsNonInferrable,
          undefined,
          [],
          undefined,
          [],
          returnType,
          0,
        );
        const returnOnlyType = createAnonymousType(
          c,
          getSymbolOfDeclaration(c, node),
          undefined,
          [returnOnlySignature],
          [],
          [],
        );
        returnOnlyType.objectFlags |= ObjectFlags.NonInferrableType;
        links.contextFreeType = returnOnlyType;
        return returnOnlyType;
      }
    }
    return c.anyFunctionType;
  }
  if (node.kind === SyntaxKind.FunctionExpression || node.kind === SyntaxKind.ArrowFunction)
    checkGrammarFunctionExpression(c, node);
  checkJSDocFullSignature(c, node);
  contextuallyCheckFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.anyType;
}

/** Assigns contextual parameter types and the return type of a function expression, once. */
function contextuallyCheckFunctionExpressionOrObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): void {
  const links = c.nodeLinks(node);
  if ((links.flags & NodeCheckFlags.ContextChecked) !== 0) return;
  const contextualSignature = getContextualSignatureForFunctionLikeDeclaration(c, node);
  // Obtaining the contextual signature may have come back here through overload resolution.
  if ((links.flags & NodeCheckFlags.ContextChecked) !== 0) return;
  links.flags |= NodeCheckFlags.ContextChecked;
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const signatures = getSignaturesOfType(c, getTypeOfSymbol(c, symbol), SignatureKind.Call);
  if (signatures.length === 0) return;
  const signature = signatures[0]!;
  if (isContextSensitive(c, node)) {
    if (contextualSignature !== undefined) {
      const inferenceContext = getInferenceContext(c, node);
      let instantiatedContextualSignature: Signature | undefined = undefined;
      if ((checkMode & CheckMode.Inferential) !== 0 && inferenceContext !== undefined) {
        inferFromAnnotatedParametersAndReturn(c, signature, contextualSignature, inferenceContext);
        const restType = getEffectiveRestType(c, contextualSignature);
        if (restType !== undefined && (restType.flags & TypeFlags.TypeParameter) !== 0)
          instantiatedContextualSignature = instantiateSignature(
            c,
            contextualSignature,
            inferenceContext.nonFixingMapper,
          );
      }
      if (instantiatedContextualSignature === undefined)
        instantiatedContextualSignature =
          inferenceContext !== undefined
            ? instantiateSignature(c, contextualSignature, inferenceContext.mapper)
            : contextualSignature;
      assignContextualParameterTypes(c, signature, instantiatedContextualSignature);
    } else assignNonContextualParameterTypes(c, node);
  } else if (
    contextualSignature !== undefined &&
    getTypeParameters(node) === undefined &&
    contextualSignature.parameters.length > getParameters(node)!.nodes.length
  ) {
    const inferenceContext = getInferenceContext(c, node);
    if ((checkMode & CheckMode.Inferential) !== 0 && inferenceContext !== undefined)
      inferFromAnnotatedParametersAndReturn(c, signature, contextualSignature, inferenceContext);
  }
  if (
    contextualSignature !== undefined &&
    getType(node) === undefined &&
    resolvedReturnTypeOf(c, signature) === undefined
  ) {
    // The resolved return type is cached, so it is computed without SkipContextSensitive to keep anyFunctionType out of it.
    const returnType = getReturnTypeFromBodyEx(c, node, checkMode & ~CheckMode.SkipContextSensitive);
    if (resolvedReturnTypeOf(c, signature) === undefined) signatureSideOf(c, signature).resolvedReturnType = returnType;
  }
  checkFunctionLikeSignature(c, node);
}

function inferFromAnnotatedParametersAndReturn(
  c: Checker,
  sig: Signature,
  context: Signature,
  inferenceContext: InferenceContext,
): void {
  const length = sig.parameters.length - (sig.hasRestParameter() ? 1 : 0);
  for (let i = 0; i < length; i++) {
    const declaration = sig.parameters[i]!.valueDeclaration;
    const typeNode = declaration !== undefined ? getType(declaration) : undefined;
    if (typeNode !== undefined) {
      const source = addOptionality(c, getTypeFromTypeNode(c, typeNode), false, isOptionalDeclaration(declaration!));
      inferTypes(
        c,
        inferenceContext.inferences,
        source,
        getTypeAtPosition(c, context, i),
        InferencePriority.None,
        false,
      );
    }
  }
  const declaration = sig.declaration;
  const returnTypeNode = declaration !== undefined ? getType(declaration) : undefined;
  if (returnTypeNode !== undefined)
    inferTypes(
      c,
      inferenceContext.inferences,
      getTypeFromTypeNode(c, returnTypeNode),
      getReturnTypeOfSignature(c, context),
      InferencePriority.None,
      false,
    );
}

function assignContextualParameterTypes(c: Checker, sig: Signature, context: Signature): void {
  if (context.typeParameters.length !== 0) {
    // A contextual inference was already performed and cached on this signature.
    if (sig.typeParameters.length !== 0) return;
    sig.typeParameters = context.typeParameters;
  }
  if (context.thisParameter !== undefined) {
    const parameter = sig.thisParameter;
    if (
      parameter === undefined ||
      (parameter.valueDeclaration !== undefined && getType(parameter.valueDeclaration) === undefined)
    ) {
      if (parameter === undefined) sig.thisParameter = createSymbolWithType(c, context.thisParameter, undefined);
      assignParameterSymbolType(c, sig.thisParameter!, getTypeOfSymbol(c, context.thisParameter));
    }
  }
  const length = sig.parameters.length - (sig.hasRestParameter() ? 1 : 0);
  for (let i = 0; i < length; i++) {
    const parameter = sig.parameters[i]!;
    const declaration = parameter.valueDeclaration;
    if (declaration === undefined || getType(declaration) !== undefined) continue;
    let t = tryGetTypeAtPosition(c, context, i);
    if (t !== undefined && getInitializer(declaration) !== undefined) {
      let initializerType = checkDeclarationInitializer(c, declaration);
      if (!isTypeAssignableTo(c, initializerType, t)) {
        initializerType = getWidenedLiteralType(c, initializerType);
        if (isTypeAssignableTo(c, t, initializerType)) t = initializerType;
      }
    }
    assignParameterSymbolType(c, parameter, t);
  }
  if (sig.hasRestParameter()) {
    const parameter = sig.parameters[sig.parameters.length - 1]!;
    const declaration = parameter.valueDeclaration;
    if (declaration !== undefined && getType(declaration) === undefined)
      assignParameterSymbolType(c, parameter, getRestTypeAtPosition(c, context, length, false));
  }
}

function assignNonContextualParameterTypes(c: Checker, func: Node): void {
  for (const param of getParameters(func)!.nodes) assignParameterType(c, param);
}

/** Fixes a parameter's type to `contextualType`, or to its declared type without one. */
function assignParameterSymbolType(c: Checker, parameter: Symbol, contextualType: Type | undefined): void {
  const id = getSymbolId(parameter);
  if (c.symbolTypes.get(id) !== undefined) return;
  const declaration = parameter.valueDeclaration;
  if (contextualType === undefined) {
    c.symbolTypes.set(
      id,
      declaration !== undefined
        ? getWidenedTypeForVariableLikeDeclaration(c, declaration, true)
        : getTypeOfSymbol(c, parameter),
    );
    return;
  }
  c.symbolTypes.set(
    id,
    addOptionality(
      c,
      contextualType,
      false,
      declaration !== undefined && getInitializer(declaration) === undefined && isOptionalDeclaration(declaration),
    ),
  );
  if (declaration === undefined) return;
  const name = getName(declaration);
  // Without a better inference than `unknown`, a binding pattern implies the type.
  if (
    c.symbolTypes.get(id) === c.unknownType &&
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  )
    c.symbolTypes.set(id, getTypeFromBindingPattern(c, name, false, false));
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  )
    assignBindingElementTypes(c, name, c.symbolTypes.get(id)!);
}

export function getTypeOfObjectLiteralMethod(c: Checker, node: Node, checkMode: CheckMode): Type {
  return checkFunctionExpressionOrObjectLiteralMethod(c, node, checkMode);
}

/** Checks the type parameters, parameters and return type annotation of a function. */
function checkFunctionLikeSignature(c: Checker, node: Node): void {
  const functionFlags = getFunctionFlags(node);
  if ((functionFlags & FunctionFlags.Invalid) === 0) {
    // Async generators before ES2018 use __await and __asyncGenerator, and async functions before ES2017 __awaiter.
    if (
      (functionFlags & FunctionFlags.AsyncGenerator) === FunctionFlags.AsyncGenerator &&
      c.languageVersion < ScriptTarget.ES2018
    )
      checkExternalEmitHelpers(c, node, ExternalEmitHelpers.AsyncGeneratorIncludes);
    if (
      (functionFlags & FunctionFlags.AsyncGenerator) === FunctionFlags.Async &&
      c.languageVersion < ScriptTarget.ES2017
    )
      checkExternalEmitHelpers(c, node, ExternalEmitHelpers.Awaiter);
  }
  checkTypeParameters(c, getTypeParameters(node));
  checkUnmatchedJSDocParameters(c, node);
  const params = getParameters(node);
  if (params !== undefined) for (const p of params.nodes) checkVariableLikeDeclaration(c, p);
  const returnTypeNode = getType(node);
  checkTypeNodeIfPresent(c, returnTypeNode);
  if (returnTypeNode !== undefined) checkSignatureReturnType(c, node, returnTypeNode, getFunctionFlags(node));
}

/**
 * Checks a function's signature and body. The signature of a function expression or object literal
 * method is checked earlier, while its contextual parameter types are assigned.
 */
export function checkFunctionLikeBody(c: Checker, node: Node): void {
  if (((c.existingNodeLinks(node)?.flags ?? 0) & NodeCheckFlags.ContextChecked) === 0)
    checkFunctionLikeSignature(c, node);
  const returnTypeNode = getType(node);
  const functionFlags = getFunctionFlags(node);
  const body = getBody(node);
  // Function and class method declarations without a body or return type return `any`.
  if (
    returnTypeNode === undefined &&
    nodeIsMissing(body) &&
    (node.kind === SyntaxKind.FunctionDeclaration ||
      (node.kind === SyntaxKind.MethodDeclaration && node.parent!.kind !== SyntaxKind.ObjectLiteralExpression)) &&
    !isPrivateWithinAmbient(node)
  )
    reportImplicitAny(c, node, c.anyType);
  if (body === undefined) return;
  const returnType = node.kind !== SyntaxKind.Constructor ? getReturnTypeFromAnnotation(c, node) : undefined;
  // Errors only found while inferring the return type (such as of yielded values) need it resolved.
  if (
    returnTypeNode === undefined &&
    (isFunctionExpressionOrArrowFunction(node) ||
      isObjectLiteralMethod(node) ||
      ((functionFlags & FunctionFlags.Generator) !== 0 && node.kind !== SyntaxKind.Constructor))
  )
    getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, node));
  if (body.kind === SyntaxKind.Block) {
    for (const s of getStatements(body)!.nodes) checkSourceElement(c, s);
    if (node.kind !== SyntaxKind.Constructor && node.kind !== SyntaxKind.SetAccessor)
      checkAllCodePathsInNonVoidFunctionReturnOrThrow(c, node, returnType);
  } else {
    // An async arrow function's awaited body is checked against the promised type.
    const exprType = checkExpression(c, body);
    if (returnType !== undefined)
      checkReturnExpression(c, node, unwrapReturnType(c, returnType, functionFlags), body, body, exprType, false);
  }
}

/** Checks a generator's or async function's return type annotation. */
function checkSignatureReturnType(c: Checker, node: Node, returnTypeNode: Node, functionFlags: FunctionFlags): void {
  if ((functionFlags & (FunctionFlags.Invalid | FunctionFlags.Generator)) === FunctionFlags.Generator) {
    const returnType = getTypeFromTypeNode(c, returnTypeNode);
    if (returnType === c.voidType) c.error(returnTypeNode, Diagnostics.A_generator_cannot_have_a_void_type_annotation);
    else checkGeneratorInstantiationAssignabilityToReturnType(c, returnType, functionFlags, returnTypeNode);
  } else if ((functionFlags & FunctionFlags.AsyncGenerator) === FunctionFlags.Async)
    checkAsyncFunctionReturnType(c, node, returnTypeNode);
}

/** Checks that an async function's return type is the global `Promise<T>` and can be awaited. */
function checkAsyncFunctionReturnType(c: Checker, node: Node, returnTypeNode: Node): void {
  const returnType = getTypeFromTypeNode(c, returnTypeNode);
  if (isErrorType(c, returnType)) return;
  const globalPromiseType = getGlobalPromiseTypeChecked(c);
  if (globalPromiseType !== c.emptyGenericType && !isReferenceToType(returnType, globalPromiseType)) {
    c.error(
      returnTypeNode,
      Diagnostics.The_return_type_of_an_async_function_or_method_must_be_the_global_Promise_T_type_Did_you_mean_to_write_Promise_0,
      typeToString(c, getAwaitedTypeNoAlias(c, returnType) ?? c.voidType),
    );
    return;
  }
  checkAwaitedType(
    c,
    returnType,
    false,
    node,
    Diagnostics.The_return_type_of_an_async_function_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
  );
}

function checkAllCodePathsInNonVoidFunctionReturnOrThrow(c: Checker, func: Node, returnType: Type | undefined): void {
  const functionFlags = getFunctionFlags(func);
  const t = returnType !== undefined ? unwrapReturnType(c, returnType, functionFlags) : undefined;
  // A return type that includes `void` or is `any` or `undefined` needs no return statements.
  if (
    t !== undefined &&
    (maybeTypeOfKind(t, TypeFlags.Void) || (t.flags & (TypeFlags.Any | TypeFlags.Undefined)) !== 0)
  )
    return;
  // Signatures, expression bodies and bodies that end in a return or throw have nothing to check.
  const body = getBody(func);
  if (
    func.kind === SyntaxKind.MethodSignature ||
    body === undefined ||
    nodeIsMissing(body) ||
    body.kind !== SyntaxKind.Block ||
    !functionHasImplicitReturn(c, func)
  )
    return;
  const hasExplicitReturn = (func.flags & NodeFlags.HasExplicitReturn) !== 0;
  const errorNode = getType(func) ?? getFullSignatureTypeNode(func) ?? func;
  if (t !== undefined && (t.flags & TypeFlags.Never) !== 0)
    c.error(errorNode, Diagnostics.A_function_returning_never_cannot_have_a_reachable_end_point);
  else if (t !== undefined && !hasExplicitReturn)
    c.error(
      errorNode,
      Diagnostics.A_function_whose_declared_type_is_neither_undefined_void_nor_any_must_return_a_value,
    );
  else if (t !== undefined && c.strictNullChecks && !isTypeAssignableTo(c, c.undefinedType, t))
    c.error(errorNode, Diagnostics.Function_lacks_ending_return_statement_and_return_type_does_not_include_undefined);
  else if (c.compilerOptions.noImplicitReturns === true) {
    if (t === undefined) {
      // Without an annotation, only functions that return values other than void or any are checked.
      if (!hasExplicitReturn) return;
      const inferredReturnType = getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, func));
      if (isUnwrappedReturnTypeUndefinedVoidOrAny(c, func, inferredReturnType)) return;
    }
    c.error(errorNode, Diagnostics.Not_all_code_paths_return_a_value);
  }
}

export function isUnwrappedReturnTypeUndefinedVoidOrAny(c: Checker, func: Node, returnType: Type): boolean {
  const t = unwrapReturnType(c, returnType, getFunctionFlags(func));
  return maybeTypeOfKind(t, TypeFlags.Void) || (t.flags & (TypeFlags.Any | TypeFlags.Undefined)) !== 0;
}

function functionHasImplicitReturn(c: Checker, func: Node): boolean {
  const endFlowNode = getEndFlowNode(func);
  return endFlowNode !== undefined && isReachableFlowNode(c, endFlowNode);
}

/**
 * Checks a returned expression against the unwrapped return type; `node` is the return statement,
 * or the expression body of an arrow function. Conditional expressions are checked by branch.
 */
export function checkReturnExpression(
  c: Checker,
  container: Node,
  unwrappedReturnType: Type,
  node: Node,
  expr: Node | undefined,
  exprType: Type,
  inConditionalExpression: boolean,
): void {
  const functionFlags = getFunctionFlags(container);
  if (expr !== undefined) {
    const unwrappedExpr = skipParentheses(expr);
    if (unwrappedExpr.kind === SyntaxKind.ConditionalExpression) {
      const conditional = unwrappedExpr as ConditionalExpression;
      const whenTrue = conditional.whenTrue;
      const whenFalse = conditional.whenFalse;
      checkReturnExpression(c, container, unwrappedReturnType, node, whenTrue, checkExpression(c, whenTrue), true);
      checkReturnExpression(c, container, unwrappedReturnType, node, whenFalse, checkExpression(c, whenFalse), true);
      return;
    }
  }
  const inReturnStatement = node.kind === SyntaxKind.ReturnStatement;
  const unwrappedExprType =
    (functionFlags & FunctionFlags.Async) !== 0
      ? checkAwaitedType(
          c,
          exprType,
          false,
          node,
          Diagnostics.The_return_type_of_an_async_function_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
        )
      : exprType;
  const effectiveExpr = expr !== undefined ? getEffectiveCheckNode(expr) : undefined;
  const errorNode = inReturnStatement && !inConditionalExpression ? node : (effectiveExpr ?? node);
  checkTypeAssignableToAndOptionallyElaborate(c, unwrappedExprType, unwrappedReturnType, errorNode, effectiveExpr);
}

/** `node` without parentheses and `satisfies`. */

export function checkAwaitExpression(c: Checker, node: Node): Type {
  checkGrammarAwaitExpression(c, node);
  const operandType = checkExpression(c, getExpression(node)!);
  const awaitedType = checkAwaitedType(
    c,
    operandType,
    true,
    node,
    Diagnostics.Type_of_await_operand_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
  );
  if (awaitedType === operandType && !isErrorType(c, awaitedType) && (operandType.flags & TypeFlags.AnyOrUnknown) === 0)
    c.addSuggestion(
      createDiagnosticForNode(node, Diagnostics.X_await_has_no_effect_on_the_type_of_this_expression, []),
    );
  return awaitedType;
}

// ---- Generators

export function checkYieldExpression(c: Checker, node: Node): Type {
  checkGrammarYieldOfExpression(c, node);
  const yieldExpr = node as YieldExpression;
  // The operand is checked also outside a generator.
  const operand = yieldExpr.expression;
  const yieldExpressionType = operand !== undefined ? checkExpression(c, operand) : c.undefinedWideningType;
  const func = getContainingFunctionLike(node);
  if (func === undefined) return c.anyType;
  const functionFlags = getFunctionFlags(func);
  // Outside a generator `yield` is a syntax error.
  if ((functionFlags & FunctionFlags.Generator) === 0) return c.anyType;
  const isAsync = (functionFlags & FunctionFlags.Async) !== 0;
  // `yield*` in an async generator before ES2018 uses __await, __asyncDelegator and __asyncValues.
  if (yieldExpr.asteriskToken !== undefined && isAsync && c.languageVersion < ScriptTarget.ES2018)
    checkExternalEmitHelpers(c, node, ExternalEmitHelpers.AsyncDelegatorIncludes);
  // Without an annotation the return type is computed from the yields, so there's nothing to check.
  let returnType = getReturnTypeFromAnnotation(c, func);
  if (returnType !== undefined && (returnType.flags & TypeFlags.Union) !== 0)
    returnType = filterType(c, returnType, (t) =>
      checkGeneratorInstantiationAssignabilityToReturnType(c, t, functionFlags, undefined),
    );
  const iterationTypes =
    returnType !== undefined ? getIterationTypesOfGeneratorFunctionReturnType(c, returnType, isAsync) : undefined;
  const signatureYieldType = iterationTypes?.yieldType ?? c.anyType;
  const signatureNextType = iterationTypes?.nextType ?? c.anyType;
  const yieldedType = getYieldedTypeOfYieldExpression(c, yieldExpr, yieldExpressionType, signatureNextType, isAsync);
  if (returnType !== undefined && yieldedType !== undefined)
    checkTypeAssignableToAndOptionallyElaborate(c, yieldedType, signatureYieldType, operand ?? node, operand);
  if (yieldExpr.asteriskToken !== undefined)
    return (
      getIterationTypeOfIterable(
        c,
        isAsync ? IterationUse.AsyncYieldStar : IterationUse.YieldStar,
        IterationTypeKind.Return,
        yieldExpressionType,
        operand,
      ) ?? c.anyType
    );
  if (returnType !== undefined)
    return getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Next, returnType, isAsync) ?? c.anyType;
  const t = getContextualIterationType(c, IterationTypeKind.Next, func);
  if (t !== undefined) return t;
  if (c.noImplicitAny && !expressionResultIsUnused(node)) {
    const contextualType = getContextualType(c, node);
    if (contextualType === undefined || (contextualType.flags & TypeFlags.Any) !== 0)
      c.error(
        node,
        Diagnostics.X_yield_expression_implicitly_results_in_an_any_type_because_its_containing_generator_lacks_a_return_type_annotation,
      );
  }
  return c.anyType;
}

/** What a `yield` yields: its operand, or what a `yield*` operand iterates, awaited in async generators. */
function getYieldedTypeOfYieldExpression(
  c: Checker,
  node: YieldExpression,
  expressionType: Type,
  sentType: Type,
  isAsync: boolean,
): Type | undefined {
  let errorNode: Node = node;
  if (node.expression !== undefined) errorNode = node.expression;
  const isYieldStar = node.asteriskToken !== undefined;
  const yieldedType = isYieldStar
    ? checkIteratedTypeOrElementType(
        c,
        isAsync ? IterationUse.AsyncYieldStar : IterationUse.YieldStar,
        expressionType,
        sentType,
        errorNode,
      )
    : expressionType;
  if (!isAsync) return yieldedType;
  return getAwaitedTypeEx(
    c,
    yieldedType,
    errorNode,
    isYieldStar
      ? Diagnostics.Type_of_iterated_elements_of_a_yield_Asterisk_operand_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member
      : Diagnostics.Type_of_yield_operand_in_an_async_generator_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
  );
}

/** Whether the value of `node` is discarded: by an expression statement, `void`, a `for` header or a comma. */
function expressionResultIsUnused(nodeIn: Node): boolean {
  let node = nodeIn;
  for (;;) {
    const parent = node.parent!;
    if (parent.kind === SyntaxKind.ParenthesizedExpression) {
      node = parent;
      continue;
    }
    if (
      parent.kind === SyntaxKind.ExpressionStatement ||
      parent.kind === SyntaxKind.VoidExpression ||
      (parent.kind === SyntaxKind.ForStatement &&
        ((parent as ForStatement).initializer === node || (parent as ForStatement).incrementor === node))
    )
      return true;
    if (
      parent.kind === SyntaxKind.BinaryExpression &&
      (parent as BinaryExpression).operatorToken.kind === SyntaxKind.CommaToken
    ) {
      // The left side of a comma is unused; the right side is when the comma is.
      if (node === (parent as BinaryExpression).left) return true;
      node = parent;
      continue;
    }
    return false;
  }
}

function getContainingFunctionLike(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined && !isFunctionLike(current)) current = current.parent;
  return current;
}

// ---- Context sensitivity

/** Whether checking `node` depends on its contextual type. */
export function isContextSensitive(c: Checker, node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.FunctionDeclaration:
      return isContextSensitiveFunctionLikeDeclaration(c, node);
    case SyntaxKind.ObjectLiteralExpression:
      for (const p of getProperties(node)!.nodes) if (isContextSensitive(c, p)) return true;
      return false;
    case SyntaxKind.ArrayLiteralExpression:
      for (const e of getElements(node)!.nodes) if (isContextSensitive(c, e)) return true;
      return false;
    case SyntaxKind.ConditionalExpression: {
      const cond = node as ConditionalExpression;
      return isContextSensitive(c, cond.whenTrue) || isContextSensitive(c, cond.whenFalse);
    }
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      const op = binary.operatorToken.kind;
      return (
        (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) &&
        (isContextSensitive(c, binary.left) || isContextSensitive(c, binary.right))
      );
    }
    case SyntaxKind.PropertyAssignment:
      return isContextSensitive(c, getInitializer(node)!);
    case SyntaxKind.ParenthesizedExpression:
      return isContextSensitive(c, getExpression(node)!);
    case SyntaxKind.JsxAttributes:
      return isJsxAttributesContextSensitive(c, node);
    case SyntaxKind.JsxAttribute: {
      // Without an initializer an attribute is `true`.
      const initializer = getInitializer(node);
      return initializer !== undefined && isContextSensitive(c, initializer);
    }
    case SyntaxKind.JsxExpression: {
      const expression = getExpression(node);
      return expression !== undefined && isContextSensitive(c, expression);
    }
  }
  return false;
}

function isContextSensitiveFunctionLikeDeclaration(c: Checker, node: Node): boolean {
  return (
    hasContextSensitiveParameters(node) ||
    hasContextSensitiveReturnExpression(c, node) ||
    hasContextSensitiveYieldExpression(c, node)
  );
}

/**
 * The type predicate a function without a return type annotation implies, as `x is string` for
 * `(x: string | number) => typeof x === "string"`: its single return expression must narrow a parameter
 * to a type in the true branch and to `never` from that type in the false branch.
 */
export function getTypePredicateFromBody(c: Checker, fn: Node): TypePredicate | undefined {
  switch (fn.kind) {
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return undefined;
  }
  if (getFunctionFlags(fn) !== FunctionFlags.Normal) return undefined;
  const body = getBody(fn);
  let singleReturn: Node | undefined = undefined;
  if (body !== undefined && body.kind !== SyntaxKind.Block) singleReturn = body;
  else {
    if (body === undefined) return undefined;
    const collector = new ReturnCollector();
    collector.visitStatements(body as Block);
    if (collector.returns.length !== 1) return undefined;
    singleReturn = collector.returns[0].expression;
    if (singleReturn === undefined || functionHasImplicitReturn(c, fn)) return undefined;
  }
  return checkIfExpressionRefinesAnyParameter(c, fn, singleReturn);
}

function checkIfExpressionRefinesAnyParameter(c: Checker, fn: Node, exprIn: Node): TypePredicate | undefined {
  const expr = skipParentheses(exprIn);
  const returnType = checkExpressionCached(c, expr);
  if ((returnType.flags & TypeFlags.Boolean) === 0) return undefined;
  const parameters = getParameters(fn)!.nodes;
  for (let i = 0; i < parameters.length; i++) {
    const param = parameters[i]!;
    const symbol = getSymbol(param);
    const name = getName(param);
    if (symbol === undefined || name === undefined) continue;
    const initType = getTypeOfSymbol(c, symbol);
    // Refining `x: boolean` to `x is true` or `x is false` isn't useful.
    if (
      (initType.flags & TypeFlags.Boolean) !== 0 ||
      name.kind !== SyntaxKind.Identifier ||
      isSymbolAssigned(c, symbol) ||
      getDotDotDotToken(param) !== undefined
    )
      continue;
    const trueType = checkIfExpressionRefinesParameter(c, fn, expr, name, initType);
    if (trueType !== undefined) return new TypePredicate(TypePredicateKind.Identifier, getText(name), i, trueType);
  }
  return undefined;
}

function checkIfExpressionRefinesParameter(
  c: Checker,
  fn: Node,
  expr: Node,
  name: Node,
  initType: Type,
): Type | undefined {
  let antecedent = getFlowNode(expr);
  if (antecedent === undefined && expr.parent!.kind === SyntaxKind.ReturnStatement)
    antecedent = getFlowNode(expr.parent!);
  if (antecedent === undefined) antecedent = new FlowNode(FlowFlags.Start, undefined, undefined);
  const trueCondition = new FlowNode(FlowFlags.TrueCondition, expr, antecedent);
  const trueType = getFlowTypeOfReferenceAt(c, name, initType, initType, fn, trueCondition);
  if (trueType === initType) return undefined;
  // `x is T` also means x isn't T when the function returns false, so nothing of T may remain there.
  const falseCondition = new FlowNode(FlowFlags.FalseCondition, expr, antecedent);
  const falseSubtype = getReducedType(c, getFlowTypeOfReferenceAt(c, name, initType, trueType, fn, falseCondition));
  return (falseSubtype.flags & TypeFlags.Never) !== 0 ? trueType : undefined;
}

function hasContextSensitiveReturnExpression(c: Checker, node: Node): boolean {
  if (getTypeParameters(node) !== undefined || getType(node) !== undefined) return false;
  const body = getBody(node);
  if (body === undefined) return false;
  if (body.kind !== SyntaxKind.Block) return isContextSensitive(c, body);
  const collector = new ReturnCollector();
  collector.visitStatements(body as Block);
  for (const ret of collector.returns)
    if (ret.expression !== undefined && isContextSensitive(c, ret.expression)) return true;
  return false;
}

function hasContextSensitiveYieldExpression(c: Checker, node: Node): boolean {
  if ((getFunctionFlags(node) & FunctionFlags.Generator) === 0) return false;
  const body = getBody(node);
  if (body === undefined) return false;
  const finder = new YieldFinder(c);
  body.forEachChild(finder);
  return finder.found;
}

/** Finds a context-sensitive `yield` operand, skipping nested functions. */
class YieldFinder extends NodeVisitor {
  readonly c: Checker;
  found = false;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.YieldExpression) {
      const expression = getExpression(node);
      if (expression !== undefined && isContextSensitive(this.c, expression)) {
        this.found = true;
        return true;
      }
    }
    if (isFunctionLikeOrClass(node)) return false;
    return node.forEachChild(this);
  }
}

function isFunctionLikeOrClass(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.Constructor:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return true;
  }
  return false;
}

// ---- Return type inference

/** The return type inferred from a function's body. */
export function getReturnTypeFromBody(c: Checker, func: Node): Type {
  return getReturnTypeFromBodyEx(c, func, CheckMode.Normal);
}

function checkExpressionCachedEx(c: Checker, node: Node, checkMode: CheckMode): Type {
  return checkMode !== CheckMode.Normal ? checkExpressionEx(c, node, checkMode) : checkExpressionCached(c, node);
}

export function getReturnTypeFromBodyEx(c: Checker, func: Node, checkMode: CheckMode): Type {
  checkMode &= ~CheckMode.SkipGenericFunctions;
  const body = getBody(func);
  if (body === undefined) return c.errorType;
  const functionFlags = getFunctionFlags(func);
  const isAsync = (functionFlags & FunctionFlags.Async) !== 0;
  const isGenerator = (functionFlags & FunctionFlags.Generator) !== 0;
  let returnType: Type | undefined;
  let yieldType: Type | undefined;
  let nextType: Type | undefined;
  let fallbackReturnType: Type = c.voidType;
  if (body.kind !== SyntaxKind.Block) {
    returnType = checkExpressionCachedEx(c, body, checkMode);
    if (isConstContext(c, body)) returnType = getRegularTypeOfLiteralType(c, returnType);
    // An async body may return a promise or a value; its awaited type is wrapped in `Promise<T>` below.
    if (isAsync)
      returnType = unwrapAwaitedType(
        c,
        checkAwaitedType(
          c,
          returnType,
          false,
          func,
          Diagnostics.The_return_type_of_an_async_function_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
        ),
      );
  } else if (isGenerator) {
    const returnTypes = checkAndAggregateReturnExpressionTypes(c, func, checkMode);
    if (returnTypes === undefined) fallbackReturnType = c.neverType;
    else if (returnTypes.length !== 0)
      returnType = getUnionTypeEx(c, returnTypes, UnionReduction.Subtype, undefined, undefined);
    const yields = checkAndAggregateYieldOperandTypes(c, func, checkMode);
    if (yields.yieldTypes.length !== 0)
      yieldType = getUnionTypeEx(c, yields.yieldTypes, UnionReduction.Subtype, undefined, undefined);
    if (yields.nextTypes.length !== 0) nextType = getIntersectionType(c, yields.nextTypes);
  } else {
    const types = checkAndAggregateReturnExpressionTypes(c, func, checkMode);
    // An async function returns `Promise<never>`, not `never`.
    if (types === undefined) return isAsync ? createPromiseReturnType(c, func, c.neverType) : c.neverType;
    if (types.length === 0) {
      // `undefined` rather than `void` when the contextual return type includes `undefined`.
      const contextualReturnType = getContextualReturnType(c, func);
      const t =
        contextualReturnType !== undefined &&
        someType(unwrapReturnType(c, contextualReturnType, functionFlags), (u) => (u.flags & TypeFlags.Undefined) !== 0)
          ? c.undefinedType
          : c.voidType;
      return isAsync ? createPromiseReturnType(c, func, t) : t;
    }
    returnType = getUnionTypeEx(c, types, UnionReduction.Subtype, undefined, undefined);
  }
  if (returnType !== undefined || yieldType !== undefined || nextType !== undefined) {
    if (yieldType !== undefined) reportErrorsFromWidening(c, func, yieldType, WideningKind.GeneratorYield);
    if (returnType !== undefined) reportErrorsFromWidening(c, func, returnType, WideningKind.FunctionReturn);
    if (nextType !== undefined) reportErrorsFromWidening(c, func, nextType, WideningKind.GeneratorNext);
    if (
      (returnType !== undefined && isUnitType(returnType)) ||
      (yieldType !== undefined && isUnitType(yieldType)) ||
      (nextType !== undefined && isUnitType(nextType))
    ) {
      const contextualSignature = getContextualSignatureForFunctionLikeDeclaration(c, func);
      let contextualType: Type | undefined;
      if (contextualSignature === undefined) contextualType = undefined;
      else if (contextualSignature === getSignatureFromDeclaration(c, func))
        contextualType = isGenerator ? undefined : returnType;
      else
        contextualType = instantiateContextualType(
          c,
          getReturnTypeOfSignature(c, contextualSignature),
          func,
          ContextFlags.None,
        );
      if (isGenerator) {
        yieldType = getWidenedLiteralLikeTypeForContextualIterationTypeIfNeeded(
          c,
          yieldType,
          contextualType,
          IterationTypeKind.Yield,
          isAsync,
        );
        returnType = getWidenedLiteralLikeTypeForContextualIterationTypeIfNeeded(
          c,
          returnType,
          contextualType,
          IterationTypeKind.Return,
          isAsync,
        );
        nextType = getWidenedLiteralLikeTypeForContextualIterationTypeIfNeeded(
          c,
          nextType,
          contextualType,
          IterationTypeKind.Next,
          isAsync,
        );
      } else if (returnType !== undefined && isUnitType(returnType)) {
        const contextualReturnType =
          contextualType !== undefined && isAsync ? getPromisedTypeOfPromise(c, contextualType) : contextualType;
        returnType = getWidenedLiteralLikeTypeForContextualType(c, returnType, contextualReturnType);
      }
    }
    if (yieldType !== undefined) yieldType = getWidenedType(c, yieldType);
    if (returnType !== undefined) returnType = getWidenedType(c, returnType);
    if (nextType !== undefined) nextType = getWidenedType(c, nextType);
  }
  if (isGenerator)
    return createGeneratorType(
      c,
      yieldType ?? c.neverType,
      returnType ?? fallbackReturnType,
      nextType ?? getContextualIterationType(c, IterationTypeKind.Next, func) ?? c.unknownType,
      isAsync,
    );
  // An async function's body returns its awaited type, wrapped in `Promise<T>`.
  return isAsync ? createPromiseType(c, returnType ?? fallbackReturnType) : (returnType ?? fallbackReturnType);
}

/**
 * Whether the widened types inferred for a function report implicit `any`: without a contextual
 * signature, or when the contextual return, yield or next type is generic.
 */
export function shouldReportErrorsFromWideningWithContextualSignature(
  c: Checker,
  declaration: Node,
  wideningKind: WideningKind,
): boolean {
  const signature = getContextualSignatureForFunctionLikeDeclaration(c, declaration);
  if (signature === undefined) return true;
  let returnType = getReturnTypeOfSignature(c, signature);
  const flags = getFunctionFlags(declaration);
  const isAsync = (flags & FunctionFlags.Async) !== 0;
  switch (wideningKind) {
    case WideningKind.FunctionReturn:
      if ((flags & FunctionFlags.Generator) !== 0)
        returnType =
          getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Return, returnType, isAsync) ?? returnType;
      else if (isAsync) returnType = getAwaitedTypeNoAlias(c, returnType) ?? returnType;
      return isGenericType(c, returnType);
    case WideningKind.GeneratorYield: {
      const yieldType = getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Yield, returnType, isAsync);
      return yieldType !== undefined && isGenericType(c, yieldType);
    }
    case WideningKind.GeneratorNext: {
      const nextType = getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Next, returnType, isAsync);
      return nextType !== undefined && isGenericType(c, nextType);
    }
  }
  return false;
}

function getWidenedLiteralLikeTypeForContextualIterationTypeIfNeeded(
  c: Checker,
  t: Type | undefined,
  contextualSignatureReturnType: Type | undefined,
  kind: IterationTypeKind,
  isAsyncGenerator: boolean,
): Type | undefined {
  if (t === undefined || !isUnitType(t)) return t;
  const contextualType =
    contextualSignatureReturnType !== undefined
      ? getIterationTypeOfGeneratorFunctionReturnType(c, kind, contextualSignatureReturnType, isAsyncGenerator)
      : undefined;
  return getWidenedLiteralLikeTypeForContextualType(c, t, contextualType);
}

/** The types of a body's returned expressions, or undefined for a function that never returns. */
function checkAndAggregateReturnExpressionTypes(c: Checker, func: Node, checkMode: CheckMode): Type[] | undefined {
  const isAsync = (getFunctionFlags(func) & FunctionFlags.Async) !== 0;
  const aggregatedTypes: Type[] = [];
  let hasReturnWithNoExpression = functionHasImplicitReturn(c, func);
  let hasReturnOfTypeNever = false;
  const collector = new ReturnCollector();
  collector.visitStatements(getBody(func) as Block);
  for (const ret of collector.returns) {
    let expr = ret.expression;
    if (expr === undefined) {
      hasReturnWithNoExpression = true;
      continue;
    }
    expr = skipParentheses(expr);
    // `return await` unwraps in async functions, and bare calls of the function itself don't contribute.
    if (isAsync && expr.kind === SyntaxKind.AwaitExpression) expr = skipParentheses(getExpression(expr)!);
    if (isRecursiveCall(c, func, expr)) {
      hasReturnOfTypeNever = true;
      continue;
    }
    let t = checkExpressionCachedEx(c, expr, checkMode);
    // An async function's returned promises are awaited; the caller wraps the result in `Promise<T>`.
    if (isAsync)
      t = unwrapAwaitedType(
        c,
        checkAwaitedType(
          c,
          t,
          false,
          func,
          Diagnostics.The_return_type_of_an_async_function_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
        ),
      );
    if ((t.flags & TypeFlags.Never) !== 0) hasReturnOfTypeNever = true;
    if (isConstContext(c, expr)) t = getRegularTypeOfLiteralType(c, t);
    if (!aggregatedTypes.includes(t)) aggregatedTypes.push(t);
  }
  if (aggregatedTypes.length === 0 && !hasReturnWithNoExpression && (hasReturnOfTypeNever || mayReturnNever(func)))
    return undefined;
  if (
    c.strictNullChecks &&
    aggregatedTypes.length !== 0 &&
    hasReturnWithNoExpression &&
    !aggregatedTypes.includes(c.undefinedType)
  )
    aggregatedTypes.push(c.undefinedType);
  return aggregatedTypes;
}

function isRecursiveCall(c: Checker, func: Node, expr: Node): boolean {
  if (expr.kind !== SyntaxKind.CallExpression) return false;
  const callee = getExpression(expr)!;
  if (callee.kind !== SyntaxKind.Identifier) return false;
  const symbol = getSymbol(func);
  if (symbol === undefined || checkExpressionCached(c, callee).symbol !== getMergedSymbol(c, symbol)) return false;
  const valueDeclaration = symbol.valueDeclaration;
  return (
    valueDeclaration === undefined ||
    !isFunctionExpressionOrArrowFunction(valueDeclaration) ||
    isConstantReference(c, callee)
  );
}

function mayReturnNever(func: Node): boolean {
  switch (func.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return true;
    case SyntaxKind.MethodDeclaration:
      return func.parent!.kind === SyntaxKind.ObjectLiteralExpression;
  }
  return false;
}

class YieldOperandTypes {
  readonly yieldTypes: Type[] = [];
  readonly nextTypes: Type[] = [];
}

function checkAndAggregateYieldOperandTypes(c: Checker, func: Node, checkMode: CheckMode): YieldOperandTypes {
  const isAsync = (getFunctionFlags(func) & FunctionFlags.Async) !== 0;
  const result = new YieldOperandTypes();
  const collector = new YieldCollector();
  collector.visit(getBody(func)!);
  for (const yieldExpr of collector.yields) {
    const operand = yieldExpr.expression;
    let yieldExprType = operand !== undefined ? checkExpressionEx(c, operand, checkMode) : c.undefinedWideningType;
    if (operand !== undefined && isConstContext(c, operand))
      yieldExprType = getRegularTypeOfLiteralType(c, yieldExprType);
    const yieldedType = getYieldedTypeOfYieldExpression(c, yieldExpr, yieldExprType, c.anyType, isAsync);
    if (yieldedType !== undefined && !result.yieldTypes.includes(yieldedType)) result.yieldTypes.push(yieldedType);
    const nextType =
      yieldExpr.asteriskToken !== undefined
        ? getIterationTypesOfIterable(
            c,
            yieldExprType,
            isAsync ? IterationUse.AsyncYieldStar : IterationUse.YieldStar,
            operand,
          ).nextType
        : getContextualType(c, yieldExpr!);
    if (nextType !== undefined && !result.nextTypes.includes(nextType)) result.nextTypes.push(nextType);
  }
  return result;
}

/**
 * Collects the `yield` expressions of a generator body, skipping nested functions and types. A class's
 * `extends` expression is an expression, not a type.
 */
class YieldCollector extends NodeVisitor {
  readonly yields: YieldExpression[] = [];

  visit(node: Node): void {
    switch (node.kind) {
      case SyntaxKind.YieldExpression: {
        this.yields.push(node as YieldExpression);
        const operand = (node as YieldExpression).expression;
        if (operand !== undefined) this.visit(operand);
        return;
      }
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
        return;
    }
    if (isFunctionLike(node)) {
      // Nested functions are skipped, but not their computed names.
      const name = getName(node);
      if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) this.visit(getExpression(name)!);
      return;
    }
    if (!isPartOfTypeNode(node)) node.forEachChild(this);
  }

  visitNode(node: Node): boolean {
    this.visit(node);
    return false;
  }
}

/** Collects the return statements of a function body, skipping nested functions and classes. */
export class ReturnCollector {
  readonly returns: ReturnStatement[] = [];

  visitStatements(block: Block): void {
    for (const s of block.statements.nodes) this.visit(s);
  }

  visit(node: Node): void {
    switch (node.kind) {
      case SyntaxKind.ReturnStatement:
        this.returns.push(node as ReturnStatement);
        return;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.ModuleDeclaration:
        return;
    }
    if (isStatementContainer(node)) node.forEachChild(new ReturnVisitor(this));
  }
}

function isStatementContainer(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Block:
    case SyntaxKind.IfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.CaseBlock:
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.TryStatement:
    case SyntaxKind.CatchClause:
      return true;
  }
  return false;
}

class ReturnVisitor extends NodeVisitor {
  readonly collector: ReturnCollector;

  constructor(collector: ReturnCollector) {
    super();
    this.collector = collector;
  }

  visitNode(node: Node): boolean {
    this.collector.visit(node);
    return false;
  }
}

function assignParameterType(c: Checker, declaration: Node): void {
  const symbol = getSymbolOfDeclaration(c, declaration);
  if (symbol === undefined) return;
  const id = getSymbolId(symbol);
  if (c.symbolTypes.get(id) !== undefined) return;
  // Without a context, the parameter's own type, reporting its implicit any errors.
  const t = getWidenedTypeForVariableLikeDeclaration(c, declaration, true);
  c.symbolTypes.set(
    id,
    addOptionality(c, t, false, getInitializer(declaration) === undefined && isOptionalDeclaration(declaration)),
  );
  const name = getName(declaration);
  if (
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
  ) {
    // Without a better inference than `unknown`, a binding pattern implies the type.
    if (c.symbolTypes.get(id) === c.unknownType)
      c.symbolTypes.set(id, getTypeFromBindingPattern(c, name, false, false));
    assignBindingElementTypes(c, name, c.symbolTypes.get(id)!);
  }
}

/** Pushes a contextually assigned parameter type into the binding elements of its pattern. */
function assignBindingElementTypes(c: Checker, pattern: Node, parentType: Type): void {
  for (const element of getElements(pattern)!.nodes) {
    if (element.kind !== SyntaxKind.BindingElement) continue;
    const name = getName(element);
    if (name === undefined) continue;
    const t = getBindingElementTypeFromParentType(c, element as BindingElement, parentType, false);
    if (name.kind === SyntaxKind.Identifier) c.symbolTypes.set(getSymbolId(getSymbolOfDeclaration(c, element)!), t);
    else assignBindingElementTypes(c, name, t);
  }
}
