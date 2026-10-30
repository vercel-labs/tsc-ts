// Signatures: from declarations, their parameters, return types and type predicates, and
// derived instantiations (erased, canonical, base).
import { resolvedReturnTypeOf, signatureSideOf } from './side-state.js';
import { instantiateSignatureInContextOf as instantiateSignatureInContextOfInference } from './checker-inference.js';
import {
  ModifierFlags,
  type Node,
  NodeFlags,
  getBody,
  getInitializer,
  getName,
  getParameters,
  getQuestionToken,
  getType,
  getTypeParameters as getTypeParameterNodes,
  getSymbol,
  type TypePredicateNode,
  getArguments,
  getDotDotDotToken,
  getText,
  ExpressionWithTypeArguments,
} from './ast.js';
import { isFunctionLikeDeclarationKind, isInJSFile, nodeIsMissing } from './ast-utilities.js';
import {
  declarationNameToString,
  getImmediatelyInvokedFunctionExpression,
  getSourceFileOfNode,
  hasSyntacticModifier,
  getNameOfDeclaration,
  getDeclarationOfKind,
} from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  ElementFlags,
  IndexInfo,
  type InterfaceType,
  ObjectFlags,
  Signature,
  SignatureFlags,
  SignatureKind,
  TupleElementInfo,
  type Type,
  TypeFlags,
  type TypeMapper,
  TypePredicate,
  TypePredicateKind,
  type TypeReference,
  ArrayToSingleTypeMapper,
  emptyTypes,
  newTypeMapper,
  TypeParameter,
  UnionOrIntersectionType,
  TypeListCache,
} from './checker-types.js';
import {
  UnionReduction,
  createArrayTypeEx,
  createTupleType,
  createTupleTypeEx,
  getNumberLiteralType,
  getTypeArguments,
  getTypeReferenceArity,
  getUnionOrIntersectionType,
  getUnionTypeEx,
  isArrayType,
  isTupleType,
  newObjectType,
  setStructuredTypeMembers,
  someType,
  tupleTargetOf,
  typeListHash,
} from './checker-type-factory.js';
import {
  getMergedSymbol,
  getSymbolOfDeclaration,
  popTypeResolution,
  pushTypeResolution,
  findResolutionCycleStartIndex,
  resolveName,
  TypeSystemPropertyName,
} from './checker-symbols.js';
import {
  fillMissingTypeArguments,
  getBaseConstructorTypeOfClass,
  getClassLikeDeclarationOfSymbol,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfTypeParameter,
  getExtendsHeritageClauseElement,
  getMinTypeArgumentCount,
  hasBindableName,
} from './checker-declared-types.js';
import { getTypeOfSymbol, addOptionality } from './checker-symbol-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { instantiateSignatureEx, instantiateType, instantiateTypes } from './instantiation.js';
import {
  hasResolvedProperties,
  getIndexInfosOfType,
  getSignaturesOfType,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import {
  getIndexedAccessType,
  getElementTypeOfSliceOfTupleType,
  isTypeAssignableToKind,
} from './checker-type-operators.js';
import { isTypeAssignableTo, type TypeComparer } from './relations.js';
import { getReturnTypeFromBody, getTypePredicateFromBody } from './checker-functions.js';
import { checkComputedPropertyName } from './checker-expressions.js';
import { hasLateBindableIndexSignature } from './checker-utilities.js';
import { declarationCount, getDeclarations, InternalSymbolName, type Symbol, SymbolFlags } from './symbol.js';

// ---- From declarations

/** Signatures of a symbol's function-like declarations, skipping overload implementations. */
export function getSignaturesOfSymbol(c: Checker, symbol: Symbol | undefined): Signature[] {
  if (symbol === undefined) return [];
  const result: Signature[] = [];
  const declarations = getDeclarations(symbol);
  for (let i = 0; i < declarations.length; i++) {
    const decl = declarations[i]!;
    if (!isFunctionLikeNode(decl)) continue;
    // An implementation directly following an overload of the same kind is skipped.
    if (i > 0 && getBody(decl) !== undefined) {
      const previous = declarations[i - 1]!;
      if (
        decl.parent === previous.parent &&
        decl.kind === previous.kind &&
        (decl.pos === previous.end || (previous.flags & NodeFlags.Reparsed) !== 0)
      )
        continue;
    }
    // A JSDoc `@type` tag gives a function its signature, for the sake of optional parameters.
    result.push(getSignatureOfFullSignatureType(c, decl) ?? getSignatureFromDeclaration(c, decl));
  }
  return result;
}

export function isFunctionLikeNode(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
    case SyntaxKind.JSDocSignature:
      return true;
  }
  return false;
}

function isRestParameter(param: Node): boolean {
  return getDotDotDotToken(param) !== undefined;
}

export function isOptionalDeclaration(node: Node): boolean {
  return getQuestionToken(node) !== undefined;
}

function getAnnotatedAccessorThisParameter(accessor: Node): Symbol | undefined {
  const params = getParameters(accessor)!.nodes;
  if (params.length !== (accessor.kind === SyntaxKind.GetAccessor ? 1 : 2)) return undefined;
  const name = getName(params[0]!);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this'
    ? getSymbol(params[0]!)
    : undefined;
}

