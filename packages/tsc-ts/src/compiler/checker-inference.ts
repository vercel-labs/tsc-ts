// Type inference: inference contexts, inferring from source to target types, and the inferred
// types of type parameters.
import { sideOf, signatureSideOf } from './side-state.js';
import {
  type NamedTupleMember,
  type ParameterDeclaration,
  type TypeReferenceNode,
  type MappedTypeNode,
  type Node,
  ModifierFlags,
  NodeFlags,
  type TypeParameterDeclaration,
  type ConditionalTypeNode,
} from './ast.js';
import { isInJSFile } from './ast-utilities.js';
import { hasSyntacticModifier } from './binder-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  ArrayToSingleTypeMapper,
  type ConditionalRoot,
  type ConditionalType,
  ElementFlags,
  IndexFlags,
  type IndexType,
  type IndexedAccessType,
  type IndexInfo,
  type IntrinsicType,
  type LiteralType,
  type MappedType,
  MergedTypeMapper,
  ObjectFlags,
  type ReverseMappedType,
  type Signature,
  SignatureFlags,
  SignatureKind,
  type StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  Ternary,
  TupleElementInfo,
  type Type,
  TypeFlags,
  TypeMapper,
  type TypeParameter,
  type TypePredicate,
  type TypeReference,
  type UnionOrIntersectionType,
  type UnionType,
  VarianceFlags,
  newTypeMapper,
  SimpleTypeMapper,
  emptyTypes,
  getNonDistributedTypeParameter,
} from './checker-types.js';
import {
  UnionReduction,
  createAnonymousType,
  createArrayType,
  createArrayTypeEx,
  createTupleType,
  createTupleTypeEx,
  filterType,
  getBaseTypeOfLiteralType,
  getBigIntLiteralType,
  getElementTypes,
  getEndElementCount,
  getIntersectionType,
  getNumberLiteralType,
  getRegularTypeOfLiteralType,
  getStringLiteralType,
  getTemplateLiteralType,
  getTypeArguments,
  getTypeReferenceArity,
  getUnionType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isArrayOrTupleType,
  isErrorType,
  isArrayType,
  isGenericTupleType,
  isLiteralType,
  isMutableArrayOrTuple,
  isReadonlyArrayType,
  isTupleType,
  mapType,
  newIndexInfo,
  newObjectType,
  setStructuredTypeMembers,
  someType,
  tupleTargetOf,
  typesOf,
  compareTypes,
} from './checker-type-factory.js';
import {
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  fillMissingTypeArguments,
  getConstraintOfTypeParameter,
  getDefaultFromTypeParameter,
  getMinTypeArgumentCount,
  getDeclaredTypeOfTypeParameter,
} from './checker-declared-types.js';
import {
  MappedTypeModifiers,
  applyStringMapping,
  getActualTypeVariable,
  getBranchTypesFromConditionalType,
  getConstraintFromConditionalType,
  getConstraintOfConditionalType,
  getConstraintTypeFromMappedType,
  getElementTypeOfSliceOfTupleType,
  getFalseTypeFromConditionalType,
  getHomomorphicTypeVariable,
  getIndexType,
  getIndexTypeEx,
  getIndexedAccessType,
  getLiteralTypeFromProperty,
  getMappedTypeModifiers,
  getNameTypeFromMappedType,
  getSimplifiedType,
  getSubstitutionIntersection,
  getTemplateTypeFromMappedType,
  getTrueTypeFromConditionalType,
  getTypeParameterFromMappedType,
  isGenericMappedType,
  isNoInferType,
  isTypeMatchedByTemplateLiteralType,
  shouldDeferIndexType,
  type TemplateTypeComparer,
} from './checker-type-operators.js';
import {
  getApparentType,
  getApplicableIndexInfo,
  getBaseConstraintOfType,
  getBaseConstraintOrType,
  getConstraintOfType,
  getIndexInfoOfType,
  getIndexInfosOfType,
  getPropertiesOfObjectType,
  getPropertiesOfType,
  getPropertyOfType,
  getPropertyOfUnionOrIntersectionType,
  getReducedApparentType,
  getReducedType,
  getSignaturesOfType,
  getTypeWithThisArgument,
  isApplicableIndexType,
  isObjectLiteralType,
} from './checker-members.js';
import {
  getEffectiveRestType,
  getErasedSignature,
  getParameterCount,
  getRestTypeAtPosition,
  getReturnTypeOfSignature,
  getSignatureInstantiation,
  getThisTypeOfSignature,
  getTypeAtPosition,
  getTypePredicateOfSignature,
  sliceTupleType,
} from './checker-signatures.js';
import {
  getNullableType,
  getTypeOfSymbol,
  getWidenedType,
  isReadonlySymbol,
  removeMissingOrUndefinedType,
  removeMissingType,
} from './checker-symbol-types.js';
import {
  combineTypeMappers,
  couldContainTypeVariables,
  instantiateSignature,
  instantiateSignatureEx,
  instantiateType,
  instantiateTypes,
} from './instantiation.js';
import {
  type TypeComparer,
  ComparerKind,
  getAliasVariances,
  getComparer,
  getUnmatchedProperty,
  getVariances,
  isUnmatchedProperty,
  isDeeplyNestedType,
  setStackEntry,
  isObjectTypeWithInferableIndex,
  isTypeAssignableTo,
  isTypeIdenticalTo,
  isTypeStrictSubtypeOf,
  isTypeSubtypeOf,
} from './relations.js';
import { maybeTypeOfKind } from './checker-utilities.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  findResolutionCycleStartIndex,
  getMergedSymbol,
  getSymbolOfDeclaration,
  TypeSystemPropertyName,
} from './checker-symbols.js';
import { parsePseudoBigInt } from './pseudo-bigint.js';
import { getContextualTypeForInference } from './checker-contextual.js';
import {
  CheckFlags,
  copyDeclarations,
  declarationCount,
  getDeclarations,
  getSymbolId,
  type Symbol,
  SymbolFlags,
} from './symbol.js';

export const enum InferenceFlags {
  None = 0,
  /** Infer `silentNeverType` for no inferences (otherwise `unknown`). */
  NoDefault = 1 << 0,
  /** Infer `any` for no inferences. */
  AnyDefault = 1 << 1,
  /** A generic function was skipped during inference. */
  SkippedGenericFunction = 1 << 2,
  /** Inferences other than pure return type inferences are not filtered by their constraints. */
  NoConstraintChecks = 1 << 3,
}

export const enum InferencePriority {
  None = 0,
  /** Naked type variable in union or intersection type. */
  NakedTypeVariable = 1 << 0,
  SpeculativeTuple = 1 << 1,
  /** Source originated within a substitution type's substitute. */
  SubstituteSource = 1 << 2,
  HomomorphicMappedType = 1 << 3,
  PartialHomomorphicMappedType = 1 << 4,
  MappedTypeConstraint = 1 << 5,
  ContravariantConditional = 1 << 6,
  /** Inference made from the return type of a generic function. */
  ReturnType = 1 << 7,
  LiteralKeyof = 1 << 8,
  /** Don't infer from constraints of instantiable types. */
  NoConstraints = 1 << 9,
  /** Always use strict rules for contravariant inferences. */
  AlwaysStrict = 1 << 10,
  MaxValue = 1 << 11,
  /** Inference circularity, less than all other priorities. */
  Circularity = -1,
  PriorityImpliesCombination = ReturnType | MappedTypeConstraint | LiteralKeyof,
}

const enum ExpandingFlags {
  None = 0,
  Source = 1,
  Target = 2,
  Both = 3,
}

// Shared empty candidate lists: an InferenceInfo gets its own on its first candidate, as tsgo's nil
// slices do. Never changed.
const noCandidates: Type[] = [];

/** Inferences for one type parameter. */
export class InferenceInfo {
  readonly typeParameter: Type;
  /** Covariant candidates. */
  candidates: Type[] = noCandidates;
  contraCandidates: Type[] = noCandidates;
  inferredType: Type | undefined = undefined;
  priority: InferencePriority = InferencePriority.MaxValue;
  /** Whether all inferences are to top-level occurrences. */
  topLevel = true;
  isFixed = false;
  impliedArity = -1;

  constructor(typeParameter: Type) {
    this.typeParameter = typeParameter;
  }

  clone(): InferenceInfo {
    const info = new InferenceInfo(this.typeParameter);
    if (this.candidates.length !== 0) info.candidates = this.candidates.slice();
    if (this.contraCandidates.length !== 0) info.contraCandidates = this.contraCandidates.slice();
    info.inferredType = this.inferredType;
    info.priority = this.priority;
    info.topLevel = this.topLevel;
    info.isFixed = this.isFixed;
    info.impliedArity = this.impliedArity;
    return info;
  }
}

export class IntraExpressionInferenceSite {
  readonly node: Node;
  readonly type: Type;

  constructor(node: Node, type: Type) {
    this.node = node;
    this.type = type;
  }
}

/**
 * The inferences for a set of type parameters. The context is its own fixing mapper (`mapper`), and
 * each read of `nonFixingMapper` returns a new mapper that reads the context: no mapper the context
 * holds refers back to it, so a context whose inference is done is freed by reference counting
 * rather than by the cycle collector.
 */
export class InferenceContext extends TypeMapper {
  readonly c: Checker;
  inferences: InferenceInfo[];
  /** The generic signature inferences are made for, if any. */
  readonly signature: Signature | undefined;
  flags: InferenceFlags;
  readonly compareTypes: TypeComparer;
  /** Combined after the non-fixing mapper (conditional types' `infer` constraints), if any. */
  nonFixingOuter: TypeMapper | undefined = undefined;
  /** Maps to inferences from the return type, if any. */
  returnMapper: TypeMapper | undefined = undefined;
  outerReturnMapper: TypeMapper | undefined = undefined;
  inferredTypeParameters: Type[] | undefined = undefined;
  /** Created on the first site; most contexts get none. */
  intraExpressionInferenceSites: IntraExpressionInferenceSite[] | undefined = undefined;

  constructor(
    c: Checker,
    inferences: InferenceInfo[],
    signature: Signature | undefined,
    flags: InferenceFlags,
    compareTypes: TypeComparer,
  ) {
    super();
    this.c = c;
    this.inferences = inferences;
    this.signature = signature;
    this.flags = flags;
    this.compareTypes = compareTypes;
  }

  /** Fixes inferences. */
  get mapper(): TypeMapper {
    return this;
  }

  /** Maps to the current inferences without fixing them. */
  get nonFixingMapper(): TypeMapper {
    const mapper = new NonFixingInferenceMapper(this);
    const outer = this.nonFixingOuter;
    return outer !== undefined ? combineTypeMappers(this.c, mapper, outer) : mapper;
  }

  map(type: Type): Type {
    const inferences = this.inferences;
    for (let i = 0; i < inferences.length; i++) {
      const inference = inferences[i]!;
      if (type !== inference.typeParameter) continue;
      if (!inference.isFixed) {
        // Infer from intra-expression sites before committing to an inference.
        inferFromIntraExpressionSites(this.c, this);
        clearCachedInferences(inferences);
        inference.isFixed = true;
      }
      return getInferredType(this.c, this, i);
    }
    return type;
  }
}

/** Maps a context's type parameters to their inferred types without fixing them. */
export class NonFixingInferenceMapper extends TypeMapper {
  readonly context: InferenceContext;

  constructor(context: InferenceContext) {
    super();
    this.context = context;
  }

  map(type: Type): Type {
    const context = this.context;
    const inferences = context.inferences;
    for (let i = 0; i < inferences.length; i++)
      if (type === inferences[i]!.typeParameter) return getInferredType(context.c, context, i);
    return type;
  }
}

export function createInferenceContext(
  c: Checker,
  typeParameters: readonly Type[],
  signature: Signature | undefined,
  flags: InferenceFlags,
  compareTypes: TypeComparer | undefined,
): InferenceContext {
  const inferences: InferenceInfo[] = [];
  for (const tp of typeParameters) inferences.push(new InferenceInfo(tp));
  return new InferenceContext(c, inferences, signature, flags, compareTypes ?? getComparer(c, ComparerKind.Assignable));
}

export function cloneInferenceContext(
  c: Checker,
  context: InferenceContext,
  extraFlags: InferenceFlags,
): InferenceContext {
  return new InferenceContext(
    c,
    context.inferences.map((i) => i.clone()),
    context.signature,
    context.flags | extraFlags,
    context.compareTypes,
  );
}

export function cloneInferredPartOfContext(c: Checker, context: InferenceContext): InferenceContext | undefined {
  const inferences: InferenceInfo[] = [];
  for (const i of context.inferences) if (hasInferenceCandidates(i)) inferences.push(i.clone());
  if (inferences.length === 0) return undefined;
  return new InferenceContext(c, inferences, context.signature, context.flags, context.compareTypes);
}

export function getMapperFromContext(context: InferenceContext | undefined): TypeMapper | undefined {
  return context !== undefined ? context.mapper : undefined;
}

/** The context's return mapper combined with a mapper erasing its other type parameters to their current inferences. */
export function createOuterReturnMapper(c: Checker, context: InferenceContext): TypeMapper {
  if (context.outerReturnMapper === undefined) {
    let mapper: TypeMapper = cloneInferenceContext(c, context, InferenceFlags.None).mapper;
    if (context.returnMapper !== undefined) mapper = new MergedTypeMapper(context.returnMapper, mapper);
    context.outerReturnMapper = mapper;
  }
  return context.outerReturnMapper;
}

export function addIntraExpressionInferenceSite(context: InferenceContext, node: Node, type: Type): void {
  (context.intraExpressionInferenceSites ??= []).push(new IntraExpressionInferenceSite(node, type));
}

export function clearCachedInferences(inferences: InferenceInfo[]): void {
  for (const inference of inferences) if (!inference.isFixed) inference.inferredType = undefined;
}

export function hasInferenceCandidates(info: InferenceInfo): boolean {
  return info.candidates.length !== 0 || info.contraCandidates.length !== 0;
}

export function hasInferenceCandidatesOrDefault(info: InferenceInfo): boolean {
  return hasInferenceCandidates(info) || hasTypeParameterDefault(info.typeParameter);
}

export function someInferenceHasCandidates(inferences: InferenceInfo[]): boolean {
  for (const info of inferences) if (hasInferenceCandidates(info)) return true;
  return false;
}

export function everyInferenceHasCandidates(inferences: InferenceInfo[]): boolean {
  for (const info of inferences) if (!hasInferenceCandidates(info)) return false;
  return true;
}

export function someInferenceHasCandidatesOrDefault(inferences: InferenceInfo[]): boolean {
  for (const info of inferences) if (hasInferenceCandidatesOrDefault(info)) return true;
  return false;
}

function hasTypeParameterDefault(tp: Type): boolean {
  const symbol = tp.symbol;
  if (symbol === undefined) return false;
  for (const d of getDeclarations(symbol))
    if (d.kind === SyntaxKind.TypeParameter && (d as TypeParameterDeclaration).defaultType !== undefined) return true;
  return false;
}

export function hasOverlappingInferences(a: InferenceInfo[], b: InferenceInfo[]): boolean {
  for (let i = 0; i < a.length; i++) if (hasInferenceCandidates(a[i]!) && hasInferenceCandidates(b[i]!)) return true;
  return false;
}

export function mergeInferences(target: InferenceInfo[], source: InferenceInfo[]): void {
  for (let i = 0; i < target.length; i++)
    if (!hasInferenceCandidates(target[i]!) && hasInferenceCandidates(source[i]!)) target[i] = source[i]!;
}

// ---- Inferring from types

/** Infers from `source` to `target` for the type parameters of `inferences`. */
export function inferTypes(
  c: Checker,
  inferences: InferenceInfo[],
  source: Type,
  target: Type,
  priority: InferencePriority,
  contravariant: boolean,
): void {
  const state = new InferenceState(c, inferences, target, priority, contravariant);
  state.inferFromTypes(source, target);
}

