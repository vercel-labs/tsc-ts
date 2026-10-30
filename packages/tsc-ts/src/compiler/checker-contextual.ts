// Contextual typing: the type an expression's position implies, and contextual signatures.
import { resolvedReturnTypeOf } from './side-state.js';
import {
  type ArrayLiteralExpression,
  type BinaryExpression,
  type ConditionalExpression,
  type Node,
  type ParameterDeclaration,
  type PropertyAssignment,
  getInitializer,
  getName,
  getParameters,
  getType,
  getText,
  getSymbol,
  getTypeParameters,
  NodeFlags,
  JsxAttribute,
  JsxElement,
} from './ast.js';
import {
  getImmediatelyInvokedFunctionExpression,
  isFunctionExpressionOrArrowFunction,
  isObjectLiteralMethod,
  isStatic,
} from './binder-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  AccessFlags,
  CheckMode,
  ElementFlags,
  type Signature,
  SignatureKind,
  type Type,
  TypeFlags,
  type TypeMapper,
  type ConditionalType,
  type MappedType,
  ObjectFlags,
  type UnionType,
} from './checker-types.js';
import {
  UnionReduction,
  filterType,
  getIntersectionType,
  getNumberLiteralType,
  getRegularTypeOfLiteralType,
  getUnionType,
  getUnionTypeEx,
  getWidenedLiteralType,
  getEndElementCount,
  getStringLiteralType,
  getTypeArguments,
  getTypeReferenceArity,
  mapType,
  mapTypeEx,
  isTupleType,
  tupleTargetOf,
  typesOf,
} from './checker-type-factory.js';
import {
  combineUnionOrIntersectionMemberSignatures,
  compareTypeParametersIdentical,
  findApplicableIndexInfo,
  getApparentType,
  getBaseConstraintOrType,
  getIndexInfosOfStructuredType,
  getPropertiesOfType,
  getPropertyOfType,
  getReducedType,
  getSignaturesOfType,
} from './checker-members.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { CheckFlags, SymbolFlags, getSymbolId } from './symbol.js';
import {
  TypeSystemPropertyName,
  findResolutionCycleStartIndex,
  getCachedGlobalType,
  getGlobalType,
  getSymbolOfDeclaration,
} from './checker-symbols.js';
import { isImportCall } from './ast-utilities.js';
import { CompositeSignature, Ternary, type TypeReference } from './checker-types.js';
import { ComparerKind, compareSignaturesIdentical } from './relations.js';
import {
  cloneSignature,
  getOrCreateTypeFromSignature,
  getParameterCount,
  getReturnTypeFromAnnotation,
  hasEffectiveRestParameter,
} from './checker-signatures.js';
import {
  MappedTypeNameTypeKind,
  getActualTypeVariable,
  getConstraintTypeFromMappedType,
  getElementTypeOfSliceOfTupleType,
  getFalseTypeFromConditionalType,
  getLiteralTypeFromPropertyName,
  getMappedTypeNameTypeKind,
  getNameTypeFromMappedType,
  getTrueTypeFromConditionalType,
  isGenericMappedType,
  substituteIndexedMappedType,
} from './checker-type-operators.js';
import { getOptionalType, getWidenedType, removeMissingType } from './checker-symbol-types.js';
import { getConstituentTypeForKeyType, getKeyPropertyName } from './checker-narrowing.js';
import {
  type BindingElement,
  type YieldExpression,
  getElements,
  getExpression,
  getNodeId,
  getProperties,
} from './ast.js';
import type { Symbol } from './symbol.js';
import { isDiscriminantProperty, isTypeAssignableTo } from './relations.js';
import {
  getPropertyNameFromType,
  hasDynamicName,
  hasLateBindableName,
  isNumericLiteralName,
  isTypeUsableAsPropertyName,
} from './checker-utilities.js';
import {
  getReturnTypeOfSignature,
  getRestTypeAtPosition,
  getTypeAtPosition,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import {
  checkExpressionCached,
  checkComputedPropertyName,
  getPropertyNameOfObjectLiteralElement,
  getTypeOfExpression,
  isConstTypeReference,
} from './checker-expressions.js';
import { getEffectiveCallArguments, getRestArgumentsType, resolveCallSignatureForContext } from './checker-calls.js';
import {
  checkDeclarationInitializer,
  checkExpression,
  checkExpressionEx,
  isLiteralOfContextualType,
} from './checker-expressions.js';
import {
  type InferenceContext,
  getMapperFromContext,
  someInferenceHasCandidatesOrDefault,
} from './checker-inference.js';
import { instantiateType, isNodeDescendantOf } from './instantiation.js';
import { getIndexedAccessTypeEx } from './checker-type-operators.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getNonNullableType } from './checker-flow.js';
import { maybeTypeOfKind } from './checker-utilities.js';
import { getFunctionFlags, FunctionFlags, indexOfNode } from './checker-utilities.js';
import { getContextualTypeForAssignmentExpression } from './checker-javascript.js';
import { isContextSensitive } from './checker-functions.js';
import {
  IterationTypeKind,
  IterationUse,
  checkGeneratorInstantiationAssignabilityToReturnType,
  createGeneratorType,
  createPromiseLikeType,
  getAwaitedTypeNoAlias,
  getAwaitedTypeOfPromise,
  getIteratedTypeOrElementType,
  getIterationTypeOfGeneratorFunctionReturnType,
  getIterationTypesOfGeneratorFunctionReturnType,
} from './checker-iteration.js';
import { isFunctionLike } from './ast-utilities.js';
import { getTypeFromBindingPattern } from './checker-destructuring.js';
import {
  getContextualJsxElementAttributesType,
  getContextualTypeForJsxAttribute,
  getContextualTypeForJsxExpression,
  getJsxElementChildrenPropertyName,
  getJsxNamespaceAt,
  getSemanticJsxChildren,
} from './checker-jsx.js';
import { getDecoratorCallSignature } from './checker-decorators.js';

export const enum ContextFlags {
  None = 0,
  /** Obtaining a contextual signature. */
  Signature = 1 << 0,
  /** Don't obtain type variable constraints. */
  NoConstraints = 1 << 1,
  Completions = 1 << 2,
  SkipBindingPatterns = 1 << 3,
}

// ---- Contextual type and inference context stacks

export function pushContextualType(c: Checker, node: Node, t: Type | undefined, isCache: boolean): void {
  const caches = c.inferenceCaches;
  const depth = caches.contextualDepth;
  if (depth < caches.contextualNodes.length) {
    caches.contextualNodes[depth] = node;
    caches.contextualTypes[depth] = t;
    caches.contextualIsCache[depth] = isCache;
  } else {
    caches.contextualNodes.push(node);
    caches.contextualTypes.push(t);
    caches.contextualIsCache.push(isCache);
  }
  caches.contextualDepth = depth + 1;
}

/** Caches the contextual type of `node` for the contextual types of its elements. */
export function pushCachedContextualType(c: Checker, node: Node): void {
  pushContextualType(c, node, getContextualTypeEx(c, node, ContextFlags.None), true);
}

export function popContextualType(c: Checker): void {
  c.inferenceCaches.contextualDepth--;
}

/** The index of the contextual type pushed onto `node`, or -1. */
export function findContextualNode(c: Checker, node: Node, includeCaches: boolean): number {
  const caches = c.inferenceCaches;
  const nodes = caches.contextualNodes;
  const depth = caches.contextualDepth;
  for (let i = 0; i < depth; i++) if (nodes[i]! === node && (includeCaches || !caches.contextualIsCache[i])) return i;
  return -1;
}

export function pushInferenceContext(c: Checker, node: Node, context: InferenceContext | undefined): void {
  const caches = c.inferenceCaches;
  const depth = caches.inferenceDepth;
  if (depth < caches.inferenceNodes.length) {
    caches.inferenceNodes[depth] = node;
    caches.inferenceContexts[depth] = context;
  } else {
    caches.inferenceNodes.push(node);
    caches.inferenceContexts.push(context);
  }
  caches.inferenceDepth = depth + 1;
}

export function popInferenceContext(c: Checker): void {
  const caches = c.inferenceCaches;
  const depth = caches.inferenceDepth - 1;
  // The context is released when popped; the node slot stays until it is reused.
  caches.inferenceContexts[depth] = undefined;
  caches.inferenceDepth = depth;
}

/** The inference context of the innermost call argument containing `node`. */
export function getInferenceContext(c: Checker, node: Node): InferenceContext | undefined {
  const caches = c.inferenceCaches;
  for (let i = caches.inferenceDepth - 1; i >= 0; i--)
    if (isNodeDescendantOf(node, caches.inferenceNodes[i]!)) return caches.inferenceContexts[i];
  return undefined;
}

/** The node a contextual type for `node` is pushed onto: an element for its attributes, which spans its children. */
function getContextNode(node: Node): Node {
  if (node.kind === SyntaxKind.JsxAttributes && node.parent!.kind !== SyntaxKind.JsxSelfClosingElement)
    return node.parent!.parent!;
  return node;
}

/** Checks `node` with `contextualType` as its contextual type, inferring into `inferenceContext`. */
export function checkExpressionWithContextualType(
  c: Checker,
  node: Node,
  contextualType: Type,
  inferenceContext: InferenceContext | undefined,
  checkMode: CheckMode,
): Type {
  const contextNode = getContextNode(node);
  pushContextualType(c, contextNode, contextualType, false);
  pushInferenceContext(c, contextNode, inferenceContext);
  let t = checkExpressionEx(
    c,
    node,
    checkMode | CheckMode.Contextual | (inferenceContext !== undefined ? CheckMode.Inferential : 0),
  );
  // Intra-expression inference sites only matter during this check.
  if (inferenceContext !== undefined) inferenceContext.intraExpressionInferenceSites = undefined;
  // Contextually typed literals keep their literal types rather than widening during inference.
  if (
    maybeTypeOfKind(t, TypeFlags.Literal) &&
    isLiteralOfContextualType(c, t, instantiateContextualType(c, contextualType, node, ContextFlags.None))
  )
    t = getRegularTypeOfLiteralType(c, t);
  popInferenceContext(c);
  popContextualType(c);
  return t;
}

/** `contextualType` instantiated with the inferences made so far for an enclosing call. */
export function instantiateContextualType(
  c: Checker,
  contextualType: Type | undefined,
  node: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  if (contextualType === undefined || !maybeTypeOfKind(contextualType, TypeFlags.Instantiable)) return contextualType;
  const inferenceContext = getInferenceContext(c, node);
  // Without inferences or defaults, instantiation would only substitute constraints.
  if (inferenceContext === undefined) return contextualType;
  if (
    (contextFlags & ContextFlags.Signature) !== 0 &&
    someInferenceHasCandidatesOrDefault(inferenceContext.inferences)
  ) {
    // Contextual signatures use all inferences so far, from return types and earlier arguments.
    const t = instantiateInstantiableTypes(c, contextualType, inferenceContext.nonFixingMapper);
    if ((t.flags & TypeFlags.AnyOrUnknown) === 0) return t;
  }
  const returnMapper = inferenceContext.returnMapper;
  if (returnMapper !== undefined) {
    // Otherwise only return type inferences apply, without `boolean` so that contextually typed
    // boolean literals widen.
    const t = instantiateInstantiableTypes(c, contextualType, returnMapper);
    if ((t.flags & TypeFlags.AnyOrUnknown) === 0) {
      if (
        (t.flags & TypeFlags.Union) !== 0 &&
        typesOf(t).includes(c.regularFalseType) &&
        typesOf(t).includes(c.regularTrueType)
      )
        return filterType(c, t, (u) => u !== c.regularFalseType && u !== c.regularTrueType);
      return t;
    }
  }
  return contextualType;
}

/** Like instantiateType, but only for instantiable types and without reducing unions. */
function instantiateInstantiableTypes(c: Checker, t: Type, mapper: TypeMapper): Type {
  if ((t.flags & TypeFlags.Instantiable) !== 0) return instantiateType(c, t, mapper);
  if ((t.flags & TypeFlags.UnionOrIntersection) === 0) return t;
  const types: Type[] = [];
  for (const u of typesOf(t)) types.push(instantiateInstantiableTypes(c, u, mapper));
  return (t.flags & TypeFlags.Union) !== 0
    ? getUnionTypeEx(c, types, UnionReduction.None, undefined, undefined)
    : getIntersectionType(c, types);
}

/** The type implied by `node`'s position, if any. */
export function getContextualType(c: Checker, node: Node): Type | undefined {
  return getContextualTypeEx(c, node, ContextFlags.None);
}

export function getContextualTypeEx(c: Checker, node: Node, contextFlags: ContextFlags): Type | undefined {
  // Cached contextual types were obtained without flags.
  const index = findContextualNode(c, node, contextFlags === ContextFlags.None);
  if (index >= 0) return c.inferenceCaches.contextualTypes[index];
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.BindingElement:
      if (getInitializer(parent) !== node) return undefined;
      return getContextualTypeForInitializerExpression(c, parent, contextFlags);
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ReturnStatement:
      return getContextualTypeForReturnExpression(c, node);
    case SyntaxKind.YieldExpression:
      return getContextualTypeForYieldOperand(c, parent, contextFlags);
    case SyntaxKind.AwaitExpression:
      return getContextualTypeForAwaitOperand(c, parent, contextFlags);
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
      return getContextualTypeForArgument(c, parent, node);
    case SyntaxKind.Decorator: {
      // A decorator expression is contextually typed by the call the runtime makes.
      const signature = getDecoratorCallSignature(c, parent);
      return signature !== undefined ? getOrCreateTypeFromSignature(c, signature) : undefined;
    }
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression: {
      const typeNode = getType(parent)!;
      return isConstTypeReference(typeNode)
        ? getContextualTypeEx(c, parent, contextFlags)
        : getTypeFromTypeNode(c, typeNode);
    }
    case SyntaxKind.SatisfiesExpression:
      return getTypeFromTypeNode(c, getType(parent)!);
    case SyntaxKind.ExportAssignment: {
      // A JSDoc `@type` on `export default`.
      const typeNode = getType(parent);
      return typeNode !== undefined ? getTypeFromTypeNode(c, typeNode) : undefined;
    }
    case SyntaxKind.BinaryExpression:
      return getContextualTypeForBinaryOperand(c, parent as BinaryExpression, node, contextFlags);
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
      // The property's name gets the property's contextual type too.
      return getContextualTypeForObjectLiteralElement(c, parent, contextFlags);
    case SyntaxKind.ObjectLiteralExpression:
      return node.kind === SyntaxKind.MethodDeclaration
        ? getContextualTypeForObjectLiteralElement(c, node, contextFlags)
        : undefined;
    case SyntaxKind.SpreadAssignment:
      return getContextualTypeEx(c, parent.parent!, contextFlags);
    case SyntaxKind.ArrayLiteralExpression: {
      const elements = (parent as ArrayLiteralExpression).elements.nodes;
      const index = indexOfNode(elements, node);
      if (index < 0) return undefined;
      const spreads = getSpreadIndices(c, parent, elements);
      return getContextualTypeForElementExpression(
        c,
        getApparentTypeOfContextualTypeEx(c, parent, contextFlags),
        index,
        elements.length,
        spreads.first,
        spreads.last,
      );
    }
    case SyntaxKind.ConditionalExpression: {
      const cond = parent as ConditionalExpression;
      return node === cond.whenTrue || node === cond.whenFalse
        ? getContextualTypeEx(c, parent, contextFlags)
        : undefined;
    }
    case SyntaxKind.TemplateSpan: {
      const template = parent.parent!;
      return template.parent !== undefined && template.parent.kind === SyntaxKind.TaggedTemplateExpression
        ? getContextualTypeForArgument(c, template.parent, node)
        : undefined;
    }
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
      return getContextualTypeEx(c, parent, contextFlags);
    case SyntaxKind.JsxExpression:
      return getContextualTypeForJsxExpression(c, parent, contextFlags);
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxSpreadAttribute:
      return getContextualTypeForJsxAttribute(c, parent, contextFlags);
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
      return getContextualJsxElementAttributesType(c, parent, contextFlags);
  }
  return undefined;
}