export function getSignatureFromDeclaration(c: Checker, declaration: Node): Signature {
  const cached = c.resolvedSignatures.get(declaration.id);
  if (cached !== undefined) return cached;
  const parameters: Symbol[] = [];
  let flags = SignatureFlags.None;
  let thisParameter: Symbol | undefined;
  let minArgumentCount = 0;
  const iife = getImmediatelyInvokedFunctionExpression(declaration);
  const params = getParameters(declaration)?.nodes ?? [];
  if (iife === undefined && isUntypedSignatureInJSFile(c, declaration, params))
    flags |= SignatureFlags.IsUntypedSignatureInJSFile;
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    let paramSymbol = getSymbol(param)!;
    const typeNode = getType(param);
    // Parameter properties use the parameter, not the property.
    const name = getName(param);
    if (
      paramSymbol !== undefined &&
      (paramSymbol.flags & SymbolFlags.Property) !== 0 &&
      name !== undefined &&
      name.kind === SyntaxKind.Identifier
    )
      paramSymbol = resolveName(c, param, paramSymbol.name, SymbolFlags.Value, undefined, false, false) ?? paramSymbol;
    if (i === 0 && paramSymbol !== undefined && paramSymbol.name === 'this') thisParameter = getSymbol(param);
    else parameters.push(paramSymbol);
    if (typeNode !== undefined && typeNode.kind === SyntaxKind.LiteralType) flags |= SignatureFlags.HasLiteralTypes;
    const iifeArgs = iife !== undefined ? getArguments(iife)!.nodes.length : 0;
    const isOptionalParameter =
      isOptionalDeclaration(param) ||
      getInitializer(param) !== undefined ||
      isRestParameter(param) ||
      (iife !== undefined && parameters.length > iifeArgs && typeNode === undefined);
    if (!isOptionalParameter) minArgumentCount = parameters.length;
  }
  // An accessor without a `this` annotation takes the one of its counterpart.
  if (
    (declaration.kind === SyntaxKind.GetAccessor || declaration.kind === SyntaxKind.SetAccessor) &&
    hasBindableName(declaration) &&
    thisParameter === undefined
  ) {
    const symbol = getSymbol(declaration);
    const other =
      symbol !== undefined
        ? getDeclarationOfKind(
            symbol,
            declaration.kind === SyntaxKind.GetAccessor ? SyntaxKind.SetAccessor : SyntaxKind.GetAccessor,
          )
        : undefined;
    if (other !== undefined) thisParameter = getAnnotatedAccessorThisParameter(other);
  }
  const classType =
    declaration.kind === SyntaxKind.Constructor
      ? getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, getSymbol(declaration.parent!)!))
      : undefined;
  const typeParameters =
    classType !== undefined ? classType.localTypeParameters() : getTypeParametersFromDeclaration(c, declaration);
  if (params.length !== 0 && isRestParameter(params[params.length - 1]!)) flags |= SignatureFlags.HasRestParameter;
  if (
    declaration.kind === SyntaxKind.ConstructorType ||
    declaration.kind === SyntaxKind.Constructor ||
    declaration.kind === SyntaxKind.ConstructSignature
  )
    flags |= SignatureFlags.Construct;
  if (
    (declaration.kind === SyntaxKind.ConstructorType && hasSyntacticModifier(declaration, ModifierFlags.Abstract)) ||
    (declaration.kind === SyntaxKind.Constructor && hasSyntacticModifier(declaration.parent!, ModifierFlags.Abstract))
  )
    flags |= SignatureFlags.Abstract;
  const signature = c.newSignature(
    flags,
    declaration,
    typeParameters,
    thisParameter,
    parameters,
    undefined,
    minArgumentCount,
  );
  c.resolvedSignatures.set(declaration.id, signature);
  return signature;
}

export function getTypeParametersFromDeclaration(c: Checker, declaration: Node): Type[] {
  const fullSignature = getSignatureOfFullSignatureType(c, declaration);
  if (fullSignature !== undefined) return fullSignature.typeParameters ?? emptyTypes;
  const nodes = getTypeParameterNodes(declaration);
  if (nodes === undefined || nodes.nodes.length === 0) return emptyTypes;
  const result: Type[] = [];
  for (const node of nodes.nodes) {
    const t = getDeclaredTypeOfTypeParameter(c, getSymbol(node)!);
    if (!result.includes(t)) result.push(t);
  }
  return result;
}

// ---- Return types and predicates

function getReturnTypesOfSignatures(c: Checker, signatures: readonly Signature[]): Type[] {
  const types: Type[] = [];
  for (const sig of signatures) types.push(getReturnTypeOfSignature(c, sig));
  return types;
}