/** Whether no inference has a candidate or an inferred type, or is fixed, as in a new context. */
function isUnstarted(inferences: readonly InferenceInfo[]): boolean {
  for (const i of inferences)
    if (i.candidates.length !== 0 || i.contraCandidates.length !== 0 || i.inferredType !== undefined || i.isFixed)
      return false;
  return true;
}

const enum UnstartedInferenceState {
  /** Walked once, which may have resolved the types the walk reaches. Nothing is kept. */
  Seen,
  /** Walked twice; the second walk created no types and left `inferences`. */
  Walked,
  /** A third walk did the same as the second, so later walks are skipped. */
  Confirmed,
  /** Always walked: walks differed or created types, or one reported a diagnostic or met a circularity. */
  Unusable,
}

/** A memoized `inferTypesFromUnstarted` walk. */
export class UnstartedInference {
  readonly state: UnstartedInferenceState;
  readonly inferences: InferenceInfo[];
  /** The instantiations the walk does, which a skipped walk adds to the counts. */
  readonly instantiations: number;
  /** The instantiation depth the confirming walk started at: a walk starting deeper might reach the limit. */
  readonly depth: number;
  /** The variance reliability flags the walk reports. */
  readonly reliabilityFlags: number;
  /** The unions and intersections the walk searched before their properties were resolved. */
  readonly searched: readonly Type[];

  constructor(
    state: UnstartedInferenceState,
    inferences: InferenceInfo[],
    instantiations: number,
    depth: number,
    reliabilityFlags: number,
    searched: readonly Type[],
  ) {
    this.state = state;
    this.inferences = inferences;
    this.instantiations = instantiations;
    this.depth = depth;
    this.reliabilityFlags = reliabilityFlags;
    this.searched = searched;
  }
}

const verifyUnstartedInferences = process.env['TSC_TS_VERIFY_INFERENCE_MEMO'] === '1';

/**
 * `inferTypes` into the inferences for `signature`'s type parameters, to `target`, which is
 * determined by `signature` (its return type). When no inference has started, the walk depends only
 * on `signature`, `source` and `priority`, so it is memoized per checker. Contextual return type
 * inference repeats the same walk for calls of a generic function with the same contextual type at
 * different call sites.
 *
 * A walk is skipped only when it would add nothing but the inferences:
 * - Once a second and a third walk have both created no types or signatures and done the same. The
 *   first walk resolves the types it reaches; only walks that repeat keep their inferences.
 * - With the instantiation count and depth replayed. The walk is skipped only where it could not
 *   reach the instantiation limits.
 * - With the variance reliability flags replayed.
 * - Never when a walk reported a diagnostic or met a circularity. Never during a variance
 *   computation, where relations are not cached and circularities are found differently.
 * - Only while the unions and intersections whose unresolved properties the walk searched
 *   (hasUnmatchedProperty) are still unresolved. Once they are resolved, the same walk creates the
 *   property types, so it is learned again.
 */
export function inferTypesFromUnstarted(
  c: Checker,
  signature: Signature,
  inferences: InferenceInfo[],
  source: Type,
  target: Type,
  priority: InferencePriority,
): void {
  if (c.varianceStack.length !== 0 || !isUnstarted(inferences)) {
    inferTypes(c, inferences, source, target, priority, false);
    return;
  }
  const caches = c.inferenceCaches;
  const memo = caches.unstartedInferences;
  let bySource = memo.get(signature.id);
  if (bySource === undefined) {
    bySource = new Map<number, UnstartedInference>();
    memo.set(signature.id, bySource);
  }
  const key = source.id * 4096 + priority;
  let known = bySource.get(key);
  if (known !== undefined && known.state === UnstartedInferenceState.Confirmed) {
    if (havePropertiesResolved(c, known.searched)) {
      // Learn the walk again for the resolved properties; each union's properties are resolved once.
      bySource.delete(key);
      known = undefined;
    } else if (c.instantiationDepth <= known.depth && c.instantiationCount + known.instantiations < 5000000) {
      if (verifyUnstartedInferences) verifyUnstartedInference(c, signature, known, source, target, priority);
      copyInferences(inferences, known.inferences);
      const outer = c.unresolvedPropertySearches;
      if (outer !== undefined) for (const t of known.searched) outer.push(t);
      c.instantiationCount += known.instantiations;
      c.totalInstantiations += known.instantiations;
      c.reliabilityFlags |= known.reliabilityFlags;
      return;
    }
  }
  const reports = c.reports;
  const cycles = c.resolutionCycleCount;
  const outerSearches = c.unresolvedPropertySearches;
  const searches: Type[] = [];
  c.unresolvedPropertySearches = searches;
  const types = c.typeCount;
  const signatures = c.signatureCount;
  const count = c.instantiationCount;
  const total = c.totalInstantiations;
  const depth = c.instantiationDepth;
  const reliabilityFlags = c.reliabilityFlags;
  // Nothing reads the flags before setting them, so the walk's own are those it leaves from zero.
  c.reliabilityFlags = 0;
  inferTypes(c, inferences, source, target, priority, false);
  const walkFlags = c.reliabilityFlags;
  c.reliabilityFlags = reliabilityFlags | walkFlags;
  c.unresolvedPropertySearches = outerSearches;
  // An enclosing walk depends on the searches of the walks within it.
  if (outerSearches !== undefined) for (const t of searches) outerSearches.push(t);
  const state = known === undefined ? undefined : known.state;
  if (state === UnstartedInferenceState.Confirmed || state === UnstartedInferenceState.Unusable) return;
  const instantiations = c.totalInstantiations - total;
  if (c.reports !== reports || c.resolutionCycleCount !== cycles || c.instantiationCount - count !== instantiations) {
    bySource.set(key, caches.alwaysWalked);
    return;
  }
  if (state === undefined) {
    bySource.set(key, caches.seenOnce);
    return;
  }
  if (c.typeCount !== types || c.signatureCount !== signatures) {
    bySource.set(key, caches.alwaysWalked);
    return;
  }
  const searched = searches.length === 0 ? searches : [...new Set(searches)];
  if (state === UnstartedInferenceState.Seen) {
    const snapshot: InferenceInfo[] = [];
    for (const i of inferences) snapshot.push(i.clone());
    bySource.set(
      key,
      new UnstartedInference(UnstartedInferenceState.Walked, snapshot, instantiations, depth, walkFlags, searched),
    );
    return;
  }
  bySource.set(
    key,
    sameInferences(inferences, known!.inferences) &&
      instantiations === known!.instantiations &&
      walkFlags === known!.reliabilityFlags
      ? new UnstartedInference(
          UnstartedInferenceState.Confirmed,
          known!.inferences,
          instantiations,
          depth,
          walkFlags,
          searched,
        )
      : caches.alwaysWalked,
  );
}

/** Whether the properties of any of `types` have been resolved. */
function havePropertiesResolved(c: Checker, types: readonly Type[]): boolean {
  for (const t of types)
    if (sideOf(c, t as UnionOrIntersectionType).membersOf?.resolvedProperties !== undefined) return true;
  return false;
}

function copyInferences(inferences: InferenceInfo[], from: readonly InferenceInfo[]): void {
  for (let k = 0; k < inferences.length; k++) {
    const info = inferences[k]!;
    const known = from[k]!;
    if (known.candidates.length !== 0) info.candidates = known.candidates.slice();
    if (known.contraCandidates.length !== 0) info.contraCandidates = known.contraCandidates.slice();
    info.inferredType = known.inferredType;
    info.priority = known.priority;
    info.topLevel = known.topLevel;
    info.isFixed = known.isFixed;
    info.impliedArity = known.impliedArity;
  }
}