function getContextualTypeForInitializerExpression(
  c: Checker,
  declaration: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  const result = getContextualTypeForInitializer(c, declaration, contextFlags);
  if (result !== undefined) return result;
  // A binding pattern implies a type, such as a tuple for an array pattern.
  const name = getName(declaration);
  if (
    (contextFlags & ContextFlags.SkipBindingPatterns) === 0 &&
    name !== undefined &&
    (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern) &&
    getElements(name)!.nodes.length > 0
  )
    return getTypeFromBindingPattern(c, name, true, false);
  return undefined;
}

function getContextualTypeForInitializer(c: Checker, declaration: Node, contextFlags: ContextFlags): Type | undefined {
  const typeNode = getType(declaration);
  if (typeNode !== undefined) return getTypeFromTypeNode(c, typeNode);
  if (declaration.kind === SyntaxKind.Parameter) return getContextuallyTypedParameterTypeOrUndefined(c, declaration);
  if (declaration.kind === SyntaxKind.BindingElement) return getContextualTypeForBindingElement(c, declaration);
  // A static property of a class expression takes the type of the same property of the class's contextual type.
  if (
    declaration.kind === SyntaxKind.PropertyDeclaration &&
    isStatic(declaration) &&
    declaration.parent!.kind === SyntaxKind.ClassExpression
  ) {
    const parentType = getContextualTypeEx(c, declaration.parent!, contextFlags);
    const symbol = getSymbolOfDeclaration(c, declaration);
    // The class's own type might still be in progress, so contextually typing by it would report a spurious circularity.
    if (
      parentType !== undefined &&
      symbol !== undefined &&
      parentType.symbol !== getSymbolOfDeclaration(c, declaration.parent!)
    )
      return getTypeOfPropertyOfContextualType(c, parentType, symbol.name);
  }
  return undefined;
}