export function getReturnTypeOfSignature(c: Checker, sig: Signature): Type {
  if (sig.resolvedReturnType !== undefined) return sig.resolvedReturnType;
  const side = signatureSideOf(c, sig);
  if (side.resolvedReturnType !== undefined) {
    if (c.threadSharing !== undefined) noteReturnTypeUse(c, sig);
    return side.resolvedReturnType;
  }
  // TSC_TS_SHARE: checker threads share the return types of declared signatures (shared-results.ts).
  if (c.threadSharing !== undefined && isSharedReturnSignature(c, sig)) {
    const sharing = c.threadSharing;
    if (sharing.computingSignature === sig) sharing.computingSignature = undefined;
    else {
      const t = threadReturnType(c, sig);
      if (side.resolvedReturnType === undefined) side.resolvedReturnType = t;
      return side.resolvedReturnType;
    }
  }
  if (!pushTypeResolution(c, sig, TypeSystemPropertyName.ResolvedReturnType)) return c.errorType;
  let t: Type;
  if (sig.target !== undefined) t = instantiateType(c, getReturnTypeOfSignature(c, sig.target), sig.mapper);
  else if (sig.composite !== undefined)
    t = instantiateType(
      c,
      getUnionOrIntersectionType(
        c,
        getReturnTypesOfSignatures(c, sig.composite.signatures),
        sig.composite.isUnion,
        UnionReduction.Subtype,
      ),
      sig.mapper,
    );
  else {
    const declaration = sig.declaration!;
    const fromAnnotation = getReturnTypeFromAnnotation(c, declaration);
    if (fromAnnotation !== undefined) t = fromAnnotation;
    else {
      const body = getBody(declaration);
      t = body !== undefined && !nodeIsMissing(body) ? getReturnTypeFromBody(c, declaration) : c.anyType;
    }
  }
  if ((sig.flags & SignatureFlags.IsInnerCallChain) !== 0) t = addOptionalTypeMarker(c, t);
  else if ((sig.flags & SignatureFlags.IsOuterCallChain) !== 0) t = getOptionalTypeLocal(c, t, false);
  if (!popTypeResolution(c)) {
    const declaration = sig.declaration;
    if (declaration !== undefined) {
      const typeNode = getType(declaration);
      if (typeNode !== undefined) c.error(typeNode, Diagnostics.Return_type_annotation_circularly_references_itself);
      else if (c.noImplicitAny) {
        const name = getNameOfDeclaration(declaration);
        if (name !== undefined)
          c.error(
            name,
            Diagnostics.X_0_implicitly_has_return_type_any_because_it_does_not_have_a_return_type_annotation_and_is_referenced_directly_or_indirectly_in_one_of_its_return_expressions,
            declarationNameToString(getSourceFileOfNode(name), name),
          );
        else
          c.error(
            declaration,
            Diagnostics.Function_implicitly_has_return_type_any_because_it_does_not_have_a_return_type_annotation_and_is_referenced_directly_or_indirectly_in_one_of_its_return_expressions,
          );
      }
    }
    t = c.anyType;
  }
  if (side.resolvedReturnType === undefined) side.resolvedReturnType = t;
  return side.resolvedReturnType;
}

import { getOptionalType as getOptionalTypeLocal, addOptionalTypeMarker } from './checker-symbol-types.js';
import { isSharedReturnSignature, noteReturnTypeUse, threadReturnType } from './shared-results.js';

export function isResolvingReturnTypeOfSignature(c: Checker, sig: Signature): boolean {
  if (sig.composite !== undefined)
    for (const s of sig.composite.signatures) if (isResolvingReturnTypeOfSignature(c, s)) return true;
  return (
    resolvedReturnTypeOf(c, sig) === undefined &&
    findResolutionCycleStartIndex(c, sig, TypeSystemPropertyName.ResolvedReturnType) >= 0
  );
}

export function getNonCircularReturnTypeOfSignature(c: Checker, sig: Signature): Type {
  return isResolvingReturnTypeOfSignature(c, sig) ? c.anyType : getReturnTypeOfSignature(c, sig);
}

function isThisParameterDeclaration(p: Node): boolean {
  const name = getName(p);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this';
}

export function getReturnTypeFromAnnotation(c: Checker, declaration: Node): Type | undefined {
  if (declaration.kind === SyntaxKind.Constructor)
    return getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, getSymbol(declaration.parent!)!));
  const returnType = getType(declaration);
  if (returnType !== undefined) return getTypeFromTypeNode(c, returnType);
  if (declaration.kind === SyntaxKind.GetAccessor) {
    const symbol = getSymbolOfDeclaration(c, declaration);
    if (symbol !== undefined) {
      const setter = getDeclarations(symbol).find((d) => d.kind === SyntaxKind.SetAccessor);
      if (setter !== undefined) {
        const parameters = getParameters(setter);
        if (parameters !== undefined) {
          for (const param of parameters.nodes) {
            if (isThisParameterDeclaration(param)) continue;
            const typeNode = getType(param);
            if (typeNode !== undefined) return getTypeFromTypeNode(c, typeNode);
            break;
          }
        }
      }
    }
  }
  return getReturnTypeOfFullSignature(c, declaration);
}

export function getTypePredicateOfSignature(c: Checker, sig: Signature): TypePredicate | undefined {
  // Signatures created with a predicate have it inline; others resolve it on first use.
  if (sig.resolvedTypePredicate !== undefined)
    return sig.resolvedTypePredicate === c.noTypePredicate ? undefined : sig.resolvedTypePredicate;
  const side = signatureSideOf(c, sig);
  if (side.resolvedTypePredicate === undefined) {
    if (sig.target !== undefined) {
      const targetPredicate = getTypePredicateOfSignature(c, sig.target);
      if (targetPredicate !== undefined)
        side.resolvedTypePredicate = instantiateTypePredicate(c, targetPredicate, sig.mapper);
    } else if (sig.composite !== undefined)
      side.resolvedTypePredicate = getUnionOrIntersectionTypePredicate(
        c,
        sig.composite.signatures,
        sig.composite.isUnion,
      );
    else if (sig.declaration !== undefined) {
      const returnType = resolvedReturnTypeOf(c, sig);
      const typeNode = getType(sig.declaration);
      if (typeNode !== undefined) {
        if (typeNode.kind === SyntaxKind.TypePredicate)
          side.resolvedTypePredicate = createTypePredicateFromTypePredicateNode(c, typeNode, sig);
      } else if (
        isFunctionLikeDeclarationKind(sig.declaration.kind) &&
        (returnType === undefined || (returnType.flags & TypeFlags.Boolean) !== 0) &&
        getParameterCount(c, sig) > 0
      ) {
        side.resolvedTypePredicate = c.noTypePredicate; // Breaks cycles through the body.
        side.resolvedTypePredicate = getTypePredicateFromBody(c, sig.declaration);
      }
    }
    if (side.resolvedTypePredicate === undefined) side.resolvedTypePredicate = c.noTypePredicate;
  }
  return side.resolvedTypePredicate === c.noTypePredicate ? undefined : side.resolvedTypePredicate;
}

