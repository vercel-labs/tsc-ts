// The iterator protocol and `await`: iteration types of iterables, iterators and generators (sync
// and async), the element types of `for...of`, spread and array destructuring, and awaited and
// promised types.
import { type Node, getExpression } from './ast.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { SymbolFlags } from './symbol.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  type InterfaceType,
  type ObjectType,
  type Signature,
  SignatureKind,
  type Type,
  TypeFlags,
  ObjectFlags,
  type TypeReference,
  getMappedType,
} from './checker-types.js';
import {
  createTypeFromGenericGlobalType,
  createTypeReference,
  filterType,
  getIntersectionType,
  getTypeArguments,
  getUnionType,
  getUnionTypeEx,
  isEmptyObjectType,
  mapType,
  someType,
  typesOf,
  UnionReduction,
} from './checker-type-factory.js';
import {
  getBaseConstraintOfType,
  getBaseConstraintOrType,
  getIndexTypeOfType,
  getPropertyOfType,
  getReducedType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
  isArrayLikeType,
} from './checker-members.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getCachedGlobalType, getGlobalTypeAliasSymbol, getGlobalValueSymbol } from './checker-symbols.js';
import {
  getMinArgumentCount,
  getReturnTypeOfSignature,
  getThisTypeOfSignature,
  getTypeAtPosition,
} from './checker-signatures.js';
import { getTypeAliasInstantiation } from './checker-type-nodes.js';
import { isGenericObjectType } from './checker-type-operators.js';
import { TypeFacts, getTypeWithFacts } from './checker-flow.js';
import {
  allTypesAssignableToKind,
  errorAndMaybeSuggestAwait,
  getPropertyNameForKnownSymbolName,
} from './checker-operators.js';
import { checkTypeRelatedTo, isTypeAssignableTo, isTypeRelatedTo } from './relations.js';
import { FunctionFlags, maybeTypeOfKind } from './checker-utilities.js';
import { typeToString } from './type-printer.js';

/** How a value is iterated, which decides the protocols looked up and the errors reported. */
export const enum IterationUse {
  None = 0,
  AllowsSyncIterablesFlag = 1 << 0,
  AllowsAsyncIterablesFlag = 1 << 1,
  AllowsStringInputFlag = 1 << 2,
  ForOfFlag = 1 << 3,
  YieldStarFlag = 1 << 4,
  SpreadFlag = 1 << 5,
  DestructuringFlag = 1 << 6,
  PossiblyOutOfBounds = 1 << 7,
  // Spread, destructuring, array element assignment
  Element = AllowsSyncIterablesFlag,
  Spread = AllowsSyncIterablesFlag | SpreadFlag,
  Destructuring = AllowsSyncIterablesFlag | DestructuringFlag,
  ForOf = AllowsSyncIterablesFlag | AllowsStringInputFlag | ForOfFlag,
  ForAwaitOf = AllowsSyncIterablesFlag | AllowsAsyncIterablesFlag | AllowsStringInputFlag | ForOfFlag,
  YieldStar = AllowsSyncIterablesFlag | YieldStarFlag,
  AsyncYieldStar = AllowsSyncIterablesFlag | AllowsAsyncIterablesFlag | YieldStarFlag,
  GeneratorReturnType = AllowsSyncIterablesFlag,
  AsyncGeneratorReturnType = AllowsAsyncIterablesFlag,
  CacheFlags = AllowsSyncIterablesFlag | AllowsAsyncIterablesFlag | ForOfFlag,
}

export const enum IterationTypeKind {
  Yield,
  Return,
  Next,
}

/** The *yield*, *return* and *next* types of an iterable, iterator or generator. */
export class IterationTypes {
  readonly yieldType: Type | undefined;
  readonly returnType: Type | undefined;
  readonly nextType: Type | undefined;

  constructor(yieldType: Type | undefined, returnType: Type | undefined, nextType: Type | undefined) {
    this.yieldType = yieldType;
    this.returnType = returnType;
    this.nextType = nextType;
  }

  hasTypes(): boolean {
    return this.yieldType !== undefined || this.returnType !== undefined || this.nextType !== undefined;
  }

  getType(kind: IterationTypeKind): Type | undefined {
    switch (kind) {
      case IterationTypeKind.Yield:
        return this.yieldType;
      case IterationTypeKind.Return:
        return this.returnType;
    }
    return this.nextType;
  }
}

function noIterationTypes(): IterationTypes {
  return new IterationTypes(undefined, undefined, undefined);
}

function anyIterationTypes(c: Checker): IterationTypes {
  return new IterationTypes(c.anyType, c.anyType, c.anyType);
}

/** A not-iterable error, reported once the file is checked so printing its type can't recurse. */
export class DeferredIterationError {
  readonly errorNode: Node;
  readonly type: Type;
  readonly allowAsyncIterables: boolean;
  readonly related: Diagnostic[];

  constructor(errorNode: Node, type: Type, allowAsyncIterables: boolean, related: Diagnostic[]) {
    this.errorNode = errorNode;
    this.type = type;
    this.allowAsyncIterables = allowAsyncIterables;
    this.related = related;
  }
}

/** Reports the not-iterable errors deferred while checking a file. */
export function produceDeferredIterationErrors(c: Checker): void {
  const errors = c.deferredIterationErrors;
  if (errors.length === 0) return;
  c.deferredIterationErrors = [];
  for (const e of errors) {
    const diagnostic = reportTypeNotIterableError(c, e.errorNode, e.type, e.allowAsyncIterables);
    for (const d of e.related) diagnostic.addRelatedInfo(d);
  }
}

// ---- Global types

export function getGlobalIteratorType(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncIterator' : 'Iterator', 3, false);
}

export function getGlobalIterableType(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncIterable' : 'Iterable', 3, false);
}

function getGlobalIterableTypeChecked(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncIterable' : 'Iterable', 3, true);
}

export function getGlobalIterableIteratorType(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncIterableIterator' : 'IterableIterator', 3, false);
}

function getGlobalIterableIteratorTypeChecked(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncIterableIterator' : 'IterableIterator', 3, true);
}

function getGlobalIteratorObjectType(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncIteratorObject' : 'IteratorObject', 3, false);
}

export function getGlobalGeneratorType(c: Checker, isAsync: boolean): Type {
  return getCachedGlobalType(c, isAsync ? 'AsyncGenerator' : 'Generator', 3, false);
}

function isReferenceToBuiltinIteratorType(c: Checker, t: Type, isAsync: boolean): boolean {
  if (isAsync) return isReferenceToType(t, getCachedGlobalType(c, 'ReadableStreamAsyncIterator', 1, false));
  return (
    isReferenceToType(t, getCachedGlobalType(c, 'ArrayIterator', 1, false)) ||
    isReferenceToType(t, getCachedGlobalType(c, 'MapIterator', 1, false)) ||
    isReferenceToType(t, getCachedGlobalType(c, 'SetIterator', 1, false)) ||
    isReferenceToType(t, getCachedGlobalType(c, 'StringIterator', 1, false))
  );
}