/** The type of the property or element a binding element destructures from its parent's contextual type. */
function getContextualTypeForBindingElement(c: Checker, declaration: Node): Type | undefined {
  const element = declaration as BindingElement;
  const name = element.propertyName ?? element.name;
  if (
    name === undefined ||
    name.kind === SyntaxKind.ObjectBindingPattern ||
    name.kind === SyntaxKind.ArrayBindingPattern ||
    (name.kind === SyntaxKind.ComputedPropertyName && !isLiteralComputedName(name))
  )
    return undefined;
  const parent = declaration.parent!.parent!;
  let parentType = getContextualTypeForInitializer(c, parent, ContextFlags.None);
  if (parentType === undefined && parent.kind !== SyntaxKind.BindingElement && getInitializer(parent) !== undefined)
    parentType = checkDeclarationInitializer(
      c,
      parent,
      element.dotDotDotToken !== undefined ? CheckMode.RestBindingElement : CheckMode.Normal,
    );
  if (parentType === undefined) return undefined;
  const parentName = getName(parent)!;
  if (parentName.kind === SyntaxKind.ArrayBindingPattern) {
    const index = getElements(parentName)!.nodes.indexOf(declaration);
    if (index < 0) return undefined;
    return getContextualTypeForElementExpression(c, parentType, index, -1, -1, -1);
  }
  const nameType = getLiteralTypeFromPropertyName(c, name);
  if (nameType === undefined || !isTypeUsableAsPropertyName(nameType)) return undefined;
  const prop = getPropertyOfType(c, parentType, getPropertyNameFromType(nameType));
  return prop !== undefined ? getTypeOfSymbol(c, prop) : undefined;
}

function isLiteralComputedName(name: Node): boolean {
  const expression = getExpression(name)!;
  return expression.kind === SyntaxKind.StringLiteral || expression.kind === SyntaxKind.NumericLiteral;
}

function getContainingFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined && !isFunctionLike(current)) current = current.parent;
  return current;
}

function getContextualTypeForReturnExpression(c: Checker, node: Node): Type | undefined {
  const func = getContainingFunction(node);
  if (func === undefined) return undefined;
  let contextualReturnType = getContextualReturnType(c, func);
  if (contextualReturnType === undefined) return undefined;
  const functionFlags = getFunctionFlags(func);
  const isAsync = (functionFlags & FunctionFlags.Async) !== 0;
  if ((functionFlags & FunctionFlags.Generator) !== 0) {
    if ((contextualReturnType.flags & TypeFlags.Union) !== 0)
      contextualReturnType = filterType(
        c,
        contextualReturnType,
        (t) => getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Return, t, isAsync) !== undefined,
      );
    const iterationReturnType = getIterationTypeOfGeneratorFunctionReturnType(
      c,
      IterationTypeKind.Return,
      contextualReturnType,
      isAsync,
    );
    if (iterationReturnType === undefined) return undefined;
    // Async generators also unwrap the promise below.
    contextualReturnType = iterationReturnType;
  }
  if (isAsync) {
    // The awaited type without the `Awaited<T>` alias.
    const contextualAwaitedType = mapType(c, contextualReturnType, (t) => getAwaitedTypeNoAlias(c, t));
    return getUnionType(c, [contextualAwaitedType, createPromiseLikeType(c, contextualAwaitedType)]);
  }
  return contextualReturnType;
}

function getContextualTypeForYieldOperand(c: Checker, node: Node, contextFlags: ContextFlags): Type | undefined {
  const func = getContainingFunction(node);
  if (func === undefined) return undefined;
  const functionFlags = getFunctionFlags(func);
  let contextualReturnType = getContextualReturnType(c, func);
  if (contextualReturnType === undefined) return undefined;
  const isAsyncGenerator = (functionFlags & FunctionFlags.Async) !== 0;
  const isYieldStar = (node as YieldExpression).asteriskToken !== undefined;
  if (!isYieldStar && (contextualReturnType.flags & TypeFlags.Union) !== 0)
    contextualReturnType = filterType(
      c,
      contextualReturnType,
      (t) =>
        getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Return, t, isAsyncGenerator) !== undefined,
    );
  if (isYieldStar) {
    const iterationTypes = getIterationTypesOfGeneratorFunctionReturnType(c, contextualReturnType, isAsyncGenerator);
    const yieldType = iterationTypes.yieldType ?? c.silentNeverType;
    const returnType = getContextualTypeEx(c, node, contextFlags) ?? c.silentNeverType;
    const nextType = iterationTypes.nextType ?? c.unknownType;
    const generatorType = createGeneratorType(c, yieldType, returnType, nextType, false);
    if (!isAsyncGenerator) return generatorType;
    return getUnionType(c, [generatorType, createGeneratorType(c, yieldType, returnType, nextType, true)]);
  }
  return getIterationTypeOfGeneratorFunctionReturnType(
    c,
    IterationTypeKind.Yield,
    contextualReturnType,
    isAsyncGenerator,
  );
}