function getUnionOrIntersectionTypePredicate(
  c: Checker,
  signatures: Signature[],
  isUnion: boolean,
): TypePredicate | undefined {
  let last: TypePredicate | undefined;
  const types: Type[] = [];
  for (const sig of signatures) {
    const pred = getTypePredicateOfSignature(c, sig);
    if (pred !== undefined) {
      // Kinds must match; assertions aren't combined.
      if (
        (pred.kind !== TypePredicateKind.This && pred.kind !== TypePredicateKind.Identifier) ||
        (last !== undefined && !(last.kind === pred.kind && last.parameterIndex === pred.parameterIndex))
      )
        return undefined;
      last = pred;
      types.push(pred.type!);
    } else {
      // Union signatures may also return `false`.
      const returnType = isUnion ? getReturnTypeOfSignature(c, sig) : undefined;
      if (returnType !== c.falseType && returnType !== c.regularFalseType) return undefined;
    }
  }
  if (last === undefined) return undefined;
  return new TypePredicate(
    last.kind,
    last.parameterName,
    last.parameterIndex,
    getUnionOrIntersectionType(c, types, isUnion, UnionReduction.Literal),
  );
}

function createTypePredicateFromTypePredicateNode(c: Checker, node: Node, signature: Signature): TypePredicate {
  const shape = node as TypePredicateNode;
  const t = shape.type !== undefined ? getTypeFromTypeNode(c, shape.type) : undefined;
  if (shape.parameterName.kind === SyntaxKind.ThisType)
    return new TypePredicate(
      shape.assertsModifier !== undefined ? TypePredicateKind.AssertsThis : TypePredicateKind.This,
      '',
      0,
      t,
    );
  const name = getText(shape.parameterName);
  const index = signature.parameters.findIndex((p) => p.name === name);
  return new TypePredicate(
    shape.assertsModifier !== undefined ? TypePredicateKind.AssertsIdentifier : TypePredicateKind.Identifier,
    name,
    index,
    t,
  );
}

export function instantiateTypePredicate(
  c: Checker,
  predicate: TypePredicate,
  mapper: TypeMapper | undefined,
): TypePredicate {
  if (predicate.type === undefined) return predicate;
  const t = instantiateType(c, predicate.type, mapper);
  return t === predicate.type
    ? predicate
    : new TypePredicate(predicate.kind, predicate.parameterName, predicate.parameterIndex, t);
}

// ---- Parameters

export function getTypeOfParameter(c: Checker, symbol: Symbol): Type {
  const declaration = symbol.valueDeclaration;
  return addOptionality(
    c,
    getTypeOfSymbol(c, symbol),
    false,
    declaration !== undefined && (getInitializer(declaration) !== undefined || isOptionalDeclaration(declaration)),
  );
}

/** The parameter count, with a tuple rest parameter counting its fixed elements. */
export function getParameterCount(c: Checker, signature: Signature): number {
  const length = signature.parameters.length;
  if (signature.hasRestParameter()) {
    const restType = getTypeOfSymbol(c, signature.parameters[length - 1]!);
    if (isTupleType(restType)) {
      const target = tupleTargetOf(restType);
      return length + target.fixedLength - ((target.combinedFlags & ElementFlags.Variable) !== 0 ? 0 : 1);
    }
  }
  return length;
}

export function getMinArgumentCount(c: Checker, signature: Signature): number {
  const side = signatureSideOf(c, signature);
  if (side.resolvedMinArgumentCount === -1) {
    let minArgumentCount = -1;
    if (signature.hasRestParameter()) {
      const restType = getTypeOfSymbol(c, signature.parameters[signature.parameters.length - 1]!);
      if (isTupleType(restType)) {
        const infos = tupleTargetOf(restType).elementInfos;
        const firstOptional = infos.findIndex((info) => (info.flags & ElementFlags.Required) === 0);
        const requiredCount = firstOptional < 0 ? tupleTargetOf(restType).fixedLength : firstOptional;
        if (requiredCount > 0) minArgumentCount = signature.parameters.length - 1 + requiredCount;
      }
    }
    if (minArgumentCount === -1) {
      if ((signature.flags & SignatureFlags.IsUntypedSignatureInJSFile) !== 0) return 0;
      minArgumentCount = signature.minArgumentCount;
    }
    // Trailing `void` parameters are optional.
    for (let i = minArgumentCount - 1; i >= 0; i--) {
      const t = getTypeAtPosition(c, signature, i);
      if (!someType(t, (u) => (u.flags & TypeFlags.Void) !== 0)) break;
      minArgumentCount = i;
    }
    side.resolvedMinArgumentCount = minArgumentCount | 0;
  }
  return side.resolvedMinArgumentCount;
}

export function hasEffectiveRestParameter(c: Checker, signature: Signature): boolean {
  if (!signature.hasRestParameter()) return false;
  const restType = getTypeOfSymbol(c, signature.parameters[signature.parameters.length - 1]!);
  return !isTupleType(restType) || (tupleTargetOf(restType).combinedFlags & ElementFlags.Variable) !== 0;
}

export function getTypeAtPosition(c: Checker, signature: Signature, pos: number): Type {
  return tryGetTypeAtPosition(c, signature, pos) ?? c.anyType;
}