function getGlobalIteratorYieldResultType(c: Checker): Type {
  return getCachedGlobalType(c, 'IteratorYieldResult', 1, false);
}

function getGlobalIteratorReturnResultType(c: Checker): Type {
  return getCachedGlobalType(c, 'IteratorReturnResult', 1, false);
}

export function getGlobalPromiseType(c: Checker): Type {
  return getCachedGlobalType(c, 'Promise', 1, false);
}

export function getGlobalPromiseTypeChecked(c: Checker): Type {
  return getCachedGlobalType(c, 'Promise', 1, true);
}

export function getGlobalPromiseLikeType(c: Checker): Type {
  return getCachedGlobalType(c, 'PromiseLike', 1, true);
}

export function isReferenceToType(t: Type, target: Type): boolean {
  return (t.objectFlags & ObjectFlags.Reference) !== 0 && (t as TypeReference).target === target;
}

function getBuiltinIteratorReturnType(c: Checker): Type {
  return c.strictBuiltinIteratorReturn ? c.undefinedType : c.anyType;
}

export function createIterableType(c: Checker, iteratedType: Type): Type {
  return createTypeFromGenericGlobalType(c, getGlobalIterableTypeChecked(c, false), [
    iteratedType,
    c.voidType,
    c.undefinedType,
  ]);
}

// ---- Resolvers

/** Async iteration awaits the yield and return types; sync iteration takes them as is. */
function resolveIterationType(c: Checker, isAsync: boolean, t: Type, errorNode: Node | undefined): Type | undefined {
  if (!isAsync) return t;
  return getAwaitedTypeEx(
    c,
    t,
    errorNode,
    Diagnostics.Type_of_await_operand_must_either_be_a_valid_promise_or_must_not_contain_a_callable_then_member,
  );
}

function getResolvedIterationTypes(
  c: Checker,
  isAsync: boolean,
  yieldType: Type,
  returnType: Type,
  nextType: Type,
): IterationTypes {
  return new IterationTypes(
    resolveIterationType(c, isAsync, yieldType, undefined) ?? yieldType,
    resolveIterationType(c, isAsync, returnType, undefined) ?? returnType,
    nextType,
  );
}

// ---- Element types

/** The element type of an iterable or array-like for `use`, reporting at `errorNode`; `any` when there is none. */
export function checkIteratedTypeOrElementType(
  c: Checker,
  use: IterationUse,
  inputType: Type,
  sentType: Type,
  errorNode: Node | undefined,
): Type {
  if ((inputType.flags & TypeFlags.Any) !== 0) return inputType;
  return getIteratedTypeOrElementType(c, use, inputType, sentType, errorNode, true) ?? c.anyType;
}

export function getIteratedTypeOrElementType(
  c: Checker,
  use: IterationUse,
  inputType: Type,
  sentType: Type,
  errorNode: Node | undefined,
  checkAssignability: boolean,
): Type | undefined {
  const allowAsyncIterables = (use & IterationUse.AllowsAsyncIterablesFlag) !== 0;
  if (inputType === c.neverType) {
    if (errorNode !== undefined) reportTypeNotIterableError(c, errorNode, inputType, allowAsyncIterables);
    return undefined;
  }
  const iterableExists = getGlobalIterableType(c, false) !== c.emptyGenericType;
  const possibleOutOfBounds = c.noUncheckedIndexedAccess && (use & IterationUse.PossiblyOutOfBounds) !== 0;
  if (iterableExists || allowAsyncIterables) {
    const iterationTypes = getIterationTypesOfIterable(c, inputType, use, iterableExists ? errorNode : undefined);
    if (checkAssignability && iterationTypes.nextType !== undefined) {
      let diagnostic: DiagnosticMessage | undefined;
      if ((use & IterationUse.ForOfFlag) !== 0)
        diagnostic =
          Diagnostics.Cannot_iterate_value_because_the_next_method_of_its_iterator_expects_type_1_but_for_of_will_always_send_0;
      else if ((use & IterationUse.SpreadFlag) !== 0)
        diagnostic =
          Diagnostics.Cannot_iterate_value_because_the_next_method_of_its_iterator_expects_type_1_but_array_spread_will_always_send_0;
      else if ((use & IterationUse.DestructuringFlag) !== 0)
        diagnostic =
          Diagnostics.Cannot_iterate_value_because_the_next_method_of_its_iterator_expects_type_1_but_array_destructuring_will_always_send_0;
      else if ((use & IterationUse.YieldStarFlag) !== 0)
        diagnostic =
          Diagnostics.Cannot_delegate_iteration_to_value_because_the_next_method_of_its_iterator_expects_type_1_but_the_containing_generator_will_always_send_0;
      if (diagnostic !== undefined)
        checkTypeRelatedTo(
          c,
          sentType,
          iterationTypes.nextType,
          c.assignableRelation,
          errorNode,
          diagnostic,
          undefined,
        );
    }
    if (iterationTypes.yieldType !== undefined || iterableExists) {
      if (iterationTypes.yieldType === undefined) return undefined;
      return possibleOutOfBounds
        ? includeUndefinedInIndexSignature(c, iterationTypes.yieldType)
        : iterationTypes.yieldType;
    }
  }
  let arrayType = inputType;
  let hasStringConstituent = false;
  // With strings allowed, string constituents are removed to find the element types of the rest.
  if ((use & IterationUse.AllowsStringInputFlag) !== 0) {
    if ((arrayType.flags & TypeFlags.Union) !== 0) {
      const arrayTypes = typesOf(inputType);
      const filtered: Type[] = [];
      for (const t of arrayTypes) if ((t.flags & TypeFlags.StringLike) === 0) filtered.push(t);
      if (filtered.length !== arrayTypes.length)
        arrayType = getUnionTypeEx(c, filtered, UnionReduction.Subtype, undefined, undefined);
    } else if ((arrayType.flags & TypeFlags.StringLike) !== 0) arrayType = c.neverType;
    hasStringConstituent = arrayType !== inputType;
    if (hasStringConstituent && (arrayType.flags & TypeFlags.Never) !== 0)
      return possibleOutOfBounds ? includeUndefinedInIndexSignature(c, c.stringType) : c.stringType;
  }
  if (!isArrayLikeType(c, arrayType)) {
    if (errorNode !== undefined) {
      // `number | string` is "not an array type"; `number` alone, with strings allowed, is "not an
      // array type or a string type".
      const allowsStrings = (use & IterationUse.AllowsStringInputFlag) !== 0 && !hasStringConstituent;
      const details = getIterationDiagnosticDetails(c, use, inputType, allowsStrings);
      errorAndMaybeSuggestAwait(
        c,
        errorNode,
        details.maybeMissingAwait && getAwaitedTypeOfPromise(c, arrayType) !== undefined,
        details.message,
        [typeToString(c, arrayType)],
      );
    }
    if (hasStringConstituent)
      return possibleOutOfBounds ? includeUndefinedInIndexSignature(c, c.stringType) : c.stringType;
    return undefined;
  }
  const arrayElementType = getIndexTypeOfType(c, arrayType, c.numberType);
  if (hasStringConstituent && arrayElementType !== undefined) {
    // An optimization for `string | string[]`.
    if ((arrayElementType.flags & TypeFlags.StringLike) !== 0 && !c.noUncheckedIndexedAccess) return c.stringType;
    return getUnionTypeEx(
      c,
      possibleOutOfBounds ? [arrayElementType, c.stringType, c.undefinedType] : [arrayElementType, c.stringType],
      UnionReduction.Subtype,
      undefined,
      undefined,
    );
  }
  if ((use & IterationUse.PossiblyOutOfBounds) !== 0 && arrayElementType !== undefined)
    return includeUndefinedInIndexSignature(c, arrayElementType);
  return arrayElementType;
}