function sameTypes(a: readonly Type[], b: readonly Type[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

function sameInferences(a: readonly InferenceInfo[], b: readonly InferenceInfo[]): boolean {
  for (let k = 0; k < a.length; k++) {
    const x = a[k]!;
    const y = b[k]!;
    if (
      !sameTypes(x.candidates, y.candidates) ||
      !sameTypes(x.contraCandidates, y.contraCandidates) ||
      x.inferredType !== y.inferredType ||
      x.priority !== y.priority ||
      x.topLevel !== y.topLevel ||
      x.isFixed !== y.isFixed ||
      x.impliedArity !== y.impliedArity
    )
      return false;
  }
  return true;
}

/** With TSC_TS_VERIFY_INFERENCE_MEMO=1: walks anyway and reports how the skipped walk would have differed. */
function verifyUnstartedInference(
  c: Checker,
  signature: Signature,
  known: UnstartedInference,
  source: Type,
  target: Type,
  priority: InferencePriority,
): void {
  const inferences: InferenceInfo[] = [];
  for (const i of known.inferences) inferences.push(new InferenceInfo(i.typeParameter));
  const types = c.typeCount;
  const signatures = c.signatureCount;
  const total = c.totalInstantiations;
  const reports = c.reports;
  const cycles = c.resolutionCycleCount;
  const reliabilityFlags = c.reliabilityFlags;
  const outerSearches = c.unresolvedPropertySearches;
  c.reliabilityFlags = 0;
  c.unresolvedPropertySearches = undefined;
  inferTypes(c, inferences, source, target, priority, false);
  const walkFlags = c.reliabilityFlags;
  c.reliabilityFlags = reliabilityFlags;
  c.unresolvedPropertySearches = outerSearches;
  const instantiations = c.totalInstantiations - total;
  // Undo the check walk's count so the run continues as without verification.
  c.instantiationCount -= instantiations;
  c.totalInstantiations -= instantiations;
  const differences: string[] = [];
  if (!sameInferences(inferences, known.inferences)) differences.push('inferences');
  if (c.typeCount !== types) differences.push(`${c.typeCount - types} types`);
  if (c.signatureCount !== signatures) differences.push(`${c.signatureCount - signatures} signatures`);
  if (instantiations !== known.instantiations)
    differences.push(`${instantiations} instantiations, not ${known.instantiations}`);
  if (c.reports !== reports) differences.push(`${c.reports - reports} diagnostics`);
  if (c.resolutionCycleCount !== cycles) differences.push('a circularity');
  if (walkFlags !== known.reliabilityFlags) differences.push('reliability flags');
  if (differences.length !== 0)
    process.stderr.write(
      `inference memo: signature ${signature.id} source ${source.id} priority ${priority}: ${differences.join(', ')}\n`,
    );
}

const enum InferenceAction {
  AliasTypeArguments,
  ConditionalType,
  GenericMappedTypes,
  ObjectTypes,
  ReferenceTypeArguments,
}

const enum MatchKind {
  TypeOrBaseIdentical,
  CloselyMatched,
  Identical,
}

class MatchedTypes {
  readonly sources: Type[];
  readonly targets: Type[];

  constructor(sources: Type[], targets: Type[]) {
    this.sources = sources;
    this.targets = targets;
  }
}

function typesMatch(c: Checker, s: Type, t: Type, kind: MatchKind): boolean {
  switch (kind) {
    case MatchKind.TypeOrBaseIdentical:
      return isTypeOrBaseIdenticalTo(c, s, t);
    case MatchKind.CloselyMatched:
      return isTypeCloselyMatchedBy(s, t);
    case MatchKind.Identical:
      return isTypeIdenticalTo(c, s, t);
  }
}

/** The state of one `inferTypes` walk. */
class InferenceState {
  readonly c: Checker;
  readonly inferences: InferenceInfo[];
  readonly originalTarget: Type;
  priority: number;
  inferencePriority: number = InferencePriority.MaxValue;
  contravariant: boolean;
  bivariant = false;
  expandingFlags: ExpandingFlags = ExpandingFlags.None;
  propagationType: Type | undefined = undefined;
  /**
   * invokeOnce's pairs, for each priority and variance of the walk (`visitMode`), by packed type ids (`visitKey`),
   * or spelled when an id is too large to pack.
   */
  visited: Map<number, Map<number, InferencePriority>> | undefined = undefined;
  visitedSpelled: Map<string, InferencePriority> | undefined = undefined;
  /** The mode `visitedPairs` belongs to, or -1 before the first `visitedOf`. */
  visitedMode = -1;
  /** `visited`'s map for `visitedMode`; a walk mostly stays in one mode. */
  visitedPairs: Map<number, InferencePriority> | undefined = undefined;
  /** invokeOnce's recursion stacks; the first `stackDepth` entries of each are live. */
  readonly sourceStack: Type[] = [];
  readonly targetStack: Type[] = [];
  stackDepth = 0;

  constructor(
    c: Checker,
    inferences: InferenceInfo[],
    originalTarget: Type,
    priority: InferencePriority,
    contravariant: boolean,
  ) {
    this.c = c;
    this.inferences = inferences;
    this.originalTarget = originalTarget;
    this.priority = priority;
    this.contravariant = contravariant;
  }

  infoFor(t: Type): InferenceInfo | undefined {
    return getInferenceInfoForType(this.inferences, t);
  }

  inferFromTypes(source: Type, target: Type): void {
    const c = this.c;
    if (!couldContainTypeVariables(c, target) || isNoInferType(c, target)) return;
    if (source === c.wildcardType || source === c.blockedStringType) {
      // Infer the `any`-like source for every type parameter referenced in the target.
      const savePropagationType = this.propagationType;
      this.propagationType = source;
      this.inferFromTypes(target, target);
      this.propagationType = savePropagationType;
      return;
    }
    const sourceAlias = source.alias;
    const targetAlias = target.alias;
    if (sourceAlias !== undefined && targetAlias !== undefined && sourceAlias.symbol === targetAlias.symbol) {
      // Instantiations of the same alias infer between their type arguments, once for each pair of types, as tsc does.
      if (sourceAlias.typeArguments.length !== 0 || targetAlias.typeArguments.length !== 0)
        this.invokeOnce(source, target, InferenceAction.AliasTypeArguments);
      return;
    }
    if (source === target && (source.flags & TypeFlags.UnionOrIntersection) !== 0) {
      for (const t of typesOf(source)) this.inferFromTypes(t, t);
      return;
    }
    if ((target.flags & TypeFlags.Union) !== 0) {
      const sourceTypes = (source.flags & TypeFlags.Union) !== 0 ? typesOf(source) : [source];
      // Infer between identically matching constituents, then closely matching ones, removing them.
      const temp = this.inferFromMatchingTypes(sourceTypes, typesOf(target), MatchKind.TypeOrBaseIdentical);
      const matched = this.inferFromMatchingTypes(temp.sources, temp.targets, MatchKind.CloselyMatched);
      if (matched.targets.length === 0) return;
      target = getUnionType(c, matched.targets);
      if (matched.sources.length === 0) {
        // Everything matched; infer from the full source at lower priority so that `string` to
        // `string | T` still infers `string` for T.
        this.inferWithPriority(source, target, InferencePriority.NakedTypeVariable);
        return;
      }
      source = getUnionType(c, matched.sources);
    } else if ((target.flags & TypeFlags.Intersection) !== 0 && !everyNonGenericObjectType(c, typesOf(target))) {
      // Reduce intersections unless they're simple combinations of object types.
      if ((source.flags & TypeFlags.Union) === 0) {
        const sourceTypes = (source.flags & TypeFlags.Intersection) !== 0 ? typesOf(source) : [source];
        const matched = this.inferFromMatchingTypes(sourceTypes, typesOf(target), MatchKind.Identical);
        if (matched.sources.length === 0 || matched.targets.length === 0) return;
        source = getIntersectionType(c, matched.sources);
        target = getIntersectionType(c, matched.targets);
      }
    }
    if ((target.flags & (TypeFlags.IndexedAccess | TypeFlags.Substitution)) !== 0) {
      if (isNoInferType(c, target)) return;
      target = getActualTypeVariable(c, target);
    }
    if ((target.flags & TypeFlags.TypeVariable) !== 0) {
      const inference = this.infoFor(target);
      if (inference !== undefined) {
        this.inferToTypeVariable(inference, source, target);
        return;
      }
      // Infer to the simplified indexed access to expose more bare type parameters.
      const simplified = getSimplifiedType(c, target, false);
      if (simplified !== target) this.inferFromTypes(source, simplified);
      else if ((target.flags & TypeFlags.IndexedAccess) !== 0) {
        const access = target as IndexedAccessType;
        const indexType = getSimplifiedType(c, access.indexType, false);
        if ((indexType.flags & TypeFlags.Instantiable) !== 0) {
          const distributed = distributeIndexOverObjectType(
            c,
            getSimplifiedType(c, access.objectType, false),
            indexType,
          );
          if (distributed !== undefined && distributed !== target) this.inferFromTypes(source, distributed);
        }
      }
    }
    if (
      (source.objectFlags & ObjectFlags.Reference) !== 0 &&
      (target.objectFlags & ObjectFlags.Reference) !== 0 &&
      (referenceTarget(source) === referenceTarget(target) || (isArrayType(c, source) && isArrayType(c, target))) &&
      !(referenceNode(source) !== undefined && referenceNode(target) !== undefined)
    ) {
      this.invokeOnce(source, target, InferenceAction.ReferenceTypeArguments);
    } else if ((source.flags & TypeFlags.Index) !== 0 && (target.flags & TypeFlags.Index) !== 0) {
      this.inferFromContravariantTypes((source as IndexType).target, (target as IndexType).target);
    } else if (
      (isLiteralType(source) || (source.flags & TypeFlags.String) !== 0) &&
      (target.flags & TypeFlags.Index) !== 0
    ) {
      const empty = createEmptyObjectTypeFromStringLiteral(c, source);
      this.inferFromContravariantTypesWithPriority(empty, (target as IndexType).target, InferencePriority.LiteralKeyof);
    } else if ((source.flags & TypeFlags.IndexedAccess) !== 0 && (target.flags & TypeFlags.IndexedAccess) !== 0) {
      this.inferFromTypes((source as IndexedAccessType).objectType, (target as IndexedAccessType).objectType);
      this.inferFromTypes((source as IndexedAccessType).indexType, (target as IndexedAccessType).indexType);
    } else if ((source.flags & TypeFlags.StringMapping) !== 0 && (target.flags & TypeFlags.StringMapping) !== 0) {
      if (source.symbol === target.symbol)
        this.inferFromTypes((source as StringMappingType).target, (target as StringMappingType).target);
    } else if ((source.flags & TypeFlags.Substitution) !== 0) {
      this.inferFromTypes((source as SubstitutionType).baseType, target);
      // Substitutes infer at a lower priority.
      this.inferWithPriority(getSubstitutionIntersection(c, source), target, InferencePriority.SubstituteSource);
    } else if ((target.flags & TypeFlags.Conditional) !== 0) {
      this.invokeOnce(source, target, InferenceAction.ConditionalType);
    } else if ((target.flags & TypeFlags.UnionOrIntersection) !== 0) {
      this.inferToMultipleTypes(source, typesOf(target), target.flags);
    } else if ((source.flags & TypeFlags.Union) !== 0) {
      for (const sourceType of typesOf(source)) this.inferFromTypes(sourceType, target);
    } else if ((target.flags & TypeFlags.TemplateLiteral) !== 0) {
      this.inferToTemplateLiteralType(source, target as TemplateLiteralType);
    } else {
      source = getReducedType(c, source);
      if (isGenericMappedType(c, source) && isGenericMappedType(c, target))
        this.invokeOnce(source, target, InferenceAction.GenericMappedTypes);
      if (
        !(
          (this.priority & InferencePriority.NoConstraints) !== 0 &&
          (source.flags & (TypeFlags.Intersection | TypeFlags.Instantiable)) !== 0
        )
      ) {
        const apparentSource = getApparentType(c, source);
        // The apparent type of an indexed access or conditional may be any type; restart with it.
        if (apparentSource !== source && (apparentSource.flags & (TypeFlags.Object | TypeFlags.Intersection)) === 0) {
          this.inferFromTypes(apparentSource, target);
          return;
        }
        source = apparentSource;
      }
      if ((source.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0)
        this.invokeOnce(source, target, InferenceAction.ObjectTypes);
    }
  }

  inferToTypeVariable(inference: InferenceInfo, source: Type, target: Type): void {
    const c = this.c;
    // Non-inferrable sources are markers that must not become candidates.
    if ((source.objectFlags & ObjectFlags.NonInferrableType) !== 0 || source === c.nonInferrableAnyType) return;
    if (!inference.isFixed) {
      const candidate = this.propagationType ?? source;
      if (candidate === c.blockedStringType) return;
      if (this.priority < inference.priority) {
        inference.candidates = noCandidates;
        inference.contraCandidates = noCandidates;
        inference.topLevel = true;
        inference.priority = this.priority;
      }
      if (this.priority === inference.priority) {
        // Contravariant inferences only in purely contravariant positions.
        if (this.contravariant && !this.bivariant) {
          if (!inference.contraCandidates.includes(candidate)) {
            if (inference.contraCandidates === noCandidates) inference.contraCandidates = [];
            inference.contraCandidates.push(candidate);
            clearCachedInferences(this.inferences);
          }
        } else if (!inference.candidates.includes(candidate)) {
          if (inference.candidates === noCandidates) inference.candidates = [];
          inference.candidates.push(candidate);
          clearCachedInferences(this.inferences);
        }
      }
      if (
        (this.priority & InferencePriority.ReturnType) === 0 &&
        (target.flags & TypeFlags.TypeParameter) !== 0 &&
        inference.topLevel &&
        !isTypeParameterAtTopLevel(c, this.originalTarget, target, 0)
      ) {
        inference.topLevel = false;
        clearCachedInferences(this.inferences);
      }
    }
    this.inferencePriority = Math.min(this.inferencePriority, this.priority);
  }

  /**
   * Infers between the type arguments of two references to one generic type. The variances only pick
   * the direction of each inference, so they are measured only when a target type argument could hold
   * one: measuring them relates marker instantiations of the whole type.
   */
  inferFromReferenceTypeArguments(source: Type, target: Type): void {
    const c = this.c;
    const sourceTypes = getTypeArguments(c, source);
    const targetTypes = getTypeArguments(c, target);
    this.inferFromTypeArguments(
      sourceTypes,
      targetTypes,
      someTypeCouldHoldInference(c, targetTypes) ? getVariances(c, referenceTarget(source)!) : noVariances,
    );
  }

  inferFromTypeArguments(sourceTypes: Type[], targetTypes: Type[], variances: VarianceFlags[]): void {
    const count = Math.min(sourceTypes.length, targetTypes.length);
    for (let i = 0; i < count; i++) {
      if (i < variances.length && (variances[i] & VarianceFlags.VarianceMask) === VarianceFlags.Contravariant)
        this.inferFromContravariantTypes(sourceTypes[i]!, targetTypes[i]!);
      else this.inferFromTypes(sourceTypes[i]!, targetTypes[i]!);
    }
  }

  inferWithPriority(source: Type, target: Type, newPriority: InferencePriority): void {
    const savePriority = this.priority;
    this.priority |= newPriority;
    this.inferFromTypes(source, target);
    this.priority = savePriority;
  }

  inferFromContravariantTypesWithPriority(source: Type, target: Type, newPriority: InferencePriority): void {
    const savePriority = this.priority;
    this.priority |= newPriority;
    this.inferFromContravariantTypes(source, target);
    this.priority = savePriority;
  }

  inferFromContravariantTypes(source: Type, target: Type): void {
    this.contravariant = !this.contravariant;
    this.inferFromTypes(source, target);
    this.contravariant = !this.contravariant;
  }

  inferFromContravariantTypesIfStrictFunctionTypes(source: Type, target: Type): void {
    if (this.c.strictFunctionTypes || (this.priority & InferencePriority.AlwaysStrict) !== 0)
      this.inferFromContravariantTypes(source, target);
    else this.inferFromTypes(source, target);
  }

  /** Runs `action` once per source and target pair, stopping at circularities. */
  invokeOnce(source: Type, target: Type, action: InferenceAction): void {
    // As in tsc, a pair is visited once for each priority and variance it is inferred with.
    const mode = visitMode(this.priority, this.contravariant, this.bivariant);
    const key = visitKey(source, target);
    // One map lookup for the pair, and the same map for both of its updates below.
    const pairs = key >= 0 ? this.visitedOf(mode) : undefined;
    const status =
      pairs !== undefined ? pairs.get(key) : this.visitedSpelled?.get(source.id + ',' + target.id + ',' + mode);
    if (status !== undefined) {
      this.inferencePriority = Math.min(this.inferencePriority, status);
      return;
    }
    if (pairs !== undefined) pairs.set(key, InferencePriority.Circularity);
    else this.setVisitedSpelled(source, target, mode, InferencePriority.Circularity);
    const saveInferencePriority = this.inferencePriority;
    this.inferencePriority = InferencePriority.MaxValue;
    // Duplicate recursion identities on both sides mean a circularity.
    const saveExpandingFlags = this.expandingFlags;
    const stackDepth = this.stackDepth;
    setStackEntry(this.sourceStack, stackDepth, source);
    setStackEntry(this.targetStack, stackDepth, target);
    this.stackDepth = stackDepth + 1;
    if (isDeeplyNestedType(this.c, source, this.sourceStack, stackDepth + 1, 2))
      this.expandingFlags |= ExpandingFlags.Source;
    if (isDeeplyNestedType(this.c, target, this.targetStack, stackDepth + 1, 2))
      this.expandingFlags |= ExpandingFlags.Target;
    if (this.expandingFlags !== ExpandingFlags.Both) {
      switch (action) {
        case InferenceAction.AliasTypeArguments:
          this.inferFromAliasTypeArguments(source, target);
          break;
        case InferenceAction.ConditionalType:
          this.inferToConditionalType(source, target as ConditionalType);
          break;
        case InferenceAction.GenericMappedTypes:
          this.inferFromGenericMappedTypes(source as MappedType, target as MappedType);
          break;
        case InferenceAction.ObjectTypes:
          this.inferFromObjectTypes(source, target);
          break;
        case InferenceAction.ReferenceTypeArguments:
          this.inferFromReferenceTypeArguments(source, target);
          break;
      }
    } else this.inferencePriority = InferencePriority.Circularity;
    this.stackDepth = stackDepth;
    this.expandingFlags = saveExpandingFlags;
    if (pairs !== undefined) pairs.set(key, this.inferencePriority);
    else this.setVisitedSpelled(source, target, mode, this.inferencePriority);
    this.inferencePriority = Math.min(this.inferencePriority, saveInferencePriority);
  }

  // Source and target are instantiations of the same type alias: infers between the type arguments, with defaults
  // applied.
  inferFromAliasTypeArguments(source: Type, target: Type): void {
    const c = this.c;
    const sourceAlias = source.alias!;
    const params = c.symbolLinks(sourceAlias.symbol).typeParameters ?? [];
    const minParams = getMinTypeArgumentCount(c, params);
    const isJavaScript = isInJSFile(sourceAlias.symbol.valueDeclaration);
    const sourceTypes = fillMissingTypeArguments(c, sourceAlias.typeArguments, params, minParams, isJavaScript);
    const targetTypes = fillMissingTypeArguments(c, target.alias!.typeArguments, params, minParams, isJavaScript);
    this.inferFromTypeArguments(
      sourceTypes,
      targetTypes,
      someTypeCouldHoldInference(c, targetTypes) ? getAliasVariances(c, sourceAlias.symbol) : noVariances,
    );
  }

  /** The visited pairs of `mode` (`visited`), created on first use. */
  visitedOf(mode: number): Map<number, InferencePriority> {
    if (mode === this.visitedMode) return this.visitedPairs!;
    let modes = this.visited;
    if (modes === undefined) {
      modes = new Map<number, Map<number, InferencePriority>>();
      this.visited = modes;
    }
    let pairs = modes.get(mode);
    if (pairs === undefined) {
      pairs = new Map<number, InferencePriority>();
      modes.set(mode, pairs);
    }
    this.visitedMode = mode;
    this.visitedPairs = pairs;
    return pairs;
  }

  /** Records the status of a pair whose ids are too large for `visitKey`. */
  setVisitedSpelled(source: Type, target: Type, mode: number, status: InferencePriority): void {
    let visited = this.visitedSpelled;
    if (visited === undefined) {
      visited = new Map<string, InferencePriority>();
      this.visitedSpelled = visited;
    }
    visited.set(source.id + ',' + target.id + ',' + mode, status);
  }

  inferFromMatchingTypes(sources: Type[], targets: Type[], kind: MatchKind): MatchedTypes {
    const c = this.c;
    const matchedSources: Type[] = [];
    const matchedTargets: Type[] = [];
    for (const t of targets)
      for (const s of sources)
        if (typesMatch(c, s, t, kind)) {
          if (kind !== MatchKind.CloselyMatched) this.inferFromTypes(s, t);
          if (!matchedSources.includes(s)) matchedSources.push(s);
          if (!matchedTargets.includes(t)) matchedTargets.push(t);
        }
    if (kind === MatchKind.CloselyMatched) {
      // Infer to closely matched targets in decreasing depth of generic instantiations: an inference
      // from a more deeply nested type argument has had more layers of instantiation stripped away. For
      // example, from `string[] | string[][]` to `T[] | T[][]`, relating `string[][]` to `T[][]` infers
      // `string`, a better inference than the `string[]` that relating `string[][]` to `T[]` infers.
      matchedTargets.sort((t1, t2) => compareTypesAndDepth(c, t1, t2));
      for (const t of matchedTargets)
        for (const s of matchedSources) if (typesMatch(c, s, t, kind)) this.inferFromTypes(s, t);
    }
    return new MatchedTypes(
      matchedSources.length !== 0 ? sources.filter((t) => !matchedSources.includes(t)) : sources,
      matchedTargets.length !== 0 ? targets.filter((t) => !matchedTargets.includes(t)) : targets,
    );
  }

  inferToMultipleTypes(source: Type, targets: Type[], targetFlags: TypeFlags): void {
    let typeVariableCount = 0;
    if ((targetFlags & TypeFlags.Union) !== 0) {
      let nakedTypeVariable: Type | undefined = undefined;
      const sources = (source.flags & TypeFlags.Union) !== 0 ? typesOf(source) : [source];
      const matched: boolean[] = [];
      for (let i = 0; i < sources.length; i++) matched.push(false);
      let inferenceCircularity = false;
      // Infer to targets that aren't naked type variables first, tracking which sources produced
      // inferences of the same quality as a naked type variable would get.
      for (const t of targets) {
        if (this.infoFor(t) !== undefined) {
          nakedTypeVariable = t;
          typeVariableCount++;
        } else
          for (let i = 0; i < sources.length; i++) {
            const saveInferencePriority = this.inferencePriority;
            this.inferencePriority = InferencePriority.MaxValue;
            this.inferFromTypes(sources[i]!, t);
            if (this.inferencePriority === this.priority) matched[i] = true;
            inferenceCircularity = inferenceCircularity || this.inferencePriority === InferencePriority.Circularity;
            this.inferencePriority = Math.min(this.inferencePriority, saveInferencePriority);
          }
      }
      if (typeVariableCount === 0) {
        // Infer `A | B` for T from `A | B` to `T & (X | Y)`.
        const intersectionTypeVariable = this.getSingleTypeVariableFromIntersectionTypes(targets);
        if (intersectionTypeVariable !== undefined)
          this.inferWithPriority(source, intersectionTypeVariable, InferencePriority.NakedTypeVariable);
        return;
      }
      // With a single naked type variable and no circularities, infer the unmatched sources to it.
      if (typeVariableCount === 1 && !inferenceCircularity) {
        const unmatched: Type[] = [];
        for (let i = 0; i < sources.length; i++) if (!matched[i]) unmatched.push(sources[i]!);
        if (unmatched.length !== 0) {
          this.inferFromTypes(getUnionType(this.c, unmatched), nakedTypeVariable!);
          return;
        }
      }
    } else {
      // Inferences from nested naked type variables come first among the candidates.
      for (const t of targets) {
        if (this.infoFor(t) !== undefined) typeVariableCount++;
        else this.inferFromTypes(source, t);
      }
    }
    // Inferences directly to naked type variables get lower priority.
    if (
      ((targetFlags & TypeFlags.Intersection) !== 0 && typeVariableCount === 1) ||
      ((targetFlags & TypeFlags.Intersection) === 0 && typeVariableCount > 0)
    )
      for (const t of targets)
        if (this.infoFor(t) !== undefined) this.inferWithPriority(source, t, InferencePriority.NakedTypeVariable);
  }

  getSingleTypeVariableFromIntersectionTypes(types: Type[]): Type | undefined {
    let typeVariable: Type | undefined = undefined;
    for (const t of types) {
      if ((t.flags & TypeFlags.Intersection) === 0) return undefined;
      let v: Type | undefined;
      for (const u of typesOf(t)) {
        if (this.infoFor(u) !== undefined) {
          v = u;
          break;
        }
      }
      if (v === undefined || (typeVariable !== undefined && v !== typeVariable)) return undefined;
      typeVariable = v;
    }
    return typeVariable;
  }

  inferToConditionalType(source: Type, target: ConditionalType): void {
    const c = this.c;
    if ((source.flags & TypeFlags.Conditional) !== 0) {
      const s = source as ConditionalType;
      // A source's distributed type parameters infer as the type parameters they were made from.
      this.inferFromTypes(getNonDistributedTypeParameter(s.checkType), target.checkType);
      this.inferFromTypes(getNonDistributedTypeParameter(s.extendsType), target.extendsType);
      this.inferFromTypes(
        getNonDistributedTypeParameter(getTrueTypeFromConditionalType(c, s)),
        getTrueTypeFromConditionalType(c, target),
      );
      this.inferFromTypes(
        getNonDistributedTypeParameter(getFalseTypeFromConditionalType(c, s)),
        getFalseTypeFromConditionalType(c, target),
      );
    } else {
      const savePriority = this.priority;
      this.priority |= this.contravariant ? InferencePriority.ContravariantConditional : 0;
      this.inferToMultipleTypes(source, getBranchTypesFromConditionalType(c, target), target.flags);
      this.priority = savePriority;
    }
  }

  inferToTemplateLiteralType(source: Type, target: TemplateLiteralType): void {
    const c = this.c;
    const matches = inferTypesFromTemplateLiteralType(c, source, target);
    const types = target.types;
    // When the target has only placeholders and nothing matches, infer `never` for each so that
    // instantiation produces `never` rather than collapsing to the constraint.
    if (matches === undefined && !target.texts.every((s) => s === '')) return;
    for (let i = 0; i < types.length; i++) {
      const placeholder = types[i]!;
      const matchSource = matches !== undefined ? matches[i]! : c.neverType;
      if ((matchSource.flags & TypeFlags.StringLiteral) !== 0 && (placeholder.flags & TypeFlags.TypeVariable) !== 0) {
        const info = this.infoFor(placeholder);
        if (info !== undefined) {
          const constraint = getBaseConstraintOfType(c, info.typeParameter);
          if (constraint !== undefined && (constraint.flags & TypeFlags.Any) === 0) {
            const matching = getTemplatePlaceholderInference(c, matchSource as LiteralType, constraint);
            if (matching !== undefined) {
              this.inferFromTypes(matching, placeholder);
              continue;
            }
          }
        }
      }
      this.inferFromTypes(matchSource, placeholder);
    }
  }

  inferFromGenericMappedTypes(source: MappedType, target: MappedType): void {
    // From `{ [P in S]: X }` to `{ [P in T]: Y }`, infer from S to T and from X to Y.
    const c = this.c;
    this.inferFromTypes(getConstraintTypeFromMappedType(c, source), getConstraintTypeFromMappedType(c, target));
    this.inferFromTypes(getTemplateTypeFromMappedType(c, source), getTemplateTypeFromMappedType(c, target));
    const sourceNameType = getNameTypeFromMappedType(c, source);
    const targetNameType = getNameTypeFromMappedType(c, target);
    if (sourceNameType !== undefined && targetNameType !== undefined)
      this.inferFromTypes(sourceNameType, targetNameType);
  }

  inferFromObjectTypes(source: Type, target: Type): void {
    const c = this.c;
    if (
      (source.objectFlags & ObjectFlags.Reference) !== 0 &&
      (target.objectFlags & ObjectFlags.Reference) !== 0 &&
      (referenceTarget(source) === referenceTarget(target) || (isArrayType(c, source) && isArrayType(c, target)))
    ) {
      this.inferFromReferenceTypeArguments(source, target);
      return;
    }
    if (isGenericMappedType(c, source) && isGenericMappedType(c, target))
      this.inferFromGenericMappedTypes(source as MappedType, target as MappedType);
    if ((target.objectFlags & ObjectFlags.Mapped) !== 0 && !hasMappedNameType(target as MappedType)) {
      const constraintType = getConstraintTypeFromMappedType(c, target as MappedType);
      if (this.inferToMappedType(source, target as MappedType, constraintType)) return;
    }
    // Infer from members only when the types are possibly related.
    if (typesDefinitelyUnrelated(c, source, target)) return;
    if (isArrayOrTupleType(c, source)) {
      if (isTupleType(target)) {
        this.inferFromTupleTypes(source, target);
        return;
      }
      if (isArrayType(c, target)) {
        this.inferFromIndexTypes(source, target);
        return;
      }
    }
    this.inferFromProperties(source, target);
    this.inferFromSignatures(source, target, SignatureKind.Call);
    this.inferFromSignatures(source, target, SignatureKind.Construct);
    this.inferFromIndexTypes(source, target);
  }

  inferFromTupleTypes(source: Type, target: Type): void {
    const c = this.c;
    const sourceArity = getTypeReferenceArity(source);
    const targetArity = getTypeReferenceArity(target);
    const elementTypes = getTypeArguments(c, target);
    const targetTuple = tupleTargetOf(target);
    const elementInfos = targetTuple.elementInfos;
    const sourceTypes = getTypeArguments(c, source);
    // Tuples of the same structure: infer between the element types.
    if (isTupleType(source) && isTupleTypeStructureMatching(source, target)) {
      for (let i = 0; i < targetArity; i++) this.inferFromTypes(sourceTypes[i]!, elementTypes[i]!);
      return;
    }
    let startLength = 0;
    let endLength = 0;
    if (isTupleType(source)) {
      const sourceTuple = tupleTargetOf(source);
      startLength = Math.min(sourceTuple.fixedLength, targetTuple.fixedLength);
      if ((targetTuple.combinedFlags & ElementFlags.Variable) !== 0)
        endLength = Math.min(
          getEndElementCount(sourceTuple, ElementFlags.Fixed),
          getEndElementCount(targetTuple, ElementFlags.Fixed),
        );
    }
    for (let i = 0; i < startLength; i++) this.inferFromTypes(sourceTypes[i]!, elementTypes[i]!);
    if (
      !isTupleType(source) ||
      (sourceArity - startLength - endLength === 1 &&
        (tupleTargetOf(source).elementInfos[startLength]!.flags & ElementFlags.Rest) !== 0)
    ) {
      // A single rest element remains in the source; infer from it to every middle target element.
      const restType = sourceTypes[startLength]!;
      for (let i = startLength; i < targetArity - endLength; i++)
        this.inferFromTypes(
          (elementInfos[i]!.flags & ElementFlags.Variadic) !== 0 ? createArrayType(c, restType) : restType,
          elementTypes[i]!,
        );
    } else {
      const middleLength = targetArity - startLength - endLength;
      if (middleLength === 2) {
        const first = elementInfos[startLength]!.flags;
        const second = elementInfos[startLength + 1]!.flags;
        if ((first & second & ElementFlags.Variadic) !== 0) {
          // [...T, ...U]: slice the source by the implied arity of T.
          const targetInfo = this.infoFor(elementTypes[startLength]!);
          if (targetInfo !== undefined && targetInfo.impliedArity >= 0) {
            this.inferFromTypes(
              sliceTupleType(c, source, startLength, endLength + sourceArity - targetInfo.impliedArity),
              elementTypes[startLength]!,
            );
            this.inferFromTypes(
              sliceTupleType(c, source, startLength + targetInfo.impliedArity, endLength),
              elementTypes[startLength + 1]!,
            );
          }
        } else if ((first & ElementFlags.Variadic) !== 0 && (second & ElementFlags.Rest) !== 0) {
          // [...T, ...rest]: use the arity of a fixed-size tuple constraint of T.
          const info = this.infoFor(elementTypes[startLength]!);
          if (info !== undefined) {
            const constraint = getBaseConstraintOfType(c, info.typeParameter);
            if (
              constraint !== undefined &&
              isTupleType(constraint) &&
              (tupleTargetOf(constraint).combinedFlags & ElementFlags.Variable) === 0
            ) {
              const impliedArity = tupleTargetOf(constraint).fixedLength;
              this.inferFromTypes(
                sliceTupleType(c, source, startLength, sourceArity - (startLength + impliedArity)),
                elementTypes[startLength]!,
              );
              const restType = getElementTypeOfSliceOfTupleType(
                c,
                source,
                startLength + impliedArity,
                endLength,
                false,
                false,
              );
              if (restType !== undefined) this.inferFromTypes(restType, elementTypes[startLength + 1]!);
            }
          }
        } else if ((first & ElementFlags.Rest) !== 0 && (second & ElementFlags.Variadic) !== 0) {
          // [...rest, ...T]: use the arity of a fixed-size tuple constraint of T.
          const info = this.infoFor(elementTypes[startLength + 1]!);
          if (info !== undefined) {
            const constraint = getBaseConstraintOfType(c, info.typeParameter);
            if (
              constraint !== undefined &&
              isTupleType(constraint) &&
              (tupleTargetOf(constraint).combinedFlags & ElementFlags.Variable) === 0
            ) {
              const impliedArity = tupleTargetOf(constraint).fixedLength;
              const endIndex = sourceArity - getEndElementCount(targetTuple, ElementFlags.Fixed);
              const startIndex = endIndex - impliedArity;
              if (startIndex >= startLength) {
                const trailingSlice = createTupleTypeEx(
                  c,
                  sourceTypes.slice(startIndex, endIndex),
                  tupleTargetOf(source).elementInfos.slice(startIndex, endIndex),
                  false,
                );
                const restType = getElementTypeOfSliceOfTupleType(
                  c,
                  source,
                  startLength,
                  endLength + impliedArity,
                  false,
                  false,
                );
                if (restType !== undefined) this.inferFromTypes(restType, elementTypes[startLength]!);
                this.inferFromTypes(trailingSlice, elementTypes[startLength + 1]!);
              }
            }
          }
        }
      } else if (middleLength === 1 && (elementInfos[startLength]!.flags & ElementFlags.Variadic) !== 0) {
        // One variadic middle element: infer the source slice between the fixed parts, speculatively
        // when the target ends in optional elements.
        const priority =
          (elementInfos[targetArity - 1]!.flags & ElementFlags.Optional) !== 0
            ? InferencePriority.SpeculativeTuple
            : InferencePriority.None;
        this.inferWithPriority(sliceTupleType(c, source, startLength, endLength), elementTypes[startLength]!, priority);
      } else if (middleLength === 1 && (elementInfos[startLength]!.flags & ElementFlags.Rest) !== 0) {
        // One rest middle element: infer the union of the middle source elements.
        const restType = getElementTypeOfSliceOfTupleType(c, source, startLength, endLength, false, false);
        if (restType !== undefined) this.inferFromTypes(restType, elementTypes[startLength]!);
      }
    }
    for (let i = 0; i < endLength; i++)
      this.inferFromTypes(sourceTypes[sourceArity - i - 1]!, elementTypes[targetArity - i - 1]!);
  }

  inferFromProperties(source: Type, target: Type): void {
    const c = this.c;
    for (const targetProp of getPropertiesOfObjectType(c, target)) {
      const sourceProp = getPropertyOfType(c, source, targetProp.name);
      if (sourceProp !== undefined)
        this.inferFromTypes(
          removeMissingType(c, getTypeOfSymbol(c, sourceProp), (sourceProp.flags & SymbolFlags.Optional) !== 0),
          removeMissingType(c, getTypeOfSymbol(c, targetProp), (targetProp.flags & SymbolFlags.Optional) !== 0),
        );
    }
  }

  inferFromSignatures(source: Type, target: Type, kind: SignatureKind): void {
    const c = this.c;
    const sourceSignatures = getSignaturesOfType(c, source, kind);
    const sourceLen = sourceSignatures.length;
    if (sourceLen === 0) return;
    // Match signatures from the bottom up; excess targets infer from the first source signature.
    const targetSignatures = getSignaturesOfType(c, target, kind);
    const targetLen = targetSignatures.length;
    for (let i = 0; i < targetLen; i++) {
      const sourceIndex = Math.max(sourceLen - targetLen + i, 0);
      this.inferFromSignature(
        getBaseSignature(c, sourceSignatures[sourceIndex]!),
        getErasedSignature(c, targetSignatures[i]!),
      );
    }
  }

  inferFromSignature(source: Signature, target: Signature): void {
    const c = this.c;
    if ((source.flags & SignatureFlags.IsNonInferrable) === 0) {
      const saveBivariant = this.bivariant;
      const kind = target.declaration !== undefined ? target.declaration.kind : SyntaxKind.Unknown;
      // Once in a bivariant signature, nested inferences stay bivariant.
      this.bivariant =
        this.bivariant ||
        kind === SyntaxKind.MethodDeclaration ||
        kind === SyntaxKind.MethodSignature ||
        kind === SyntaxKind.Constructor;
      applyToParameterTypes(c, source, target, (s, t) => this.inferFromContravariantTypesIfStrictFunctionTypes(s, t));
      this.bivariant = saveBivariant;
    }
    applyToReturnTypes(c, source, target, (s, t) => this.inferFromTypes(s, t));
  }

  inferFromIndexTypes(source: Type, target: Type): void {
    const c = this.c;
    // Inferences across mapped type index signatures are like inferences to homomorphic variables.
    const priority =
      (source.objectFlags & target.objectFlags & ObjectFlags.Mapped) !== 0
        ? InferencePriority.HomomorphicMappedType
        : InferencePriority.None;
    const indexInfos = getIndexInfosOfType(c, target);
    if (isObjectTypeWithInferableIndex(c, source))
      for (const targetInfo of indexInfos) {
        const propTypes: Type[] = [];
        for (const prop of getPropertiesOfType(c, source))
          if (
            isApplicableIndexType(
              c,
              getLiteralTypeFromProperty(c, prop, TypeFlags.StringOrNumberLiteralOrUnique, false),
              targetInfo.keyType,
            )
          ) {
            const propType = getTypeOfSymbol(c, prop);
            propTypes.push(
              (prop.flags & SymbolFlags.Optional) !== 0 ? removeMissingOrUndefinedType(c, propType) : propType,
            );
          }
        for (const info of getIndexInfosOfType(c, source))
          if (isApplicableIndexType(c, info.keyType, targetInfo.keyType)) propTypes.push(info.valueType);
        if (propTypes.length !== 0) this.inferWithPriority(getUnionType(c, propTypes), targetInfo.valueType, priority);
      }
    for (const targetInfo of indexInfos) {
      const sourceInfo = getApplicableIndexInfo(c, source, targetInfo.keyType);
      if (sourceInfo !== undefined) this.inferWithPriority(sourceInfo.valueType, targetInfo.valueType, priority);
    }
  }

  inferToMappedType(source: Type, target: MappedType, constraintType: Type): boolean {
    const c = this.c;
    if ((constraintType.flags & TypeFlags.UnionOrIntersection) !== 0) {
      let result = false;
      for (const t of typesOf(constraintType)) result = this.inferToMappedType(source, target, t) || result;
      return result;
    }
    if ((constraintType.flags & TypeFlags.Index) !== 0) {
      // From S to a homomorphic `{ [P in keyof T]: X }`: reverse-map S and make a secondary
      // inference to T, so direct inferences to T win over ones to `Partial<T>`.
      const inference = this.infoFor((constraintType as IndexType).target);
      if (inference !== undefined && !inference.isFixed) {
        const inferredType = inferTypeForHomomorphicMappedType(c, source, target, constraintType as IndexType);
        if (inferredType !== undefined)
          this.inferWithPriority(
            inferredType,
            inference.typeParameter,
            (source.objectFlags & ObjectFlags.NonInferrableType) !== 0
              ? InferencePriority.PartialHomomorphicMappedType
              : InferencePriority.HomomorphicMappedType,
          );
      }
      return true;
    }
    if ((constraintType.flags & TypeFlags.TypeParameter) !== 0) {
      // From S to `{ [P in K]: X }`: infer `keyof S` to K, then to K's constraint like a homomorphic
      // mapped type (for `Pick<T, K>`).
      this.inferWithPriority(
        getIndexTypeEx(c, source, c.patternForType.has(source) ? IndexFlags.NoIndexSignatures : IndexFlags.None),
        constraintType,
        InferencePriority.MappedTypeConstraint,
      );
      const extendedConstraint = getConstraintOfType(c, constraintType);
      if (extendedConstraint !== undefined && this.inferToMappedType(source, target, extendedConstraint)) return true;
      // Otherwise infer the union of the source's property types to X.
      const types: Type[] = [];
      for (const p of getPropertiesOfType(c, source)) types.push(getTypeOfSymbol(c, p));
      for (const info of getIndexInfosOfType(c, source))
        types.push(info !== c.enumNumberIndexInfo ? info.valueType : c.neverType);
      this.inferFromTypes(getUnionType(c, types), getTemplateTypeFromMappedType(c, target));
      return true;
    }
    return false;
  }
}

// ---- Helpers

function getInferenceInfoForType(inferences: InferenceInfo[], t: Type): InferenceInfo | undefined {
  if ((t.flags & TypeFlags.TypeVariable) !== 0) {
    const typeVariable = getNonDistributedTypeParameter(t);
    for (const inference of inferences) if (typeVariable === inference.typeParameter) return inference;
  }
  return undefined;
}

/** Orders types by decreasing depth, then by the regular type ordering. */
function compareTypesAndDepth(c: Checker, t1: Type, t2: Type): number {
  const d1 = getTypeDepth(c, t1, 3);
  const d2 = getTypeDepth(c, t2, 3);
  if (d1 !== d2) return d2 - d1;
  return compareTypes(c, t1, t2);
}

/**
 * The depth of a type, up to `maxDepth`: one plus the largest type argument depth for generic aliased
 * types and type references, the largest constituent depth for unions and intersections, and zero
 * otherwise. The maximum keeps circular types from recursing forever.
 */
function getTypeDepth(c: Checker, t: Type, maxDepth: number): number {
  if (maxDepth !== 0) {
    if (t.alias !== undefined && t.alias.typeArguments.length !== 0)
      return getTypeListDepth(c, t.alias.typeArguments, maxDepth - 1) + 1;
    if ((t.objectFlags & ObjectFlags.Reference) !== 0) {
      const typeArguments = getTypeArguments(c, t);
      if (typeArguments.length !== 0) return getTypeListDepth(c, typeArguments, maxDepth - 1) + 1;
    }
    if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) return getTypeListDepth(c, typesOf(t), maxDepth);
  }
  return 0;
}

function getTypeListDepth(c: Checker, types: readonly Type[], maxDepth: number): number {
  let depth = 0;
  for (const t of types) depth = Math.max(depth, getTypeDepth(c, t, maxDepth));
  return depth;
}

function distributedTypes(t: Type): Type[] {
  return (t.flags & TypeFlags.Union) !== 0 ? typesOf(t) : [t];
}

function referenceTarget(t: Type): Type | undefined {
  return (t as TypeReference).target;
}

function referenceNode(t: Type): Node | undefined {
  return (t as TypeReference).node;
}

const noVariances: VarianceFlags[] = [];

/** Whether inferring to one of `targets` could record a candidate. */
function someTypeCouldHoldInference(c: Checker, targets: readonly Type[]): boolean {
  for (const t of targets) if (couldHoldInference(c, t, 0)) return true;
  return false;
}

/**
 * `couldContainTypeVariables` without two of its conservative answers: a deferred reference without an
 * alias holds type variables only through its type arguments, like any other reference; and the static
 * side of a class declared at the top level of a file or module holds none outside its generic
 * signatures, which inference erases. A deferred reference's type arguments are resolved here unless
 * they are being resolved already, where resolving them would report a circularity.
 */
function couldHoldInference(c: Checker, t: Type, depth: number): boolean {
  if (!couldContainTypeVariables(c, t)) return false;
  if (t.alias !== undefined || depth === 4) return true;
  if ((t.objectFlags & ObjectFlags.Reference) !== 0) {
    const resolved =
      (t as TypeReference).resolvedTypeArguments ??
      sideOf(c, t as TypeReference).resolvedTypeArguments ??
      (findResolutionCycleStartIndex(c, t, TypeSystemPropertyName.ResolvedTypeArguments) < 0
        ? getTypeArguments(c, t)
        : undefined);
    if (resolved === undefined) return true;
    for (const a of resolved) if (couldHoldInference(c, a, depth + 1)) return true;
    return false;
  }
  return !isTopLevelClassStaticSide(t);
}

function isTopLevelClassStaticSide(t: Type): boolean {
  const symbol = t.symbol;
  if (
    (t.objectFlags & ObjectFlags.Anonymous) === 0 ||
    symbol === undefined ||
    (symbol.flags & SymbolFlags.Class) === 0 ||
    (symbol.flags &
      (SymbolFlags.Function | SymbolFlags.Method | SymbolFlags.TypeLiteral | SymbolFlags.ObjectLiteral)) !==
      0 ||
    declarationCount(symbol) === 0
  )
    return false;
  for (const d of getDeclarations(symbol)) {
    if (
      d.kind !== SyntaxKind.ClassDeclaration &&
      d.kind !== SyntaxKind.InterfaceDeclaration &&
      d.kind !== SyntaxKind.ModuleDeclaration
    )
      return false;
    for (let n = d.parent!; n.kind !== SyntaxKind.SourceFile; n = n.parent!)
      if (n.kind !== SyntaxKind.ModuleBlock && n.kind !== SyntaxKind.ModuleDeclaration) return false;
  }
  return true;
}

function isNonGenericObjectType(c: Checker, t: Type): boolean {
  return (t.flags & TypeFlags.Object) !== 0 && !isGenericMappedType(c, t);
}

function hasMappedNameType(t: MappedType): boolean {
  return t.declaration !== undefined && (t.declaration as MappedTypeNode).nameType !== undefined;
}

/** `(T | U)[K]` as `T[K] | U[K]` and `(T & U)[K]` as `T[K] & U[K]`. */
function distributeIndexOverObjectType(c: Checker, objectType: Type, indexType: Type): Type | undefined {
  if (
    (objectType.flags & TypeFlags.Union) !== 0 ||
    ((objectType.flags & TypeFlags.Intersection) !== 0 && !shouldDeferIndexType(c, objectType, IndexFlags.None))
  ) {
    const types: Type[] = [];
    for (const t of typesOf(objectType)) types.push(getSimplifiedType(c, getIndexedAccessType(c, t, indexType), false));
    return (objectType.flags & TypeFlags.Intersection) !== 0 ? getIntersectionType(c, types) : getUnionType(c, types);
  }
  return undefined;
}

/** An object with a property of type `any` for each string literal in `t`. */
function createEmptyObjectTypeFromStringLiteral(c: Checker, t: Type): Type {
  const members = new Map<string, Symbol>();
  for (const u of distributedTypes(t)) {
    if ((u.flags & TypeFlags.StringLiteral) === 0) continue;
    const name = (u as LiteralType).stringValue;
    const literalProp = c.newSymbol(SymbolFlags.Property, name);
    c.symbolTypes.set(getSymbolId(literalProp), c.anyType);
    if (u.symbol !== undefined) {
      copyDeclarations(literalProp, u.symbol);
      literalProp.valueDeclaration = u.symbol.valueDeclaration;
    }
    members.set(name, literalProp);
  }
  const indexInfos: IndexInfo[] =
    (t.flags & TypeFlags.String) !== 0 ? [newIndexInfo(c.stringType, c.emptyObjectType, false, undefined)] : [];
  return createAnonymousType(c, undefined, members, [], [], indexInfos);
}

export function isTypeParameterAtTopLevel(c: Checker, t: Type, tp: Type, depth: number): boolean {
  if (t === tp) return true;
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const u of typesOf(t)) if (isTypeParameterAtTopLevel(c, u, tp, depth)) return true;
    return false;
  }
  return (
    depth < 3 &&
    (t.flags & TypeFlags.Conditional) !== 0 &&
    (isTypeParameterAtTopLevel(c, getTrueTypeFromConditionalType(c, t as ConditionalType), tp, depth + 1) ||
      isTypeParameterAtTopLevel(c, getFalseTypeFromConditionalType(c, t as ConditionalType), tp, depth + 1))
  );
}