export function tryGetTypeAtPosition(c: Checker, signature: Signature, pos: number): Type | undefined {
  const paramCount = signature.parameters.length - (signature.hasRestParameter() ? 1 : 0);
  if (pos < paramCount) return getTypeOfParameter(c, signature.parameters[pos]!);
  if (signature.hasRestParameter()) {
    // Out-of-bounds positions of fixed tuples are undefined.
    const restType = getTypeOfSymbol(c, signature.parameters[paramCount]!);
    const index = pos - paramCount;
    if (
      !isTupleType(restType) ||
      (tupleTargetOf(restType).combinedFlags & ElementFlags.Variable) !== 0 ||
      index < tupleTargetOf(restType).fixedLength
    )
      return getIndexedAccessType(c, restType, getNumberLiteralType(c, index));
  }
  return undefined;
}

/** The rest type at `pos`, with `any[]` as `any` so it's compatible with anything. */
export function getRestOrAnyTypeAtPosition(c: Checker, source: Signature, pos: number): Type | undefined {
  const restType = getRestTypeAtPosition(c, source, pos, false);
  if (
    restType !== undefined &&
    isArrayType(c, restType) &&
    (getTypeArguments(c, restType)[0]!.flags & TypeFlags.Any) !== 0
  )
    return c.anyType;
  return restType;
}

export function getRestTypeAtPosition(c: Checker, source: Signature, pos: number, readonly: boolean): Type {
  const parameterCount = getParameterCount(c, source);
  const minArgumentCount = getMinArgumentCount(c, source);
  const restType = getEffectiveRestType(c, source);
  if (restType !== undefined && pos >= parameterCount - 1)
    return pos === parameterCount - 1
      ? restType
      : createArrayTypeEx(c, getIndexedAccessType(c, restType, c.numberType), false);
  const length = parameterCount - pos;
  if (length <= 0) return createTupleTypeEx(c, [], [], readonly);
  const types: Type[] = [];
  const infos: TupleElementInfo[] = [];
  for (let i = 0; i < length; i++) {
    if (restType === undefined || i < length - 1) {
      types.push(getTypeAtPosition(c, source, i + pos));
      infos.push(
        new TupleElementInfo(
          i + pos < minArgumentCount ? ElementFlags.Required : ElementFlags.Optional,
          getNameableDeclarationAtPosition(c, source, i + pos),
        ),
      );
    } else {
      types.push(restType);
      infos.push(new TupleElementInfo(ElementFlags.Variadic, getNameableDeclarationAtPosition(c, source, i + pos)));
    }
  }
  return createTupleTypeEx(c, types, infos, readonly);
}

function getNameableDeclarationAtPosition(c: Checker, signature: Signature, pos: number): Node | undefined {
  const paramCount = signature.parameters.length - (signature.hasRestParameter() ? 1 : 0);
  if (pos < paramCount) {
    const decl = signature.parameters[pos]!.valueDeclaration;
    return decl !== undefined && isValidDeclarationForTupleLabel(decl) ? decl : undefined;
  }
  if (signature.hasRestParameter()) {
    const restParameter = signature.parameters[paramCount]!;
    const restType = getTypeOfSymbol(c, restParameter);
    if (isTupleType(restType)) {
      const infos = tupleTargetOf(restType).elementInfos;
      const index = pos - paramCount;
      return index < infos.length ? infos[index]!.labeledDeclaration : undefined;
    }
    if (restParameter.valueDeclaration !== undefined && isValidDeclarationForTupleLabel(restParameter.valueDeclaration))
      return restParameter.valueDeclaration;
  }
  return undefined;
}

function isValidDeclarationForTupleLabel(d: Node): boolean {
  if (d.kind === SyntaxKind.NamedTupleMember) return true;
  const name = d.kind === SyntaxKind.Parameter ? getName(d) : undefined;
  return name !== undefined && name.kind === SyntaxKind.Identifier;
}

export function getNonArrayRestType(c: Checker, signature: Signature): Type | undefined {
  const restType = getEffectiveRestType(c, signature);
  return restType !== undefined && !isArrayType(c, restType) && (restType.flags & TypeFlags.Any) === 0
    ? restType
    : undefined;
}

export function getEffectiveRestType(c: Checker, signature: Signature): Type | undefined {
  if (!signature.hasRestParameter()) return undefined;
  const restType = getTypeOfSymbol(c, signature.parameters[signature.parameters.length - 1]!);
  if (!isTupleType(restType)) return (restType.flags & TypeFlags.Any) !== 0 ? c.anyArrayType : restType;
  if ((tupleTargetOf(restType).combinedFlags & ElementFlags.Variable) !== 0)
    return sliceTupleType(c, restType, tupleTargetOf(restType).fixedLength, 0);
  return undefined;
}

export function sliceTupleType(c: Checker, t: Type, index: number, endSkipCount: number): Type {
  const target = tupleTargetOf(t);
  const endIndex = getTypeReferenceArity(t) - Math.max(endSkipCount, 0);
  if (index > target.fixedLength) {
    const rest = getElementTypeOfSliceOfTupleType(c, t, target.fixedLength, 0, false, false);
    return rest !== undefined ? createArrayTypeEx(c, rest, false) : createTupleType(c, []);
  }
  if (index >= endIndex) return createTupleType(c, []);
  return createTupleTypeEx(
    c,
    getTypeArguments(c, t).slice(index, endIndex),
    target.elementInfos.slice(index, endIndex),
    false,
  );
}