function includeUndefinedInIndexSignature(c: Checker, t: Type): Type {
  return c.noUncheckedIndexedAccess ? getUnionType(c, [t, c.missingType]) : t;
}

class IterationDiagnosticDetails {
  readonly message: DiagnosticMessage;
  readonly maybeMissingAwait: boolean;

  constructor(message: DiagnosticMessage, maybeMissingAwait: boolean) {
    this.message = message;
    this.maybeMissingAwait = maybeMissingAwait;
  }
}

function getIterationDiagnosticDetails(
  c: Checker,
  use: IterationUse,
  inputType: Type,
  allowsStrings: boolean,
): IterationDiagnosticDetails {
  const downlevel =
    Diagnostics.Type_0_can_only_be_iterated_through_when_using_the_downlevelIteration_flag_or_with_a_target_of_es2015_or_higher;
  if (getIterationTypeOfIterable(c, use, IterationTypeKind.Yield, inputType, undefined) !== undefined)
    return new IterationDiagnosticDetails(downlevel, false);
  if (inputType.symbol !== undefined && isES2015OrLaterIterable(inputType.symbol.name))
    return new IterationDiagnosticDetails(downlevel, true);
  return new IterationDiagnosticDetails(
    allowsStrings ? Diagnostics.Type_0_is_not_an_array_type_or_a_string_type : Diagnostics.Type_0_is_not_an_array_type,
    true,
  );
}

function isES2015OrLaterIterable(name: string): boolean {
  switch (name) {
    case 'Float32Array':
    case 'Float64Array':
    case 'Int16Array':
    case 'Int32Array':
    case 'Int8Array':
    case 'NodeList':
    case 'Uint16Array':
    case 'Uint32Array':
    case 'Uint8Array':
    case 'Uint8ClampedArray':
      return true;
  }
  return false;
}

function reportTypeNotIterableError(c: Checker, errorNode: Node, t: Type, allowAsyncIterables: boolean): Diagnostic {
  const message = allowAsyncIterables
    ? Diagnostics.Type_0_must_have_a_Symbol_asyncIterator_method_that_returns_an_async_iterator
    : Diagnostics.Type_0_must_have_a_Symbol_iterator_method_that_returns_an_iterator;
  const parent = errorNode.parent;
  const suggestAwait =
    getAwaitedTypeOfPromise(c, t) !== undefined ||
    (!allowAsyncIterables &&
      parent !== undefined &&
      parent.kind === SyntaxKind.ForOfStatement &&
      getExpression(parent) === errorNode &&
      getGlobalIterableType(c, true) !== c.emptyGenericType &&
      isTypeAssignableTo(
        c,
        t,
        createTypeFromGenericGlobalType(c, getGlobalIterableType(c, true), [c.anyType, c.anyType, c.anyType]),
      ));
  return errorAndMaybeSuggestAwait(c, errorNode, suggestAwait, message, [typeToString(c, t)]);
}

// ---- Iterables

/** The requested iteration type of an `Iterable`-like or `AsyncIterable`-like type. */
export function getIterationTypeOfIterable(
  c: Checker,
  use: IterationUse,
  kind: IterationTypeKind,
  inputType: Type,
  errorNode: Node | undefined,
): Type | undefined {
  if ((inputType.flags & TypeFlags.Any) !== 0) return undefined;
  return getIterationTypesOfIterable(c, inputType, use, errorNode).getType(kind);
}

/**
 * The *yield*, *return* and *next* types of an `Iterable`-like or `AsyncIterable`-like type, or no
 * types when it isn't one (reported at `errorNode`).
 *
 * `for...of`, `yield*`, spread, destructuring and generators look up `[Symbol.iterator]()`; async
 * generators `[Symbol.asyncIterator]()`; `for await...of` and `yield*` in async generators
 * `[Symbol.asyncIterator]()` first, then `[Symbol.iterator]()`.
 */
export function getIterationTypesOfIterable(
  c: Checker,
  t: Type,
  use: IterationUse,
  errorNode: Node | undefined,
): IterationTypes {
  t = getReducedType(c, t);
  if ((t.flags & TypeFlags.Any) !== 0) return anyIterationTypes(c);
  const key = t.id * 16 + (use & IterationUse.CacheFlags);
  // A cached failure is recomputed when reporting errors, without caching the result.
  let noCache = false;
  const cached = c.iterationTypesCache.get(key);
  if (cached !== undefined) {
    if (errorNode === undefined || cached.hasTypes()) return cached;
    noCache = true;
  }
  const result = getIterationTypesOfIterableWorker(c, t, use, errorNode);
  if (!noCache) c.iterationTypesCache.set(key, result);
  return result;
}