function isTypeParameterAtTopLevelInReturnType(c: Checker, signature: Signature, typeParameter: Type): boolean {
  const typePredicate = getTypePredicateOfSignature(c, signature);
  if (typePredicate !== undefined)
    return typePredicate.type !== undefined && isTypeParameterAtTopLevel(c, typePredicate.type, typeParameter, 0);
  return isTypeParameterAtTopLevel(c, getReturnTypeOfSignature(c, signature), typeParameter, 0);
}

function isTypeOrBaseIdenticalTo(c: Checker, s: Type, t: Type): boolean {
  if (t === c.missingType) return s === t;
  return (
    isTypeIdenticalTo(c, s, t) ||
    ((t.flags & TypeFlags.String) !== 0 && (s.flags & TypeFlags.StringLiteral) !== 0) ||
    ((t.flags & TypeFlags.Number) !== 0 && (s.flags & TypeFlags.NumberLiteral) !== 0)
  );
}

function isTypeCloselyMatchedBy(s: Type, t: Type): boolean {
  if (
    (s.flags & TypeFlags.Object) !== 0 &&
    (t.flags & TypeFlags.Object) !== 0 &&
    s.symbol !== undefined &&
    s.symbol === t.symbol
  )
    return true;
  const sa = s.alias;
  const ta = t.alias;
  return sa !== undefined && ta !== undefined && sa.typeArguments.length !== 0 && sa.symbol === ta.symbol;
}