export function getThisTypeOfSignature(c: Checker, signature: Signature): Type | undefined {
  return signature.thisParameter !== undefined ? getTypeOfSymbol(c, signature.thisParameter) : undefined;
}

export function getParameterNameAtPosition(c: Checker, signature: Signature, pos: number): string {
  const paramCount = signature.parameters.length - (signature.hasRestParameter() ? 1 : 0);
  if (pos < paramCount) return signature.parameters[pos]!.name;
  const restParameter = signature.parameters[paramCount]!;
  const restType = getTypeOfSymbol(c, restParameter);
  if (isTupleType(restType)) {
    const index = pos - paramCount;
    const info = tupleTargetOf(restType).elementInfos[index]!;
    if (info.labeledDeclaration !== undefined) return getText(getName(info.labeledDeclaration)!);
    return restParameter.name + '_' + index;
  }
  return restParameter.name;
}

/** `(...args: any[] | never[]) => any | unknown`. */
export function isTopSignature(c: Checker, s: Signature): boolean {
  if (s.typeParameters.length !== 0 || s.parameters.length !== 1 || !s.hasRestParameter()) return false;
  if (s.thisParameter !== undefined && (getTypeOfParameter(c, s.thisParameter).flags & TypeFlags.Any) === 0)
    return false;
  const paramType = getTypeOfParameter(c, s.parameters[0]!);
  const restType = isArrayType(c, paramType) ? getTypeArguments(c, paramType)[0]! : paramType;
  return (
    (restType.flags & (TypeFlags.Any | TypeFlags.Never)) !== 0 &&
    (getReturnTypeOfSignature(c, s).flags & TypeFlags.AnyOrUnknown) !== 0
  );
}

// ---- Derived signatures

export function cloneSignature(c: Checker, sig: Signature): Signature {
  const result = c.newSignature(
    sig.flags & SignatureFlags.PropagatingFlags,
    sig.declaration,
    sig.typeParameters,
    sig.thisParameter,
    sig.parameters,
    undefined,
    sig.minArgumentCount,
  );
  result.target = sig.target;
  result.mapper = sig.mapper;
  result.composite = sig.composite;
  return result;
}

export function getSignatureInstantiation(
  c: Checker,
  sig: Signature,
  typeArguments: Type[],
  isJavaScript: boolean,
): Signature {
  return getSignatureInstantiationWithoutFillingInTypeArguments(
    c,
    sig,
    fillMissingTypeArguments(
      c,
      typeArguments,
      sig.typeParameters,
      getMinTypeArgumentCount(c, sig.typeParameters),
      isJavaScript,
    ),
  );
}

export function getSignatureInstantiationWithoutFillingInTypeArguments(
  c: Checker,
  sig: Signature,
  typeArguments: Type[],
): Signature {
  const side = signatureSideOf(c, sig);
  let instantiations = side.instantiations;
  if (instantiations === undefined) {
    instantiations = new TypeListCache<Signature>();
    side.instantiations = instantiations;
  }
  const hash = typeListHash(typeArguments, undefined, 0);
  let instantiation = instantiations.get(hash, typeArguments, undefined, 0);
  if (instantiation === undefined) {
    instantiation = createSignatureInstantiation(c, sig, typeArguments);
    instantiations.set(hash, typeArguments, undefined, 0, instantiation);
  }
  return instantiation;
}

export function createSignatureInstantiation(c: Checker, sig: Signature, typeArguments: Type[]): Signature {
  const typeParameters: Type[] = [];
  for (const tp of sig.typeParameters) typeParameters.push(instantiateType(c, tp, (tp as TypeParameter).mapper));
  return instantiateSignatureEx(c, sig, newTypeMapper(typeParameters, typeArguments), true);
}

export function getErasedSignature(c: Checker, signature: Signature): Signature {
  if (signature.typeParameters.length === 0) return signature;
  const side = signatureSideOf(c, signature);
  if (side.erasedSignatureCache === undefined)
    side.erasedSignatureCache = instantiateSignatureEx(
      c,
      signature,
      new ArrayToSingleTypeMapper(signature.typeParameters, c.anyType),
      true,
    );
  return side.erasedSignatureCache;
}

/** Unconstrained instantiated type parameters map back to their originals. */
export function getCanonicalSignature(c: Checker, signature: Signature): Signature {
  if (signature.typeParameters.length === 0) return signature;
  const side = signatureSideOf(c, signature);
  if (side.canonicalSignatureCache === undefined) {
    const typeArguments: Type[] = [];
    for (const tp of signature.typeParameters) {
      const target = (tp as TypeParameter).target;
      typeArguments.push(target !== undefined && getConstraintOfTypeParameter(c, target) === undefined ? target : tp);
    }
    side.canonicalSignatureCache = getSignatureInstantiation(
      c,
      signature,
      typeArguments,
      signature.declaration !== undefined && (signature.declaration.flags & NodeFlags.JavaScriptFile) !== 0,
    );
  }
  return side.canonicalSignatureCache;
}

/** The generic `signature` instantiated in the context of the non-generic `contextualSignature`. */
export function instantiateSignatureInContextOf(
  c: Checker,
  signature: Signature,
  contextualSignature: Signature,
  comparer: TypeComparer,
): Signature {
  return instantiateSignatureInContextOfInference(c, signature, contextualSignature, undefined, comparer);
}

export function getSingleCallSignature(c: Checker, t: Type): Signature | undefined {
  return getSingleSignature(c, t, SignatureKind.Call, false);
}

export function getSingleCallOrConstructSignature(c: Checker, t: Type): Signature | undefined {
  return (
    getSingleSignature(c, t, SignatureKind.Call, false) ?? getSingleSignature(c, t, SignatureKind.Construct, false)
  );
}