function getIterationTypesOfIterableWorker(
  c: Checker,
  t: Type,
  use: IterationUse,
  errorNode: Node | undefined,
): IterationTypes {
  const allowAsync = (use & IterationUse.AllowsAsyncIterablesFlag) !== 0;
  if ((t.flags & TypeFlags.Union) !== 0) {
    const all: IterationTypes[] = [];
    for (const constituent of typesOf(t)) {
      const iterationTypes = getIterationTypesOfIterableWorker(c, constituent, use, undefined);
      if (!iterationTypes.hasTypes()) {
        if (errorNode !== undefined && c.saveDeferredDiagnostics)
          c.deferredIterationErrors.push(new DeferredIterationError(errorNode, t, allowAsync, []));
        return noIterationTypes();
      }
      all.push(iterationTypes);
    }
    return combineIterationTypes(c, all);
  }
  const diagnostics: Diagnostic[] = [];
  if (allowAsync) {
    let iterationTypes = getIterationTypesOfIterableFast(c, t, true);
    if (iterationTypes.hasTypes())
      return (use & IterationUse.ForOfFlag) !== 0
        ? getAsyncFromSyncIterationTypes(c, iterationTypes, errorNode)
        : iterationTypes;
    iterationTypes = getIterationTypesOfIterableSlow(c, t, true, errorNode, diagnostics);
    if (iterationTypes.hasTypes()) {
      for (const d of diagnostics) c.addDiagnostic(d);
      return iterationTypes;
    }
  }
  if ((use & IterationUse.AllowsSyncIterablesFlag) !== 0) {
    let iterationTypes = getIterationTypesOfIterableFast(c, t, false);
    if (iterationTypes.hasTypes())
      return allowAsync ? getAsyncFromSyncIterationTypes(c, iterationTypes, errorNode) : iterationTypes;
    iterationTypes = getIterationTypesOfIterableSlow(c, t, false, errorNode, diagnostics);
    if (iterationTypes.hasTypes()) {
      for (const d of diagnostics) c.addDiagnostic(d);
      return allowAsync ? getAsyncFromSyncIterationTypes(c, iterationTypes, errorNode) : iterationTypes;
    }
  }
  if (errorNode !== undefined && c.saveDeferredDiagnostics)
    c.deferredIterationErrors.push(new DeferredIterationError(errorNode, t, allowAsync, diagnostics));
  return noIterationTypes();
}

/** Reads the iteration types of references to the global iterable types from their type arguments. */
function getIterationTypesOfIterableFast(c: Checker, t: Type, isAsync: boolean): IterationTypes {
  if (
    isReferenceToType(t, getGlobalIterableType(c, isAsync)) ||
    isReferenceToType(t, getGlobalIteratorObjectType(c, isAsync)) ||
    isReferenceToType(t, getGlobalIterableIteratorType(c, isAsync)) ||
    isReferenceToType(t, getGlobalGeneratorType(c, isAsync))
  ) {
    const typeArguments = getTypeArguments(c, t);
    return getResolvedIterationTypes(c, isAsync, typeArguments[0]!, typeArguments[1]!, typeArguments[2]!);
  }
  if (isReferenceToBuiltinIteratorType(c, t, isAsync))
    return getResolvedIterationTypes(
      c,
      isAsync,
      getTypeArguments(c, t)[0]!,
      getBuiltinIteratorReturnType(c),
      c.unknownType,
    );
  return noIterationTypes();
}

function combineIterationTypes(c: Checker, all: IterationTypes[]): IterationTypes {
  return new IterationTypes(
    getIterationTypeUnion(c, all, IterationTypeKind.Yield),
    getIterationTypeUnion(c, all, IterationTypeKind.Return),
    getIterationTypeUnion(c, all, IterationTypeKind.Next),
  );
}

function getIterationTypeUnion(c: Checker, all: IterationTypes[], kind: IterationTypeKind): Type | undefined {
  const types: Type[] = [];
  for (const iterationTypes of all) {
    const t = iterationTypes.getType(kind);
    if (t !== undefined) types.push(t);
  }
  return types.length === 0 ? undefined : getUnionType(c, types);
}

function getAsyncFromSyncIterationTypes(
  c: Checker,
  iterationTypes: IterationTypes,
  errorNode: Node | undefined,
): IterationTypes {
  if (
    !iterationTypes.hasTypes() ||
    (iterationTypes.yieldType === c.anyType &&
      iterationTypes.returnType === c.anyType &&
      iterationTypes.nextType === c.anyType)
  )
    return iterationTypes;
  // Reports a missing `Awaited<T>` when requesting diagnostics.
  if (errorNode !== undefined) getGlobalTypeAliasSymbol(c, 'Awaited', 1, true);
  return new IterationTypes(
    getAwaitedIterationType(c, iterationTypes.yieldType, errorNode),
    getAwaitedIterationType(c, iterationTypes.returnType, errorNode),
    iterationTypes.nextType,
  );
}

function getAwaitedIterationType(c: Checker, t: Type | undefined, errorNode: Node | undefined): Type {
  const awaitedType = t !== undefined ? getAwaitedTypeEx(c, t, errorNode, undefined) : undefined;
  return awaitedType ?? c.anyType;
}

/** The iteration types of an iterable from the iterator its `[Symbol.iterator]()` method returns. */
function getIterationTypesOfIterableSlow(
  c: Checker,
  t: Type,
  isAsync: boolean,
  errorNode: Node | undefined,
  diagnosticOutput: Diagnostic[],
): IterationTypes {
  const method = getPropertyOfType(c, t, getPropertyNameForKnownSymbolName(c, isAsync ? 'asyncIterator' : 'iterator'));
  if (method === undefined || (method.flags & SymbolFlags.Optional) !== 0) return noIterationTypes();
  const methodType = getTypeOfSymbol(c, method);
  if ((methodType.flags & TypeFlags.Any) !== 0) return anyIterationTypes(c);
  const allSignatures = getSignaturesOfType(c, methodType, SignatureKind.Call);
  const returnTypes: Type[] = [];
  for (const sig of allSignatures)
    if (getMinArgumentCount(c, sig) === 0) returnTypes.push(getReturnTypeOfSignature(c, sig));
  if (returnTypes.length !== 0)
    return getIterationTypesOfIterator(c, getIntersectionType(c, returnTypes), isAsync, errorNode, diagnosticOutput);
  if (errorNode !== undefined && allSignatures.length !== 0)
    checkTypeRelatedTo(
      c,
      t,
      getGlobalIterableTypeChecked(c, isAsync),
      c.assignableRelation,
      errorNode,
      undefined,
      diagnosticOutput,
    );
  return noIterationTypes();
}

// ---- Iterators

/** The *yield*, *return* and *next* types of an `Iterator`-like or `AsyncIterator`-like type. */
export function getIterationTypesOfIterator(
  c: Checker,
  t: Type,
  isAsync: boolean,
  errorNode: Node | undefined,
  diagnosticOutput: Diagnostic[] | undefined,
): IterationTypes {
  if ((t.flags & TypeFlags.Any) !== 0) return anyIterationTypes(c);
  const iterationTypes = getIterationTypesOfIteratorFast(c, t, isAsync);
  if (iterationTypes.hasTypes()) return iterationTypes;
  return combineIterationTypes(c, [
    getIterationTypesOfMethod(c, t, isAsync, 'next', errorNode, diagnosticOutput),
    getIterationTypesOfMethod(c, t, isAsync, 'return', errorNode, diagnosticOutput),
    getIterationTypesOfMethod(c, t, isAsync, 'throw', errorNode, diagnosticOutput),
  ]);
}