function typesDefinitelyUnrelated(c: Checker, source: Type, target: Type): boolean {
  // Tuples of incompatible arities, or objects that each have a property missing in the other.
  if (isTupleType(source) && isTupleType(target)) {
    const s = tupleTargetOf(source);
    const t = tupleTargetOf(target);
    return (
      ((t.combinedFlags & ElementFlags.Variadic) === 0 && t.minLength > s.minLength) ||
      ((t.combinedFlags & ElementFlags.Variable) === 0 &&
        ((s.combinedFlags & ElementFlags.Variable) !== 0 || t.fixedLength < s.fixedLength))
    );
  }
  return hasUnmatchedProperty(c, source, target, true) && hasUnmatchedProperty(c, target, source, false);
}

/**
 * Whether `getUnmatchedProperty(c, source, target, false, matchDiscriminantProperties)` finds a
 * property, without creating every property of a union or intersection target whose properties
 * aren't resolved yet. That test reports only required properties: a union property is optional
 * when it is optional in any constituent, an intersection property when it is optional in every
 * constituent that has it. So only names required in a constituent (of those
 * `getPropertiesOfUnionOrIntersectionType` reads) are candidates, and the search stops at the first
 * unmatched one. A union property is created only when the result can depend on it: when the source
 * lacks the name, or for the discriminant test when the first constituent's property type is a unit
 * type or never (otherwise the union of the constituents' types is not a unit type).
 */
function hasUnmatchedProperty(c: Checker, source: Type, target: Type, matchDiscriminantProperties: boolean): boolean {
  const t = getReducedApparentType(c, target);
  if (
    (t.flags & TypeFlags.UnionOrIntersection) === 0 ||
    sideOf(c, t as UnionOrIntersectionType).membersOf?.resolvedProperties !== undefined
  )
    return getUnmatchedProperty(c, source, target, false, matchDiscriminantProperties) !== undefined;
  if (c.unresolvedPropertySearches !== undefined) c.unresolvedPropertySearches.push(t);
  const containingType = t as UnionOrIntersectionType;
  const isUnion = (t.flags & TypeFlags.Union) !== 0;
  const checked = new Set<string>();
  for (const current of containingType.types) {
    for (const prop of getPropertiesOfType(c, current)) {
      const name = prop.name;
      if ((prop.flags & SymbolFlags.Optional) !== 0) {
        if (isUnion) checked.add(name);
        continue;
      }
      if (checked.has(name)) continue;
      checked.add(name);
      if (
        isUnion &&
        getPropertyOfType(c, source, name) !== undefined &&
        (!matchDiscriminantProperties || (getTypeOfSymbol(c, prop).flags & (TypeFlags.Unit | TypeFlags.Never)) === 0)
      )
        continue;
      const combined = getPropertyOfUnionOrIntersectionType(c, containingType, name, !isUnion);
      if (combined !== undefined && isUnmatchedProperty(c, source, combined, false, matchDiscriminantProperties))
        return true;
    }
    if (isUnion && getIndexInfosOfType(c, current).length === 0) break;
  }
  return false;
}

function isTupleTypeStructureMatching(t1: Type, t2: Type): boolean {
  if (getTypeReferenceArity(t1) !== getTypeReferenceArity(t2)) return false;
  const infos1 = tupleTargetOf(t1).elementInfos;
  const infos2 = tupleTargetOf(t2).elementInfos;
  for (let i = 0; i < infos1.length; i++)
    if ((infos1[i]!.flags & ElementFlags.Variable) !== (infos2[i]!.flags & ElementFlags.Variable)) return false;
  return true;
}