export function getSingleSignature(
  c: Checker,
  t: Type,
  kind: SignatureKind,
  allowMembers: boolean,
): Signature | undefined {
  if ((t.flags & TypeFlags.Object) === 0) return undefined;
  const resolved = resolveStructuredTypeMembers(c, t);
  if (!allowMembers && (hasResolvedProperties(resolved) || resolved.indexInfos.length !== 0)) return undefined;
  if (kind === SignatureKind.Call && resolved.callSignatures.length === 1 && resolved.constructSignatures.length === 0)
    return resolved.callSignatures[0]!;
  if (
    kind === SignatureKind.Construct &&
    resolved.constructSignatures.length === 1 &&
    resolved.callSignatures.length === 0
  )
    return resolved.constructSignatures[0]!;
  return undefined;
}

export function getOrCreateTypeFromSignature(c: Checker, sig: Signature): Type {
  const side = signatureSideOf(c, sig);
  if (side.isolatedSignatureType === undefined) {
    const kind = sig.declaration !== undefined ? sig.declaration.kind : SyntaxKind.Unknown;
    // No declaration means a default constructor.
    const isConstructor =
      kind === SyntaxKind.Unknown ||
      kind === SyntaxKind.Constructor ||
      kind === SyntaxKind.ConstructSignature ||
      kind === SyntaxKind.ConstructorType;
    const t = newObjectType(
      c,
      ObjectFlags.Anonymous | ObjectFlags.SingleSignatureType,
      sig.declaration !== undefined ? getSymbol(sig.declaration) : undefined,
    );
    if (isConstructor) setStructuredTypeMembers(c, t, undefined, [], [sig], []);
    else setStructuredTypeMembers(c, t, undefined, [sig], [], []);
    side.isolatedSignatureType = t;
  }
  return side.isolatedSignatureType;
}

export function getDefaultConstructSignatures(c: Checker, classType: InterfaceType): Signature[] {
  const baseConstructorType = getBaseConstructorTypeOfClass(c, classType);
  const baseSignatures = getSignaturesOfType(c, baseConstructorType, SignatureKind.Construct);
  const declaration = getClassLikeDeclarationOfSymbol(classType.symbol!);
  const isAbstract = declaration !== undefined && hasSyntacticModifier(declaration, ModifierFlags.Abstract);
  if (baseSignatures.length === 0) {
    const flags = isAbstract ? SignatureFlags.Construct | SignatureFlags.Abstract : SignatureFlags.Construct;
    return [c.newSignature(flags, undefined, classType.localTypeParameters(), undefined, [], classType, 0)];
  }
  const baseTypeNode = declaration !== undefined ? getExtendsHeritageClauseElement(declaration) : undefined;
  const isJavaScript = declaration !== undefined && (declaration.flags & NodeFlags.JavaScriptFile) !== 0;
  const typeArgumentNodes =
    baseTypeNode !== undefined ? ((baseTypeNode as ExpressionWithTypeArguments).typeArguments?.nodes ?? []) : [];
  const typeArguments: Type[] = [];
  for (const n of typeArgumentNodes) typeArguments.push(getTypeFromTypeNode(c, n));
  const typeArgCount = typeArguments.length;
  const result: Signature[] = [];
  for (const baseSig of baseSignatures) {
    const minTypeArgumentCount = getMinTypeArgumentCount(c, baseSig.typeParameters);
    const typeParamCount = baseSig.typeParameters.length;
    if (isJavaScript || (typeArgCount >= minTypeArgumentCount && typeArgCount <= typeParamCount)) {
      const sig =
        typeParamCount !== 0
          ? createSignatureInstantiation(
              c,
              baseSig,
              fillMissingTypeArguments(c, typeArguments, baseSig.typeParameters, minTypeArgumentCount, isJavaScript),
            )
          : cloneSignature(c, baseSig);
      sig.typeParameters = classType.localTypeParameters();
      sig.resolvedReturnType = classType;
      if (isAbstract) sig.flags |= SignatureFlags.Abstract;
      else sig.flags &= ~SignatureFlags.Abstract;
      result.push(sig);
    }
  }
  return result;
}

// ---- Index infos of index symbols