function getIterationTypesOfIteratorFast(c: Checker, t: Type, isAsync: boolean): IterationTypes {
  if (
    isReferenceToType(t, getGlobalIteratorType(c, isAsync)) ||
    isReferenceToType(t, getGlobalIteratorObjectType(c, isAsync)) ||
    isReferenceToType(t, getGlobalIterableIteratorType(c, isAsync)) ||
    isReferenceToType(t, getGlobalGeneratorType(c, isAsync))
  ) {
    const typeArguments = getTypeArguments(c, t);
    return getResolvedIterationTypes(c, isAsync, typeArguments[0]!, typeArguments[1]!, typeArguments[2]!);
  }
  if (isReferenceToBuiltinIteratorType(c, t, isAsync))
    return getResolvedIterationTypes(
      c,
      isAsync,
      getTypeArguments(c, t)[0]!,
      getBuiltinIteratorReturnType(c),
      c.unknownType,
    );
  return noIterationTypes();
}

function reportDiagnostic(c: Checker, diagnostic: Diagnostic, output: Diagnostic[] | undefined): void {
  if (output !== undefined) output.push(diagnostic);
  else c.addDiagnostic(diagnostic);
}

function getIterationTypesOfMethod(
  c: Checker,
  t: Type,
  isAsync: boolean,
  methodName: string,
  errorNode: Node | undefined,
  diagnosticOutput: Diagnostic[] | undefined,
): IterationTypes {
  const method = getPropertyOfType(c, t, methodName);
  // `return` and `throw` are optional.
  if (method === undefined && methodName !== 'next') return noIterationTypes();
  let methodType: Type | undefined;
  if (method !== undefined && !(methodName === 'next' && (method.flags & SymbolFlags.Optional) !== 0))
    methodType =
      methodName === 'next'
        ? getTypeOfSymbol(c, method)
        : getTypeWithFacts(c, getTypeOfSymbol(c, method), TypeFacts.NEUndefinedOrNull);
  if (methodType !== undefined && (methodType.flags & TypeFlags.Any) !== 0) return anyIterationTypes(c);
  // Both async and sync iterators must have a `next` method.
  const methodSignatures = methodType !== undefined ? getSignaturesOfType(c, methodType, SignatureKind.Call) : [];
  if (methodSignatures.length === 0) {
    if (errorNode !== undefined) {
      const message =
        methodName === 'next'
          ? isAsync
            ? Diagnostics.An_async_iterator_must_have_a_next_method
            : Diagnostics.An_iterator_must_have_a_next_method
          : isAsync
            ? Diagnostics.The_0_property_of_an_async_iterator_must_be_a_method
            : Diagnostics.The_0_property_of_an_iterator_must_be_a_method;
      reportDiagnostic(c, createDiagnosticForNode(errorNode, message, [methodName]), diagnosticOutput);
    }
    return noIterationTypes();
  }
  // A method that comes only from the global `Iterator` or `Generator` type gives the iteration
  // types from its type arguments, without the `undefined` its signature adds. This happens for
  // types such as `interface SpecialIterator extends Iterator<number> {}`.
  if (methodSignatures.length === 1 && methodType!.symbol !== undefined) {
    const globalGeneratorType = getGlobalGeneratorType(c, isAsync);
    const globalIteratorType = getGlobalIteratorType(c, isAsync);
    const isGeneratorMethod =
      globalGeneratorType.symbol !== undefined &&
      globalGeneratorType.symbol.members?.get(methodName) === methodType!.symbol;
    const isIteratorMethod =
      !isGeneratorMethod &&
      globalIteratorType.symbol !== undefined &&
      globalIteratorType.symbol.members?.get(methodName) === methodType!.symbol;
    if (isGeneratorMethod || isIteratorMethod) {
      const typeParameters = (
        (isGeneratorMethod ? globalGeneratorType : globalIteratorType) as InterfaceType
      ).typeParameters();
      const mapper = (methodType as ObjectType).mapper;
      if (mapper !== undefined)
        return new IterationTypes(
          getMappedType(typeParameters[0]!, mapper),
          getMappedType(typeParameters[1]!, mapper),
          methodName === 'next' ? getMappedType(typeParameters[2]!, mapper) : undefined,
        );
    }
  }
  // The first parameter and return type of each signature.
  const methodParameterTypes: Type[] = [];
  const methodReturnTypes: Type[] = [];
  for (const signature of methodSignatures) {
    if (methodName !== 'throw' && signature.parameters.length !== 0)
      methodParameterTypes.push(getTypeAtPosition(c, signature, 0));
    methodReturnTypes.push(getReturnTypeOfSignature(c, signature));
  }
  // The *next* or *return* type from the first parameter of `next()` or `return()`.
  const returnTypes: Type[] = [];
  let nextType: Type | undefined;
  if (methodName !== 'throw') {
    const methodParameterType =
      methodParameterTypes.length !== 0 ? getUnionType(c, methodParameterTypes) : c.unknownType;
    // Async generators don't await `next(value)`, but they do await `return(value)`.
    if (methodName === 'next') nextType = methodParameterType;
    else returnTypes.push(resolveIterationType(c, isAsync, methodParameterType, errorNode) ?? c.anyType);
  }
  // The *yield* and *return* types from the method's `IteratorResult`.
  const methodReturnType = methodReturnTypes.length !== 0 ? getIntersectionType(c, methodReturnTypes) : c.neverType;
  const resolvedMethodReturnType = resolveIterationType(c, isAsync, methodReturnType, errorNode) ?? c.anyType;
  const iterationTypes = getIterationTypesOfIteratorResult(c, resolvedMethodReturnType);
  let yieldType: Type | undefined;
  if (!iterationTypes.hasTypes()) {
    if (errorNode !== undefined)
      reportDiagnostic(
        c,
        createDiagnosticForNode(
          errorNode,
          isAsync
            ? Diagnostics.The_type_returned_by_the_0_method_of_an_async_iterator_must_be_a_promise_for_a_type_with_a_value_property
            : Diagnostics.The_type_returned_by_the_0_method_of_an_iterator_must_have_a_value_property,
          [methodName],
        ),
        diagnosticOutput,
      );
    yieldType = c.anyType;
    returnTypes.push(c.anyType);
  } else {
    yieldType = iterationTypes.yieldType;
    if (iterationTypes.returnType !== undefined) returnTypes.push(iterationTypes.returnType);
  }
  return new IterationTypes(yieldType, returnTypes.length !== 0 ? getUnionType(c, returnTypes) : undefined, nextType);
}