export function isConstTypeVariable(c: Checker, t: Type | undefined, depth: number): boolean {
  if (depth >= 5 || t === undefined) return false;
  if ((t.flags & TypeFlags.TypeParameter) !== 0) {
    if (t.symbol === undefined) return false;
    for (const d of getDeclarations(t.symbol)) if (hasSyntacticModifier(d, ModifierFlags.Const)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) {
    for (const s of typesOf(t)) if (isConstTypeVariable(c, s, depth)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.IndexedAccess) !== 0)
    return isConstTypeVariable(c, (t as IndexedAccessType).objectType, depth + 1);
  if ((t.flags & TypeFlags.Conditional) !== 0)
    return isConstTypeVariable(c, getConstraintOfConditionalType(c, t), depth + 1);
  if ((t.flags & TypeFlags.Substitution) !== 0) return isConstTypeVariable(c, (t as SubstitutionType).baseType, depth);
  if ((t.objectFlags & ObjectFlags.Mapped) !== 0) {
    const typeVariable = getHomomorphicTypeVariable(c, t as MappedType);
    return typeVariable !== undefined && isConstTypeVariable(c, typeVariable, depth);
  }
  if (isGenericTupleType(t)) {
    const elements = getElementTypes(c, t);
    const infos = tupleTargetOf(t).elementInfos;
    for (let i = 0; i < elements.length; i++)
      if ((infos[i]!.flags & ElementFlags.Variadic) !== 0 && isConstTypeVariable(c, elements[i]!, depth)) return true;
  }
  return false;
}

export function isMutableArrayLikeType(c: Checker, t: Type): boolean {
  return (
    isMutableArrayOrTuple(c, t) ||
    ((t.flags & (TypeFlags.Any | TypeFlags.Nullable | TypeFlags.Never)) === 0 &&
      isTypeAssignableTo(c, t, c.anyArrayType))
  );
}

function typePredicateKindsMatch(a: TypePredicate, b: TypePredicate): boolean {
  return a.kind === b.kind && a.parameterIndex === b.parameterIndex;
}

/** Calls `callback` with each pair of corresponding parameter types of `source` and `target`. */
export function applyToParameterTypes(
  c: Checker,
  source: Signature,
  target: Signature,
  callback: (s: Type, t: Type) => void,
): void {
  const sourceCount = getParameterCount(c, source);
  const targetCount = getParameterCount(c, target);
  const sourceRestType = getEffectiveRestType(c, source);
  const targetRestType = getEffectiveRestType(c, target);
  const targetNonRestCount = targetRestType !== undefined ? targetCount - 1 : targetCount;
  const paramCount = sourceRestType !== undefined ? targetNonRestCount : Math.min(sourceCount, targetNonRestCount);
  const sourceThisType = getThisTypeOfSignature(c, source);
  if (sourceThisType !== undefined) {
    const targetThisType = getThisTypeOfSignature(c, target);
    if (targetThisType !== undefined) callback(sourceThisType, targetThisType);
  }
  for (let i = 0; i < paramCount; i++) callback(getTypeAtPosition(c, source, i), getTypeAtPosition(c, target, i));
  if (targetRestType !== undefined)
    callback(
      getRestTypeAtPosition(
        c,
        source,
        paramCount,
        isConstTypeVariable(c, targetRestType, 0) && !someType(targetRestType, (t) => isMutableArrayLikeType(c, t)),
      ),
      targetRestType,
    );
}

export function applyToReturnTypes(
  c: Checker,
  source: Signature,
  target: Signature,
  callback: (s: Type, t: Type) => void,
): void {
  const targetTypePredicate = getTypePredicateOfSignature(c, target);
  if (targetTypePredicate !== undefined) {
    const sourceTypePredicate = getTypePredicateOfSignature(c, source);
    if (
      sourceTypePredicate !== undefined &&
      typePredicateKindsMatch(sourceTypePredicate, targetTypePredicate) &&
      sourceTypePredicate.type !== undefined &&
      targetTypePredicate.type !== undefined
    ) {
      callback(sourceTypePredicate.type, targetTypePredicate.type);
      return;
    }
  }
  const targetReturnType = getReturnTypeOfSignature(c, target);
  if (couldContainTypeVariables(c, targetReturnType)) callback(getReturnTypeOfSignature(c, source), targetReturnType);
}

/** `signature` with its type parameters replaced by their base constraints. */
export function getBaseSignature(c: Checker, signature: Signature): Signature {
  const typeParameters = signature.typeParameters;
  if (typeParameters.length === 0) return signature;
  const side = signatureSideOf(c, signature);
  if (side.baseSignatureCache !== undefined) return side.baseSignatureCache;
  const constraints: Type[] = [];
  for (const tp of typeParameters) constraints.push(getConstraintOfTypeParameter(c, tp) ?? c.unknownType);
  const baseConstraintMapper = newTypeMapper(typeParameters, constraints);
  let baseConstraints: Type[] = [];
  for (const tp of typeParameters) baseConstraints.push(instantiateType(c, tp, baseConstraintMapper));
  // Resolve non-circular interdependent constraints, then erase what remains circular.
  for (let i = 0; i < typeParameters.length - 1; i++)
    baseConstraints = instantiateTypes(c, baseConstraints, baseConstraintMapper);
  baseConstraints = instantiateTypes(c, baseConstraints, new ArrayToSingleTypeMapper(typeParameters, c.anyType));
  const result = instantiateSignatureEx(c, signature, newTypeMapper(typeParameters, baseConstraints), true);
  side.baseSignatureCache = result;
  return result;
}

export function getTypeParametersForMapper(c: Checker, signature: Signature): Type[] {
  const result: Type[] = [];
  for (const tp of signature.typeParameters) result.push(instantiateType(c, tp, (tp as TypeParameter).mapper));
  return result;
}

/** The generic `signature` instantiated in the context of the non-generic `contextualSignature`. */
export function instantiateSignatureInContextOf(
  c: Checker,
  signature: Signature,
  contextualSignature: Signature,
  inferenceContext: InferenceContext | undefined,
  compareTypes: TypeComparer | undefined,
): Signature {
  const context = createInferenceContext(
    c,
    getTypeParametersForMapper(c, signature),
    signature,
    InferenceFlags.None,
    compareTypes,
  );
  // Clone so that inferring through a rest type parameter doesn't fix it.
  const restType = getEffectiveRestType(c, contextualSignature);
  const mapper =
    inferenceContext !== undefined
      ? restType !== undefined && (restType.flags & TypeFlags.TypeParameter) !== 0
        ? inferenceContext.nonFixingMapper
        : inferenceContext.mapper
      : undefined;
  const sourceSignature =
    mapper !== undefined ? instantiateSignature(c, contextualSignature, mapper) : contextualSignature;
  applyToParameterTypes(c, sourceSignature, signature, (source, target) =>
    inferTypes(c, context.inferences, source, target, InferencePriority.None, false),
  );
  if (inferenceContext === undefined)
    applyToReturnTypes(c, contextualSignature, signature, (source, target) =>
      inferTypes(c, context.inferences, source, target, InferencePriority.ReturnType, false),
    );
  return getSignatureInstantiation(
    c,
    signature,
    getInferredTypes(c, context),
    contextualSignature.declaration !== undefined &&
      (contextualSignature.declaration.flags & NodeFlags.JavaScriptFile) !== 0,
  );
}

// ---- Template literal inference

/**
 * Whether `source`, a string literal or a template literal type, fails the start and end text test of
 * `inferFromLiteralPartsToTemplateLiteral` against `target`: its first text does not start with the
 * target's first text, its last text does not end with the target's last text, or a string literal
 * is shorter than both. `inferTypesFromTemplateLiteralType` returns undefined then.
 */
export function failsTemplateLiteralTextTest(source: Type, target: TemplateLiteralType): boolean {
  const targetTexts = target.texts;
  const targetStartText = targetTexts[0]!;
  const targetEndText = targetTexts[targetTexts.length - 1]!;
  if ((source.flags & TypeFlags.StringLiteral) !== 0) {
    const text = (source as LiteralType).stringValue;
    return (
      text.length < targetStartText.length + targetEndText.length ||
      !text.startsWith(targetStartText) ||
      !text.endsWith(targetEndText)
    );
  }
  const sourceTexts = (source as TemplateLiteralType).texts;
  return !sourceTexts[0]!.startsWith(targetStartText) || !sourceTexts[sourceTexts.length - 1]!.endsWith(targetEndText);
}

/**
 * Whether `source` is a string literal, or a template literal type whose placeholders are `string`,
 * `number` or `bigint`, that fails the start and end text test against `target`. It is then not
 * assignable to `target`, and relating the two has no other effect: such a template has no type
 * variables for a variance marker mapper to find.
 */
export function isUnmatchedTemplateLiteralKey(source: Type, target: TemplateLiteralType): boolean {
  if ((source.flags & TypeFlags.TemplateLiteral) !== 0) {
    for (const t of (source as TemplateLiteralType).types)
      if ((t.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.BigInt)) === 0) return false;
  } else if ((source.flags & TypeFlags.StringLiteral) === 0) return false;
  return failsTemplateLiteralTextTest(source, target);
}

/** The types matched by `target`'s placeholders in `source`, or undefined if it doesn't match. */
/**
 * The types that `source` gives the placeholders of `target`. A placeholder of a source template with the same
 * texts keeps its type where `compareTypes` (assignability by default) relates their base constraints.
 */
export function inferTypesFromTemplateLiteralType(
  c: Checker,
  source: Type,
  target: TemplateLiteralType,
  compareTypes?: TemplateTypeComparer,
): Type[] | undefined {
  if ((source.flags & TypeFlags.StringLiteral) !== 0) {
    // Most string literals fail the start and end text test; apply it before building the
    // one-element source texts.
    if (failsTemplateLiteralTextTest(source, target)) return undefined;
    return inferFromLiteralPartsToTemplateLiteral(c, [(source as LiteralType).stringValue], emptyTypes, target);
  }
  if ((source.flags & TypeFlags.TemplateLiteral) !== 0) {
    const s = source as TemplateLiteralType;
    if (arraysEqual(s.texts, target.texts)) {
      const result: Type[] = [];
      for (let i = 0; i < s.types.length; i++) {
        const t = s.types[i]!;
        const sourceConstraint = getBaseConstraintOrType(c, t);
        const targetConstraint = getBaseConstraintOrType(c, target.types[i]!);
        const related =
          compareTypes !== undefined
            ? compareTypes(sourceConstraint, targetConstraint)
            : isTypeAssignableTo(c, sourceConstraint, targetConstraint);
        result.push(related ? t : getStringLikeTypeForType(c, t));
      }
      return result;
    }
    return inferFromLiteralPartsToTemplateLiteral(c, s.texts, s.types, target);
  }
  return undefined;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function getStringLikeTypeForType(c: Checker, t: Type): Type {
  return (t.flags & (TypeFlags.Any | TypeFlags.StringLike)) !== 0 ? t : getTemplateLiteralType(c, ['', ''], [t]);
}

/** Matches the text and type parts of a source literal against a target template literal. */
class TemplateMatcher {
  readonly c: Checker;
  readonly sourceTexts: string[];
  readonly sourceTypes: Type[];
  readonly lastSourceIndex: number;
  readonly remainingEndText: string;
  seg = 0;
  pos: number;
  readonly matches: Type[] = [];

  constructor(c: Checker, sourceTexts: string[], sourceTypes: Type[], remainingEndText: string, pos: number) {
    this.c = c;
    this.sourceTexts = sourceTexts;
    this.sourceTypes = sourceTypes;
    this.lastSourceIndex = sourceTexts.length - 1;
    this.remainingEndText = remainingEndText;
    this.pos = pos;
  }

  sourceText(index: number): string {
    return index < this.lastSourceIndex ? this.sourceTexts[index]! : this.remainingEndText;
  }

  addMatch(s: number, p: number): void {
    let matchType: Type;
    if (s === this.seg) matchType = getStringLiteralType(this.c, this.sourceText(s).substring(this.pos, p));
    else {
      const texts: string[] = [this.sourceTexts[this.seg]!.substring(this.pos)];
      for (let i = this.seg + 1; i < s; i++) texts.push(this.sourceTexts[i]!);
      texts.push(this.sourceText(s).substring(0, p));
      matchType = getTemplateLiteralType(this.c, texts, this.sourceTypes.slice(this.seg, s));
    }
    this.matches.push(matchType);
    this.seg = s;
    this.pos = p;
  }
}

function inferFromLiteralPartsToTemplateLiteral(
  c: Checker,
  sourceTexts: string[],
  sourceTypes: Type[],
  target: TemplateLiteralType,
): Type[] | undefined {
  const lastSourceIndex = sourceTexts.length - 1;
  const sourceStartText = sourceTexts[0]!;
  const sourceEndText = sourceTexts[lastSourceIndex]!;
  const targetTexts = target.texts;
  const lastTargetIndex = targetTexts.length - 1;
  const targetStartText = targetTexts[0]!;
  const targetEndText = targetTexts[lastTargetIndex]!;
  if (
    (lastSourceIndex === 0 && sourceStartText.length < targetStartText.length + targetEndText.length) ||
    !sourceStartText.startsWith(targetStartText) ||
    !sourceEndText.endsWith(targetEndText)
  )
    return undefined;
  const m = new TemplateMatcher(
    c,
    sourceTexts,
    sourceTypes,
    sourceEndText.substring(0, sourceEndText.length - targetEndText.length),
    targetStartText.length,
  );
  for (let i = 1; i < lastTargetIndex; i++) {
    const delim = targetTexts[i]!;
    if (delim.length > 0) {
      let s = m.seg;
      let p = m.pos;
      for (;;) {
        const d = m.sourceText(s).indexOf(delim, p);
        if (d >= 0) {
          p = d;
          break;
        }
        s++;
        if (s === sourceTexts.length) return undefined;
        p = 0;
      }
      m.addMatch(s, p);
      m.pos += delim.length;
    } else if (m.pos < m.sourceText(m.seg).length) {
      // Consume one code point.
      const code = m.sourceText(m.seg).codePointAt(m.pos)!;
      m.addMatch(m.seg, m.pos + (code > 0xffff ? 2 : 1));
    } else if (m.seg < lastSourceIndex) m.addMatch(m.seg + 1, 0);
    else return undefined;
  }
  m.addMatch(lastSourceIndex, m.sourceText(lastSourceIndex).length);
  return m.matches;
}

/** For a string literal inferred to a placeholder constrained to primitives, the literal type the constraint prefers. */
function getTemplatePlaceholderInference(c: Checker, source: LiteralType, constraint: Type): Type | undefined {
  let allTypeFlags = TypeFlags.None;
  for (const t of distributedTypes(constraint)) allTypeFlags |= t.flags;
  // A constraint including `string` needs no more specific type.
  if ((allTypeFlags & TypeFlags.String) !== 0) return undefined;
  const str = source.stringValue;
  if ((allTypeFlags & TypeFlags.NumberLike) !== 0 && !isValidNumberString(str, true))
    allTypeFlags &= ~TypeFlags.NumberLike;
  if ((allTypeFlags & TypeFlags.BigIntLike) !== 0 && !isValidBigIntString(str, true))
    allTypeFlags &= ~TypeFlags.BigIntLike;
  let matching: Type = c.neverType;
  for (const t of distributedTypes(constraint))
    matching = choosePlaceholderType(c, matching, t, source, str, allTypeFlags);
  return (matching.flags & TypeFlags.Never) === 0 ? matching : undefined;
}

function choosePlaceholderType(
  c: Checker,
  left: Type,
  right: Type,
  source: LiteralType,
  str: string,
  allTypeFlags: TypeFlags,
): Type {
  if ((right.flags & allTypeFlags) === 0) return left;
  if ((left.flags & TypeFlags.String) !== 0) return left;
  if ((right.flags & TypeFlags.String) !== 0) return source;
  if ((left.flags & TypeFlags.TemplateLiteral) !== 0) return left;
  if (
    (right.flags & TypeFlags.TemplateLiteral) !== 0 &&
    isTypeMatchedByTemplateLiteralType(c, source, right as TemplateLiteralType)
  )
    return source;
  if ((left.flags & TypeFlags.StringMapping) !== 0) return left;
  if ((right.flags & TypeFlags.StringMapping) !== 0 && str === applyStringMapping(right.symbol!, str)) return source;
  if ((left.flags & TypeFlags.StringLiteral) !== 0) return left;
  if ((right.flags & TypeFlags.StringLiteral) !== 0 && (right as LiteralType).stringValue === str) return right;
  if ((left.flags & TypeFlags.Number) !== 0) return left;
  if ((right.flags & TypeFlags.Number) !== 0) return getNumberLiteralType(c, Number(str));
  if ((left.flags & TypeFlags.Enum) !== 0) return left;
  if ((right.flags & TypeFlags.Enum) !== 0) return getNumberLiteralType(c, Number(str));
  if ((left.flags & TypeFlags.NumberLiteral) !== 0) return left;
  if ((right.flags & TypeFlags.NumberLiteral) !== 0 && (right as LiteralType).numberValue === Number(str)) return right;
  if ((left.flags & TypeFlags.BigInt) !== 0) return left;
  if ((right.flags & TypeFlags.BigInt) !== 0) return getBigIntLiteralType(c, parsePseudoBigInt(str));
  if ((left.flags & TypeFlags.BigIntLiteral) !== 0) return left;
  if ((right.flags & TypeFlags.BigIntLiteral) !== 0 && (right as LiteralType).stringValue === str) return right;
  if ((left.flags & TypeFlags.Boolean) !== 0) return left;
  if ((right.flags & TypeFlags.Boolean) !== 0)
    return str === 'true' ? c.trueType : str === 'false' ? c.falseType : c.booleanType;
  if ((left.flags & TypeFlags.BooleanLiteral) !== 0) return left;
  if ((right.flags & TypeFlags.BooleanLiteral) !== 0 && (right as LiteralType).stringValue === str) return right;
  if ((left.flags & TypeFlags.Undefined) !== 0) return left;
  if ((right.flags & TypeFlags.Undefined) !== 0 && (right as IntrinsicType).intrinsicName === str) return right;
  if ((left.flags & TypeFlags.Null) !== 0) return left;
  if ((right.flags & TypeFlags.Null) !== 0 && (right as IntrinsicType).intrinsicName === str) return right;
  return left;
}

export function isValidNumberString(s: string, roundTripOnly: boolean): boolean {
  if (s === '') return false;
  const n = Number(s);
  return isFinite(n) && (!roundTripOnly || String(n) === s);
}

/** Whether `s` scans as a bigint literal without separators; round-trippable ones print as written. */
export function isValidBigIntString(s: string, roundTripOnly: boolean): boolean {
  if (roundTripOnly) return /^-?(0|[1-9][0-9]*)$/.test(s) && s !== '-0';
  return /^-?(0|[1-9][0-9]*|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+)$/.test(s);
}

// ---- Reverse mapped types

/** Infers a source type for the homomorphic mapped type `{ [P in keyof T]: X }`, cached. */
export function inferTypeForHomomorphicMappedType(
  c: Checker,
  source: Type,
  target: MappedType,
  constraint: IndexType,
): Type | undefined {
  const key = source.id + ',' + target.id + ',' + constraint.id;
  const caches = c.inferenceCaches;
  if (caches.reverseHomomorphicMapped.has(key)) return caches.reverseHomomorphicMapped.get(key);
  const t = createReverseMappedType(c, source, target, constraint);
  caches.reverseHomomorphicMapped.set(key, t);
  return t;
}

function createReverseMappedType(
  c: Checker,
  source: Type,
  target: MappedType,
  constraint: IndexType,
): Type | undefined {
  // Reverse mappable: a string index signature, or properties of a partially inferable type.
  if (
    !(
      getIndexInfoOfType(c, source, c.stringType) !== undefined ||
      (getPropertiesOfType(c, source).length !== 0 && isPartiallyInferableType(c, source))
    )
  )
    return undefined;
  // Arrays and tuples map to arrays and tuples of reverse-mapped elements.
  if (isArrayType(c, source)) {
    const elementType = inferReverseMappedType(c, getTypeArguments(c, source)[0]!, target, constraint);
    if (elementType === undefined) return undefined;
    return createArrayTypeEx(c, elementType, isReadonlyArrayType(c, source));
  }
  if (isTupleType(source)) {
    const elementTypes: Type[] = [];
    for (const t of getElementTypes(c, source)) {
      const e = inferReverseMappedType(c, t, target, constraint);
      if (e === undefined) return undefined;
      elementTypes.push(e);
    }
    let elementInfos = tupleTargetOf(source).elementInfos;
    if ((getMappedTypeModifiers(target) & MappedTypeModifiers.IncludeOptional) !== 0)
      elementInfos = elementInfos.map((info) =>
        (info.flags & ElementFlags.Optional) !== 0
          ? new TupleElementInfo(ElementFlags.Required, info.labeledDeclaration)
          : info,
      );
    return createTupleTypeEx(c, elementTypes, elementInfos, tupleTargetOf(source).readonly);
  }
  // Other object types map to an object whose properties are reverse-mapped lazily.
  const reversed = newObjectType(c, ObjectFlags.ReverseMapped | ObjectFlags.Anonymous, undefined) as ReverseMappedType;
  reversed.source = source;
  reversed.mappedType = target;
  reversed.constraintType = constraint;
  return reversed;
}

/** Not marked non-inferable, or an object literal or tuple with some inferable part. */
function isPartiallyInferableType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.NonInferrableType) === 0) return true;
  if (isObjectLiteralType(t))
    for (const p of getPropertiesOfType(c, t)) if (isPartiallyInferableType(c, getTypeOfSymbol(c, p))) return true;
  if (isTupleType(t)) for (const e of getElementTypes(c, t)) if (isPartiallyInferableType(c, e)) return true;
  return false;
}