function getContextualTypeForAwaitOperand(c: Checker, node: Node, contextFlags: ContextFlags): Type | undefined {
  const contextualType = getContextualTypeEx(c, node, contextFlags);
  if (contextualType === undefined) return undefined;
  const contextualAwaitedType = getAwaitedTypeNoAlias(c, contextualType);
  if (contextualAwaitedType === undefined) return undefined;
  return getUnionType(c, [contextualAwaitedType, createPromiseLikeType(c, contextualAwaitedType)]);
}

/** The iteration type of `kind` a generator's contextual return type implies. */
export function getContextualIterationType(c: Checker, kind: IterationTypeKind, func: Node): Type | undefined {
  const contextualReturnType = getContextualReturnType(c, func);
  if (contextualReturnType === undefined) return undefined;
  return getIterationTypeOfGeneratorFunctionReturnType(
    c,
    kind,
    contextualReturnType,
    (getFunctionFlags(func) & FunctionFlags.Async) !== 0,
  );
}

/** The return type a function's annotation or contextual signature implies. */
export function getContextualReturnType(c: Checker, func: Node): Type | undefined {
  // A return type annotation, a constructor's class, a getter's annotated setter or a JSDoc `@type`.
  const annotated = getReturnTypeFromAnnotation(c, func);
  if (annotated !== undefined) return annotated;
  const signature = getContextualSignatureForFunctionLikeDeclaration(c, func);
  if (signature !== undefined && !isResolvingReturnTypeOfSignature(c, signature)) {
    const returnType = getReturnTypeOfSignature(c, signature);
    const functionFlags = getFunctionFlags(func);
    if ((functionFlags & FunctionFlags.Generator) !== 0)
      return filterType(
        c,
        returnType,
        (t) =>
          (t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void | TypeFlags.InstantiableNonPrimitive)) !== 0 ||
          checkGeneratorInstantiationAssignabilityToReturnType(c, t, functionFlags, undefined),
      );
    if ((functionFlags & FunctionFlags.Async) !== 0)
      return filterType(
        c,
        returnType,
        (t) =>
          (t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Void | TypeFlags.InstantiableNonPrimitive)) !== 0 ||
          getAwaitedTypeOfPromise(c, t) !== undefined,
      );
    return returnType;
  }
  const iife = getImmediatelyInvokedFunctionExpression(func);
  return iife !== undefined ? getContextualType(c, iife) : undefined;
}

function isResolvingReturnTypeOfSignature(c: Checker, signature: Signature): boolean {
  const composite = signature.composite;
  if (composite !== undefined)
    for (const s of composite.signatures) if (isResolvingReturnTypeOfSignature(c, s)) return true;
  return (
    resolvedReturnTypeOf(c, signature) === undefined &&
    findResolutionCycleStartIndex(c, signature, TypeSystemPropertyName.ResolvedReturnType) >= 0
  );
}

function getContextualTypeForArgument(c: Checker, call: Node, arg: Node): Type | undefined {
  const index = getEffectiveCallArguments(c, call).indexOf(arg);
  // -1 for the callee.
  if (index < 0) return undefined;
  return getContextualTypeForArgumentAtIndex(c, call, index);
}

export function getContextualTypeForArgumentAtIndex(c: Checker, call: Node, argIndex: number): Type {
  // `import(specifier, options)`.
  if (isImportCall(call))
    return argIndex === 0
      ? c.stringType
      : argIndex === 1
        ? getCachedGlobalType(c, 'ImportCallOptions', 0, false)
        : c.anyType;
  // While resolving the call's signature, arguments get the resolving signature's `any`.
  const signature = resolveCallSignatureForContext(c, call);
  const restIndex = signature.parameters.length - 1;
  if (signature.hasRestParameter() && argIndex >= restIndex)
    return getIndexedAccessTypeEx(
      c,
      getTypeOfSymbol(c, signature.parameters[restIndex]!),
      getNumberLiteralType(c, argIndex - restIndex),
      AccessFlags.Contextual,
      undefined,
      undefined,
    );
  return getTypeAtPosition(c, signature, argIndex);
}

/**
 * The contextual type of element `index` of an array literal of `length` elements (or -1 when
 * unknown) in `t`, given the indices of the literal's first and last spreads (or -1).
 */
export function getContextualTypeForElementExpression(
  c: Checker,
  t: Type | undefined,
  index: number,
  length: number,
  firstSpreadIndex: number,
  lastSpreadIndex: number,
): Type | undefined {
  if (t === undefined) return undefined;
  return mapTypeEx(
    c,
    t,
    (u) => {
      if (isTupleType(u)) {
        const target = tupleTargetOf(u);
        // Before any spread and within the fixed part: the tuple element.
        if ((firstSpreadIndex < 0 || index < firstSpreadIndex) && index < target.fixedLength)
          return removeMissingType(
            c,
            getTypeArguments(c, u)[index]!,
            (target.elementInfos[index]!.flags & ElementFlags.Optional) !== 0,
          );
        // With a known length and the index after all spreads, count from the end.
        const offset = length >= 0 && (lastSpreadIndex < 0 || index > lastSpreadIndex) ? length - index : 0;
        const fixedEndLength =
          offset > 0 && (target.combinedFlags & ElementFlags.Variable) !== 0
            ? getEndElementCount(target, ElementFlags.Fixed)
            : 0;
        if (offset > 0 && offset <= fixedEndLength) return getTypeArguments(c, u)[getTypeReferenceArity(u) - offset]!;
        // Otherwise the union of the possible element types, without subtype reduction.
        const tupleIndex = firstSpreadIndex >= 0 ? Math.min(target.fixedLength, firstSpreadIndex) : target.fixedLength;
        const endSkipCount =
          length >= 0 && lastSpreadIndex >= 0 ? Math.min(fixedEndLength, length - lastSpreadIndex) : fixedEndLength;
        return getElementTypeOfSliceOfTupleType(c, u, tupleIndex, endSkipCount, false, true);
      }
      // A contextual property named by the index, else the iterated or element type.
      if (firstSpreadIndex < 0 || index < firstSpreadIndex) {
        const propType = getTypeOfPropertyOfContextualType(c, u, String(index));
        if (propType !== undefined) return propType;
      }
      return getIteratedTypeOrElementTypeForContext(c, u);
    },
    true,
  );
}

function getIteratedTypeOrElementTypeForContext(c: Checker, t: Type): Type | undefined {
  return getIteratedTypeOrElementType(c, IterationUse.Element, t, c.undefinedType, undefined, false);
}

/** The indices of the first and last spread elements of an array literal, or -1. */
export class SpreadIndices {
  readonly first: number;
  readonly last: number;

  constructor(first: number, last: number) {
    this.first = first;
    this.last = last;
  }
}

function getSpreadIndices(c: Checker, node: Node, elements: Node[]): SpreadIndices {
  const cached = c.spreadIndices.get(node);
  if (cached !== undefined) return cached;
  let first = -1;
  let last = -1;
  for (let i = 0; i < elements.length; i++)
    if (elements[i]!.kind === SyntaxKind.SpreadElement) {
      if (first < 0) first = i;
      last = i;
    }
  const result = new SpreadIndices(first, last);
  c.spreadIndices.set(node, result);
  return result;
}