/** The *yield* and *return* types of an `IteratorResult`-like type. */
function getIterationTypesOfIteratorResult(c: Checker, t: Type): IterationTypes {
  if ((t.flags & TypeFlags.Any) !== 0) return anyIterationTypes(c);
  if (isReferenceToType(t, getGlobalIteratorYieldResultType(c)))
    return new IterationTypes(getTypeArguments(c, t)[0]!, undefined, undefined);
  if (isReferenceToType(t, getGlobalIteratorReturnResultType(c)))
    return new IterationTypes(undefined, getTypeArguments(c, t)[0]!, undefined);
  const yieldIteratorResult = filterType(c, t, (u) => isIteratorResult(c, u, IterationTypeKind.Yield));
  const yieldType =
    yieldIteratorResult !== c.neverType ? getTypeOfPropertyOfType(c, yieldIteratorResult, 'value') : undefined;
  const returnIteratorResult = filterType(c, t, (u) => isIteratorResult(c, u, IterationTypeKind.Return));
  const returnType =
    returnIteratorResult !== c.neverType ? getTypeOfPropertyOfType(c, returnIteratorResult, 'value') : undefined;
  if (yieldType === undefined && returnType === undefined) return noIterationTypes();
  // A result without a return value may omit `value`.
  return new IterationTypes(yieldType, returnType ?? c.voidType, undefined);
}

/** Whether `done` admits `false` (a yield result) or `true` (a return result); a missing `done` is `false`. */
function isIteratorResult(c: Checker, t: Type, kind: IterationTypeKind): boolean {
  const doneType = getTypeOfPropertyOfType(c, t, 'done') ?? c.falseType;
  return isTypeAssignableTo(c, kind === IterationTypeKind.Yield ? c.falseType : c.trueType, doneType);
}

// ---- Generators

/** The requested iteration type of a generator's declared return type, which may be an iterable or an iterator. */
export function getIterationTypeOfGeneratorFunctionReturnType(
  c: Checker,
  kind: IterationTypeKind,
  returnType: Type,
  isAsyncGenerator: boolean,
): Type | undefined {
  if ((returnType.flags & TypeFlags.Any) !== 0) return undefined;
  return getIterationTypesOfGeneratorFunctionReturnType(c, returnType, isAsyncGenerator).getType(kind);
}

export function getIterationTypesOfGeneratorFunctionReturnType(
  c: Checker,
  t: Type,
  isAsyncGenerator: boolean,
): IterationTypes {
  if ((t.flags & TypeFlags.Any) !== 0) return anyIterationTypes(c);
  const use = isAsyncGenerator ? IterationUse.AsyncGeneratorReturnType : IterationUse.GeneratorReturnType;
  const result = getIterationTypesOfIterable(c, t, use, undefined);
  if (result.hasTypes()) return result;
  return getIterationTypesOfIterator(c, t, isAsyncGenerator, undefined, undefined);
}

/** `Generator<T, TReturn, TNext>` or `AsyncGenerator<T, TReturn, TNext>`. */
export function createGeneratorType(
  c: Checker,
  yieldType: Type,
  returnType: Type,
  nextType: Type,
  isAsyncGenerator: boolean,
): Type {
  const globalGeneratorType = getGlobalGeneratorType(c, isAsyncGenerator);
  yieldType = resolveIterationType(c, isAsyncGenerator, yieldType, undefined) ?? c.unknownType;
  returnType = resolveIterationType(c, isAsyncGenerator, returnType, undefined) ?? c.unknownType;
  if (globalGeneratorType === c.emptyGenericType) {
    // Falls back to `IterableIterator`.
    const globalIterableIteratorType = getGlobalIterableIteratorType(c, isAsyncGenerator);
    if (globalIterableIteratorType !== c.emptyGenericType)
      return createTypeFromGenericGlobalType(c, globalIterableIteratorType, [yieldType, returnType, nextType]);
    // Reports the missing global type.
    getGlobalIterableIteratorTypeChecked(c, isAsyncGenerator);
    return c.emptyObjectType;
  }
  return createTypeFromGenericGlobalType(c, globalGeneratorType, [yieldType, returnType, nextType]);
}

/**
 * Whether `Generator<T, TReturn, TNext>` of the iteration types of `returnType` is assignable to
 * it, which catches types such as `interface BadGenerator extends Iterable<number>, Iterator<string> {}`.
 */
export function checkGeneratorInstantiationAssignabilityToReturnType(
  c: Checker,
  returnType: Type,
  functionFlags: FunctionFlags,
  errorNode: Node | undefined,
): boolean {
  const isAsync = (functionFlags & FunctionFlags.Async) !== 0;
  const yieldType =
    getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Yield, returnType, isAsync) ?? c.anyType;
  const generatorReturnType =
    getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Return, returnType, isAsync) ?? yieldType;
  const nextType =
    getIterationTypeOfGeneratorFunctionReturnType(c, IterationTypeKind.Next, returnType, isAsync) ?? c.unknownType;
  const generatorInstantiation = createGeneratorType(c, yieldType, generatorReturnType, nextType, isAsync);
  return checkTypeRelatedTo(
    c,
    generatorInstantiation,
    returnType,
    c.assignableRelation,
    errorNode,
    undefined,
    undefined,
  );
}

/** The type `return` statements are checked against: the generator return type or the promised type. */
export function unwrapReturnType(c: Checker, returnType: Type, functionFlags: FunctionFlags): Type {
  const isAsync = (functionFlags & FunctionFlags.Async) !== 0;
  if ((functionFlags & FunctionFlags.Generator) !== 0) {
    const returnIterationType = getIterationTypeOfGeneratorFunctionReturnType(
      c,
      IterationTypeKind.Return,
      returnType,
      isAsync,
    );
    if (returnIterationType === undefined) return c.errorType;
    return isAsync
      ? (getAwaitedTypeNoAlias(c, unwrapAwaitedType(c, returnIterationType)) ?? c.errorType)
      : returnIterationType;
  }
  return isAsync ? (getAwaitedTypeNoAlias(c, returnType) ?? c.errorType) : returnType;
}

// ---- Awaited types

/** The awaited type of `t`, or the error type when it can't be awaited (reported at `errorNode`). */
export function checkAwaitedType(
  c: Checker,
  t: Type,
  withAlias: boolean,
  errorNode: Node | undefined,
  message: DiagnosticMessage,
): Type {
  const awaitedType = withAlias
    ? getAwaitedTypeEx(c, t, errorNode, message)
    : getAwaitedTypeNoAliasEx(c, t, errorNode, message);
  return awaitedType ?? c.errorType;
}

/**
 * The type `await` produces: the promised type of a promise-like, unwrapped recursively, else the
 * type itself. Generic types are wrapped in `Awaited<T>`.
 */