export function inferReverseMappedType(
  c: Checker,
  source: Type,
  target: MappedType,
  constraint: IndexType,
): Type | undefined {
  const key = source.id + ',' + target.id + ',' + constraint.id;
  const caches = c.inferenceCaches;
  if (caches.reverseMapped.has(key)) return caches.reverseMapped.get(key) ?? c.unknownType;
  const stackDepth = caches.reverseStackDepth;
  setStackEntry(caches.reverseSourceStack, stackDepth, source);
  setStackEntry(caches.reverseTargetStack, stackDepth, target as Type);
  caches.reverseStackDepth = stackDepth + 1;
  const saveExpandingFlags = caches.reverseExpandingFlags;
  if (isDeeplyNestedType(c, source, caches.reverseSourceStack, stackDepth + 1, 2))
    caches.reverseExpandingFlags |= ExpandingFlags.Source;
  if (isDeeplyNestedType(c, target, caches.reverseTargetStack, stackDepth + 1, 2))
    caches.reverseExpandingFlags |= ExpandingFlags.Target;
  let t: Type | undefined = undefined;
  if (caches.reverseExpandingFlags !== ExpandingFlags.Both) {
    const typeParameter = getIndexedAccessType(c, constraint.target, getTypeParameterFromMappedType(c, target));
    const templateType = getTemplateTypeFromMappedType(c, target);
    const inference = new InferenceInfo(typeParameter);
    inferTypes(c, [inference], source, templateType, InferencePriority.None, false);
    t = getWidenedType(c, getTypeFromInference(c, inference) ?? c.unknownType);
  }
  caches.reverseStackDepth = stackDepth;
  caches.reverseExpandingFlags = saveExpandingFlags;
  caches.reverseMapped.set(key, t);
  return t;
}

export function resolveReverseMappedTypeMembers(c: Checker, t: ReverseMappedType): void {
  const source = t.source!;
  const mappedType = t.mappedType as MappedType;
  const constraintType = t.constraintType as IndexType;
  const indexInfo = getIndexInfoOfType(c, source, c.stringType);
  const modifiers = getMappedTypeModifiers(mappedType);
  const readonlyMask = (modifiers & MappedTypeModifiers.IncludeReadonly) === 0;
  const optionalMask = (modifiers & MappedTypeModifiers.IncludeOptional) !== 0 ? 0 : SymbolFlags.Optional;
  const indexInfos: IndexInfo[] =
    indexInfo !== undefined
      ? [
          newIndexInfo(
            c.stringType,
            inferReverseMappedType(c, indexInfo.valueType, mappedType, constraintType) ?? c.unknownType,
            readonlyMask && indexInfo.isReadonly,
            undefined,
          ),
        ]
      : [];
  const members = new Map<string, Symbol>();
  const limitedConstraint = getLimitedConstraint(c, t);
  for (const prop of getPropertiesOfType(c, source)) {
    // With an intersection constraint, skip properties the filtering literals exclude.
    if (limitedConstraint !== undefined) {
      const propertyNameType = getLiteralTypeFromProperty(c, prop, TypeFlags.StringOrNumberLiteralOrUnique, false);
      if (!isTypeAssignableTo(c, propertyNameType, limitedConstraint)) continue;
    }
    const checkFlags = CheckFlags.ReverseMapped | (readonlyMask && isReadonlySymbol(c, prop) ? CheckFlags.Readonly : 0);
    const inferredProp = c.newSymbolWithCheckFlags(
      SymbolFlags.Property | (prop.flags & optionalMask),
      prop.name,
      checkFlags,
    );
    copyDeclarations(inferredProp, prop);
    const links = c.symbolLinks(inferredProp);
    const id = inferredProp.id;
    c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(prop)));
    links.reverseMappedPropertyType = getTypeOfSymbol(c, prop);
    const constraintTarget = constraintType.target;
    if (
      (constraintTarget.flags & TypeFlags.IndexedAccess) !== 0 &&
      ((constraintTarget as IndexedAccessType).objectType.flags & TypeFlags.TypeParameter) !== 0 &&
      ((constraintTarget as IndexedAccessType).indexType.flags & TypeFlags.TypeParameter) !== 0
    ) {
      // `{[K in keyof T[K_1]]: T[K_1]}` reverse-maps like `{[K in keyof T]: T}`.
      const newTypeParam = (constraintTarget as IndexedAccessType).objectType;
      links.reverseMappedMappedType = replaceIndexedAccess(
        c,
        mappedType,
        constraintTarget as IndexedAccessType,
        newTypeParam,
      );
      links.reverseMappedConstraintType = getIndexType(c, newTypeParam);
    } else {
      links.reverseMappedMappedType = mappedType;
      links.reverseMappedConstraintType = constraintType;
    }
    members.set(prop.name, inferredProp);
  }
  setStructuredTypeMembers(c, t, members, [], [], indexInfos);
}

export function getTypeOfReverseMappedSymbol(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  const id = symbol.id;
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type =
      inferReverseMappedType(
        c,
        links.reverseMappedPropertyType!,
        links.reverseMappedMappedType as MappedType,
        links.reverseMappedConstraintType as IndexType,
      ) ?? c.unknownType;
    c.symbolTypes.set(id, type);
  }
  return type;
}

/** The filtering literals of an intersection constraint, e.g. `"a" | "b"` in `keyof U & ("a" | "b")`. */
function getLimitedConstraint(c: Checker, t: ReverseMappedType): Type | undefined {
  const constraint = getConstraintTypeFromMappedType(c, t.mappedType as MappedType);
  if ((constraint.flags & TypeFlags.UnionOrIntersection) === 0) return undefined;
  const origin = (constraint.flags & TypeFlags.Union) !== 0 ? (constraint as UnionType).origin : constraint;
  if (origin === undefined || (origin.flags & TypeFlags.Intersection) === 0) return undefined;
  const limited = getIntersectionType(
    c,
    typesOf(origin).filter((u) => u !== t.constraintType),
  );
  return limited !== c.neverType ? limited : undefined;
}

function replaceIndexedAccess(c: Checker, instantiable: Type, t: IndexedAccessType, replacement: Type): Type {
  // Map the index to 0 and the object to `[replacement]`, making the access `replacement`.
  return instantiateType(
    c,
    instantiable,
    newTypeMapper([t.indexType, t.objectType], [getNumberLiteralType(c, 0), createTupleType(c, [replacement])]),
  );
}

export function instantiateReverseMappedType(c: Checker, t: ReverseMappedType, mapper: TypeMapper): Type {
  const innerMappedType = instantiateType(c, t.mappedType!, mapper);
  if ((innerMappedType.objectFlags & ObjectFlags.Mapped) === 0) return t;
  const innerIndexType = instantiateType(c, t.constraintType!, mapper);
  if ((innerIndexType.flags & TypeFlags.Index) === 0) return t;
  const inferred = inferTypeForHomomorphicMappedType(
    c,
    instantiateType(c, t.source!, mapper),
    innerMappedType as MappedType,
    innerIndexType as IndexType,
  );
  return inferred === undefined ? t : (inferred as Type);
}

// ---- Inferred types

/** Infers early from intra-expression sites (context-sensitive elements of object and array literals). */
export function inferFromIntraExpressionSites(c: Checker, context: InferenceContext): void {
  const sites = context.intraExpressionInferenceSites;
  if (sites === undefined) return;
  context.intraExpressionInferenceSites = undefined;
  for (const site of sites) {
    const contextualType = getContextualTypeForInference(c, site.node);
    if (contextualType !== undefined)
      inferTypes(c, context.inferences, site.type, contextualType, InferencePriority.None, false);
  }
}

export function getInferredType(c: Checker, context: InferenceContext, index: number): Type {
  const inference = context.inferences[index]!;
  if (inference.inferredType !== undefined) return inference.inferredType;
  if (inference.typeParameter === c.errorType) return inference.typeParameter;
  let inferredType: Type | undefined = undefined;
  let fallbackType: Type | undefined = undefined;
  const signature = context.signature;
  if (signature !== undefined) {
    const covariant = inference.candidates.length !== 0 ? getCovariantInference(c, inference, signature) : undefined;
    const contravariant = inference.contraCandidates.length !== 0 ? getContravariantInference(c, inference) : undefined;
    if (covariant !== undefined || contravariant !== undefined) {
      // Prefer the covariant inference when it isn't never or any, is assignable to some
      // contravariant candidate, and no type parameter constrained to this one conflicts.
      const preferCovariantType =
        covariant !== undefined &&
        (contravariant === undefined ||
          ((covariant.flags & (TypeFlags.Never | TypeFlags.Any)) === 0 &&
            someTypeAssignableFrom(c, covariant, inference.contraCandidates) &&
            noConflictingConstrainedInference(c, context, inference, covariant)));
      if (preferCovariantType) {
        inferredType = covariant;
        fallbackType = contravariant;
      } else {
        inferredType = contravariant;
        fallbackType = covariant;
      }
    } else if ((context.flags & InferenceFlags.NoDefault) !== 0) {
      // silentNeverType signals no inferences.
      inferredType = c.silentNeverType;
    } else {
      // No inferences: the default, with forward references to later type parameters erased.
      const defaultType = getDefaultFromTypeParameter(c, inference.typeParameter);
      if (defaultType !== undefined)
        inferredType = instantiateType(
          c,
          defaultType,
          new MergedTypeMapper(newBackreferenceMapper(c, context, index), context.nonFixingMapper),
        );
    }
  } else inferredType = getTypeFromInference(c, inference);
  inference.inferredType =
    inferredType ?? ((context.flags & InferenceFlags.AnyDefault) !== 0 ? c.anyType : c.unknownType);
  const constraint = getConstraintOfTypeParameter(c, inference.typeParameter);
  if (constraint !== undefined) {
    const instantiatedConstraint = instantiateType(c, constraint, context.nonFixingMapper);
    // A pure return type inference is still filtered in a recursive call resolution: its result can become
    // the type of the enclosing declaration.
    if (
      inferredType !== undefined &&
      ((context.flags & InferenceFlags.NoConstraintChecks) === 0 || inference.priority === InferencePriority.ReturnType)
    ) {
      const constraintWithThis = getTypeWithThisArgument(c, instantiatedConstraint, inferredType, false);
      if (context.compareTypes.compare(inferredType, constraintWithThis, false) === Ternary.False) {
        // A pure return type inference may still succeed without the constituents the constraint rejects.
        let filtered: Type | undefined = undefined;
        if (inference.priority === InferencePriority.ReturnType)
          filtered = mapType(c, inferredType, (t) =>
            context.compareTypes.compare(t, constraintWithThis, false) !== Ternary.False ? t : c.neverType,
          );
        inferredType = filtered !== undefined && (filtered.flags & TypeFlags.Never) === 0 ? filtered : undefined;
      }
    }
    if (inferredType === undefined)
      inferredType =
        fallbackType !== undefined &&
        context.compareTypes.compare(
          fallbackType,
          getTypeWithThisArgument(c, instantiatedConstraint, fallbackType, false),
          false,
        ) !== Ternary.False
          ? fallbackType
          : instantiatedConstraint;
    inference.inferredType = inferredType;
  }
  clearActiveMapperCaches(c);
  return inference.inferredType;
}

function clearActiveMapperCaches(c: Checker): void {
  for (const cache of c.activeMapperCaches) if (cache !== undefined) cache.clear();
  for (const cache of c.activeMapperAliasCaches) if (cache !== undefined) cache.clear();
}

/** Type ids below this bound pack in pairs into one exact number. */
const VisitKeyIdLimit = 1 << 26;

/** invokeOnce's key for a pair of types: both ids in one number, or -1 when an id is too large. */
/** The priority and variance of an inference walk, packed. */
function visitMode(priority: number, contravariant: boolean, bivariant: boolean): number {
  return priority * 4 + (contravariant ? 2 : 0) + (bivariant ? 1 : 0);
}

function visitKey(source: Type, target: Type): number {
  const s = source.id;
  const t = target.id;
  return s < VisitKeyIdLimit && t < VisitKeyIdLimit ? s * VisitKeyIdLimit + t : -1;
}

/** Maps forward references to later type parameters to `unknown`, for instantiating defaults. */
function newBackreferenceMapper(c: Checker, context: InferenceContext, index: number): TypeMapper {
  return new ArrayToSingleTypeMapper(
    context.inferences.slice(index).map((i) => i.typeParameter),
    c.unknownType,
  );
}

export function getInferredTypes(c: Checker, context: InferenceContext): Type[] {
  const result: Type[] = [];
  for (let i = 0; i < context.inferences.length; i++) result.push(getInferredType(c, context, i));
  return result;
}