function getContextualTypeForObjectLiteralElement(
  c: Checker,
  element: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  // A JSDoc `@type` on the property.
  const typeNode = getType(element);
  if (typeNode !== undefined && !isObjectLiteralMethod(element)) return getTypeFromTypeNode(c, typeNode);
  const objectLiteral = element.parent!;
  const t = getApparentTypeOfContextualTypeEx(c, objectLiteral, contextFlags);
  if (t === undefined) return undefined;
  const isDynamic = hasDynamicName(element);
  if (!isDynamic || hasLateBindableName(c, element)) {
    const name = getPropertyNameOfObjectLiteralElement(c, element);
    if (name !== undefined) {
      const symbol = getSymbol(element);
      let nameType = symbol !== undefined ? c.symbolNameTypes.get(getSymbolId(symbol)) : undefined;
      // Late-bound members are named by the type of their computed name, like a unique symbol.
      const nameNode = getName(element)!;
      if (nameType === undefined && nameNode.kind === SyntaxKind.ComputedPropertyName)
        nameType = checkComputedPropertyName(c, nameNode);
      return getTypeOfPropertyOfContextualTypeEx(c, t, name, nameType);
    }
  } else {
    // Other computed names are checked again, uncached.
    const exprType = checkExpression(c, getExpression(getName(element)!)!);
    if (isTypeUsableAsPropertyName(exprType)) {
      const propType = getTypeOfPropertyOfContextualType(c, t, getPropertyNameFromType(exprType));
      if (propType !== undefined) return propType;
    }
  }
  const nameNode = getName(element);
  if (nameNode === undefined) return undefined;
  const nameType = getLiteralTypeFromPropertyName(c, nameNode);
  if (nameType === undefined) return undefined;
  // Avoids getApplicableIndexInfo's potentially expensive intersection reduction.
  return mapTypeEx(
    c,
    t,
    (u) => {
      const info = findApplicableIndexInfo(c, getIndexInfosOfStructuredType(c, u), nameType);
      return info !== undefined ? info.valueType : undefined;
    },
    true,
  );
}

/** The type of property `name` in a contextual type, through unions, intersections, mapped types and index signatures. */
export function getTypeOfPropertyOfContextualType(c: Checker, t: Type, name: string): Type | undefined {
  return getTypeOfPropertyOfContextualTypeEx(c, t, name, undefined);
}

function getTypeOfPropertyOfContextualTypeEx(
  c: Checker,
  t: Type,
  name: string,
  nameType: Type | undefined,
): Type | undefined {
  // Most contextual types are not unions: map them without a closure (as mapTypeEx would).
  if ((t.flags & TypeFlags.Union) === 0)
    return (t.flags & TypeFlags.Never) !== 0 ? t : getTypeOfPropertyOfContextualConstituent(c, t, name, nameType);
  return mapTypeEx(c, t, (u) => getTypeOfPropertyOfContextualConstituent(c, u, name, nameType), true);
}

function getTypeOfPropertyOfContextualConstituent(
  c: Checker,
  u: Type,
  name: string,
  nameType: Type | undefined,
): Type | undefined {
  if ((u.flags & TypeFlags.Intersection) !== 0) {
    let types: Type[] = [];
    let indexInfoCandidates: Type[] = [];
    let ignoreIndexInfos = false;
    for (const constituent of typesOf(u)) {
      if ((constituent.flags & TypeFlags.Object) === 0) continue;
      if (
        isGenericMappedType(c, constituent) &&
        getMappedTypeNameTypeKind(c, constituent as MappedType) !== MappedTypeNameTypeKind.Remapping
      ) {
        types = appendContextualPropertyTypeConstituent(
          c,
          types,
          getIndexedMappedTypeSubstitutedTypeOfContextualType(c, constituent as MappedType, name, nameType),
        );
        continue;
      }
      const propertyType = getTypeOfConcretePropertyOfContextualType(c, constituent, name);
      if (propertyType === undefined) {
        if (!ignoreIndexInfos) indexInfoCandidates.push(constituent);
        continue;
      }
      ignoreIndexInfos = true;
      indexInfoCandidates = [];
      types = appendContextualPropertyTypeConstituent(c, types, propertyType);
    }
    for (const candidate of indexInfoCandidates)
      types = appendContextualPropertyTypeConstituent(
        c,
        types,
        getTypeFromIndexInfosOfContextualType(c, candidate, name, nameType),
      );
    if (types.length === 0) return undefined;
    return types.length === 1 ? types[0]! : getIntersectionType(c, types);
  }
  if ((u.flags & TypeFlags.Object) === 0) return undefined;
  if (isGenericMappedType(c, u) && getMappedTypeNameTypeKind(c, u as MappedType) !== MappedTypeNameTypeKind.Remapping)
    return getIndexedMappedTypeSubstitutedTypeOfContextualType(c, u as MappedType, name, nameType);
  return (
    getTypeOfConcretePropertyOfContextualType(c, u, name) ?? getTypeFromIndexInfosOfContextualType(c, u, name, nameType)
  );
}

function getIndexedMappedTypeSubstitutedTypeOfContextualType(
  c: Checker,
  t: MappedType,
  name: string,
  nameType: Type | undefined,
): Type | undefined {
  const propertyNameType = nameType ?? getStringLiteralType(c, name);
  const constraint = getConstraintTypeFromMappedType(c, t);
  // Conditional types pretending to be negated types.
  const mappedNameType = getNameTypeFromMappedType(c, t);
  if (
    (mappedNameType !== undefined && isExcludedMappedPropertyName(c, mappedNameType, propertyNameType)) ||
    isExcludedMappedPropertyName(c, constraint, propertyNameType)
  )
    return undefined;
  if (!isTypeAssignableTo(c, propertyNameType, getBaseConstraintOrType(c, constraint))) return undefined;
  return substituteIndexedMappedType(c, t, propertyNameType);
}

function isExcludedMappedPropertyName(c: Checker, t: Type, propertyNameType: Type): boolean {
  if ((t.flags & TypeFlags.Conditional) !== 0) {
    const conditional = t as ConditionalType;
    return (
      (getReducedType(c, getTrueTypeFromConditionalType(c, conditional)).flags & TypeFlags.Never) !== 0 &&
      getActualTypeVariable(c, getFalseTypeFromConditionalType(c, conditional)) ===
        getActualTypeVariable(c, conditional.checkType) &&
      isTypeAssignableTo(c, propertyNameType, conditional.extendsType)
    );
  }
  if ((t.flags & TypeFlags.Intersection) !== 0)
    for (const u of typesOf(t)) if (isExcludedMappedPropertyName(c, u, propertyNameType)) return true;
  return false;
}

function getTypeOfConcretePropertyOfContextualType(c: Checker, t: Type, name: string): Type | undefined {
  const prop = getPropertyOfType(c, t, name);
  if (prop === undefined || isCircularMappedProperty(c, prop)) return undefined;
  return removeMissingType(c, getTypeOfSymbol(c, prop), (prop.flags & SymbolFlags.Optional) !== 0);
}

/** Whether the type of a mapped type property is being resolved. */
function isCircularMappedProperty(c: Checker, symbol: Symbol): boolean {
  return (
    (symbol.checkFlags & CheckFlags.Mapped) !== 0 &&
    c.symbolTypes.get(getSymbolId(symbol)) === undefined &&
    findResolutionCycleStartIndex(c, symbol, TypeSystemPropertyName.Type) >= 0
  );
}

function getTypeFromIndexInfosOfContextualType(
  c: Checker,
  t: Type,
  name: string,
  nameType: Type | undefined,
): Type | undefined {
  if (isTupleType(t) && isNumericLiteralName(name) && Number(name) >= 0) {
    const restType = getElementTypeOfSliceOfTupleType(c, t, tupleTargetOf(t).fixedLength, 0, false, true);
    if (restType !== undefined) return restType;
  }
  const info = findApplicableIndexInfo(
    c,
    getIndexInfosOfStructuredType(c, t),
    nameType ?? getStringLiteralType(c, name),
  );
  return info !== undefined ? info.valueType : undefined;
}