export function getAwaitedType(c: Checker, t: Type): Type | undefined {
  return getAwaitedTypeEx(c, t, undefined, undefined);
}

export function getAwaitedTypeEx(
  c: Checker,
  t: Type,
  errorNode: Node | undefined,
  message: DiagnosticMessage | undefined,
): Type | undefined {
  const awaitedType = getAwaitedTypeNoAliasEx(c, t, errorNode, message);
  return awaitedType !== undefined ? createAwaitedTypeIfNeeded(c, awaitedType) : undefined;
}

/** The awaited type without an `Awaited<T>` wrapper. */
export function getAwaitedTypeNoAlias(c: Checker, t: Type): Type | undefined {
  return getAwaitedTypeNoAliasEx(c, t, undefined, undefined);
}

export function getAwaitedTypeNoAliasEx(
  c: Checker,
  t: Type,
  errorNode: Node | undefined,
  message: DiagnosticMessage | undefined,
): Type | undefined {
  if ((t.flags & TypeFlags.Any) !== 0) return t;
  // An `Awaited<T>` stays as is, avoiding `Awaited<Awaited<T>>`.
  if (isAwaitedTypeInstantiation(c, t)) return t;
  const key = cachedTypeKey(CachedTypeKind.Awaited, t.id);
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached;
  if ((t.flags & TypeFlags.Union) !== 0) {
    if (c.awaitedTypeStack.includes(t.id)) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Type_is_referenced_directly_or_indirectly_in_the_fulfillment_callback_of_its_own_then_method,
        );
      return undefined;
    }
    c.awaitedTypeStack.push(t.id);
    const mapped = mapType(c, t, (u) => getAwaitedTypeNoAliasEx(c, u, errorNode, message));
    c.awaitedTypeStack.pop();
    c.cachedTypesById.set(key, mapped);
    return mapped;
  }
  // A generic type that should be wrapped in `Awaited<T>` is returned as is.
  if (isAwaitedTypeNeeded(c, t)) {
    c.cachedTypesById.set(key, t);
    return t;
  }
  const promised = getPromisedTypeOfPromiseWorker(c, t, undefined);
  if (promised.promisedType !== undefined) {
    const promisedType = promised.promisedType;
    // A promise of itself, directly or through other promises, never resolves.
    if (t === promisedType || c.awaitedTypeStack.includes(promisedType.id)) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Type_is_referenced_directly_or_indirectly_in_the_fulfillment_callback_of_its_own_then_method,
        );
      return undefined;
    }
    c.awaitedTypeStack.push(t.id);
    const awaitedType = getAwaitedTypeNoAliasEx(c, promisedType, errorNode, message);
    c.awaitedTypeStack.pop();
    if (awaitedType === undefined) return undefined;
    c.cachedTypesById.set(key, awaitedType);
    return awaitedType;
  }
  // A non-promise with a callable `then` would never settle when adopted by a promise.
  if (isThenableType(c, t)) {
    if (errorNode !== undefined && message !== undefined) {
      let chain: Diagnostic | undefined;
      if (promised.thisTypeForError !== undefined)
        chain = createDiagnosticForNode(
          errorNode,
          Diagnostics.The_this_context_of_type_0_is_not_assignable_to_method_s_this_of_type_1,
          [typeToString(c, t), typeToString(c, promised.thisTypeForError)],
        );
      const diagnostic = createDiagnosticForNode(errorNode, message, []);
      if (chain !== undefined) {
        diagnostic.addMessageChain(chain);
        diagnostic.relatedInformation = chain.relatedInformation;
      }
      c.addDiagnostic(diagnostic);
    }
    return undefined;
  }
  c.cachedTypesById.set(key, t);
  return t;
}

export function isAwaitedTypeInstantiation(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Conditional) === 0) return false;
  const awaitedSymbol = getGlobalTypeAliasSymbol(c, 'Awaited', 1, false);
  return (
    awaitedSymbol !== undefined &&
    t.alias !== undefined &&
    t.alias.symbol === awaitedSymbol &&
    t.alias.typeArguments.length === 1
  );
}

/** Whether a generic `t` may be a promise and so awaits to `Awaited<T>`. */
function isAwaitedTypeNeeded(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Any) !== 0 || isAwaitedTypeInstantiation(c, t)) return false;
  if (isGenericObjectType(c, t)) {
    const baseConstraint = getBaseConstraintOfType(c, t);
    if (baseConstraint !== undefined)
      return (
        (baseConstraint.flags & TypeFlags.AnyOrUnknown) !== 0 ||
        isEmptyObjectType(c, baseConstraint) ||
        someType(baseConstraint, (u) => isThenableType(c, u))
      );
    return maybeTypeOfKind(t, TypeFlags.TypeVariable);
  }
  return false;
}

export function createAwaitedTypeIfNeeded(c: Checker, t: Type): Type {
  if (isAwaitedTypeNeeded(c, t)) {
    const awaitedSymbol = getGlobalTypeAliasSymbol(c, 'Awaited', 1, true);
    // Unions are unwrapped so `Awaited<Awaited<T> | U>` becomes `Awaited<T | U>`.
    if (awaitedSymbol !== undefined)
      return getTypeAliasInstantiation(c, awaitedSymbol, [unwrapAwaitedType(c, t)], undefined);
  }
  return t;
}

/** `T` of a generic `Awaited<T>`, through unions. */
export function unwrapAwaitedType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Union) !== 0) return mapType(c, t, (u) => unwrapAwaitedType(c, u));
  if (isAwaitedTypeInstantiation(c, t)) return t.alias!.typeArguments[0]!;
  return t;
}

export function isThenableType(c: Checker, t: Type): boolean {
  // Primitives aren't objects, so they aren't thenable.
  if (allTypesAssignableToKind(c, getBaseConstraintOrType(c, t), TypeFlags.Primitive | TypeFlags.Never)) return false;
  const thenFunction = getTypeOfPropertyOfType(c, t, 'then');
  return (
    thenFunction !== undefined &&
    getSignaturesOfType(c, getTypeWithFacts(c, thenFunction, TypeFacts.NEUndefinedOrNull), SignatureKind.Call)
      .length !== 0
  );
}

/** The awaited promised type of a promise-like, or undefined for other types. */
export function getAwaitedTypeOfPromise(c: Checker, t: Type): Type | undefined {
  const promisedType = getPromisedTypeOfPromise(c, t);
  return promisedType !== undefined ? getAwaitedTypeEx(c, promisedType, undefined, undefined) : undefined;
}

// ---- Promises

class PromisedType {
  readonly promisedType: Type | undefined;
  /** The `this` type of a `then` method that the promise doesn't satisfy. */
  readonly thisTypeForError: Type | undefined;