function getCovariantInference(c: Checker, inference: InferenceInfo, signature: Signature): Type {
  // Object and array literal candidates become one widened, normalized type.
  const candidates = unionObjectAndArrayLiteralCandidates(c, inference.candidates);
  // Widen literals when all inferences were to top-level occurrences, the type parameter has no
  // primitive constraint, and it was fixed or doesn't occur at top level in the return type.
  const primitiveConstraint =
    hasPrimitiveConstraint(c, inference.typeParameter) || isConstTypeVariable(c, inference.typeParameter, 0);
  const widenLiteralTypes =
    !primitiveConstraint &&
    inference.topLevel &&
    (inference.isFixed || !isTypeParameterAtTopLevelInReturnType(c, signature, inference.typeParameter));
  let baseCandidates = candidates;
  if (primitiveConstraint || widenLiteralTypes) {
    baseCandidates = [];
    for (const t of candidates)
      baseCandidates.push(primitiveConstraint ? getRegularTypeOfLiteralType(c, t) : getWidenedLiteralType(c, t));
  }
  // Positions implying a combined result infer a union, others a common supertype.
  const unwidenedType =
    (inference.priority & InferencePriority.PriorityImpliesCombination) !== 0
      ? getUnionTypeEx(c, baseCandidates, UnionReduction.Subtype, undefined, undefined)
      : getCommonSupertype(c, baseCandidates);
  return getWidenedType(c, unwidenedType);
}

function getContravariantInference(c: Checker, inference: InferenceInfo): Type {
  return (inference.priority & InferencePriority.PriorityImpliesCombination) !== 0
    ? getIntersectionType(c, inference.contraCandidates)
    : getCommonSubtype(c, inference.contraCandidates);
}

function someTypeAssignableFrom(c: Checker, source: Type, targets: Type[]): boolean {
  for (const t of targets) if (isTypeAssignableTo(c, source, t)) return true;
  return false;
}

/** No other inference constrained to `inference`'s type parameter has a candidate not assignable to `covariant`. */
function noConflictingConstrainedInference(
  c: Checker,
  context: InferenceContext,
  inference: InferenceInfo,
  covariant: Type,
): boolean {
  for (const other of context.inferences) {
    if (other !== inference && getConstraintOfTypeParameter(c, other.typeParameter) !== inference.typeParameter)
      continue;
    for (const t of other.candidates) if (!isTypeAssignableTo(c, t, covariant)) return false;
  }
  return true;
}

function everyNonGenericObjectType(c: Checker, types: Type[]): boolean {
  for (const t of types) if (!isNonGenericObjectType(c, t)) return false;
  return true;
}

function isObjectOrArrayLiteralType(t: Type): boolean {
  return (t.objectFlags & (ObjectFlags.ObjectLiteral | ObjectFlags.ArrayLiteral)) !== 0;
}

function unionObjectAndArrayLiteralCandidates(c: Checker, candidates: Type[]): Type[] {
  if (candidates.length > 1) {
    const objectLiterals: Type[] = [];
    const result: Type[] = [];
    for (const t of candidates) {
      if (isObjectOrArrayLiteralType(t)) objectLiterals.push(t);
      else result.push(t);
    }
    if (objectLiterals.length !== 0) {
      result.push(getUnionTypeEx(c, objectLiterals, UnionReduction.Subtype, undefined, undefined));
      return result;
    }
  }
  return candidates;
}

function hasPrimitiveConstraint(c: Checker, t: Type): boolean {
  let constraint = getConstraintOfTypeParameter(c, t);
  if (constraint === undefined) return false;
  if ((constraint.flags & TypeFlags.Conditional) !== 0) constraint = getConstraintFromConditionalType(c, constraint);
  return maybeTypeOfKind(
    constraint,
    TypeFlags.Primitive | TypeFlags.Index | TypeFlags.TemplateLiteral | TypeFlags.StringMapping,
  );
}

export function getTypeFromInference(c: Checker, inference: InferenceInfo): Type | undefined {
  if (inference.candidates.length !== 0)
    return getUnionTypeEx(c, inference.candidates, UnionReduction.Subtype, undefined, undefined);
  if (inference.contraCandidates.length !== 0) return getIntersectionType(c, inference.contraCandidates);
  return undefined;
}

export function getCommonSupertype(c: Checker, types: Type[]): Type {
  if (types.length === 1) return types[0]!;
  // Remove nullable types, find the supertype, and add them back.
  let primaryTypes = types;
  if (c.strictNullChecks) {
    primaryTypes = [];
    for (const t of types) primaryTypes.push(filterType(c, t, (u) => (u.flags & TypeFlags.Nullable) === 0));
  }
  const supertype = literalTypesWithSameBaseType(c, primaryTypes)
    ? getUnionType(c, primaryTypes)
    : getSingleCommonSupertype(c, primaryTypes);
  let same = true;
  for (let i = 0; i < types.length; i++) if (primaryTypes[i]! !== types[i]!) same = false;
  if (same) return supertype;
  return getNullableType(c, supertype, getCombinedTypeFlags(types) & TypeFlags.Nullable);
}

function getSingleCommonSupertype(c: Checker, types: Type[]): Type {
  // The leftmost type no type to its right is a strict supertype of, if it's a strict supertype of
  // all others; otherwise the same with regular supertypes.
  let candidate: Type | undefined = undefined;
  for (const t of types) if (candidate === undefined || isTypeStrictSubtypeOf(c, candidate, t)) candidate = t;
  let strictSupertype = true;
  for (const t of types) {
    if (t !== candidate && !isTypeStrictSubtypeOf(c, t, candidate!)) {
      strictSupertype = false;
      break;
    }
  }
  if (strictSupertype) return candidate!;
  candidate = undefined;
  for (const t of types) if (candidate === undefined || isTypeSubtypeOf(c, candidate, t)) candidate = t;
  return candidate!;
}

/** The leftmost type no type to its right is a subtype of. */
export function getCommonSubtype(c: Checker, types: Type[]): Type {
  let subtype: Type | undefined = undefined;
  for (const t of types) if (subtype === undefined || isTypeSubtypeOf(c, t, subtype)) subtype = t;
  return subtype!;
}

function getCombinedTypeFlags(types: Type[]): TypeFlags {
  let flags = TypeFlags.None;
  for (const t of types) flags |= (t.flags & TypeFlags.Union) !== 0 ? getCombinedTypeFlags(typesOf(t)) : t.flags;
  return flags;
}

function literalTypesWithSameBaseType(c: Checker, types: Type[]): boolean {
  let commonBaseType: Type | undefined = undefined;
  for (const t of types) {
    if ((t.flags & TypeFlags.Never) !== 0) continue;
    const baseType = getBaseTypeOfLiteralType(c, t);
    if (commonBaseType === undefined) commonBaseType = baseType;
    if (baseType === t || baseType !== commonBaseType) return false;
  }
  return true;
}

// ---- Conditional types

/** A mapper from a conditional type's `infer` type parameters to their inferences. */
export function inferTypesForConditional(
  c: Checker,
  root: ConditionalRoot,
  checkType: Type,
  extendsType: Type,
  mapper: TypeMapper | undefined,
  checkTypeDeferred: boolean,
): TypeMapper | undefined {
  // The constraints of `infer` type parameters may refer to other roots or to what `mapper` maps,
  // so the non-fixing mapper combines with `mapper`.
  const context = createInferenceContext(c, root.inferTypeParameters, undefined, InferenceFlags.None, undefined);
  if (mapper !== undefined) context.nonFixingOuter = mapper;
  // Inferences from constraints could eagerly resolve what should defer; contravariance is always strict.
  if (!checkTypeDeferred)
    inferTypes(
      c,
      context.inferences,
      checkType,
      extendsType,
      InferencePriority.NoConstraints | InferencePriority.AlwaysStrict,
      false,
    );
  return context.mapper;
}

/** Caches and stacks for inference, contextual typing and call resolution. */
export class InferenceCaches {
  /**
   * Contextual types pushed for nodes being checked, innermost last. The first `contextualDepth`
   * entries are live; popping keeps the slots after them for reuse.
   */
  readonly contextualNodes: Node[] = [];
  readonly contextualTypes: (Type | undefined)[] = [];
  readonly contextualIsCache: boolean[] = [];
  contextualDepth = 0;
  /** Inference contexts pushed for arguments being checked, innermost last; `inferenceDepth` are live. */
  readonly inferenceNodes: Node[] = [];
  readonly inferenceContexts: (InferenceContext | undefined)[] = [];
  inferenceDepth = 0;
  readonly optionalCallSignatures = new Map<Signature, Map<string, Signature>>();
  readonly discriminatedContextualTypes = new Map<string, Type>();
  /** `discriminatedContextualTypes` by node and type id packed into one number, when they fit. */
  readonly discriminatedContextualTypesById = new Map<number, Type>();
  /** For union contextual types, what each constituent has for a missing optional property (discriminateTypeByObjectLiteral). */
  readonly missingPropertyStates = new Map<Type, Map<string, number>>();
  readonly contextFreeTypes = new Map<Node, Type>();
  readonly reverseMapped = new Map<string, Type | undefined>();
  readonly reverseHomomorphicMapped = new Map<string, Type | undefined>();
  /** inferReverseMappedType's recursion stacks; the first `reverseStackDepth` entries of each are live. */
  readonly reverseSourceStack: Type[] = [];
  readonly reverseTargetStack: Type[] = [];
  reverseStackDepth = 0;
  reverseExpandingFlags: number = ExpandingFlags.None;
  /**
   * What `inferTypesFromUnstarted` left in each inference, by signature id, then by source type id
   * times 4096 plus the priority.
   */
  readonly unstartedInferences = new Map<number, Map<number, UnstartedInference>>();
  /** The `unstartedInferences` entry of a walk seen once. */
  readonly seenOnce = new UnstartedInference(UnstartedInferenceState.Seen, [], 0, 0, 0, []);
  /** The `unstartedInferences` entry of a walk that is never skipped. */
  readonly alwaysWalked = new UnstartedInference(UnstartedInferenceState.Unusable, [], 0, 0, 0, []);
}

// ---- Constraints of `infer` type parameters

/**
 * Maps the type parameters of a type reference to its type arguments, resolving them (and filling
 * in defaults) only when a type parameter is mapped.
 */
class TypeArgumentMapper extends TypeMapper {
  readonly c: Checker;
  readonly typeArgumentNodes: readonly Node[];
  readonly typeParameters: readonly Type[];
  filled: Type[] | undefined = undefined;

  constructor(c: Checker, typeArgumentNodes: readonly Node[], typeParameters: readonly Type[]) {
    super();
    this.c = c;
    this.typeArgumentNodes = typeArgumentNodes;
    this.typeParameters = typeParameters;
  }

  map(t: Type): Type {
    const index = this.typeParameters.indexOf(t);
    if (index < 0) return t;
    if (index < this.typeArgumentNodes.length) return getTypeFromTypeNode(this.c, this.typeArgumentNodes[index]!);
    if (this.filled === undefined) {
      const typeArguments: Type[] = [];
      for (const n of this.typeArgumentNodes) typeArguments.push(getTypeFromTypeNode(this.c, n));
      this.filled = fillMissingTypeArguments(
        this.c,
        typeArguments,
        this.typeParameters,
        getMinTypeArgumentCount(this.c, this.typeParameters),
        false,
      );
    }
    return this.filled[index]!;
  }
}

/**
 * The constraint an `infer T` position implies, e.g. `unknown[]` in a rest position; with
 * `omitTypeReferences`, `Foo<infer T>` implies none.
 */
export function getInferredTypeParameterConstraint(c: Checker, t: Type, omitTypeReferences = false): Type | undefined {
  const inferences: Type[] = [];
  const symbol = t.symbol;
  if (symbol !== undefined)
    for (const declaration of getDeclarations(symbol)) {
      if (declaration.parent === undefined || declaration.parent.kind !== SyntaxKind.InferType) continue;
      let child: Node = declaration.parent;
      let parent = child.parent;
      while (parent !== undefined && parent.kind === SyntaxKind.ParenthesizedType) {
        child = parent;
        parent = child.parent;
      }
      if (parent === undefined) continue;
      switch (parent.kind) {
        case SyntaxKind.TypeReference: {
          if (omitTypeReferences) break;
          // `Foo<infer T>` takes the constraint of Foo's corresponding type parameter.
          const typeArgumentNodes = (parent as TypeReferenceNode).typeArguments;
          const typeParameters = getTypeParametersForTypeReference(c, parent);
          if (typeArgumentNodes === undefined || typeParameters === undefined) break;
          const index = typeArgumentNodes.nodes.indexOf(child);
          if (index < 0 || index >= typeParameters.length) break;
          const declaredConstraint = getConstraintOfTypeParameter(c, typeParameters[index]!);
          if (declaredConstraint === undefined) break;
          // Constraints referencing the type parameter itself are discarded.
          const constraint = instantiateType(
            c,
            declaredConstraint,
            new TypeArgumentMapper(c, typeArgumentNodes.nodes, typeParameters),
          );
          if (constraint !== t) inferences.push(constraint);
          break;
        }
        case SyntaxKind.Parameter:
          if ((parent as ParameterDeclaration).dotDotDotToken !== undefined)
            inferences.push(createArrayType(c, c.unknownType));
          break;
        case SyntaxKind.RestType:
          inferences.push(createArrayType(c, c.unknownType));
          break;
        case SyntaxKind.NamedTupleMember:
          if ((parent as NamedTupleMember).dotDotDotToken !== undefined)
            inferences.push(createArrayType(c, c.unknownType));
          break;
        case SyntaxKind.TemplateLiteralTypeSpan:
          inferences.push(c.stringType);
          break;
        case SyntaxKind.TypeParameter:
          if (parent.parent !== undefined && parent.parent.kind === SyntaxKind.MappedType)
            inferences.push(c.stringNumberSymbolType);
          break;
        case SyntaxKind.MappedType: {
          // `{ [P in K]: X } extends { [Q in L]: infer U }` constrains U to X with P replaced by K.
          const mapped = parent as MappedTypeNode;
          const conditional = parent.parent;
          if (
            mapped.type !== undefined &&
            mapped.type === declaration.parent &&
            conditional !== undefined &&
            conditional.kind === SyntaxKind.ConditionalType &&
            (conditional as ConditionalTypeNode).extendsType === parent &&
            (conditional as ConditionalTypeNode).checkType.kind === SyntaxKind.MappedType &&
            ((conditional as ConditionalTypeNode).checkType as MappedTypeNode).type !== undefined
          ) {
            const checkMappedType = (conditional as ConditionalTypeNode).checkType as MappedTypeNode;
            const nodeType = getTypeFromTypeNode(c, checkMappedType.type!);
            const checkMappedTypeParameter = checkMappedType.typeParameter;
            const mapper = new SimpleTypeMapper(
              getDeclaredTypeOfTypeParameter(c, getSymbolOfDeclaration(c, checkMappedTypeParameter)!),
              checkMappedTypeParameter.constraint !== undefined
                ? getTypeFromTypeNode(c, checkMappedTypeParameter.constraint)
                : c.stringNumberSymbolType,
            );
            inferences.push(instantiateType(c, nodeType, mapper));
          }
          break;
        }
      }
    }
  return inferences.length !== 0 ? getIntersectionType(c, inferences) : undefined;
}

function getTypeParametersForTypeReference(c: Checker, node: Node): readonly Type[] | undefined {
  if (isErrorType(c, getTypeFromTypeNode(c, node))) return undefined;
  const symbol = c.resolvedSymbols.get(node.id);
  if (symbol === undefined || symbol === c.unknownSymbol) return undefined;
  if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0)
    return getDeclaredTypeOfClassOrInterface(c, getMergedSymbol(c, symbol)).localTypeParameters();
  if ((symbol.flags & SymbolFlags.TypeAlias) !== 0) {
    getDeclaredTypeOfSymbol(c, symbol);
    return c.symbolLinks(symbol).typeParameters;
  }
  return undefined;
}