/** `any` gives no contextual information and would spoil other constituents, so it becomes `unknown`. */
function appendContextualPropertyTypeConstituent(c: Checker, types: Type[], t: Type | undefined): Type[] {
  if (t === undefined) return types;
  types.push((t.flags & TypeFlags.Any) !== 0 ? c.unknownType : t);
  return types;
}

function getContextualTypeForBinaryOperand(
  c: Checker,
  binary: BinaryExpression,
  node: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  // A JSDoc type on a JavaScript assignment.
  if (binary.type !== undefined) return getTypeFromTypeNode(c, binary.type);
  const op = binary.operatorToken.kind;
  switch (op) {
    case SyntaxKind.EqualsToken:
    case SyntaxKind.AmpersandAmpersandEqualsToken:
    case SyntaxKind.BarBarEqualsToken:
    case SyntaxKind.QuestionQuestionEqualsToken:
      if (node !== binary.right) return undefined;
      return getContextualTypeForAssignmentExpression(c, binary);
    case SyntaxKind.BarBarToken:
    case SyntaxKind.QuestionQuestionToken: {
      const t = getContextualTypeEx(c, binary, contextFlags);
      // A contextual type implied by a binding pattern gives way to the left operand's type.
      return node === binary.right && (t === undefined || c.patternForType.has(t))
        ? getTypeOfExpression(c, binary.left)
        : t;
    }
    case SyntaxKind.AmpersandAmpersandToken:
    case SyntaxKind.CommaToken:
      return node === binary.right ? getContextualTypeEx(c, binary, contextFlags) : undefined;
  }
  return undefined;
}

/** The apparent form of `node`'s contextual type. */
export function getApparentTypeOfContextualType(c: Checker, node: Node): Type | undefined {
  return getApparentTypeOfContextualTypeEx(c, node, ContextFlags.None);
}

export function getApparentTypeOfContextualTypeEx(
  c: Checker,
  node: Node,
  contextFlags: ContextFlags,
): Type | undefined {
  const contextualType = isObjectLiteralMethod(node)
    ? getContextualTypeForObjectLiteralElement(c, node, contextFlags)
    : getContextualTypeEx(c, node, contextFlags);
  const t = instantiateContextualType(c, contextualType, node, contextFlags);
  if (t === undefined) return undefined;
  if ((contextFlags & ContextFlags.NoConstraints) !== 0 && (t.flags & TypeFlags.TypeVariable) !== 0) return undefined;
  // Most contextual types are not unions: map them without a closure (as mapTypeEx would).
  const apparentType =
    (t.flags & TypeFlags.Union) === 0
      ? (t.flags & TypeFlags.Never) !== 0 || (t.objectFlags & ObjectFlags.Mapped) !== 0
        ? t
        : getApparentType(c, t)
      : mapTypeEx(c, t, (u) => ((u.objectFlags & ObjectFlags.Mapped) !== 0 ? u : getApparentType(c, u)), true);
  if (apparentType === undefined) return undefined;
  if ((apparentType.flags & TypeFlags.Union) !== 0 && node.kind === SyntaxKind.ObjectLiteralExpression)
    return discriminateContextualTypeByObjectMembers(c, node, apparentType as UnionType);
  if ((apparentType.flags & TypeFlags.Union) !== 0 && node.kind === SyntaxKind.JsxAttributes)
    return discriminateContextualTypeByJSXAttributes(c, node, apparentType as UnionType);
  return apparentType;
}

/** Node ids below this and type ids below `PairTypeIdLimit` pack into one exact number. */
const PairNodeIdLimit = 1 << 29;
const PairTypeIdLimit = 1 << 24;

function getDiscriminatedContextualType(c: Checker, nodeId: number, t: Type): Type | undefined {
  const caches = c.inferenceCaches;
  return nodeId < PairNodeIdLimit && t.id < PairTypeIdLimit
    ? caches.discriminatedContextualTypesById.get(nodeId * PairTypeIdLimit + t.id)
    : caches.discriminatedContextualTypes.get(nodeId + ',' + t.id);
}

function setDiscriminatedContextualType(c: Checker, nodeId: number, t: Type, value: Type): void {
  const caches = c.inferenceCaches;
  if (nodeId < PairNodeIdLimit && t.id < PairTypeIdLimit)
    caches.discriminatedContextualTypesById.set(nodeId * PairTypeIdLimit + t.id, value);
  else caches.discriminatedContextualTypes.set(nodeId + ',' + t.id, value);
}

/** The constituents of a union contextual type an object literal's discriminant members select. */
function discriminateContextualTypeByObjectMembers(c: Checker, node: Node, contextualType: UnionType): Type {
  const nodeId = getNodeId(node);
  const cached = getDiscriminatedContextualType(c, nodeId, contextualType);
  if (cached !== undefined) return cached;
  let discriminated = getMatchingUnionConstituentForObjectLiteral(c, contextualType, node);
  if (discriminated === undefined) {
    const props: Node[] = [];
    for (const p of getProperties(node)!.nodes) {
      const symbol = getSymbol(p);
      if (symbol === undefined) continue;
      if (
        (p.kind === SyntaxKind.PropertyAssignment &&
          isPossiblyDiscriminantValue((p as PropertyAssignment).initializer) &&
          isDiscriminantProperty(c, contextualType, symbol.name)) ||
        (p.kind === SyntaxKind.ShorthandPropertyAssignment && isDiscriminantProperty(c, contextualType, symbol.name))
      )
        props.push(p);
    }
    const nodeSymbol = getSymbol(node);
    const members = getPropertiesOfType(c, contextualType).filter(
      (s) =>
        (s.flags & SymbolFlags.Optional) !== 0 &&
        nodeSymbol !== undefined &&
        (nodeSymbol.members === undefined || !nodeSymbol.members.has(s.name)) &&
        isDiscriminantProperty(c, contextualType, s.name),
    );
    discriminated = discriminateTypeByObjectLiteral(c, contextualType, props, members);
  }
  setDiscriminatedContextualType(c, nodeId, contextualType, discriminated);
  return discriminated;
}

function discriminateContextualTypeByJSXAttributes(c: Checker, node: Node, contextualType: UnionType): Type {
  const nodeId = getNodeId(node);
  const cached = getDiscriminatedContextualType(c, nodeId, contextualType);
  if (cached !== undefined) return cached;
  const childrenPropertyName = getJsxElementChildrenPropertyName(c, getJsxNamespaceAt(c, node));
  const props: Node[] = [];
  for (const p of getProperties(node)!.nodes) {
    const symbol = getSymbol(p);
    if (symbol === undefined || !(p instanceof JsxAttribute)) continue;
    const initializer = p.initializer;
    if (
      (initializer === undefined || isPossiblyDiscriminantValue(initializer)) &&
      isDiscriminantProperty(c, contextualType, symbol.name)
    )
      props.push(p);
  }
  const nodeSymbol = getSymbol(node);
  const element = node.parent!.parent!;
  const members = getPropertiesOfType(c, contextualType).filter((s) => {
    if ((s.flags & SymbolFlags.Optional) === 0 || nodeSymbol === undefined) return false;
    // Children given in the body aren't missing.
    if (
      s.name === childrenPropertyName &&
      element instanceof JsxElement &&
      getSemanticJsxChildren(element.children.nodes).length !== 0
    )
      return false;
    return (
      (nodeSymbol.members === undefined || !nodeSymbol.members.has(s.name)) &&
      isDiscriminantProperty(c, contextualType, s.name)
    );
  });
  const discriminated = discriminateTypeByObjectLiteral(c, contextualType, props, members);
  setDiscriminatedContextualType(c, nodeId, contextualType, discriminated);
  return discriminated;
}