  constructor(promisedType: Type | undefined, thisTypeForError: Type | undefined) {
    this.promisedType = promisedType;
    this.thisTypeForError = thisTypeForError;
  }
}

function noPromisedType(): PromisedType {
  return new PromisedType(undefined, undefined);
}

/** The type of the `value` parameter of a promise's `onfulfilled` callback, or undefined for non-promises. */
export function getPromisedTypeOfPromise(c: Checker, t: Type): Type | undefined {
  return getPromisedTypeOfPromiseWorker(c, t, undefined).promisedType;
}

export function getPromisedTypeOfPromiseEx(c: Checker, t: Type, errorNode: Node | undefined): Type | undefined {
  return getPromisedTypeOfPromiseWorker(c, t, errorNode).promisedType;
}

function getPromisedTypeOfPromiseWorker(c: Checker, t: Type, errorNode: Node | undefined): PromisedType {
  //  { then(onfulfilled: (value: T) => any): any }
  if ((t.flags & TypeFlags.Any) !== 0) return noPromisedType();
  const key = cachedTypeKey(CachedTypeKind.PromisedTypeOfPromise, t.id);
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return new PromisedType(cached, undefined);
  if (isReferenceToType(t, getGlobalPromiseType(c))) {
    const result = getTypeArguments(c, t)[0]!;
    c.cachedTypesById.set(key, result);
    return new PromisedType(result, undefined);
  }
  // Primitives with a `then` aren't adopted.
  if (allTypesAssignableToKind(c, getBaseConstraintOrType(c, t), TypeFlags.Primitive | TypeFlags.Never))
    return noPromisedType();
  const thenFunction = getTypeOfPropertyOfType(c, t, 'then');
  if (thenFunction !== undefined && (thenFunction.flags & TypeFlags.Any) !== 0) return noPromisedType();
  const thenSignatures = thenFunction !== undefined ? getSignaturesOfType(c, thenFunction, SignatureKind.Call) : [];
  if (thenSignatures.length === 0) {
    if (errorNode !== undefined) c.error(errorNode, Diagnostics.A_promise_must_have_a_then_method);
    return noPromisedType();
  }
  let thisTypeForError: Type | undefined;
  const candidates: Signature[] = [];
  for (const thenSignature of thenSignatures) {
    const thisType = getThisTypeOfSignature(c, thenSignature);
    if (thisType !== undefined && thisType !== c.voidType && !isTypeRelatedTo(c, t, thisType, c.subtypeRelation))
      thisTypeForError = thisType;
    else candidates.push(thenSignature);
  }
  if (candidates.length === 0) {
    if (errorNode !== undefined)
      c.error(
        errorNode,
        Diagnostics.The_this_context_of_type_0_is_not_assignable_to_method_s_this_of_type_1,
        typeToString(c, t),
        typeToString(c, thisTypeForError!),
      );
    return new PromisedType(undefined, thisTypeForError);
  }
  const onfulfilledParameterType = getTypeWithFacts(
    c,
    getUnionType(c, getTypesOfFirstParameterOfSignatures(c, candidates)),
    TypeFacts.NEUndefinedOrNull,
  );
  if ((onfulfilledParameterType.flags & TypeFlags.Any) !== 0) return noPromisedType();
  const onfulfilledParameterSignatures = getSignaturesOfType(c, onfulfilledParameterType, SignatureKind.Call);
  if (onfulfilledParameterSignatures.length === 0) {
    if (errorNode !== undefined)
      c.error(errorNode, Diagnostics.The_first_parameter_of_the_then_method_of_a_promise_must_be_a_callback);
    return noPromisedType();
  }
  const result = getUnionTypeEx(
    c,
    getTypesOfFirstParameterOfSignatures(c, onfulfilledParameterSignatures),
    UnionReduction.Subtype,
    undefined,
    undefined,
  );
  c.cachedTypesById.set(key, result);
  return new PromisedType(result, undefined);
}

function getTypesOfFirstParameterOfSignatures(c: Checker, signatures: readonly Signature[]): Type[] {
  const result: Type[] = [];
  for (const s of signatures) result.push(getTypeOfFirstParameterOfSignature(c, s));
  return result;
}

export function getTypeOfFirstParameterOfSignature(c: Checker, signature: Signature): Type {
  return signature.parameters.length > 0 ? getTypeAtPosition(c, signature, 0) : c.neverType;
}

/** `Promise<T>` of the awaited `T`, or `unknown` without a global `Promise`. */
export function createPromiseType(c: Checker, promisedType: Type): Type {
  const globalPromiseType = getGlobalPromiseTypeChecked(c);
  if (globalPromiseType === c.emptyGenericType) return c.unknownType;
  // A promise of a promise is a promise of its awaited type; `Awaited<T>` unwraps to `T` for inference.
  promisedType = getAwaitedTypeNoAlias(c, unwrapAwaitedType(c, promisedType)) ?? c.unknownType;
  return createTypeReference(c, globalPromiseType, [promisedType]);
}

export function createPromiseLikeType(c: Checker, promisedType: Type): Type {
  const globalPromiseLikeType = getGlobalPromiseLikeType(c);
  if (globalPromiseLikeType === c.emptyGenericType) return c.unknownType;
  promisedType = getAwaitedTypeNoAlias(c, unwrapAwaitedType(c, promisedType)) ?? c.unknownType;
  return createTypeReference(c, globalPromiseLikeType, [promisedType]);
}

/** `Promise<T>` for an async function's body, reporting a missing global `Promise`. */
export function createPromiseReturnType(c: Checker, func: Node, promisedType: Type): Type {
  const promiseType = createPromiseType(c, promisedType);
  if (promiseType === c.unknownType) {
    c.error(
      func,
      func.kind === SyntaxKind.CallExpression
        ? Diagnostics.A_dynamic_import_call_returns_a_Promise_Make_sure_you_have_a_declaration_for_Promise_or_include_ES2015_in_your_lib_option
        : Diagnostics.An_async_function_or_method_must_return_a_Promise_Make_sure_you_have_a_declaration_for_Promise_or_include_ES2015_in_your_lib_option,
    );
    return c.errorType;
  }
  if (getGlobalValueSymbol(c, 'Promise', true) === undefined)
    c.error(
      func,
      func.kind === SyntaxKind.CallExpression
        ? Diagnostics.A_dynamic_import_call_in_ES5_requires_the_Promise_constructor_Make_sure_you_have_a_declaration_for_the_Promise_constructor_or_include_ES2015_in_your_lib_option
        : Diagnostics.An_async_function_or_method_in_ES5_requires_the_Promise_constructor_Make_sure_you_have_a_declaration_for_the_Promise_constructor_or_include_ES2015_in_your_lib_option,
    );
  return promiseType;
}