export function getIndexInfosOfIndexSymbol(c: Checker, indexSymbol: Symbol, siblingSymbols: Symbol[]): IndexInfo[] {
  const indexInfos: IndexInfo[] = [];
  let hasComputedString = false;
  let hasComputedNumber = false;
  let hasComputedSymbol = false;
  let readonlyString = true;
  let readonlyNumber = true;
  let readonlySymbol = true;
  const propertySymbols: Symbol[] = [];
  for (const declaration of getDeclarations(indexSymbol)) {
    if (declaration.kind === SyntaxKind.IndexSignature) {
      const parameters = getParameters(declaration)?.nodes ?? [];
      const returnTypeNode = getType(declaration);
      if (parameters.length !== 1) continue;
      const typeNode = getType(parameters[0]!);
      if (typeNode === undefined) continue;
      const valueType = returnTypeNode !== undefined ? getTypeFromTypeNode(c, returnTypeNode) : c.anyType;
      const keyTypes = getTypeFromTypeNode(c, typeNode);
      const isReadonly = hasSyntacticModifier(declaration, ModifierFlags.Readonly);
      const add = (keyType: Type): void => {
        if (isValidIndexKeyTypeLocal(c, keyType) && indexInfos.every((info) => info.keyType !== keyType))
          indexInfos.push(new IndexInfo(keyType, valueType, isReadonly, declaration, []));
      };
      if ((keyTypes.flags & TypeFlags.Union) !== 0) for (const k of (keyTypes as UnionOrIntersectionType).types) add(k);
      else add(keyTypes);
    } else if (hasLateBindableIndexSignature(c, declaration)) {
      const keyType = checkComputedPropertyName(c, getName(declaration)!);
      if (indexInfos.some((info) => info.keyType === keyType)) continue;
      if (isTypeAssignableTo(c, keyType, c.stringNumberSymbolType)) {
        const isReadonly = hasSyntacticModifier(declaration, ModifierFlags.Readonly);
        if (isTypeAssignableTo(c, keyType, c.numberType)) {
          hasComputedNumber = true;
          if (!isReadonly) readonlyNumber = false;
        } else if (isTypeAssignableTo(c, keyType, c.esSymbolType)) {
          hasComputedSymbol = true;
          if (!isReadonly) readonlySymbol = false;
        } else {
          hasComputedString = true;
          if (!isReadonly) readonlyString = false;
        }
        propertySymbols.push(getSymbol(declaration)!);
      }
    }
  }
  if (hasComputedString || hasComputedNumber || hasComputedSymbol) {
    for (const s of siblingSymbols) if (s !== indexSymbol) propertySymbols.push(s);
    if (hasComputedString && indexInfos.every((i) => i.keyType !== c.stringType))
      indexInfos.push(getObjectLiteralIndexInfo(c, readonlyString, propertySymbols, c.stringType));
    if (hasComputedNumber && indexInfos.every((i) => i.keyType !== c.numberType))
      indexInfos.push(getObjectLiteralIndexInfo(c, readonlyNumber, propertySymbols, c.numberType));
    if (hasComputedSymbol && indexInfos.every((i) => i.keyType !== c.esSymbolType))
      indexInfos.push(getObjectLiteralIndexInfo(c, readonlySymbol, propertySymbols, c.esSymbolType));
  }
  return indexInfos;
}

import { isValidIndexKeyType as isValidIndexKeyTypeLocal, isNumericLiteralName } from './checker-utilities.js';
import { getReturnTypeOfFullSignature, getSignatureOfFullSignatureType } from './checker-jsdoc.js';
import { ContextFlags, getContextualTypeEx } from './checker-contextual.js';

/** Whether `symbol` is a known symbol or has a computed name of a symbol type. */
function isSymbolWithSymbolName(c: Checker, symbol: Symbol): boolean {
  if (symbol.name.startsWith('\ufffe@')) return true;
  const name = declarationCount(symbol) !== 0 ? getName(symbol.declaration!) : undefined;
  return (
    name !== undefined &&
    name.kind === SyntaxKind.ComputedPropertyName &&
    isTypeAssignableToKind(c, checkComputedPropertyName(c, name), TypeFlags.ESSymbol)
  );
}

/** Whether `symbol` has a numeric name, or a computed name of a number type. */
function isSymbolWithNumericName(c: Checker, symbol: Symbol): boolean {
  if (isNumericLiteralName(symbol.name)) return true;
  const name = declarationCount(symbol) !== 0 ? getName(symbol.declaration!) : undefined;
  if (name === undefined) return false;
  if (name.kind === SyntaxKind.ComputedPropertyName)
    return isTypeAssignableToKind(c, checkComputedPropertyName(c, name), TypeFlags.NumberLike);
  return (
    (name.kind === SyntaxKind.Identifier ||
      name.kind === SyntaxKind.StringLiteral ||
      name.kind === SyntaxKind.NumericLiteral) &&
    isNumericLiteralName(getText(name))
  );
}

function getObjectLiteralIndexInfo(c: Checker, isReadonly: boolean, properties: Symbol[], keyType: Type): IndexInfo {
  const propTypes: Type[] = [];
  const components: Node[] = [];
  for (const prop of properties) {
    if (
      (keyType === c.stringType && !isSymbolWithSymbolName(c, prop)) ||
      (keyType === c.numberType && isSymbolWithNumericName(c, prop)) ||
      (keyType === c.esSymbolType && isSymbolWithSymbolName(c, prop))
    ) {
      propTypes.push(getTypeOfSymbol(c, prop));
      if (isSymbolWithComputedName(prop)) components.push(prop.declaration!);
    }
  }
  const unionType =
    propTypes.length !== 0
      ? getUnionTypeEx(c, propTypes, UnionReduction.Subtype, undefined, undefined)
      : c.undefinedType;
  return new IndexInfo(keyType, unionType, isReadonly, undefined, components);
}

function isSymbolWithComputedName(symbol: Symbol): boolean {
  if (declarationCount(symbol) === 0) return false;
  const name = getName(symbol.declaration!);
  return name !== undefined && name.kind === SyntaxKind.ComputedPropertyName;
}

export {
  InternalSymbolName,
  getIndexInfosOfType,
  instantiateTypes,
  getConstraintOfTypeParameter,
  getClassLikeDeclarationOfSymbol,
  getSymbolOfDeclaration,
  ElementFlags,
};
export type { TypeReference };

/** A JavaScript function without parameter types or a contextual signature: all its parameters are optional. */
function isUntypedSignatureInJSFile(c: Checker, declaration: Node, params: Node[]): boolean {
  if (!isInJSFile(declaration)) return false;
  switch (declaration.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.Constructor:
      break;
    default:
      return false;
  }
  for (const param of params) if (getType(param) !== undefined) return false;
  return getContextualTypeEx(c, declaration, ContextFlags.Signature) === undefined;
}