function getMatchingUnionConstituentForObjectLiteral(c: Checker, unionType: UnionType, node: Node): Type | undefined {
  const keyPropertyName = getKeyPropertyName(c, unionType);
  if (keyPropertyName === '') return undefined;
  let propNode: Node | undefined;
  for (const p of getProperties(node)!.nodes) {
    const symbol = getSymbol(p);
    if (
      symbol !== undefined &&
      p.kind === SyntaxKind.PropertyAssignment &&
      symbol.name === keyPropertyName &&
      isPossiblyDiscriminantValue((p as PropertyAssignment).initializer)
    ) {
      propNode = p;
      break;
    }
  }
  if (propNode === undefined) return undefined;
  return getConstituentTypeForKeyType(
    c,
    unionType,
    getContextFreeTypeOfExpression(c, (propNode as PropertyAssignment).initializer),
  );
}

/** Whether `node` may be a discriminant value without depending on its contextual type. */
function isPossiblyDiscriminantValue(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.Identifier:
    case SyntaxKind.UndefinedKeyword:
      return true;
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ParenthesizedExpression:
      return isPossiblyDiscriminantValue(getExpression(node)!);
    case SyntaxKind.JsxExpression: {
      const expression = getExpression(node);
      return expression === undefined || isPossiblyDiscriminantValue(expression);
    }
  }
  return false;
}

/** The type of `node` checked without a contextual type, cached. */
export function getContextFreeTypeOfExpression(c: Checker, node: Node): Type {
  const cache = c.inferenceCaches.contextFreeTypes;
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  pushContextualType(c, node, c.anyType, false);
  const t = checkExpressionEx(c, node, CheckMode.SkipContextSensitive);
  cache.set(node, t);
  popContextualType(c);
  return t;
}

/** Narrows `target` by the discriminant properties `props` and missing optional discriminants `members`. */
/** What a constituent of a union has for a missing optional property: none, or a type `undefined` matches or not. */
const enum MissingPropertyState {
  Unknown = 0,
  Absent = 1,
  Matches = 2,
  Mismatches = 3,
}

function discriminateTypeByObjectLiteral(c: Checker, target: UnionType, props: Node[], members: Symbol[]): Type {
  const types = target.types;
  const include: Ternary[] = [];
  for (const t of types)
    include.push(
      (t.flags & TypeFlags.Primitive) === 0 && (getReducedType(c, t).flags & TypeFlags.Never) === 0
        ? Ternary.True
        : Ternary.False,
    );
  const count = props.length + members.length;
  // Whether `undefined` (a missing property) matches a constituent's property depends only on the
  // union and the name: it is remembered for each constituent, two bits each.
  let missingStates: Map<string, number> | undefined = undefined;
  if (members.length !== 0 && types.length <= 16) {
    missingStates = c.inferenceCaches.missingPropertyStates.get(target);
    if (missingStates === undefined) {
      missingStates = new Map<string, number>();
      c.inferenceCaches.missingPropertyStates.set(target, missingStates);
    }
  }
  for (let n = 0; n < count; n++) {
    // Eliminate non-matching constituents only if some constituent matches.
    let matched = false;
    if (n >= props.length && missingStates !== undefined) {
      const name = members[n - props.length]!.name;
      let states = missingStates.get(name) ?? 0;
      for (let i = 0; i < types.length; i++) {
        if (include[i]! === Ternary.False) continue;
        let state = (states >>> (i * 2)) & 3;
        if (state === MissingPropertyState.Unknown) {
          const targetType = getTypeOfPropertyOrIndexSignatureOfType(c, types[i]!, name);
          state =
            targetType === undefined
              ? MissingPropertyState.Absent
              : discriminantMatches(c, props, n, targetType)
                ? MissingPropertyState.Matches
                : MissingPropertyState.Mismatches;
          states |= state << (i * 2);
        }
        if (state === MissingPropertyState.Matches) matched = true;
        else if (state === MissingPropertyState.Mismatches) include[i] = Ternary.Maybe;
      }
      missingStates.set(name, states);
    } else {
      const name = n < props.length ? getSymbol(props[n]!)!.name : members[n - props.length]!.name;
      for (let i = 0; i < types.length; i++) {
        if (include[i]! === Ternary.False) continue;
        const targetType = getTypeOfPropertyOrIndexSignatureOfType(c, types[i]!, name);
        if (targetType === undefined) continue;
        if (discriminantMatches(c, props, n, targetType)) matched = true;
        else include[i] = Ternary.Maybe;
      }
    }
    for (let i = 0; i < types.length; i++)
      if (include[i]! === Ternary.Maybe) include[i] = matched ? Ternary.False : Ternary.True;
  }
  if (!include.includes(Ternary.False)) return target;
  const filteredTypes: Type[] = [];
  for (let i = 0; i < types.length; i++) if (include[i]! === Ternary.True) filteredTypes.push(types[i]!);
  const filtered = getUnionTypeEx(c, filteredTypes, UnionReduction.None, undefined, undefined);
  return (filtered.flags & TypeFlags.Never) === 0 ? filtered : target;
}

function discriminantMatches(c: Checker, props: Node[], index: number, t: Type): boolean {
  let propType: Type;
  if (index < props.length) {
    const prop = props[index]!;
    if (prop.kind === SyntaxKind.PropertyAssignment)
      propType = getContextFreeTypeOfExpression(c, (prop as PropertyAssignment).initializer);
    else if (prop instanceof JsxAttribute)
      // An attribute without an initializer is `true`.
      propType = prop.initializer !== undefined ? getContextFreeTypeOfExpression(c, prop.initializer) : c.trueType;
    else propType = getContextFreeTypeOfExpression(c, getName(prop)!);
  } else propType = c.undefinedType;
  const sources = (propType.flags & TypeFlags.Union) !== 0 ? typesOf(propType) : [propType];
  for (const s of sources) {
    // A type is assignable to a union it is a constituent of, such as `undefined` to the type of
    // an optional property; most discriminants checked are missing optional properties.
    if ((t.flags & TypeFlags.Union) !== 0 && typesOf(t).includes(s)) return true;
    if (isTypeAssignableTo(c, s, t)) return true;
  }
  return false;
}

function getTypeOfPropertyOrIndexSignatureOfType(c: Checker, t: Type, name: string): Type | undefined {
  const prop = getPropertyOfType(c, t, name);
  if (prop !== undefined) return getTypeOfSymbol(c, prop);
  const info = findApplicableIndexInfo(c, getIndexInfosOfStructuredType(c, t), getStringLiteralType(c, name));
  return info !== undefined ? getOptionalType(c, info.valueType, true) : undefined;
}

/** Whether `node` is a function, arrow or object literal method whose parameters may get types from context. */
export function isContextSensitiveFunctionOrObjectLiteralMethod(c: Checker, func: Node): boolean {
  return (
    (isFunctionExpressionOrArrowFunction(func) || isObjectLiteralMethod(func)) &&
    isContextSensitiveFunctionLikeDeclaration(c, func)
  );
}

export function isContextSensitiveFunctionLikeDeclaration(c: Checker, func: Node): boolean {
  return isContextSensitive(c, func);
}

/** Whether a function has parameters, or an implicit `this`, that take types from context. */
export function hasContextSensitiveParameters(func: Node): boolean {
  // Functions with type parameters are not context sensitive.
  if (getTypeParameters(func) !== undefined) return false;
  const params = getParameters(func)!.nodes;
  for (const p of params) if (getType(p) === undefined) return true;
  if (func.kind !== SyntaxKind.ArrowFunction) {
    // Without an explicit `this` parameter, the implicit one is contextually typed.
    if (params.length === 0 || !isThisParameter(params[0]!)) return (func.flags & NodeFlags.ContainsThis) !== 0;
  }
  return false;
}

/** The contextual signature of a function expression, arrow or object literal method. */
export function getContextualSignatureForFunctionLikeDeclaration(c: Checker, func: Node): Signature | undefined {
  if (!isFunctionExpressionOrArrowFunction(func) && !isObjectLiteralMethod(func)) return undefined;
  return getContextualSignature(c, func);
}

/**
 * The contextual signature of a function: the single call signature of its contextual type, or of
 * each union constituent when they're identical ignoring return types.
 */
export function getContextualSignature(c: Checker, node: Node): Signature | undefined {
  const t = getApparentTypeOfContextualTypeEx(c, node, ContextFlags.Signature);
  if (t === undefined) return undefined;
  if ((t.flags & TypeFlags.Union) === 0) return getContextualCallSignature(c, t, node);
  const signatureList: Signature[] = [];
  for (const current of typesOf(t)) {
    const signature = getContextualCallSignature(c, current, node);
    if (signature === undefined) continue;
    if (
      signatureList.length !== 0 &&
      compareSignaturesIdentical(c, signatureList[0]!, signature, false, true, true, ComparerKind.Identical) ===
        Ternary.False
    )
      return undefined;
    signatureList.push(signature);
  }
  if (signatureList.length === 0) return undefined;
  if (signatureList.length === 1) return signatureList[0]!;
  // The union of the signatures, with the union of their return types.
  const result = cloneSignature(c, signatureList[0]!);
  result.composite = new CompositeSignature(true, signatureList);
  result.target = undefined;
  result.mapper = undefined;
  return result;
}

/** The single call signature of `t` with at least as many parameters as `node`. */
export function getContextualCallSignature(c: Checker, t: Type, node: Node): Signature | undefined {
  const signatures = getSignaturesOfType(c, t, SignatureKind.Call);
  const applicableByArity: Signature[] = [];
  for (const s of signatures) if (!isAritySmaller(c, s, node)) applicableByArity.push(s);
  return applicableByArity.length === 1 ? applicableByArity[0]! : getIntersectedSignatures(c, applicableByArity);
}

/** Signatures with identical type parameters combined into one, under noImplicitAny. */
function getIntersectedSignatures(c: Checker, signatures: Signature[]): Signature | undefined {
  if (!c.noImplicitAny) return undefined;
  let combined: Signature | undefined = undefined;
  for (const sig of signatures) {
    if (combined === undefined || combined === sig) combined = sig;
    else if (compareTypeParametersIdentical(c, combined.typeParameters, sig.typeParameters))
      combined = combineUnionOrIntersectionMemberSignatures(c, combined, sig, false);
    else return undefined;
  }
  return combined;
}

function isAritySmaller(c: Checker, signature: Signature, target: Node): boolean {
  const parameters = getParameters(target)!.nodes;
  let targetParameterCount = 0;
  while (targetParameterCount < parameters.length) {
    const param = parameters[targetParameterCount]! as ParameterDeclaration;
    if (param.initializer !== undefined || param.questionToken !== undefined || param.dotDotDotToken !== undefined)
      break;
    targetParameterCount++;
  }
  if (parameters.length !== 0 && isThisParameter(parameters[0]!)) targetParameterCount--;
  return !hasEffectiveRestParameter(c, signature) && getParameterCount(c, signature) < targetParameterCount;
}

function isThisParameter(node: Node): boolean {
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this';
}

function getContextuallyTypedParameterTypeOrUndefined(c: Checker, parameter: Node): Type | undefined {
  const func = parameter.parent!;
  if (!isContextSensitiveFunctionOrObjectLiteralMethod(c, func)) return undefined;
  const iife = getImmediatelyInvokedFunctionExpression(func);
  if (iife !== undefined) {
    // Parameters of an immediately invoked function take the types of the arguments.
    const args = getEffectiveCallArguments(c, iife);
    const indexOfParameter = getParameters(func)!.nodes.indexOf(parameter);
    if ((parameter as ParameterDeclaration).dotDotDotToken !== undefined)
      return getRestArgumentsType(c, iife, args, indexOfParameter);
    const cached = c.resolvedSignatures.get(iife.id);
    c.resolvedSignatures.set(iife.id, c.anySignature);
    const t =
      indexOfParameter < args.length
        ? getWidenedLiteralType(c, checkExpression(c, args[indexOfParameter]!))
        : getInitializer(parameter) !== undefined
          ? undefined
          : c.undefinedWideningType;
    c.resolvedSignatures.set(iife.id, cached);
    return t;
  }
  const signature = getContextualSignatureForFunctionLikeDeclaration(c, func);
  if (signature === undefined) return undefined;
  const params = getParameters(func)!.nodes;
  let index = params.indexOf(parameter);
  if (params.length > 0) {
    const first = getName(params[0]!);
    if (first !== undefined && first.kind === SyntaxKind.Identifier && getText(first) === 'this') index--;
  }
  if ((parameter as ParameterDeclaration).dotDotDotToken !== undefined && index === params.length - 1)
    return getRestTypeAtPosition(c, signature, index, false);
  return tryGetTypeAtPosition(c, signature, index);
}

/** The type a parameter of a context-sensitive function gets from its contextual signature. */
export function getContextuallyTypedParameterType(c: Checker, parameter: Node): Type | undefined {
  return getContextuallyTypedParameterTypeOrUndefined(c, parameter);
}

/** The contextual type of an intra-expression inference site. */
export function getContextualTypeForInference(c: Checker, node: Node): Type | undefined {
  return node.kind === SyntaxKind.MethodDeclaration
    ? getContextualTypeForObjectLiteralElement(c, node, ContextFlags.NoConstraints)
    : getContextualTypeEx(c, node, ContextFlags.NoConstraints);
}

// ---- `this` in object literals

/**
 * `this` in a method of an object literal: the `T` of a contextual `ThisType<T>` of the literal or
 * an enclosing one, else the literal's contextual type or its own type.
 */
export function getThisTypeOfObjectLiteralMember(c: Checker, literal: Node): Type {
  const contextualType = getApparentTypeOfContextualTypeEx(c, literal, ContextFlags.None);
  const thisType = getThisTypeOfObjectLiteralFromContextualType(c, literal, contextualType);
  if (thisType !== undefined) {
    const mapper = getMapperFromContext(getInferenceContext(c, literal));
    return mapper !== undefined ? instantiateType(c, thisType, mapper) : thisType;
  }
  return getWidenedType(
    c,
    contextualType !== undefined ? getNonNullableType(c, contextualType) : checkExpressionCached(c, literal),
  );
}

function getThisTypeOfObjectLiteralFromContextualType(
  c: Checker,
  containingLiteral: Node,
  contextualType: Type | undefined,
): Type | undefined {
  let literal = containingLiteral;
  let t = contextualType;
  while (t !== undefined) {
    const thisType = getThisTypeFromContextualType(c, t);
    if (thisType !== undefined) return thisType;
    if (literal.parent!.kind !== SyntaxKind.PropertyAssignment) break;
    literal = literal.parent!.parent!;
    t = getApparentTypeOfContextualTypeEx(c, literal, ContextFlags.None);
  }
  return undefined;
}

function getThisTypeFromContextualType(c: Checker, t: Type): Type | undefined {
  return mapTypeEx(
    c,
    t,
    (u) => {
      if ((u.flags & TypeFlags.Intersection) === 0) return getThisTypeArgument(c, u);
      for (const v of typesOf(u)) {
        const typeArgument = getThisTypeArgument(c, v);
        if (typeArgument !== undefined) return typeArgument;
      }
      return undefined;
    },
    false,
  );
}

function getThisTypeArgument(c: Checker, t: Type): Type | undefined {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return undefined;
  const globalThisType = getGlobalType(c, 'ThisType', 1, false);
  return (t as TypeReference).target === globalThisType ? getTypeArguments(c, t)[0]! : undefined;
}
