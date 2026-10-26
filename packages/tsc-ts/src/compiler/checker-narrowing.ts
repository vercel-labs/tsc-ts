// Control flow analysis: the type of a reference at a position, walking the binder's flow graph
// backwards from the reference through assignments, conditions, calls and labels.
import { sideOf } from './side-state.js';
import {
  type ForInOrOfStatement,
  type MetaProperty,
  type BindingElement,
  type VariableDeclaration,
  type Identifier,
  getName,
  type BinaryExpression,
  type ElementAccessExpression,
  type Node,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  type QualifiedName,
  type SwitchStatement,
  type ShorthandPropertyAssignment,
  type CaseOrDefaultClause,
  getExpression,
  getFlowNode,
  getInitializer,
  getText,
  ExportDeclaration,
  ExportSpecifier,
  ModifierFlags,
  NodeFlags,
  NodeVisitor,
  getArguments,
  getDotDotDotToken,
  getParameters,
  getElements,
  getType,
  getStatements,
} from './ast.js';
import { FlowFlags, type FlowNode, FlowReduceLabel, FlowSwitchClause } from './flow.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  cachedTypePairKey,
  type LiteralType,
  type Type,
  TypeFlags,
  type UnionType,
  CheckMode,
  type EvolvingArrayType,
  InterfaceType,
  NodeCheckFlags,
  ObjectFlags,
  Signature,
  SignatureKind,
  TypePredicate,
  TypePredicateKind,
} from './checker-types.js';
import { getSymbolId, CheckFlags, InternalSymbolName, SymbolFlags, type Symbol } from './symbol.js';
import { getNodeId } from './ast.js';
import {
  TypeFacts,
  getAdjustedTypeWithFacts,
  getNonNullableType,
  getTypeFacts,
  getTypeWithFacts,
  hasTypeFacts,
} from './checker-flow.js';
import {
  UnionReduction,
  everyType,
  filterType,
  getBaseTypeOfLiteralType,
  getFreshTypeOfLiteralType,
  getIntersectionType,
  getRegularTypeOfLiteralType,
  getUnionType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isEmptyAnonymousObjectType,
  isFreshLiteralType,
  isLiteralType,
  isPatternLiteralType,
  isUnitType,
  mapType,
  removeType,
  someType,
  typesOf,
  containsMissingType,
  getNumberLiteralType,
  createArrayType,
  isTupleType,
  newObjectType,
} from './checker-type-factory.js';
import {
  areTypesComparable,
  isDiscriminantProperty,
  isTypeAssignableTo,
  isTypeDerivedFrom,
  isTypeRelatedTo,
  isTypeStrictSubtypeOf,
  isTypeSubsetOf,
  isTypeSubtypeOf,
} from './relations.js';
import {
  checkExpression,
  checkExpressionCached,
  checkExpressionEx,
  checkNonNullExpression,
  checkNonNullType,
  getNarrowableTypeForReference,
  someTypeIsGenericWithUnionConstraint,
  getResolvedSymbol,
  getTypeOfExpression,
  isThisInTypeQuery,
  isTupleLikeType,
} from './checker-expressions.js';
import { isBlockScopedNameDeclaredBeforeUse } from './checker-declaration-order.js';
import {
  getContextualSignature,
  getInferenceContext,
  isContextSensitiveFunctionOrObjectLiteralMethod,
} from './checker-contextual.js';
import { instantiateType } from './instantiation.js';
import { IterationUse, checkIteratedTypeOrElementType } from './checker-iteration.js';
import { checkSuperExpression } from './checker-super.js';
import { getSymbolNameForPrivateIdentifier } from './binder.js';
import { isTypeAssignableToKindEx } from './checker-type-operators.js';
import { getRegularTypeOfObjectLiteral } from './checker-literals.js';
import { checkRightHandSideOfForOf } from './checker-statements.js';
import {
  getApparentType,
  getApplicableIndexInfoForName,
  getBaseConstraintOfType,
  getPropertiesOfType,
  getPropertyOfType,
  getReducedApparentType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
  mapToBaseConstraintOrType,
} from './checker-members.js';
import {
  getAssignmentTarget,
  isAssignmentTarget,
  isPushOrUnshiftIdentifier,
  getCombinedModifierFlags,
  hasStaticModifier,
  getCombinedNodeFlags,
  getImmediatelyInvokedFunctionExpression,
  getRootDeclaration,
  getThisContainer,
  isAssignmentExpression,
  isClassLike,
  isEntityNameExpression,
  isObjectLiteralMethod,
  isExpressionOfOptionalChainRoot,
  isGlobalSourceFile,
  isLogicalOrCoalescingAssignmentOperator,
  isOptionalChain,
  isStatic,
  skipParentheses,
  getRangeOfTokenAtPosition,
  getSourceFileOfNode,
} from './binder-utilities.js';
import { getDeclaredTypeOfSymbol, isConstructorType } from './checker-declared-types.js';
import {
  getErasedSignature,
  getReturnTypeFromAnnotation,
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getTypePredicateOfSignature,
} from './checker-signatures.js';
import {
  getExportSymbolOfValueSymbolIfExported,
  getSymbolOfDeclaration,
  resolveEntityName,
  resolveSymbol,
  getGlobalTypeAliasSymbol,
} from './checker-symbols.js';
import { getOptionalType, getTypeOfSymbol, isReadonlySymbol } from './checker-symbol-types.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName, maybeTypeOfKind } from './checker-utilities.js';
import { getTypeFromTypeNode, getTypeAliasInstantiation } from './checker-type-nodes.js';
import { isFunctionLike, isInJSFile } from './ast-utilities.js';
import { Diagnostic } from './diagnostics.js';
import { Diagnostics } from './diagnostic-messages.js';
import { getOptionalExpressionType, getResolvedSignature } from './checker-calls.js';
import { getSymbolHasInstanceMethodOfObjectType } from './checker-operators.js';
import { getSymbolForPrivateIdentifierExpression } from './checker-property-access.js';
import {
  getIndexedAccessType,
  getLiteralTypeFromPropertyName,
  getTupleElementTypeOutOfStartCount,
} from './checker-type-operators.js';
import {
  getBindingElementTypeFromParentType,
  getNonUndefinedType,
  getTypeForBindingElementParent,
} from './checker-destructuring.js';

/**
 * The number of shared nodes a walk caches before it indexes them. A walk through many consecutive
 * conditions on one reference caches a node for each, and searching them all for each node made
 * such walks cubic in the number of conditions. A walk's own entries stay in the cache until it
 * ends, so a walk with at least this many is indexed.
 */
const sharedFlowIndexThreshold = 128;

/** Indexes the entries of walk `f` in the shared flow cache by their first occurrence. */
function indexSharedFlows(c: Checker, f: FlowState, walkDepth: number): void {
  while (c.sharedFlowIndexes.length <= walkDepth) c.sharedFlowIndexes.push(new Map<FlowNode, number>());
  const index = c.sharedFlowIndexes[walkDepth]!;
  index.clear();
  for (let i = f.sharedFlowStart; i < c.sharedFlowCount; i++) {
    const node = c.sharedFlowNodes[i]!;
    if (!index.has(node)) index.set(node, i);
  }
}

/** The state of one `getFlowTypeOfReference` walk. `incomplete` describes the last returned type. */
export class FlowState {
  reference: Node;
  declaredType: Type;
  initialType: Type;
  flowContainer: Node | undefined;
  refKey: string | undefined = undefined;
  depth = 0;
  sharedFlowStart = 0;
  incomplete = false;
  /** The flow nodes visited, and the deepest nesting of the walk. */
  steps = 0;
  maxDepth = 0;
  /** Whether this walk may be kept and end on a kept one (`FlowWalk`), and whether it looked one up. */
  keepsWalk = false;
  lookedUp = false;
  /** The reference's last long walk, which this walk may end on. */
  walk: FlowWalk | undefined = undefined;
  /** The node where this walk would be kept from: see `flowWalkAnchorSteps`. */
  anchor: FlowNode | undefined = undefined;
  /** Whether the result depends on where the reference is, not only on its key. */
  positional = false;

  constructor(reference: Node, declaredType: Type, initialType: Type, flowContainer: Node | undefined) {
    this.reference = reference;
    this.declaredType = declaredType;
    this.initialType = initialType;
    this.flowContainer = flowContainer;
  }

  /** Prepares a free flow state for another walk. */
  reset(reference: Node, declaredType: Type, initialType: Type, flowContainer: Node | undefined): void {
    this.reference = reference;
    this.declaredType = declaredType;
    this.initialType = initialType;
    this.flowContainer = flowContainer;
    this.refKey = undefined;
    this.depth = 0;
    this.sharedFlowStart = 0;
    this.incomplete = false;
    this.steps = 0;
    this.maxDepth = 0;
    this.keepsWalk = false;
    this.lookedUp = false;
    this.walk = undefined;
    this.anchor = undefined;
    this.positional = false;
  }
}

/**
 * A node of a reference's last long walk, and the walk's result. Without loops or reduce labels in
 * effect, the type of a reference at a flow node doesn't change, so a later walk that reaches `start`
 * ends there. In a long list of top-level declarations, each reference otherwise walks back over
 * every one before it.
 */
export class FlowWalk {
  start: FlowNode;
  type: Type;
  /** The deepest nesting of a walk from `start`, which reaches the depth limit the same way. */
  depth: number;

  constructor(start: FlowNode, type: Type, depth: number) {
    this.start = start;
    this.type = type;
    this.depth = depth;
  }
}

/** Walks shorter than this aren't kept. */
const minFlowWalkSteps = 32;

/**
 * The step of a frame of a walk at which the walk looks up the reference's kept walk; in the first
 * frame, also the node it would be kept from. Every node a frame passes before the last one leaves
 * the type unchanged, so the type there is the walk's result. Shorter walks don't compute the
 * reference's key. A later walk that passes this walk's start reaches the node after this many steps
 * or more, once it has looked.
 */
const flowWalkAnchorSteps = 16;

/**
 * Whether `node` is an identifier, `this`, or property and element accesses on one. Walks of such
 * references with the same key (`getFlowReferenceKey`) go the same way; with parentheses or a
 * non-null assertion in between, a reference has the key of the one without, but not its walk.
 */
function isDottedReference(node: Node): boolean {
  let n = node;
  for (;;) {
    switch (n.kind) {
      case SyntaxKind.Identifier:
        return !isThisInTypeQuery(n);
      case SyntaxKind.ThisKeyword:
        return true;
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        n = getExpression(n)!;
        break;
      default:
        return false;
    }
  }
}

/**
 * Whether an element access in `node` names a property with a character that keys use as a
 * separator (`.`, `@`, `#`). Its key can then be another reference's, as `o["a.b"]` has the key of
 * `o.a.b`, so its walks aren't kept.
 */
function hasKeyCharacterInName(c: Checker, node: Node): boolean {
  let n = node;
  while (n.kind === SyntaxKind.PropertyAccessExpression || n.kind === SyntaxKind.ElementAccessExpression) {
    if (n.kind === SyntaxKind.ElementAccessExpression) {
      const name = getAccessedPropertyName(c, n);
      if (name !== undefined && /[.@#]/.test(name)) return true;
    }
    n = getExpression(n)!;
  }
  return false;
}

/** A loop junction being analyzed for a reference, with the types seen on its paths so far. */
export class FlowLoopInfo {
  readonly flow: FlowNode;
  readonly refKey: string;
  readonly types: Type[];

  constructor(flow: FlowNode, refKey: string, types: Type[]) {
    this.flow = flow;
    this.refKey = refKey;
    this.types = types;
  }
}

/** The type of `reference` at its flow position, narrowed from `declaredType` starting at `initialType`. */
export function getFlowTypeOfReference(
  c: Checker,
  reference: Node,
  declaredType: Type,
  initialType: Type,
  flowContainer: Node | undefined,
): Type {
  return getFlowTypeOfReferenceAt(c, reference, declaredType, initialType, flowContainer, getFlowNode(reference));
}

/** `getFlowTypeOfReference` at `flowNode`, for pseudo-references such as binding patterns. */
export function getFlowTypeOfReferenceAt(
  c: Checker,
  reference: Node,
  declaredType: Type,
  initialType: Type,
  flowContainer: Node | undefined,
  flowNode: FlowNode | undefined,
): Type {
  if (c.flowAnalysisDisabled) return c.errorType;
  if (flowNode === undefined) return declaredType;
  let f: FlowState;
  const stateDepth = c.flowStateDepth;
  if (stateDepth < c.flowStates.length) {
    f = c.flowStates[stateDepth]!;
    f.reset(reference, declaredType, initialType, flowContainer);
  } else {
    f = new FlowState(reference, declaredType, initialType, flowContainer);
    c.flowStates.push(f);
  }
  c.flowStateDepth = stateDepth + 1;
  f.sharedFlowStart = c.sharedFlowCount;
  c.flowInvocationCount++;
  f.keepsWalk =
    c.flowLoopStack.length === 0 &&
    c.flowReduceLabels.length === 0 &&
    c.inlineLevel === 0 &&
    isDottedReference(reference);
  const cycles = c.resolutionCycleCount;
  const evolvedType = getTypeAtFlowNode(c, f, flowNode);
  const anchor = f.anchor;
  if (
    anchor !== undefined &&
    f.steps >= minFlowWalkSteps &&
    !f.incomplete &&
    !f.positional &&
    !c.flowAnalysisDisabled &&
    c.resolutionCycleCount === cycles
  ) {
    const walk = f.walk;
    if (walk !== undefined) {
      walk.start = anchor;
      walk.type = evolvedType;
      walk.depth = f.maxDepth;
    } else c.flowWalks.set(f.refKey!, new FlowWalk(anchor, evolvedType, f.maxDepth));
  }
  c.sharedFlowCount = f.sharedFlowStart;
  c.flowStateDepth = stateDepth;
  // `x` in `x.length`, `x.push(v)`, `x.unshift(v)` or `x[n] = v` stays `any[]` so empty arrays may be
  // operated on and new element types inferred without implicit any or mismatch errors.
  const resultType =
    (evolvedType.objectFlags & ObjectFlags.EvolvingArray) !== 0 && isEvolvingArrayOperationTarget(c, reference)
      ? c.autoArrayType
      : finalizeEvolvingArrayType(c, evolvedType);
  if (
    resultType === c.unreachableNeverType ||
    (reference.parent !== undefined &&
      reference.parent.kind === SyntaxKind.NonNullExpression &&
      (resultType.flags & TypeFlags.Never) === 0 &&
      (getTypeWithFacts(c, resultType, TypeFacts.NEUndefinedOrNull).flags & TypeFlags.Never) !== 0)
  )
    return declaredType;
  return resultType;
}

function newFlowType(c: Checker, f: FlowState, t: Type, incomplete: boolean): Type {
  f.incomplete = incomplete;
  return incomplete && (t.flags & TypeFlags.Never) !== 0 ? c.silentNeverType : t;
}

function complete(f: FlowState, t: Type): Type {
  f.incomplete = false;
  return t;
}

export function getTypeAtFlowNode(c: Checker, f: FlowState, start: FlowNode): Type {
  if (f.depth === 2000) {
    c.flowAnalysisDisabled = true;
    reportFlowControlError(c, f.reference);
    return complete(f, c.errorType);
  }
  f.depth++;
  if (f.depth > f.maxDepth) f.maxDepth = f.depth;
  let flow = start;
  let sharedFlow: FlowNode | undefined = undefined;
  let frameSteps = 0;
  for (;;) {
    f.steps++;
    if (++frameSteps === flowWalkAnchorSteps && f.keepsWalk && !f.lookedUp) {
      f.lookedUp = true;
      if (f.refKey === undefined) f.refKey = getFlowReferenceKey(c, f);
      if (f.refKey !== '' && !hasKeyCharacterInName(c, f.reference)) {
        f.walk = c.flowWalks.get(f.refKey);
        // Only the first frame's nodes have the walk's result as their type.
        if (f.depth === 1) f.anchor = flow;
      }
    }
    const walk = f.walk;
    const flags = flow.flags;
    if ((flags & FlowFlags.Shared) !== 0) {
      // Shared nodes are cached for the duration of one walk.
      if (c.sharedFlowCount - f.sharedFlowStart >= sharedFlowIndexThreshold) {
        const i = c.sharedFlowIndexes[c.flowStateDepth - 1]!.get(flow);
        if (i !== undefined) {
          f.depth--;
          f.incomplete = c.sharedFlowIncomplete[i]!;
          return c.sharedFlowTypes[i]!;
        }
      } else
        for (let i = f.sharedFlowStart; i < c.sharedFlowCount; i++) {
          if (c.sharedFlowNodes[i]! === flow) {
            f.depth--;
            f.incomplete = c.sharedFlowIncomplete[i]!;
            return c.sharedFlowTypes[i]!;
          }
        }
      sharedFlow = flow;
    }
    let t: Type;
    if (
      walk !== undefined &&
      flow === walk.start &&
      c.flowLoopStack.length === 0 &&
      c.flowReduceLabels.length === 0 &&
      c.inlineLevel === 0 &&
      f.depth + walk.depth - 1 <= 2000
    ) {
      if (f.depth + walk.depth - 1 > f.maxDepth) f.maxDepth = f.depth + walk.depth - 1;
      t = complete(f, walk.type);
    } else if ((flags & FlowFlags.Assignment) !== 0) {
      const assigned = getTypeAtFlowAssignment(c, f, flow);
      if (assigned === undefined) {
        flow = flow.antecedent!;
        continue;
      }
      t = assigned;
    } else if ((flags & FlowFlags.Call) !== 0) {
      const narrowed = getTypeAtFlowCall(c, f, flow);
      if (narrowed === undefined) {
        flow = flow.antecedent!;
        continue;
      }
      t = narrowed;
    } else if ((flags & FlowFlags.Condition) !== 0) t = getTypeAtFlowCondition(c, f, flow);
    else if ((flags & FlowFlags.SwitchClause) !== 0) t = getTypeAtSwitchClause(c, f, flow as FlowSwitchClause);
    else if ((flags & FlowFlags.BranchLabel) !== 0) {
      const antecedents = getBranchLabelAntecedents(c, flow);
      if (antecedents.length === 1) {
        flow = antecedents[0]!;
        continue;
      }
      t = getTypeAtFlowBranchLabel(c, f, antecedents);
    } else if ((flags & FlowFlags.LoopLabel) !== 0) {
      const antecedents = flow.antecedents!;
      if (antecedents.length === 1) {
        flow = antecedents[0]!;
        continue;
      }
      t = getTypeAtFlowLoopLabel(c, f, flow);
    } else if ((flags & FlowFlags.ArrayMutation) !== 0) {
      const mutated = getTypeAtFlowArrayMutation(c, f, flow);
      if (mutated === undefined) {
        flow = flow.antecedent!;
        continue;
      }
      t = mutated;
    } else if ((flags & FlowFlags.ReduceLabel) !== 0) {
      c.flowReduceLabels.push(flow as FlowReduceLabel);
      t = getTypeAtFlowNode(c, f, flow.antecedent!);
      c.flowReduceLabels.pop();
    } else if ((flags & FlowFlags.Start) !== 0) {
      // Continue with the containing function's flow when the reference is captured.
      const container = flow.node;
      if (
        container !== undefined &&
        container !== f.flowContainer &&
        f.reference.kind !== SyntaxKind.PropertyAccessExpression &&
        f.reference.kind !== SyntaxKind.ElementAccessExpression &&
        !(f.reference.kind === SyntaxKind.ThisKeyword && container.kind !== SyntaxKind.ArrowFunction)
      ) {
        const outer = getFlowNode(container);
        if (outer !== undefined) {
          flow = outer;
          continue;
        }
      }
      t = complete(f, f.initialType);
    } else {
      // Unreachable code; errors are reported by the binder.
      t = complete(f, convertAutoToAny(c, f.declaredType));
    }
    if (sharedFlow !== undefined) {
      const count = c.sharedFlowCount;
      if (count < c.sharedFlowNodes.length) {
        c.sharedFlowNodes[count] = sharedFlow;
        c.sharedFlowTypes[count] = t;
        c.sharedFlowIncomplete[count] = f.incomplete;
      } else {
        c.sharedFlowNodes.push(sharedFlow);
        c.sharedFlowTypes.push(t);
        c.sharedFlowIncomplete.push(f.incomplete);
      }
      c.sharedFlowCount = count + 1;
      const own = count + 1 - f.sharedFlowStart;
      if (own > sharedFlowIndexThreshold) {
        const index = c.sharedFlowIndexes[c.flowStateDepth - 1]!;
        if (!index.has(sharedFlow)) index.set(sharedFlow, count);
      } else if (own === sharedFlowIndexThreshold) indexSharedFlows(c, f, c.flowStateDepth - 1);
    }
    f.depth--;
    return t;
  }
}

export function convertAutoToAny(c: Checker, t: Type): Type {
  if (t === c.autoType) return c.anyType;
  if (t === c.autoArrayType) return c.anyArrayType;
  return t;
}

/** A branch label's antecedents, as limited by the innermost reduce label being passed that targets it. */
export function getBranchLabelAntecedents(c: Checker, flow: FlowNode): FlowNode[] {
  const reduceLabels = c.flowReduceLabels;
  for (let i = reduceLabels.length - 1; i >= 0; i--)
    if (reduceLabels[i]!.target === flow) return reduceLabels[i]!.antecedents!;
  return flow.antecedents!;
}

// ---- Assignments and calls

function getTypeAtFlowAssignment(c: Checker, f: FlowState, flow: FlowNode): Type | undefined {
  const node = flow.node!;
  if (isMatchingReference(c, f.reference, node)) {
    if (!isReachableFlowNode(c, flow)) return complete(f, c.unreachableNeverType);
    if (getAssignmentTargetKind(node) === AssignmentKind.Compound) {
      const flowType = getTypeAtFlowNode(c, f, flow.antecedent!);
      return newFlowType(c, f, getBaseTypeOfLiteralType(c, flowType), f.incomplete);
    }
    if (f.declaredType === c.autoType || f.declaredType === c.autoArrayType) {
      if (isEmptyArrayAssignment(node)) return complete(f, getEvolvingArrayType(c, c.neverType));
      const assignedType = getWidenedLiteralType(c, getInitialOrAssignedType(c, f, flow));
      return complete(f, isTypeAssignableTo(c, assignedType, f.declaredType) ? assignedType : c.anyArrayType);
    }
    let t = f.declaredType;
    if (isInCompoundLikeAssignment(node)) t = getBaseTypeOfLiteralType(c, t);
    if ((t.flags & TypeFlags.Union) !== 0)
      return complete(f, getAssignmentReducedType(c, t, getInitialOrAssignedType(c, f, flow)));
    return complete(f, t);
  }
  // An assignment to a prefix of a dotted name resets it to the declared type.
  if (containsMatchingReference(c, f.reference, node)) {
    if (!isReachableFlowNode(c, flow)) return complete(f, c.unreachableNeverType);
    // The dotted name may be an expando property of a function expression; its flow continues
    // back past the function's declaration.
    if (node.kind === SyntaxKind.VariableDeclaration) {
      const blockScope = getCombinedNodeFlags(node) & NodeFlags.BlockScoped;
      const initializer = getInitializer(node);
      if (
        (isInJSFile(node) ||
          blockScope === NodeFlags.Const ||
          blockScope === NodeFlags.Using ||
          blockScope === NodeFlags.AwaitUsing) &&
        initializer !== undefined &&
        (initializer.kind === SyntaxKind.FunctionExpression || initializer.kind === SyntaxKind.ArrowFunction)
      )
        return getTypeAtFlowNode(c, f, flow.antecedent!);
    }
    return complete(f, f.declaredType);
  }
  // `for (const _ in ref)` acts as a non-null check of `ref`.
  if (node.kind === SyntaxKind.VariableDeclaration && node.parent!.parent!.kind === SyntaxKind.ForInStatement) {
    const statementExpression = getExpression(node.parent!.parent!)!;
    if (
      isMatchingReference(c, f.reference, statementExpression) ||
      optionalChainContainsReference(c, statementExpression, f.reference)
    ) {
      const antecedentType = getTypeAtFlowNode(c, f, flow.antecedent!);
      const finalType = finalizeEvolvingArrayType(c, antecedentType);
      return complete(
        f,
        hasTypeFacts(c, finalType, TypeFacts.IsUndefinedOrNull) ? getNonNullableType(c, finalType) : finalType,
      );
    }
  }
  return undefined;
}

function isEmptyArrayAssignment(node: Node): boolean {
  if (node.kind === SyntaxKind.VariableDeclaration) {
    const initializer = getInitializer(node);
    return initializer !== undefined && isEmptyArrayLiteral(initializer);
  }
  const parent = node.parent!;
  return (
    node.kind !== SyntaxKind.BindingElement &&
    parent.kind === SyntaxKind.BinaryExpression &&
    isEmptyArrayLiteral((parent as BinaryExpression).right)
  );
}

function isEmptyArrayLiteral(node: Node): boolean {
  return node.kind === SyntaxKind.ArrayLiteralExpression && getElements(node)!.nodes.length === 0;
}

function getInitialOrAssignedType(c: Checker, f: FlowState, flow: FlowNode): Type {
  const node = flow.node!;
  const t =
    node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.BindingElement
      ? getInitialType(c, node)
      : getAssignedType(c, node);
  // getNarrowableTypeForReference looks at the reference's position for these.
  if (someTypeIsGenericWithUnionConstraint(c, t)) f.positional = true;
  return getNarrowableTypeForReference(c, t, f.reference);
}

function getInitialType(c: Checker, node: Node): Type {
  if (node.kind === SyntaxKind.VariableDeclaration) {
    const initializer = getInitializer(node);
    if (initializer !== undefined) return getTypeOfInitializer(c, initializer);
    const statement = node.parent!.parent!;
    if (statement.kind === SyntaxKind.ForInStatement) return c.stringType;
    if (statement.kind === SyntaxKind.ForOfStatement) return checkRightHandSideOfForOf(c, statement);
    return c.errorType;
  }
  return getInitialTypeOfBindingElement(c, node as BindingElement);
}

/** The type of an initializer: the type a variable was inferred from, else computed without caching. */
export function getTypeOfInitializer(c: Checker, node: Node): Type {
  return c.resolvedTypes.get(node.id) ?? getTypeOfExpression(c, node);
}

function getInitialTypeOfBindingElement(c: Checker, node: BindingElement): Type {
  const pattern = node.parent!;
  const parentType = getInitialType(c, pattern.parent!);
  let t: Type;
  if (pattern.kind === SyntaxKind.ObjectBindingPattern)
    t = getTypeOfDestructuredProperty(c, parentType, (node.propertyName ?? node.name)!);
  else if (node.dotDotDotToken === undefined)
    t = getTypeOfDestructuredArrayElement(c, parentType, getElements(pattern)!.nodes.indexOf(node));
  else t = getTypeOfDestructuredSpreadExpression(c, parentType);
  return getTypeWithDefault(c, t, node.initializer);
}

function getAssignedType(c: Checker, node: Node): Type {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.ForInStatement:
      return c.stringType;
    case SyntaxKind.ForOfStatement:
      return checkRightHandSideOfForOf(c, parent);
    case SyntaxKind.BinaryExpression:
      return getAssignedTypeOfBinaryExpression(c, parent as BinaryExpression);
    case SyntaxKind.DeleteExpression:
      return c.undefinedType;
    case SyntaxKind.ArrayLiteralExpression:
      return getTypeOfDestructuredArrayElement(c, getAssignedType(c, parent), getElements(parent)!.nodes.indexOf(node));
    case SyntaxKind.SpreadElement:
      return getTypeOfDestructuredSpreadExpression(c, getAssignedType(c, parent.parent!));
    case SyntaxKind.PropertyAssignment:
      return getAssignedTypeOfPropertyAssignment(c, parent);
    case SyntaxKind.ShorthandPropertyAssignment:
      return getTypeWithDefault(
        c,
        getAssignedTypeOfPropertyAssignment(c, parent),
        (parent as ShorthandPropertyAssignment).objectAssignmentInitializer,
      );
  }
  return c.errorType;
}

function getAssignedTypeOfBinaryExpression(c: Checker, node: BinaryExpression): Type {
  const parent = node.parent!;
  const isDestructuringDefaultAssignment =
    (parent.kind === SyntaxKind.ArrayLiteralExpression && isDestructuringAssignmentTarget(parent)) ||
    (parent.kind === SyntaxKind.PropertyAssignment && isDestructuringAssignmentTarget(parent.parent!));
  if (isDestructuringDefaultAssignment) return getTypeWithDefault(c, getAssignedType(c, node), node.right);
  return getTypeOfExpression(c, node.right);
}

function isDestructuringAssignmentTarget(parent: Node): boolean {
  const grandparent = parent.parent!;
  return (
    (grandparent.kind === SyntaxKind.BinaryExpression && (grandparent as BinaryExpression).left === parent) ||
    (grandparent.kind === SyntaxKind.ForOfStatement && (grandparent as ForInOrOfStatement).initializer === parent)
  );
}

function getAssignedTypeOfPropertyAssignment(c: Checker, node: Node): Type {
  return getTypeOfDestructuredProperty(c, getAssignedType(c, node.parent!), getName(node)!);
}

function getTypeOfDestructuredArrayElement(c: Checker, t: Type, index: number): Type {
  if (everyType(t, (u) => isTupleLikeType(c, u))) {
    const elementType = getTupleElementType(c, t, index);
    if (elementType !== undefined) return elementType;
  }
  return includeUndefinedInIndexSignature(
    c,
    checkIteratedTypeOrElementType(c, IterationUse.Destructuring, t, c.undefinedType, undefined),
  );
}

function getTupleElementType(c: Checker, t: Type, index: number): Type | undefined {
  const propType = getTypeOfPropertyOfType(c, t, String(index));
  if (propType !== undefined) return propType;
  if (everyType(t, isTupleType))
    return getTupleElementTypeOutOfStartCount(c, t, index, c.noUncheckedIndexedAccess ? c.undefinedType : undefined);
  return undefined;
}

function includeUndefinedInIndexSignature(c: Checker, t: Type): Type {
  return c.noUncheckedIndexedAccess ? getUnionType(c, [t, c.missingType]) : t;
}

function getTypeOfDestructuredSpreadExpression(c: Checker, t: Type): Type {
  return createArrayType(
    c,
    checkIteratedTypeOrElementType(c, IterationUse.Destructuring, t, c.undefinedType, undefined),
  );
}

function getTypeOfDestructuredProperty(c: Checker, t: Type, name: Node): Type {
  const nameType = getLiteralTypeFromPropertyName(c, name);
  if (nameType === undefined || !isTypeUsableAsPropertyName(nameType)) return c.errorType;
  const text = getPropertyNameFromType(nameType);
  const propType = getTypeOfPropertyOfType(c, t, text);
  if (propType !== undefined) return propType;
  const indexInfo = getApplicableIndexInfoForName(c, t, text);
  if (indexInfo !== undefined) return includeUndefinedInIndexSignature(c, indexInfo.valueType);
  return c.errorType;
}

function getTypeWithDefault(c: Checker, t: Type, defaultExpression: Node | undefined): Type {
  return defaultExpression !== undefined
    ? getUnionType(c, [getNonUndefinedType(c, t), getTypeOfExpression(c, defaultExpression)])
    : t;
}

/** The constituents of `declaredType` that some constituent of `assignedType` is assignable to. */
export function getAssignmentReducedType(c: Checker, declaredType: Type, assignedType: Type): Type {
  if (declaredType === assignedType) return declaredType;
  if ((assignedType.flags & TypeFlags.Never) !== 0) return assignedType;
  const pair = cachedTypePairKey(declaredType.id, assignedType.id, 0);
  const key = pair < 0 ? 'assignmentReduced' + declaredType.id + ',' + assignedType.id : '';
  let result = pair < 0 ? c.cachedTypes.get(key) : c.cachedTypesByPair.get(pair);
  if (result === undefined) {
    const filteredType = filterType(c, declaredType, (t) => typeMaybeAssignableTo(c, assignedType, t));
    let reducedType = filteredType;
    if ((assignedType.flags & TypeFlags.BooleanLiteral) !== 0 && isFreshLiteralType(assignedType))
      reducedType = mapType(c, filteredType, (t) => getFreshTypeOfLiteralType(c, t));
    result = isTypeAssignableTo(c, assignedType, reducedType) ? reducedType : declaredType;
    if (pair < 0) c.cachedTypes.set(key, result);
    else c.cachedTypesByPair.set(pair, result);
  }
  return result;
}

function typeMaybeAssignableTo(c: Checker, source: Type, target: Type): boolean {
  if ((source.flags & TypeFlags.Union) === 0) return isTypeAssignableTo(c, source, target);
  for (const t of typesOf(source)) if (isTypeAssignableTo(c, t, target)) return true;
  return false;
}

function getTypeAtFlowCall(c: Checker, f: FlowState, flow: FlowNode): Type | undefined {
  const call = flow.node!;
  const signature = getEffectsSignature(c, call);
  if (signature === undefined) return undefined;
  const predicate = getTypePredicateOfSignature(c, signature);
  if (
    predicate !== undefined &&
    (predicate.kind === TypePredicateKind.AssertsThis || predicate.kind === TypePredicateKind.AssertsIdentifier)
  ) {
    const flowType = getTypeAtFlowNode(c, f, flow.antecedent!);
    const incomplete = f.incomplete;
    const t = finalizeEvolvingArrayType(c, flowType);
    let narrowedType = t;
    const args = getArguments(call)!.nodes;
    if (predicate.type !== undefined) narrowedType = narrowTypeByTypePredicate(c, f, t, predicate, call, true);
    else if (
      predicate.kind === TypePredicateKind.AssertsIdentifier &&
      predicate.parameterIndex >= 0 &&
      predicate.parameterIndex < args.length
    )
      narrowedType = narrowTypeByAssertion(c, f, t, args[predicate.parameterIndex]!);
    if (narrowedType === t) return newFlowType(c, f, flowType, incomplete);
    return newFlowType(c, f, narrowedType, incomplete);
  }
  if ((getReturnTypeOfSignature(c, signature).flags & TypeFlags.Never) !== 0)
    return complete(f, c.unreachableNeverType);
  return undefined;
}

function narrowTypeByAssertion(c: Checker, f: FlowState, t: Type, expr: Node): Type {
  const node = skipParentheses(expr);
  if (node.kind === SyntaxKind.FalseKeyword) return c.unreachableNeverType;
  if (node.kind === SyntaxKind.BinaryExpression) {
    const binary = node as BinaryExpression;
    if (binary.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken)
      return narrowTypeByAssertion(c, f, narrowTypeByAssertion(c, f, t, binary.left), binary.right);
    if (binary.operatorToken.kind === SyntaxKind.BarBarToken)
      return getUnionType(c, [
        narrowTypeByAssertion(c, f, t, binary.left),
        narrowTypeByAssertion(c, f, t, binary.right),
      ]);
  }
  return narrowType(c, f, t, node, true);
}

/** The signature of a call whose effects (type predicates, `never` returns) apply to control flow. */
export function getEffectsSignature(c: Checker, node: Node): Signature | undefined {
  const links = c.nodeLinks(node);
  let signature = links.effectsSignature;
  if (signature === undefined) {
    // Assertion calls resolve their target with getTypeOfDottedName to avoid circularities.
    let funcType: Type | undefined = undefined;
    if (node.kind === SyntaxKind.BinaryExpression)
      funcType = getSymbolHasInstanceMethodOfObjectType(c, checkNonNullExpression(c, (node as BinaryExpression).right));
    else {
      const callee = getExpression(node)!;
      // Assertions resolve their target without inference, to avoid circularities in flow analysis.
      if (node.parent!.kind === SyntaxKind.ExpressionStatement) funcType = getTypeOfDottedName(c, callee);
      else if (callee.kind !== SyntaxKind.SuperKeyword)
        funcType = isOptionalChain(node)
          ? checkNonNullType(c, getOptionalExpressionType(c, checkExpression(c, callee), callee), callee)
          : checkNonNullExpression(c, callee);
    }
    const signatures = getSignaturesOfType(
      c,
      funcType !== undefined ? getApparentType(c, funcType) : c.unknownType,
      SignatureKind.Call,
    );
    let candidate: Signature | undefined = undefined;
    if (signatures.length === 1 && signatures[0]!.typeParameters.length === 0) candidate = signatures[0]!;
    // Generic or overloaded predicates and assertions take effect through the resolved signature.
    else if (someSignatureHasTypePredicateOrNeverReturnType(c, signatures))
      candidate = getResolvedSignature(c, node, CheckMode.Normal);
    signature =
      candidate !== undefined && hasTypePredicateOrNeverReturnType(c, candidate) ? candidate : c.unknownSignature;
    links.effectsSignature = signature;
  }
  return signature === c.unknownSignature ? undefined : signature;
}

function someSignatureHasTypePredicateOrNeverReturnType(c: Checker, signatures: readonly Signature[]): boolean {
  for (const sig of signatures) if (hasTypePredicateOrNeverReturnType(c, sig)) return true;
  return false;
}

function hasTypePredicateOrNeverReturnType(c: Checker, sig: Signature): boolean {
  if (getTypePredicateOfSignature(c, sig) !== undefined) return true;
  if (sig.declaration === undefined) return false;
  const returnType = getReturnTypeFromAnnotation(c, sig.declaration);
  return returnType !== undefined && (returnType.flags & TypeFlags.Never) !== 0;
}

/** The declared type of a dotted name, without inference, for assertion calls. */
function getTypeOfDottedName(c: Checker, node: Node): Type | undefined {
  if ((node.flags & NodeFlags.InWithStatement) !== 0) return undefined;
  switch (node.kind) {
    case SyntaxKind.Identifier:
      return getExplicitTypeOfSymbol(c, getExportSymbolOfValueSymbolIfExported(c, getResolvedSymbol(c, node)));
    case SyntaxKind.ThisKeyword:
      return getExplicitThisType(c, node);
    case SyntaxKind.SuperKeyword:
      return checkSuperExpression(c, node);
    case SyntaxKind.PropertyAccessExpression: {
      const t = getTypeOfDottedName(c, getExpression(node)!);
      if (t === undefined) return undefined;
      const name = (node as PropertyAccessExpression).name;
      let prop: Symbol | undefined;
      if (name.kind === SyntaxKind.PrivateIdentifier)
        prop =
          t.symbol !== undefined
            ? getPropertyOfType(c, t, getSymbolNameForPrivateIdentifier(t.symbol, getText(name)))
            : undefined;
      else prop = getPropertyOfType(c, t, getText(name));
      return prop !== undefined ? getExplicitTypeOfSymbol(c, prop) : undefined;
    }
    case SyntaxKind.ParenthesizedExpression:
      return getTypeOfDottedName(c, getExpression(node)!);
  }
  return undefined;
}

function getExplicitTypeOfSymbol(c: Checker, original: Symbol): Type | undefined {
  const symbol = resolveSymbol(c, original) ?? original;
  if ((symbol.flags & (SymbolFlags.Function | SymbolFlags.Method | SymbolFlags.Class | SymbolFlags.ValueModule)) !== 0)
    return getTypeOfSymbol(c, symbol);
  if ((symbol.flags & (SymbolFlags.Variable | SymbolFlags.Property)) !== 0) {
    if ((symbol.checkFlags & CheckFlags.Mapped) !== 0) {
      const origin = c.symbolSyntheticOrigins.get(getSymbolId(symbol));
      if (origin !== undefined && getExplicitTypeOfSymbol(c, origin) !== undefined) return getTypeOfSymbol(c, symbol);
    }
    const declaration = symbol.valueDeclaration;
    if (declaration !== undefined) {
      if (isDeclarationWithExplicitTypeAnnotation(declaration)) return getTypeOfSymbol(c, symbol);
      // `for (const x of xs)` where `xs` has an explicit type.
      if (
        declaration.kind === SyntaxKind.VariableDeclaration &&
        declaration.parent!.parent!.kind === SyntaxKind.ForOfStatement
      ) {
        const statement = declaration.parent!.parent! as ForInOrOfStatement;
        const expressionType = getTypeOfDottedName(c, statement.expression);
        if (expressionType !== undefined)
          return checkIteratedTypeOrElementType(
            c,
            statement.awaitModifier !== undefined ? IterationUse.ForAwaitOf : IterationUse.ForOf,
            expressionType,
            c.undefinedType,
            undefined,
          );
      }
    }
  }
  return undefined;
}

function isDeclarationWithExplicitTypeAnnotation(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.Parameter:
      return getType(node) !== undefined;
    case SyntaxKind.BinaryExpression: {
      // An expando property assigned a function with a return type annotation.
      const right = (node as BinaryExpression).right;
      return isFunctionLike(right) && getType(right) !== undefined;
    }
  }
  return false;
}

function getExplicitThisType(c: Checker, node: Node): Type | undefined {
  const container = getThisContainer(node, false, false);
  if (isFunctionLike(container)) {
    const signature = getSignatureFromDeclaration(c, container);
    if (signature.thisParameter !== undefined) return getExplicitTypeOfSymbol(c, signature.thisParameter);
  }
  const parent = container.parent;
  if (parent !== undefined && isClassLike(parent)) {
    const symbol = getSymbolOfDeclaration(c, parent);
    if (symbol === undefined) return undefined;
    return isStatic(container)
      ? getTypeOfSymbol(c, symbol)
      : (getDeclaredTypeOfSymbol(c, symbol) as InterfaceType).thisType;
  }
  return undefined;
}

// ---- Conditions

function getTypeAtFlowCondition(c: Checker, f: FlowState, flow: FlowNode): Type {
  const flowType = getTypeAtFlowNode(c, f, flow.antecedent!);
  const incomplete = f.incomplete;
  if ((flowType.flags & TypeFlags.Never) !== 0) return newFlowType(c, f, flowType, incomplete);
  const assumeTrue = (flow.flags & FlowFlags.TrueCondition) !== 0;
  const nonEvolvingType = finalizeEvolvingArrayType(c, flowType);
  const narrowedType = narrowType(c, f, nonEvolvingType, flow.node!, assumeTrue);
  if (narrowedType === nonEvolvingType) {
    f.incomplete = incomplete;
    return flowType;
  }
  return newFlowType(c, f, narrowedType, incomplete);
}

function getTypeAtFlowBranchLabel(c: Checker, f: FlowState, antecedents: FlowNode[]): Type {
  const types: Type[] = [];
  let subtypeReduction = false;
  let seenIncomplete = false;
  let bypassFlow: FlowSwitchClause | undefined = undefined;
  for (const antecedent of antecedents) {
    if (
      bypassFlow === undefined &&
      (antecedent.flags & FlowFlags.SwitchClause) !== 0 &&
      (antecedent as FlowSwitchClause).isEmpty()
    ) {
      // The bypass branch of a possibly exhaustive switch.
      bypassFlow = antecedent as FlowSwitchClause;
      continue;
    }
    const flowType = getTypeAtFlowNode(c, f, antecedent);
    const incomplete = f.incomplete;
    if (flowType === f.declaredType && f.declaredType === f.initialType) return complete(f, flowType);
    if (!types.includes(flowType)) types.push(flowType);
    if (!isTypeSubsetOf(c, flowType, f.initialType)) subtypeReduction = true;
    if (incomplete) seenIncomplete = true;
  }
  if (bypassFlow !== undefined) {
    const flowType = getTypeAtFlowNode(c, f, bypassFlow);
    const incomplete = f.incomplete;
    if (
      (flowType.flags & TypeFlags.Never) === 0 &&
      !types.includes(flowType) &&
      !isExhaustiveSwitchStatement(c, bypassFlow.switchStatement)
    ) {
      if (flowType === f.declaredType && f.declaredType === f.initialType) return complete(f, flowType);
      types.push(flowType);
      if (!isTypeSubsetOf(c, flowType, f.initialType)) subtypeReduction = true;
      if (incomplete) seenIncomplete = true;
    }
  }
  return newFlowType(
    c,
    f,
    getUnionOfFlowTypes(c, f, types, subtypeReduction ? UnionReduction.Subtype : UnionReduction.Literal),
    seenIncomplete,
  );
}

/**
 * The union of the types at a junction: an evolving array when every path has one, otherwise the
 * union with evolving arrays finalized.
 */
function getUnionOfFlowTypes(c: Checker, f: FlowState, types: Type[], reduction: UnionReduction): Type {
  if (isEvolvingArrayTypeList(types)) {
    const elementTypes: Type[] = [];
    for (const t of types) elementTypes.push(getElementTypeOfEvolvingArrayType(c, t));
    return getEvolvingArrayType(c, getUnionType(c, elementTypes));
  }
  // Finalizing changes only evolving arrays; without one, the list itself is unioned (getUnionTypeEx
  // does not keep or change it).
  let finalized = types;
  for (const t of types)
    if ((t.objectFlags & ObjectFlags.EvolvingArray) !== 0) {
      finalized = [];
      for (const u of types) finalized.push(finalizeEvolvingArrayType(c, u));
      break;
    }
  const result = recombineUnknownType(c, getUnionTypeEx(c, finalized, reduction, undefined, undefined));
  const declared = f.declaredType;
  if (result !== declared && (result.flags & declared.flags & TypeFlags.Union) !== 0) {
    const a = (result as UnionType).types;
    const b = (declared as UnionType).types;
    if (a.length === b.length) {
      let same = true;
      for (let i = 0; i < a.length; i++)
        if (a[i]! !== b[i]!) {
          same = false;
          break;
        }
      if (same) return declared;
    }
  }
  return result;
}

export function recombineUnknownType(c: Checker, t: Type): Type {
  return t === c.unknownUnionType ? c.unknownType : t;
}

function getTypeAtFlowLoopLabel(c: Checker, f: FlowState, flow: FlowNode): Type {
  if (f.refKey === undefined) f.refKey = getFlowReferenceKey(c, f);
  if (f.refKey === '') return complete(f, f.declaredType);
  const key = f.refKey;
  let cache = c.flowLoopCaches.get(flow);
  if (cache === undefined) {
    cache = new Map<string, Type>();
    c.flowLoopCaches.set(flow, cache);
  }
  const cached = cache.get(key);
  if (cached !== undefined) return complete(f, cached);
  // A junction already being analyzed for this reference yields the types seen so far, incomplete.
  for (const loop of c.flowLoopStack) {
    if (loop.flow === flow && loop.refKey === key && loop.types.length !== 0)
      return newFlowType(c, f, getUnionOfFlowTypes(c, f, loop.types, UnionReduction.Literal), true);
  }
  const antecedentTypes: Type[] = [];
  let subtypeReduction = false;
  let firstIncomplete = false;
  let first = true;
  for (const antecedent of flow.antecedents!) {
    let flowType: Type;
    if (first) {
      // The first antecedent is the path into the loop.
      flowType = getTypeAtFlowNode(c, f, antecedent);
      firstIncomplete = f.incomplete;
      first = false;
    } else {
      c.flowLoopStack.push(new FlowLoopInfo(flow, key, antecedentTypes));
      const saveFlowTypeCache = c.flowTypeCache;
      c.flowTypeCache = undefined;
      flowType = getTypeAtFlowNode(c, f, antecedent);
      c.flowTypeCache = saveFlowTypeCache;
      c.flowLoopStack.pop();
      const restarted = cache.get(key);
      if (restarted !== undefined) return complete(f, restarted);
    }
    if (!antecedentTypes.includes(flowType)) antecedentTypes.push(flowType);
    if (!isTypeSubsetOf(c, flowType, f.initialType)) subtypeReduction = true;
    if (flowType === f.declaredType) break;
  }
  const result = getUnionOfFlowTypes(
    c,
    f,
    antecedentTypes,
    subtypeReduction ? UnionReduction.Subtype : UnionReduction.Literal,
  );
  if (firstIncomplete) return newFlowType(c, f, result, true);
  cache.set(key, result);
  return complete(f, result);
}

/** A key identifying a dotted-name reference and its declared/initial types; '' when not a dotted name. */
function getFlowReferenceKey(c: Checker, f: FlowState): string {
  return writeFlowCacheKey(c, f.reference, f.declaredType, f.initialType, f.flowContainer) ?? '';
}

function writeFlowCacheKey(
  c: Checker,
  node: Node,
  declaredType: Type,
  initialType: Type,
  flowContainer: Node | undefined,
): string | undefined {
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.ThisKeyword: {
      let key = '';
      if (node.kind === SyntaxKind.Identifier && !isThisInTypeQuery(node)) {
        const symbol = getResolvedSymbol(c, node);
        if (symbol === c.unknownSymbol) return undefined;
        key = String(getSymbolId(symbol));
      }
      key += ':' + declaredType.id;
      if (initialType !== declaredType) key += '=' + initialType.id;
      if (flowContainer !== undefined) key += '@' + getNodeId(flowContainer);
      return key;
    }
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.ParenthesizedExpression:
      return writeFlowCacheKey(c, getExpression(node)!, declaredType, initialType, flowContainer);
    case SyntaxKind.QualifiedName: {
      const left = writeFlowCacheKey(c, (node as QualifiedName).left, declaredType, initialType, flowContainer);
      return left === undefined ? undefined : left + '.' + getText((node as QualifiedName).right);
    }
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression: {
      const name = getAccessedPropertyName(c, node);
      if (name !== undefined) {
        const left = writeFlowCacheKey(c, getExpression(node)!, declaredType, initialType, flowContainer);
        return left === undefined ? undefined : left + '.' + name;
      }
      // `obj[key]` for a key that isn't reassigned.
      if (node.kind !== SyntaxKind.ElementAccessExpression) return undefined;
      const argument = (node as ElementAccessExpression).argumentExpression;
      if (argument.kind !== SyntaxKind.Identifier) return undefined;
      const symbol = getResolvedSymbol(c, argument);
      if (!isUnreassignedVariable(c, symbol)) return undefined;
      const left = writeFlowCacheKey(c, getExpression(node)!, declaredType, initialType, flowContainer);
      return left === undefined ? undefined : left + '.@' + getSymbolId(symbol);
    }
    // Pseudo-references of getNarrowedTypeOfSymbol.
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
      return '#' + getNodeId(node) + '#' + declaredType.id;
  }
  return undefined;
}

// ---- Narrowing by expressions

function narrowType(c: Checker, f: FlowState, t: Type, expr: Node, assumeTrue: boolean): Type {
  // `a?.b` implies `a` is not nullish; so does the left of `??`.
  const parent = expr.parent;
  if (
    isExpressionOfOptionalChainRoot(expr) ||
    (parent !== undefined &&
      parent.kind === SyntaxKind.BinaryExpression &&
      ((parent as BinaryExpression).operatorToken.kind === SyntaxKind.QuestionQuestionToken ||
        (parent as BinaryExpression).operatorToken.kind === SyntaxKind.QuestionQuestionEqualsToken) &&
      (parent as BinaryExpression).left === expr)
  )
    return narrowTypeByOptionality(c, f, t, expr, assumeTrue);
  switch (expr.kind) {
    case SyntaxKind.Identifier:
      // Narrowing through aliased conditions: `const ok = x !== undefined; if (ok) ...`.
      if (!isMatchingReference(c, f.reference, expr) && c.inlineLevel < 5) {
        const symbol = getResolvedSymbol(c, expr);
        if (isConstantVariable(c, symbol)) {
          const declaration = symbol.valueDeclaration;
          if (
            declaration !== undefined &&
            declaration.kind === SyntaxKind.VariableDeclaration &&
            getType(declaration) === undefined
          ) {
            const initializer = getInitializer(declaration);
            // For an access, isConstantReference reads the property symbol resolved where the
            // reference is, which narrowing of its object changes.
            if (initializer !== undefined && isAccessExpression(f.reference)) f.positional = true;
            if (initializer !== undefined && isConstantReference(c, f.reference)) {
              c.inlineLevel++;
              const result = narrowType(c, f, t, initializer, assumeTrue);
              c.inlineLevel--;
              return result;
            }
          }
        }
      }
      return narrowTypeByTruthiness(c, f, t, expr, assumeTrue);
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
      return narrowTypeByTruthiness(c, f, t, expr, assumeTrue);
    case SyntaxKind.CallExpression:
      return narrowTypeByCallExpression(c, f, t, expr, assumeTrue);
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
      return narrowType(c, f, t, getExpression(expr)!, assumeTrue);
    case SyntaxKind.BinaryExpression:
      return narrowTypeByBinaryExpression(c, f, t, expr as BinaryExpression, assumeTrue);
    case SyntaxKind.PrefixUnaryExpression:
      if ((expr as PrefixUnaryExpression).operator === SyntaxKind.ExclamationToken)
        return narrowType(c, f, t, (expr as PrefixUnaryExpression).operand, !assumeTrue);
      break;
  }
  return t;
}

function narrowTypeByOptionality(c: Checker, f: FlowState, t: Type, expr: Node, assumePresent: boolean): Type {
  const facts = assumePresent ? TypeFacts.NEUndefinedOrNull : TypeFacts.EQUndefinedOrNull;
  if (isMatchingReference(c, f.reference, expr)) return getAdjustedTypeWithFacts(c, t, facts);
  const access = getDiscriminantPropertyAccess(c, f, expr, t);
  if (access !== undefined) return narrowTypeByDiscriminant(c, t, access, (u) => getTypeWithFacts(c, u, facts));
  return t;
}

function narrowTypeByTruthiness(c: Checker, f: FlowState, t: Type, expr: Node, assumeTrue: boolean): Type {
  const facts = assumeTrue ? TypeFacts.Truthy : TypeFacts.Falsy;
  if (isMatchingReference(c, f.reference, expr)) return getAdjustedTypeWithFacts(c, t, facts);
  if (c.strictNullChecks && assumeTrue && optionalChainContainsReference(c, expr, f.reference))
    t = getAdjustedTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull);
  const access = getDiscriminantPropertyAccess(c, f, expr, t);
  if (access !== undefined) return narrowTypeByDiscriminant(c, t, access, (u) => getTypeWithFacts(c, u, facts));
  return t;
}

function narrowTypeByCallExpression(c: Checker, f: FlowState, t: Type, call: Node, assumeTrue: boolean): Type {
  if (hasMatchingArgument(c, call, f.reference)) {
    const signature = assumeTrue || !isCallChain(call) ? getEffectsSignature(c, call) : undefined;
    const predicate = signature !== undefined ? getTypePredicateOfSignature(c, signature) : undefined;
    if (
      predicate !== undefined &&
      (predicate.kind === TypePredicateKind.This || predicate.kind === TypePredicateKind.Identifier)
    )
      return narrowTypeByTypePredicate(c, f, t, predicate, call, assumeTrue);
  }
  // `obj.hasOwnProperty("p")` narrows an optional `obj.p` under exactOptionalPropertyTypes.
  if (containsMissingType(c, t) && isAccessExpression(f.reference)) {
    const callee = getExpression(call)!;
    if (callee.kind === SyntaxKind.PropertyAccessExpression) {
      const name = (callee as PropertyAccessExpression).name;
      const args = getArguments(call)!.nodes;
      if (
        isMatchingReference(c, getExpression(f.reference)!, getReferenceCandidate(getExpression(callee)!)) &&
        name.kind === SyntaxKind.Identifier &&
        getText(name) === 'hasOwnProperty' &&
        args.length === 1 &&
        isStringLiteralLike(args[0]!) &&
        getAccessedPropertyName(c, f.reference) === getText(args[0]!)
      )
        return getTypeWithFacts(c, t, assumeTrue ? TypeFacts.NEUndefined : TypeFacts.EQUndefined);
    }
  }
  return t;
}

function narrowTypeByTypePredicate(
  c: Checker,
  f: FlowState,
  t: Type,
  predicate: TypePredicate,
  call: Node,
  assumeTrue: boolean,
): Type {
  const predicateType = predicate.type;
  if (predicateType === undefined) return t;
  if (
    (t.flags & TypeFlags.Any) !== 0 &&
    (predicateType === c.globalObjectType || predicateType === c.globalFunctionType)
  )
    return t;
  const argument = getTypePredicateArgument(predicate, call);
  if (argument === undefined) return t;
  if (isMatchingReference(c, f.reference, argument)) return getNarrowedType(c, t, predicateType, assumeTrue, false);
  if (
    c.strictNullChecks &&
    optionalChainContainsReference(c, argument, f.reference) &&
    ((assumeTrue && !hasTypeFacts(c, predicateType, TypeFacts.EQUndefined)) ||
      (!assumeTrue && everyType(predicateType, isNullableType)))
  )
    t = getAdjustedTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull);
  const access = getDiscriminantPropertyAccess(c, f, argument, t);
  if (access !== undefined)
    return narrowTypeByDiscriminant(c, t, access, (u) => getNarrowedType(c, u, predicateType, assumeTrue, false));
  return t;
}

function isNullableType(t: Type): boolean {
  return (t.flags & TypeFlags.Nullable) !== 0;
}

function getTypePredicateArgument(predicate: TypePredicate, call: Node): Node | undefined {
  if (predicate.kind === TypePredicateKind.Identifier || predicate.kind === TypePredicateKind.AssertsIdentifier) {
    const args = getArguments(call)!.nodes;
    return predicate.parameterIndex >= 0 && predicate.parameterIndex < args.length
      ? args[predicate.parameterIndex]!
      : undefined;
  }
  const invoked = skipParentheses(getExpression(call)!);
  return invoked.kind === SyntaxKind.PropertyAccessExpression || invoked.kind === SyntaxKind.ElementAccessExpression
    ? skipParentheses(getExpression(invoked)!)
    : undefined;
}

function narrowTypeByBinaryExpression(
  c: Checker,
  f: FlowState,
  t: Type,
  expr: BinaryExpression,
  assumeTrue: boolean,
): Type {
  const operator = expr.operatorToken.kind;
  switch (operator) {
    case SyntaxKind.EqualsToken:
    case SyntaxKind.BarBarEqualsToken:
    case SyntaxKind.AmpersandAmpersandEqualsToken:
    case SyntaxKind.QuestionQuestionEqualsToken:
      return narrowTypeByTruthiness(c, f, narrowType(c, f, t, expr.right, assumeTrue), expr.left, assumeTrue);
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken: {
      const left = getReferenceCandidate(expr.left);
      const right = getReferenceCandidate(expr.right);
      if (left.kind === SyntaxKind.TypeOfExpression && isStringLiteralLike(right))
        return narrowTypeByTypeof(c, f, t, left, operator, right, assumeTrue);
      if (right.kind === SyntaxKind.TypeOfExpression && isStringLiteralLike(left))
        return narrowTypeByTypeof(c, f, t, right, operator, left, assumeTrue);
      if (isMatchingReference(c, f.reference, left)) return narrowTypeByEquality(c, t, operator, right, assumeTrue);
      if (isMatchingReference(c, f.reference, right)) return narrowTypeByEquality(c, t, operator, left, assumeTrue);
      if (c.strictNullChecks) {
        if (optionalChainContainsReference(c, left, f.reference))
          t = narrowTypeByOptionalChainContainment(c, t, operator, right, assumeTrue);
        else if (optionalChainContainsReference(c, right, f.reference))
          t = narrowTypeByOptionalChainContainment(c, t, operator, left, assumeTrue);
      }
      const leftAccess = getDiscriminantPropertyAccess(c, f, left, t);
      if (leftAccess !== undefined)
        return narrowTypeByDiscriminantProperty(c, t, leftAccess, operator, right, assumeTrue);
      const rightAccess = getDiscriminantPropertyAccess(c, f, right, t);
      if (rightAccess !== undefined)
        return narrowTypeByDiscriminantProperty(c, t, rightAccess, operator, left, assumeTrue);
      if (isMatchingConstructorReference(c, f, left)) return narrowTypeByConstructor(c, t, operator, right, assumeTrue);
      if (isMatchingConstructorReference(c, f, right)) return narrowTypeByConstructor(c, t, operator, left, assumeTrue);
      if (isBooleanLiteral(right) && !isAccessExpression(left))
        return narrowTypeByBooleanComparison(c, f, t, left, right, operator, assumeTrue);
      if (isBooleanLiteral(left) && !isAccessExpression(right))
        return narrowTypeByBooleanComparison(c, f, t, right, left, operator, assumeTrue);
      break;
    }
    case SyntaxKind.InstanceOfKeyword:
      return narrowTypeByInstanceof(c, f, t, expr, assumeTrue);
    case SyntaxKind.InKeyword: {
      if (expr.left.kind === SyntaxKind.PrivateIdentifier)
        return narrowTypeByPrivateIdentifierInInExpression(c, f, t, expr, assumeTrue);
      const target = getReferenceCandidate(expr.right);
      if (
        containsMissingType(c, t) &&
        isAccessExpression(f.reference) &&
        isMatchingReference(c, getExpression(f.reference)!, target)
      ) {
        const leftType = getTypeOfExpression(c, expr.left);
        if (
          isTypeUsableAsPropertyName(leftType) &&
          getAccessedPropertyName(c, f.reference) === getPropertyNameFromType(leftType)
        )
          return getTypeWithFacts(c, t, assumeTrue ? TypeFacts.NEUndefined : TypeFacts.EQUndefined);
      }
      if (isMatchingReference(c, f.reference, target)) {
        const leftType = getTypeOfExpression(c, expr.left);
        if (isTypeUsableAsPropertyName(leftType)) return narrowTypeByInKeyword(c, t, leftType, assumeTrue);
      }
      break;
    }
    case SyntaxKind.CommaToken:
      return narrowType(c, f, t, expr.right, assumeTrue);
    case SyntaxKind.AmpersandAmpersandToken:
      if (assumeTrue) return narrowType(c, f, narrowType(c, f, t, expr.left, true), expr.right, true);
      return getUnionType(c, [narrowType(c, f, t, expr.left, false), narrowType(c, f, t, expr.right, false)]);
    case SyntaxKind.BarBarToken:
      if (assumeTrue)
        return getUnionType(c, [narrowType(c, f, t, expr.left, true), narrowType(c, f, t, expr.right, true)]);
      return narrowType(c, f, narrowType(c, f, t, expr.left, false), expr.right, false);
  }
  return t;
}

function narrowTypeByPrivateIdentifierInInExpression(
  c: Checker,
  f: FlowState,
  t: Type,
  expr: BinaryExpression,
  assumeTrue: boolean,
): Type {
  if (!isMatchingReference(c, f.reference, getReferenceCandidate(expr.right))) return t;
  const symbol = getSymbolForPrivateIdentifierExpression(c, expr.left);
  if (symbol === undefined) return t;
  const classSymbol = symbol.parent!;
  const targetType = hasStaticModifier(symbol.valueDeclaration!)
    ? getTypeOfSymbol(c, classSymbol)
    : getDeclaredTypeOfSymbol(c, classSymbol);
  return getNarrowedType(c, t, targetType, assumeTrue, true);
}

function isBooleanLiteral(node: Node): boolean {
  return node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword;
}

function isAccessExpression(node: Node): boolean {
  return node.kind === SyntaxKind.PropertyAccessExpression || node.kind === SyntaxKind.ElementAccessExpression;
}

function isStringLiteralLike(node: Node): boolean {
  return node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
}

function narrowTypeByBooleanComparison(
  c: Checker,
  f: FlowState,
  t: Type,
  expr: Node,
  boolValue: Node,
  operator: SyntaxKind,
  assumeTrue: boolean,
): Type {
  const isEquality =
    operator !== SyntaxKind.ExclamationEqualsEqualsToken && operator !== SyntaxKind.ExclamationEqualsToken;
  return narrowType(c, f, t, expr, (assumeTrue !== (boolValue.kind === SyntaxKind.TrueKeyword)) !== isEquality);
}

function narrowTypeByEquality(c: Checker, t: Type, operator: SyntaxKind, value: Node, assumeTrueIn: boolean): Type {
  if ((t.flags & TypeFlags.Any) !== 0) return t;
  let assumeTrue = assumeTrueIn;
  if (operator === SyntaxKind.ExclamationEqualsToken || operator === SyntaxKind.ExclamationEqualsEqualsToken)
    assumeTrue = !assumeTrue;
  const valueType = getTypeOfExpression(c, value);
  const doubleEquals = operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken;
  if ((t.flags & TypeFlags.Union) === 0) return narrowTypeByEqualityWorker(c, t, valueType, doubleEquals, assumeTrue);
  // The result depends only on the types and the operator, and each flow walk through a condition
  // narrows the same union again: cache it.
  const bits = 8 | (doubleEquals ? 2 : 0) | (assumeTrue ? 1 : 0);
  const pair = cachedTypePairKey(t.id, valueType.id, bits);
  const key = pair < 0 ? 'narrowedByEquality' + t.id + ',' + valueType.id + ',' + bits : '';
  let result = pair < 0 ? c.cachedTypes.get(key) : c.cachedTypesByPair.get(pair);
  if (result === undefined) {
    result = narrowTypeByEqualityWorker(c, t, valueType, doubleEquals, assumeTrue);
    if (pair < 0) c.cachedTypes.set(key, result);
    else c.cachedTypesByPair.set(pair, result);
  }
  return result;
}

function narrowTypeByEqualityWorker(
  c: Checker,
  t: Type,
  valueType: Type,
  doubleEquals: boolean,
  assumeTrue: boolean,
): Type {
  if ((valueType.flags & TypeFlags.Nullable) !== 0) {
    if (!c.strictNullChecks) return t;
    let facts: TypeFacts;
    if (doubleEquals) facts = assumeTrue ? TypeFacts.EQUndefinedOrNull : TypeFacts.NEUndefinedOrNull;
    else if ((valueType.flags & TypeFlags.Null) !== 0) facts = assumeTrue ? TypeFacts.EQNull : TypeFacts.NENull;
    else facts = assumeTrue ? TypeFacts.EQUndefined : TypeFacts.NEUndefined;
    return getAdjustedTypeWithFacts(c, t, facts);
  }
  if (assumeTrue) {
    if (
      !doubleEquals &&
      ((t.flags & TypeFlags.Unknown) !== 0 || someType(t, (u) => isEmptyAnonymousObjectType(c, u)))
    ) {
      if (
        (valueType.flags & (TypeFlags.Primitive | TypeFlags.NonPrimitive)) !== 0 ||
        isEmptyAnonymousObjectType(c, valueType)
      )
        return valueType;
      if ((valueType.flags & TypeFlags.Object) !== 0) return c.nonPrimitiveType;
    }
    const filtered = filterType(
      c,
      t,
      (u) => areTypesComparable(c, u, valueType) || (doubleEquals && isCoercibleUnderDoubleEquals(u, valueType)),
    );
    return replacePrimitivesWithLiterals(c, filtered, valueType);
  }
  if (isUnitType(valueType))
    return filterType(c, t, (u) => !(isUnitLikeType(u) && areTypesComparable(c, u, valueType)));
  return t;
}

function isCoercibleUnderDoubleEquals(source: Type, target: Type): boolean {
  return (
    (source.flags & (TypeFlags.Number | TypeFlags.String | TypeFlags.BooleanLiteral)) !== 0 &&
    (target.flags & (TypeFlags.Number | TypeFlags.String | TypeFlags.Boolean)) !== 0
  );
}

function isUnitLikeType(t: Type): boolean {
  return extractUnitType(t) !== undefined;
}

/** `t`, or the first unit type of intersection `t`; undefined when `t` isn't unit-like. */
function extractUnitType(t: Type): Type | undefined {
  if ((t.flags & TypeFlags.Intersection) === 0) return isUnitType(t) ? t : undefined;
  for (const u of typesOf(t)) if (isUnitType(u)) return u;
  return undefined;
}

function replacePrimitivesWithLiterals(c: Checker, typeWithPrimitives: Type, typeWithLiterals: Type): Type {
  if (
    maybeTypeOfKind(
      typeWithPrimitives,
      TypeFlags.String | TypeFlags.TemplateLiteral | TypeFlags.Number | TypeFlags.BigInt,
    ) &&
    maybeTypeOfKind(
      typeWithLiterals,
      TypeFlags.StringLiteral |
        TypeFlags.TemplateLiteral |
        TypeFlags.StringMapping |
        TypeFlags.NumberLiteral |
        TypeFlags.BigIntLiteral,
    )
  ) {
    return mapType(c, typeWithPrimitives, (t) => {
      if ((t.flags & TypeFlags.String) !== 0)
        return extractTypesOfKind(
          c,
          typeWithLiterals,
          TypeFlags.String | TypeFlags.StringLiteral | TypeFlags.TemplateLiteral | TypeFlags.StringMapping,
        );
      if (
        isPatternLiteralType(c, t) &&
        !maybeTypeOfKind(typeWithLiterals, TypeFlags.String | TypeFlags.TemplateLiteral | TypeFlags.StringMapping)
      )
        return extractTypesOfKind(c, typeWithLiterals, TypeFlags.StringLiteral);
      if ((t.flags & TypeFlags.Number) !== 0)
        return extractTypesOfKind(c, typeWithLiterals, TypeFlags.Number | TypeFlags.NumberLiteral);
      if ((t.flags & TypeFlags.BigInt) !== 0)
        return extractTypesOfKind(c, typeWithLiterals, TypeFlags.BigInt | TypeFlags.BigIntLiteral);
      return t;
    });
  }
  return typeWithPrimitives;
}

function extractTypesOfKind(c: Checker, t: Type, kind: TypeFlags): Type {
  return filterType(c, t, (u) => (u.flags & kind) !== 0);
}

function narrowTypeByTypeof(
  c: Checker,
  f: FlowState,
  t: Type,
  typeOfExpr: Node,
  operator: SyntaxKind,
  literal: Node,
  assumeTrueIn: boolean,
): Type {
  let assumeTrue = assumeTrueIn;
  if (operator === SyntaxKind.ExclamationEqualsToken || operator === SyntaxKind.ExclamationEqualsEqualsToken)
    assumeTrue = !assumeTrue;
  const target = getReferenceCandidate(getExpression(typeOfExpr)!);
  const text = getText(literal);
  if (!isMatchingReference(c, f.reference, target)) {
    if (
      c.strictNullChecks &&
      optionalChainContainsReference(c, target, f.reference) &&
      assumeTrue === (text !== 'undefined')
    )
      t = getAdjustedTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull);
    const access = getDiscriminantPropertyAccess(c, f, target, t);
    if (access !== undefined)
      return narrowTypeByDiscriminant(c, t, access, (u) => narrowTypeByLiteralExpression(c, u, text, assumeTrue));
    return t;
  }
  return narrowTypeByLiteralExpression(c, t, text, assumeTrue);
}

function typeofNEFacts(text: string): TypeFacts {
  switch (text) {
    case 'string':
      return TypeFacts.TypeofNEString;
    case 'number':
      return TypeFacts.TypeofNENumber;
    case 'bigint':
      return TypeFacts.TypeofNEBigInt;
    case 'boolean':
      return TypeFacts.TypeofNEBoolean;
    case 'symbol':
      return TypeFacts.TypeofNESymbol;
    case 'undefined':
      return TypeFacts.NEUndefined;
    case 'object':
      return TypeFacts.TypeofNEObject;
    case 'function':
      return TypeFacts.TypeofNEFunction;
  }
  return TypeFacts.TypeofNEHostObject;
}

function narrowTypeByLiteralExpression(c: Checker, t: Type, text: string, assumeTrue: boolean): Type {
  return assumeTrue ? narrowTypeByTypeName(c, t, text) : getAdjustedTypeWithFacts(c, t, typeofNEFacts(text));
}

function narrowTypeByTypeName(c: Checker, t: Type, typeName: string): Type {
  switch (typeName) {
    case 'string':
      return narrowTypeByTypeFacts(c, t, c.stringType, TypeFacts.TypeofEQString);
    case 'number':
      return narrowTypeByTypeFacts(c, t, c.numberType, TypeFacts.TypeofEQNumber);
    case 'bigint':
      return narrowTypeByTypeFacts(c, t, c.bigintType, TypeFacts.TypeofEQBigInt);
    case 'boolean':
      return narrowTypeByTypeFacts(c, t, c.booleanType, TypeFacts.TypeofEQBoolean);
    case 'symbol':
      return narrowTypeByTypeFacts(c, t, c.esSymbolType, TypeFacts.TypeofEQSymbol);
    case 'object':
      if ((t.flags & TypeFlags.Any) !== 0) return t;
      return getUnionType(c, [
        narrowTypeByTypeFacts(c, t, c.nonPrimitiveType, TypeFacts.TypeofEQObject),
        narrowTypeByTypeFacts(c, t, c.nullType, TypeFacts.EQNull),
      ]);
    case 'function':
      if ((t.flags & TypeFlags.Any) !== 0) return t;
      return narrowTypeByTypeFacts(c, t, c.globalFunctionType, TypeFacts.TypeofEQFunction);
    case 'undefined':
      return narrowTypeByTypeFacts(c, t, c.undefinedType, TypeFacts.EQUndefined);
  }
  return narrowTypeByTypeFacts(c, t, c.nonPrimitiveType, TypeFacts.TypeofEQHostObject);
}

function narrowTypeByTypeFacts(c: Checker, t: Type, impliedType: Type, facts: TypeFacts): Type {
  return mapType(c, t, (u) => {
    if (isTypeRelatedTo(c, u, impliedType, c.strictSubtypeRelation)) return hasTypeFacts(c, u, facts) ? u : c.neverType;
    if (isTypeSubtypeOf(c, impliedType, u)) return impliedType;
    if (hasTypeFacts(c, u, facts)) return getIntersectionType(c, [u, impliedType]);
    return c.neverType;
  });
}

function narrowTypeByOptionalChainContainment(
  c: Checker,
  t: Type,
  operator: SyntaxKind,
  value: Node,
  assumeTrue: boolean,
): Type {
  const equalsOperator = operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.EqualsEqualsEqualsToken;
  const nullableFlags =
    operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken
      ? TypeFlags.Nullable
      : TypeFlags.Undefined;
  const valueType = getTypeOfExpression(c, value);
  const removeNullable =
    (equalsOperator !== assumeTrue && everyType(valueType, (u) => (u.flags & nullableFlags) !== 0)) ||
    (equalsOperator === assumeTrue &&
      everyType(valueType, (u) => (u.flags & (TypeFlags.AnyOrUnknown | nullableFlags)) === 0));
  return removeNullable ? getAdjustedTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull) : t;
}

function narrowTypeByInstanceof(c: Checker, f: FlowState, t: Type, expr: BinaryExpression, assumeTrue: boolean): Type {
  const left = getReferenceCandidate(expr.left);
  if (!isMatchingReference(c, f.reference, left)) {
    if (assumeTrue && c.strictNullChecks && optionalChainContainsReference(c, left, f.reference))
      return getAdjustedTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull);
    return t;
  }
  const rightType = getTypeOfExpression(c, expr.right);
  if (!isTypeDerivedFrom(c, rightType, c.globalObjectType)) return t;
  // A `[Symbol.hasInstance]` method with a type predicate narrows like a type guard call.
  const signature = getEffectsSignature(c, expr);
  const predicate = signature !== undefined ? getTypePredicateOfSignature(c, signature) : undefined;
  if (predicate !== undefined && predicate.kind === TypePredicateKind.Identifier && predicate.parameterIndex === 0)
    return getNarrowedType(c, t, predicate.type!, assumeTrue, true);
  if (!isTypeDerivedFrom(c, rightType, c.globalFunctionType)) return t;
  const instanceType = mapType(c, rightType, (u) => getInstanceType(c, u));
  if (
    ((t.flags & TypeFlags.Any) !== 0 &&
      (instanceType === c.globalObjectType || instanceType === c.globalFunctionType)) ||
    (!assumeTrue && !((instanceType.flags & TypeFlags.Object) !== 0 && !isEmptyAnonymousObjectType(c, instanceType)))
  )
    return t;
  return getNarrowedType(c, t, instanceType, assumeTrue, true);
}

function getInstanceType(c: Checker, constructorType: Type): Type {
  const prototypeType = getTypeOfPropertyOfType(c, constructorType, 'prototype');
  if (prototypeType !== undefined && (prototypeType.flags & TypeFlags.Any) === 0) return prototypeType;
  const signatures = getSignaturesOfType(c, constructorType, SignatureKind.Construct);
  if (signatures.length === 0) return c.emptyObjectType;
  const types: Type[] = [];
  for (const s of signatures) types.push(getReturnTypeOfSignature(c, getErasedSignature(c, s)));
  return getUnionType(c, types);
}

function narrowTypeByInKeyword(c: Checker, t: Type, nameType: Type, assumeTrue: boolean): Type {
  const name = getPropertyNameFromType(nameType);
  if (someType(t, (u) => isTypePresencePossible(c, u, name, true)))
    return filterType(c, t, (u) => isTypePresencePossible(c, u, name, assumeTrue));
  // `"x" in t` for an unknown property x narrows t to `t & Record<"x", unknown>`.
  if (assumeTrue) {
    const record = getGlobalTypeAliasSymbol(c, 'Record', 2, true);
    if (record !== undefined)
      return getIntersectionType(c, [t, getTypeAliasInstantiation(c, record, [nameType, c.unknownType], undefined)]);
  }
  return t;
}

function isTypePresencePossible(c: Checker, t: Type, propName: string, assumeTrue: boolean): boolean {
  const prop = getPropertyOfType(c, t, propName);
  if (prop !== undefined)
    return (prop.flags & SymbolFlags.Optional) !== 0 || (prop.checkFlags & CheckFlags.Partial) !== 0 || assumeTrue;
  return getApplicableIndexInfoForName(c, t, propName) !== undefined || !assumeTrue;
}

/** `t` narrowed to `candidate` (or with it removed when `assumeTrue` is false). */
export function getNarrowedType(
  c: Checker,
  t: Type,
  candidate: Type,
  assumeTrue: boolean,
  checkDerived: boolean,
): Type {
  if ((t.flags & TypeFlags.Union) === 0) return getNarrowedTypeWorker(c, t, candidate, assumeTrue, checkDerived);
  const pair = cachedTypePairKey(t.id, candidate.id, 4 | (assumeTrue ? 2 : 0) | (checkDerived ? 1 : 0));
  const key =
    pair < 0 ? 'narrowed' + t.id + ',' + candidate.id + (assumeTrue ? 't' : 'f') + (checkDerived ? 'd' : '') : '';
  let result = pair < 0 ? c.cachedTypes.get(key) : c.cachedTypesByPair.get(pair);
  if (result === undefined) {
    result = getNarrowedTypeWorker(c, t, candidate, assumeTrue, checkDerived);
    if (pair < 0) c.cachedTypes.set(key, result);
    else c.cachedTypesByPair.set(pair, result);
  }
  return result;
}

function getNarrowedTypeWorker(
  c: Checker,
  typeIn: Type,
  candidate: Type,
  assumeTrue: boolean,
  checkDerived: boolean,
): Type {
  let t = typeIn;
  if (!assumeTrue) {
    if (t === candidate) return c.neverType;
    if (checkDerived) return filterType(c, t, (u) => !isTypeDerivedFrom(c, u, candidate));
    if ((t.flags & TypeFlags.Unknown) !== 0) t = c.unknownUnionType;
    const trueType = getNarrowedType(c, t, candidate, true, false);
    return recombineUnknownType(
      c,
      filterType(c, t, (u) => !isTypeSubsetOf(c, u, trueType)),
    );
  }
  if ((t.flags & TypeFlags.AnyOrUnknown) !== 0) return candidate;
  if (t === candidate) return candidate;
  const keyPropertyName = (t.flags & TypeFlags.Union) !== 0 ? getKeyPropertyName(c, t as UnionType) : '';
  const narrowedType = mapType(c, candidate, (n) => {
    let matching = t;
    if (keyPropertyName !== '') {
      const discriminant = getTypeOfPropertyOfType(c, n, keyPropertyName);
      if (discriminant !== undefined) {
        const constituent = getConstituentTypeForKeyType(c, t as UnionType, discriminant);
        if (constituent !== undefined) matching = constituent;
      }
    }
    const directlyRelated = mapType(c, matching, (u) => {
      if (checkDerived) {
        if (isTypeDerivedFrom(c, u, n)) return u;
        if (isTypeDerivedFrom(c, n, u)) return n;
        return c.neverType;
      }
      if (isTypeStrictSubtypeOf(c, u, n)) return u;
      if (isTypeStrictSubtypeOf(c, n, u)) return n;
      if (isTypeSubtypeOf(c, u, n)) return u;
      if (isTypeSubtypeOf(c, n, u)) return n;
      return c.neverType;
    });
    if ((directlyRelated.flags & TypeFlags.Never) === 0) return directlyRelated;
    return mapType(c, t, (u) => {
      if (maybeTypeOfKind(u, TypeFlags.Instantiable)) {
        const constraint = getBaseConstraintOfType(c, u);
        if (
          constraint === undefined ||
          (checkDerived ? isTypeDerivedFrom(c, n, constraint) : isTypeSubtypeOf(c, n, constraint))
        )
          return getIntersectionType(c, [u, n]);
      }
      return c.neverType;
    });
  });
  if ((narrowedType.flags & TypeFlags.Never) === 0) return narrowedType;
  if (isTypeSubtypeOf(c, candidate, t)) return candidate;
  if (isTypeAssignableTo(c, t, candidate)) return t;
  if (isTypeAssignableTo(c, candidate, t)) return candidate;
  return getIntersectionType(c, [t, candidate]);
}

// ---- Discriminants

function getDiscriminantPropertyAccess(c: Checker, f: FlowState, expr: Node, computedType: Type): Node | undefined {
  if ((f.declaredType.flags & TypeFlags.Union) === 0 && (computedType.flags & TypeFlags.Union) === 0) return undefined;
  const access = getCandidateDiscriminantPropertyAccess(c, f, expr);
  if (access === undefined) return undefined;
  const name = getAccessedPropertyName(c, access);
  if (name === undefined) return undefined;
  const t =
    (f.declaredType.flags & TypeFlags.Union) !== 0 && isTypeSubsetOf(c, computedType, f.declaredType)
      ? f.declaredType
      : computedType;
  return isDiscriminantProperty(c, t, name) ? access : undefined;
}

function getCandidateDiscriminantPropertyAccess(c: Checker, f: FlowState, expr: Node): Node | undefined {
  const reference = f.reference;
  if (
    reference.kind === SyntaxKind.ObjectBindingPattern ||
    reference.kind === SyntaxKind.ArrayBindingPattern ||
    reference.kind === SyntaxKind.FunctionExpression ||
    reference.kind === SyntaxKind.ArrowFunction ||
    isObjectLiteralMethod(reference)
  ) {
    // A pseudo-reference from getNarrowedTypeOfSymbol: a sibling destructured variable or parameter is a candidate.
    if (expr.kind !== SyntaxKind.Identifier) return undefined;
    const declaration = getExportSymbolOfValueSymbolIfExported(c, getResolvedSymbol(c, expr)).valueDeclaration;
    if (
      declaration !== undefined &&
      (declaration.kind === SyntaxKind.BindingElement || declaration.kind === SyntaxKind.Parameter) &&
      declaration.parent === reference &&
      getInitializer(declaration) === undefined &&
      (declaration.kind === SyntaxKind.BindingElement
        ? (declaration as BindingElement).dotDotDotToken
        : getDotDotDotToken(declaration)) === undefined
    )
      return declaration;
    return undefined;
  }
  if (isAccessExpression(expr)) return isMatchingReference(c, reference, getExpression(expr)!) ? expr : undefined;
  if (expr.kind === SyntaxKind.Identifier) {
    const symbol = getResolvedSymbol(c, expr);
    if (isConstantVariable(c, symbol)) {
      const declaration = symbol.valueDeclaration;
      // `const x = obj.kind` makes `x` an alias of `obj.kind`.
      const initializer = getCandidateVariableDeclarationInitializer(declaration);
      if (
        initializer !== undefined &&
        isAccessExpression(initializer) &&
        isMatchingReference(c, reference, getExpression(initializer)!)
      )
        return initializer;
      // `const { kind: x } = obj` makes `x` an alias of `obj.kind`.
      if (
        declaration !== undefined &&
        declaration.kind === SyntaxKind.BindingElement &&
        getInitializer(declaration) === undefined
      ) {
        const parentInitializer = getCandidateVariableDeclarationInitializer(declaration.parent!.parent!);
        if (
          parentInitializer !== undefined &&
          (parentInitializer.kind === SyntaxKind.Identifier || isAccessExpression(parentInitializer)) &&
          isMatchingReference(c, reference, parentInitializer)
        )
          return declaration;
      }
    }
  }
  return undefined;
}

function getCandidateVariableDeclarationInitializer(node: Node | undefined): Node | undefined {
  if (node === undefined || node.kind !== SyntaxKind.VariableDeclaration || getType(node) !== undefined)
    return undefined;
  const initializer = getInitializer(node);
  return initializer !== undefined ? skipParentheses(initializer) : undefined;
}

function narrowTypeByDiscriminant(c: Checker, t: Type, access: Node, narrow: (t: Type) => Type): Type {
  const propName = getAccessedPropertyName(c, access);
  if (propName === undefined) return t;
  const optionalChain = isOptionalChain(access);
  const removeNullable =
    c.strictNullChecks && (optionalChain || isNonNullAccess(access)) && maybeTypeOfKind(t, TypeFlags.Nullable);
  const nonNullType = removeNullable ? getTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull) : t;
  let propType = getTypeOfPropertyOfType(c, nonNullType, propName);
  if (propType === undefined) return t;
  if (removeNullable && optionalChain) propType = getOptionalType(c, propType, false);
  const narrowedPropType = narrow(propType);
  return filterType(c, t, (u) => {
    const discriminantType = getTypeOfPropertyOrIndexSignatureOfType(c, u, propName) ?? c.unknownType;
    return (
      (discriminantType.flags & TypeFlags.Never) === 0 &&
      (narrowedPropType.flags & TypeFlags.Never) === 0 &&
      areTypesComparable(c, narrowedPropType, discriminantType)
    );
  });
}

function isNonNullAccess(node: Node): boolean {
  return isAccessExpression(node) && getExpression(node)!.kind === SyntaxKind.NonNullExpression;
}

function getTypeOfPropertyOrIndexSignatureOfType(c: Checker, t: Type, name: string): Type | undefined {
  const propType = getTypeOfPropertyOfType(c, t, name);
  if (propType !== undefined) return propType;
  const info = getApplicableIndexInfoForName(c, t, name);
  return info !== undefined ? getOptionalType(c, info.valueType, true) : undefined;
}

function narrowTypeByDiscriminantProperty(
  c: Checker,
  t: Type,
  access: Node,
  operator: SyntaxKind,
  value: Node,
  assumeTrue: boolean,
): Type {
  if (
    (operator === SyntaxKind.EqualsEqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsEqualsToken) &&
    (t.flags & TypeFlags.Union) !== 0
  ) {
    const keyPropertyName = getKeyPropertyName(c, t as UnionType);
    if (keyPropertyName !== '' && keyPropertyName === getAccessedPropertyName(c, access)) {
      const candidate = getConstituentTypeForKeyType(c, t as UnionType, getTypeOfExpression(c, value));
      if (candidate !== undefined) {
        if (
          (assumeTrue && operator === SyntaxKind.EqualsEqualsEqualsToken) ||
          (!assumeTrue && operator === SyntaxKind.ExclamationEqualsEqualsToken)
        )
          return candidate;
        const propType = getTypeOfPropertyOfType(c, candidate, keyPropertyName);
        return propType !== undefined && isUnitType(propType) ? removeType(c, t, candidate) : t;
      }
    }
  }
  return narrowTypeByDiscriminant(c, t, access, (u) => narrowTypeByEquality(c, u, operator, value, assumeTrue));
}

/** The name of a property usable to index the constituents of a large union by literal values, or ''. */
export function getKeyPropertyName(c: Checker, t: UnionType): string {
  const side = sideOf(c, t);
  if (side.keyPropertyName === '') computeKeyPropertyNameAndMap(c, t, side);
  return side.keyPropertyName === InternalSymbolName.Missing ? '' : side.keyPropertyName;
}

export function getConstituentTypeForKeyType(c: Checker, t: UnionType, keyType: Type): Type | undefined {
  const result = sideOf(c, t).constituentMap?.get(getRegularTypeOfLiteralType(c, keyType));
  return result !== c.unknownType ? result : undefined;
}

/** Computes the key property of `t` and its constituents by key into `side`, the holder of its state. */
function computeKeyPropertyNameAndMap(c: Checker, t: UnionType, side: UnionType): void {
  side.keyPropertyName = InternalSymbolName.Missing;
  const types = t.types;
  let objectCount = 0;
  for (const u of types) if ((u.flags & (TypeFlags.Object | TypeFlags.InstantiableNonPrimitive)) !== 0) objectCount++;
  if (types.length < 10 || (t.objectFlags & ObjectFlags.PrimitiveUnion) !== 0 || objectCount < 10) return;
  let keyPropertyName = '';
  for (const u of types) {
    if (keyPropertyName !== '') break;
    if ((u.flags & (TypeFlags.Object | TypeFlags.InstantiableNonPrimitive)) === 0) continue;
    for (const p of getPropertiesOfType(c, u)) {
      if (isUnitType(getTypeOfSymbol(c, p))) {
        keyPropertyName = p.name;
        break;
      }
    }
  }
  if (keyPropertyName === '') return;
  const map = new Map<Type, Type>();
  let count = 0;
  for (const u of types) {
    if ((u.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.InstantiableNonPrimitive)) === 0) continue;
    const discriminant = getTypeOfPropertyOfType(c, u, keyPropertyName);
    if (discriminant === undefined || !isLiteralType(discriminant)) return;
    let duplicate = false;
    for (const d of (discriminant.flags & TypeFlags.Union) !== 0 ? typesOf(discriminant) : [discriminant]) {
      const key = getRegularTypeOfLiteralType(c, d);
      const existing = map.get(key);
      if (existing === undefined) map.set(key, u);
      else if (existing !== c.unknownType) {
        map.set(key, c.unknownType);
        duplicate = true;
      }
    }
    if (!duplicate) count++;
  }
  if (count >= 10 && count * 2 >= types.length) {
    side.keyPropertyName = keyPropertyName;
    side.constituentMap = map;
  }
}

// ---- Switch statements

function getTypeAtSwitchClause(c: Checker, f: FlowState, flow: FlowSwitchClause): Type {
  const statement = flow.switchStatement as SwitchStatement;
  const expr = skipParentheses(statement.expression);
  const flowType = getTypeAtFlowNode(c, f, flow.antecedent!);
  const incomplete = f.incomplete;
  let t = flowType;
  if (isMatchingReference(c, f.reference, expr)) t = narrowTypeBySwitchOnDiscriminant(c, t, flow);
  else if (expr.kind === SyntaxKind.TypeOfExpression && isMatchingReference(c, f.reference, getExpression(expr)!))
    t = narrowTypeBySwitchOnTypeOf(c, t, flow);
  else if (expr.kind === SyntaxKind.TrueKeyword) t = narrowTypeBySwitchOnTrue(c, f, t, flow);
  else {
    if (c.strictNullChecks) {
      if (optionalChainContainsReference(c, expr, f.reference))
        t = narrowTypeBySwitchOptionalChainContainment(
          c,
          t,
          flow,
          (u) => (u.flags & (TypeFlags.Undefined | TypeFlags.Never)) === 0,
        );
      else if (
        expr.kind === SyntaxKind.TypeOfExpression &&
        optionalChainContainsReference(c, getExpression(expr)!, f.reference)
      )
        t = narrowTypeBySwitchOptionalChainContainment(
          c,
          t,
          flow,
          (u) =>
            !(
              (u.flags & TypeFlags.Never) !== 0 ||
              ((u.flags & TypeFlags.StringLiteral) !== 0 && (u as LiteralType).stringValue === 'undefined')
            ),
        );
    }
    const access = getDiscriminantPropertyAccess(c, f, expr, t);
    if (access !== undefined) t = narrowTypeBySwitchOnDiscriminantProperty(c, t, access, flow);
  }
  return newFlowType(c, f, t, incomplete);
}

function narrowTypeBySwitchOptionalChainContainment(
  c: Checker,
  t: Type,
  flow: FlowSwitchClause,
  clauseCheck: (t: Type) => boolean,
): Type {
  if (flow.clauseStart === flow.clauseEnd) return t;
  const clauseTypes = getSwitchClauseTypes(c, flow.switchStatement);
  for (let i = flow.clauseStart; i < flow.clauseEnd; i++) if (!clauseCheck(clauseTypes[i])) return t;
  return getTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull);
}

function narrowTypeBySwitchOnDiscriminantProperty(c: Checker, t: Type, access: Node, flow: FlowSwitchClause): Type {
  if (flow.clauseStart < flow.clauseEnd && (t.flags & TypeFlags.Union) !== 0) {
    const accessedName = getAccessedPropertyName(c, access);
    if (accessedName !== undefined && accessedName !== '' && getKeyPropertyName(c, t as UnionType) === accessedName) {
      const clauseTypes = getSwitchClauseTypes(c, flow.switchStatement);
      const types: Type[] = [];
      for (let i = flow.clauseStart; i < flow.clauseEnd && i < clauseTypes.length; i++)
        types.push(getConstituentTypeForKeyType(c, t as UnionType, clauseTypes[i]!) ?? c.unknownType);
      const candidate = getUnionType(c, types);
      if (candidate !== c.unknownType) return candidate;
    }
  }
  return narrowTypeByDiscriminant(c, t, access, (u) => narrowTypeBySwitchOnDiscriminant(c, u, flow));
}

function getClauses(statement: Node): Node[] {
  return (statement as SwitchStatement).caseBlock.clauses.nodes;
}

function getSwitchClauseTypes(c: Checker, statement: Node): Type[] {
  const links = c.nodeLinks(statement);
  if (links.switchTypes === undefined) {
    const types: Type[] = [];
    for (const clause of getClauses(statement)) {
      const expr = (clause as CaseOrDefaultClause).expression;
      types.push(expr !== undefined ? getRegularTypeOfLiteralType(c, getTypeOfExpression(c, expr)) : c.neverType);
    }
    links.switchTypes = types;
  }
  return links.switchTypes;
}

function narrowTypeBySwitchOnDiscriminant(c: Checker, t: Type, flow: FlowSwitchClause): Type {
  if ((t.flags & TypeFlags.Union) === 0) return narrowTypeBySwitchOnDiscriminantWorker(c, t, flow);
  // As in narrowTypeByEquality, each union is narrowed by each range of clauses once.
  const key =
    'narrowedBySwitch' + t.id + ',' + getNodeId(flow.switchStatement) + ',' + flow.clauseStart + ',' + flow.clauseEnd;
  let result = c.cachedTypes.get(key);
  if (result === undefined) {
    result = narrowTypeBySwitchOnDiscriminantWorker(c, t, flow);
    c.cachedTypes.set(key, result);
  }
  return result;
}

function narrowTypeBySwitchOnDiscriminantWorker(c: Checker, t: Type, flow: FlowSwitchClause): Type {
  const switchTypes = getSwitchClauseTypes(c, flow.switchStatement);
  if (switchTypes.length === 0) return t;
  const clauseTypes = switchTypes.slice(flow.clauseStart, flow.clauseEnd);
  const hasDefaultClause = flow.clauseStart === flow.clauseEnd || clauseTypes.includes(c.neverType);
  if ((t.flags & TypeFlags.Unknown) !== 0 && !hasDefaultClause) {
    const ground: Type[] = [];
    for (const s of clauseTypes) {
      if ((s.flags & (TypeFlags.Primitive | TypeFlags.NonPrimitive)) !== 0) ground.push(s);
      else if ((s.flags & TypeFlags.Object) !== 0) ground.push(c.nonPrimitiveType);
      else return t;
    }
    return getUnionType(c, ground);
  }
  const discriminantType = getUnionType(c, clauseTypes);
  const caseType =
    (discriminantType.flags & TypeFlags.Never) !== 0
      ? c.neverType
      : replacePrimitivesWithLiterals(
          c,
          filterType(c, t, (u) => areTypesComparable(c, discriminantType, u)),
          discriminantType,
        );
  if (!hasDefaultClause) return caseType;
  const defaultType = filterType(c, t, (u) => {
    const unit = extractUnitType(u);
    if (unit === undefined) return true;
    const v = (u.flags & TypeFlags.Undefined) !== 0 ? c.undefinedType : getRegularTypeOfLiteralType(c, unit);
    for (const st of switchTypes) if (isUnitType(st) && areTypesComparable(c, st, v)) return false;
    return true;
  });
  if ((caseType.flags & TypeFlags.Never) !== 0) return defaultType;
  return getUnionType(c, [caseType, defaultType]);
}

function getSwitchClauseTypeOfWitnesses(c: Checker, statement: Node): string[] | undefined {
  const links = c.nodeLinks(statement);
  if (links.switchWitnesses === undefined) {
    const witnesses: string[] = [];
    let valid = true;
    for (const clause of getClauses(statement)) {
      const expr = (clause as CaseOrDefaultClause).expression;
      if (expr === undefined) {
        witnesses.push('');
        continue;
      }
      if (!isStringLiteralLike(expr)) {
        valid = false;
        break;
      }
      const text = getText(expr);
      witnesses.push(witnesses.includes(text) ? '' : text);
    }
    links.switchWitnesses = valid ? witnesses : [];
    links.switchWitnessesValid = valid;
  }
  return links.switchWitnessesValid ? links.switchWitnesses : undefined;
}

function getNotEqualFactsFromTypeofSwitch(start: number, end: number, witnesses: string[]): TypeFacts {
  let facts = TypeFacts.None;
  for (let i = 0; i < witnesses.length; i++)
    if ((i < start || i >= end) && witnesses[i]! !== '') facts |= typeofNEFacts(witnesses[i]!);
  return facts;
}

function getDefaultClauseIndex(statement: Node): number {
  const clauses = getClauses(statement);
  for (let i = 0; i < clauses.length; i++) if (clauses[i]!.kind === SyntaxKind.DefaultClause) return i;
  return -1;
}

function narrowTypeBySwitchOnTypeOf(c: Checker, t: Type, flow: FlowSwitchClause): Type {
  const witnesses = getSwitchClauseTypeOfWitnesses(c, flow.switchStatement);
  if (witnesses === undefined) return t;
  const defaultIndex = getDefaultClauseIndex(flow.switchStatement);
  const hasDefaultClause =
    flow.clauseStart === flow.clauseEnd || (defaultIndex >= flow.clauseStart && defaultIndex < flow.clauseEnd);
  if (hasDefaultClause) {
    const notEqualFacts = getNotEqualFactsFromTypeofSwitch(flow.clauseStart, flow.clauseEnd, witnesses);
    return filterType(c, t, (u) => getTypeFacts(c, u, notEqualFacts) === notEqualFacts);
  }
  const types: Type[] = [];
  for (const text of witnesses.slice(flow.clauseStart, flow.clauseEnd))
    types.push(text !== '' ? narrowTypeByTypeName(c, t, text) : c.neverType);
  return getUnionType(c, types);
}

function narrowTypeBySwitchOnTrue(c: Checker, f: FlowState, typeIn: Type, flow: FlowSwitchClause): Type {
  let t = typeIn;
  const clauses = getClauses(flow.switchStatement);
  const defaultIndex = getDefaultClauseIndex(flow.switchStatement);
  const hasDefaultClause =
    flow.clauseStart === flow.clauseEnd || (defaultIndex >= flow.clauseStart && defaultIndex < flow.clauseEnd);
  for (let i = 0; i < flow.clauseStart; i++) {
    const expr = (clauses[i]! as CaseOrDefaultClause).expression;
    if (expr !== undefined) t = narrowType(c, f, t, expr, false);
  }
  if (hasDefaultClause) {
    for (let i = flow.clauseEnd; i < clauses.length; i++) {
      const expr = (clauses[i]! as CaseOrDefaultClause).expression;
      if (expr !== undefined) t = narrowType(c, f, t, expr, false);
    }
    return t;
  }
  const types: Type[] = [];
  for (let i = flow.clauseStart; i < flow.clauseEnd; i++) {
    const expr = (clauses[i]! as CaseOrDefaultClause).expression;
    types.push(expr !== undefined ? narrowType(c, f, t, expr, true) : c.neverType);
  }
  return getUnionType(c, types);
}

/** Whether every value of the switch expression is handled by a case. */
export function isExhaustiveSwitchStatement(c: Checker, statement: Node): boolean {
  const links = c.nodeLinks(statement);
  if (links.exhaustiveState === 0) {
    links.exhaustiveState = 1;
    const exhaustive = computeExhaustiveSwitchStatement(c, statement);
    if (links.exhaustiveState === 1) links.exhaustiveState = exhaustive ? 3 : 2;
  } else if (links.exhaustiveState === 1) links.exhaustiveState = 2;
  return links.exhaustiveState === 3;
}

function computeExhaustiveSwitchStatement(c: Checker, statement: Node): boolean {
  const expression = (statement as SwitchStatement).expression;
  if (expression.kind === SyntaxKind.TypeOfExpression) {
    const witnesses = getSwitchClauseTypeOfWitnesses(c, statement);
    if (witnesses === undefined) return false;
    const operandConstraint = getBaseConstraintOrType(c, checkExpressionCached(c, getExpression(expression)!));
    const notEqualFacts = getNotEqualFactsFromTypeofSwitch(0, 0, witnesses);
    if ((operandConstraint.flags & TypeFlags.AnyOrUnknown) !== 0)
      return (TypeFacts.AllTypeofNE & notEqualFacts) === TypeFacts.AllTypeofNE;
    return !someType(operandConstraint, (u) => getTypeFacts(c, u, notEqualFacts) === notEqualFacts);
  }
  const t = getBaseConstraintOrType(c, checkExpressionCached(c, expression));
  if (!isLiteralType(t)) return false;
  const switchTypes = getSwitchClauseTypes(c, statement);
  if (switchTypes.length === 0) return false;
  for (const s of switchTypes) if (!isUnitType(s) && (s.flags & TypeFlags.Never) === 0) return false;
  const regular = mapType(c, t, (u) => getRegularTypeOfLiteralType(c, u));
  if ((regular.flags & TypeFlags.Union) !== 0) return typesOf(regular).every((u) => switchTypes.includes(u));
  return switchTypes.includes(regular);
}

function getBaseConstraintOrType(c: Checker, t: Type): Type {
  return getBaseConstraintOfType(c, t) ?? t;
}

// ---- References

export function isMatchingReference(c: Checker, source: Node, target: Node): boolean {
  // A declaration's symbol has the declaration's name, and an identifier's text is its name: an
  // identifier never refers to the variable or binding element of a declaration of another name.
  if (
    source.kind === SyntaxKind.Identifier &&
    (target.kind === SyntaxKind.VariableDeclaration || target.kind === SyntaxKind.BindingElement)
  ) {
    // A cast to one class: a union of the two would be boxed in native builds.
    const name =
      target.kind === SyntaxKind.VariableDeclaration
        ? (target as VariableDeclaration).name
        : (target as BindingElement).name;
    if (
      name !== undefined &&
      name.kind === SyntaxKind.Identifier &&
      (name as Identifier).text !== (source as Identifier).text
    )
      return false;
  }
  switch (target.kind) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
      return isMatchingReference(c, source, getExpression(target)!);
    case SyntaxKind.BinaryExpression: {
      const binary = target as BinaryExpression;
      return (
        (isAssignmentExpression(target, false) && isMatchingReference(c, source, binary.left)) ||
        (binary.operatorToken.kind === SyntaxKind.CommaToken && isMatchingReference(c, source, binary.right))
      );
    }
  }
  switch (source.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
      if (isThisInTypeQuery(source)) return target.kind === SyntaxKind.ThisKeyword;
      if (target.kind === SyntaxKind.Identifier) return getResolvedSymbol(c, source) === getResolvedSymbol(c, target);
      if (target.kind === SyntaxKind.VariableDeclaration || target.kind === SyntaxKind.BindingElement)
        return (
          getExportSymbolOfValueSymbolIfExported(c, getResolvedSymbol(c, source)) === getSymbolOfDeclaration(c, target)
        );
      return false;
    case SyntaxKind.ThisKeyword:
      return target.kind === SyntaxKind.ThisKeyword;
    case SyntaxKind.SuperKeyword:
      return target.kind === SyntaxKind.SuperKeyword;
    case SyntaxKind.MetaProperty:
      return (
        target.kind === SyntaxKind.MetaProperty &&
        (source as MetaProperty).keywordToken === (target as MetaProperty).keywordToken &&
        (source as MetaProperty).name.text === (target as MetaProperty).name.text
      );
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.SatisfiesExpression:
      return isMatchingReference(c, getExpression(source)!, target);
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression: {
      const sourceName = getAccessedPropertyName(c, source);
      if (sourceName !== undefined && isAccessExpression(target)) {
        const targetName = getAccessedPropertyName(c, target);
        if (targetName !== undefined)
          return targetName === sourceName && isMatchingReference(c, getExpression(source)!, getExpression(target)!);
      }
      // `obj[key]` matches `obj[key]` for a key that isn't reassigned.
      if (source.kind === SyntaxKind.ElementAccessExpression && target.kind === SyntaxKind.ElementAccessExpression) {
        const sourceArg = (source as ElementAccessExpression).argumentExpression;
        const targetArg = (target as ElementAccessExpression).argumentExpression;
        if (sourceArg.kind === SyntaxKind.Identifier && targetArg.kind === SyntaxKind.Identifier) {
          const symbol = getResolvedSymbol(c, sourceArg);
          if (symbol === getResolvedSymbol(c, targetArg) && isUnreassignedVariable(c, symbol))
            return isMatchingReference(c, getExpression(source)!, getExpression(target)!);
        }
      }
      return false;
    }
    case SyntaxKind.QualifiedName:
      if (isAccessExpression(target)) {
        const targetName = getAccessedPropertyName(c, target);
        if (targetName !== undefined)
          return (
            getText((source as QualifiedName).right) === targetName &&
            isMatchingReference(c, (source as QualifiedName).left, getExpression(target)!)
          );
      }
      return false;
    case SyntaxKind.BinaryExpression:
      return (
        (source as BinaryExpression).operatorToken.kind === SyntaxKind.CommaToken &&
        isMatchingReference(c, (source as BinaryExpression).right, target)
      );
  }
  return false;
}

/** Whether `expr` is `reference.constructor`. */
function isMatchingConstructorReference(c: Checker, f: FlowState, expr: Node): boolean {
  // Only a literal name is read here; resolving an entity name argument could start a circularity.
  let name: Node | undefined = undefined;
  if (expr.kind === SyntaxKind.PropertyAccessExpression) name = (expr as PropertyAccessExpression).name;
  else if (
    expr.kind === SyntaxKind.ElementAccessExpression &&
    isStringLiteralLike((expr as ElementAccessExpression).argumentExpression)
  )
    name = (expr as ElementAccessExpression).argumentExpression;
  return (
    name !== undefined && getText(name) === 'constructor' && isMatchingReference(c, f.reference, getExpression(expr)!)
  );
}

/** Narrows by `x.constructor === C` to the constituents constructed by `C`. */
function narrowTypeByConstructor(
  c: Checker,
  t: Type,
  operator: SyntaxKind,
  identifier: Node,
  assumeTrue: boolean,
): Type {
  // Inequality doesn't narrow.
  if (
    assumeTrue
      ? operator !== SyntaxKind.EqualsEqualsToken && operator !== SyntaxKind.EqualsEqualsEqualsToken
      : operator !== SyntaxKind.ExclamationEqualsToken && operator !== SyntaxKind.ExclamationEqualsEqualsToken
  )
    return t;
  const identifierType = getTypeOfExpression(c, identifier);
  if (
    !(
      (identifierType.flags & TypeFlags.Object) !== 0 &&
      getSignaturesOfType(c, identifierType, SignatureKind.Call).length > 0
    ) &&
    !isConstructorType(c, identifierType)
  )
    return t;
  const prototypeProperty = getPropertyOfType(c, identifierType, 'prototype');
  if (prototypeProperty === undefined) return t;
  const prototypeType = getTypeOfSymbol(c, prototypeProperty);
  if (
    (prototypeType.flags & TypeFlags.Any) !== 0 ||
    prototypeType === c.globalObjectType ||
    prototypeType === c.globalFunctionType
  )
    return t;
  if ((t.flags & TypeFlags.Any) !== 0) return prototypeType;
  return filterType(c, t, (u) => isConstructedBy(c, u, prototypeType));
}

function isConstructedBy(c: Checker, source: Type, target: Type): boolean {
  // Class instances are only constructed by their own class, even when structurally identical to another.
  if (
    ((source.flags & TypeFlags.Object) !== 0 && (source.objectFlags & ObjectFlags.Class) !== 0) ||
    ((target.flags & TypeFlags.Object) !== 0 && (target.objectFlags & ObjectFlags.Class) !== 0)
  )
    return source.symbol === target.symbol;
  return isTypeSubtypeOf(c, source, target);
}

export function getAccessedPropertyName(c: Checker, access: Node): string | undefined {
  if (access.kind === SyntaxKind.PropertyAccessExpression) return getText((access as PropertyAccessExpression).name);
  if (access.kind === SyntaxKind.BindingElement) return getDestructuringPropertyName(c, access);
  if (access.kind === SyntaxKind.ElementAccessExpression) {
    const argument = (access as ElementAccessExpression).argumentExpression;
    if (isStringLiteralLike(argument)) return getText(argument);
    if (argument.kind === SyntaxKind.NumericLiteral) return String(Number(getText(argument)));
    if (isEntityNameExpression(argument, false)) return tryGetNameFromEntityNameExpression(c, argument);
  }
  if (access.kind === SyntaxKind.Parameter) return String(getParameters(access.parent!)!.nodes.indexOf(access));
  return undefined;
}

/** The property name a constant or enum member used as an index stands for. */
export function tryGetNameFromEntityNameExpression(c: Checker, node: Node): string | undefined {
  const symbol = resolveEntityName(c, node, SymbolFlags.Value, true, false, undefined);
  if (symbol === undefined || !(isConstantVariable(c, symbol) || (symbol.flags & SymbolFlags.EnumMember) !== 0))
    return undefined;
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined) return undefined;
  const typeNode = getType(declaration);
  if (typeNode !== undefined) {
    const name = tryGetNameFromType(getTypeFromTypeNode(c, typeNode));
    if (name !== undefined) return name;
  }
  // Binding elements are excluded: their initializers don't alone determine their types, and resolving
  // their full types can be circular.
  if (
    (declaration.kind === SyntaxKind.VariableDeclaration ||
      declaration.kind === SyntaxKind.PropertyDeclaration ||
      declaration.kind === SyntaxKind.PropertyAssignment ||
      declaration.kind === SyntaxKind.Parameter ||
      declaration.kind === SyntaxKind.EnumMember) &&
    isBlockScopedNameDeclaredBeforeUse(c, declaration, node)
  ) {
    const initializer = getInitializer(declaration);
    if (initializer !== undefined) return tryGetNameFromType(getTypeOfExpression(c, initializer));
    if (declaration.kind === SyntaxKind.EnumMember) {
      const name = getName(declaration)!;
      if (isStringLiteralLike(name) || name.kind === SyntaxKind.NumericLiteral || name.kind === SyntaxKind.Identifier)
        return getText(name);
    }
  }
  return undefined;
}

export function tryGetNameFromType(t: Type): string | undefined {
  return (t.flags & (TypeFlags.UniqueESSymbol | TypeFlags.StringOrNumberLiteral)) !== 0
    ? getPropertyNameFromType(t)
    : undefined;
}

/** The property name or element index a destructuring element reads. */
export function getDestructuringPropertyName(c: Checker, node: Node): string | undefined {
  const parent = node.parent!;
  let name: Node | undefined;
  if (node.kind === SyntaxKind.BindingElement && parent.kind === SyntaxKind.ObjectBindingPattern)
    name = (node as BindingElement).propertyName ?? (node as BindingElement).name;
  else if (node.kind === SyntaxKind.PropertyAssignment || node.kind === SyntaxKind.ShorthandPropertyAssignment)
    name = getName(node);
  else if (parent.kind === SyntaxKind.ArrayLiteralExpression || parent.kind === SyntaxKind.ArrayBindingPattern)
    return String(getElements(parent)!.nodes.indexOf(node));
  if (name === undefined) return undefined;
  const t = getLiteralTypeFromPropertyName(c, name);
  return t !== undefined && (t.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) !== 0
    ? getPropertyNameFromType(t)
    : undefined;
}

export function isConstantReference(c: Checker, node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ThisKeyword:
      return true;
    case SyntaxKind.Identifier: {
      if (isThisInTypeQuery(node)) return false;
      const symbol = getResolvedSymbol(c, node);
      return (
        isConstantVariable(c, symbol) ||
        (isParameterOrMutableLocalVariable(c, symbol) && !isSymbolAssigned(c, symbol)) ||
        (symbol.valueDeclaration !== undefined && symbol.valueDeclaration.kind === SyntaxKind.FunctionExpression)
      );
    }
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression: {
      if (!isConstantReference(c, getExpression(node)!)) return false;
      const symbol = c.resolvedSymbols.get(node.id);
      return symbol !== undefined && isReadonlySymbol(c, symbol);
    }
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern: {
      // A destructuring pseudo-reference is constant when none of its variables are reassigned.
      const rootDeclaration = getRootDeclaration(node.parent!);
      if (
        rootDeclaration.kind === SyntaxKind.Parameter ||
        (rootDeclaration.kind === SyntaxKind.VariableDeclaration &&
          rootDeclaration.parent!.kind === SyntaxKind.CatchClause)
      )
        return !isSomeSymbolAssigned(c, getName(rootDeclaration)!);
      if (rootDeclaration.kind !== SyntaxKind.VariableDeclaration) return false;
      const blockScopeKind = getCombinedNodeFlags(rootDeclaration) & NodeFlags.BlockScoped;
      return (
        blockScopeKind === NodeFlags.Const ||
        blockScopeKind === NodeFlags.Using ||
        blockScopeKind === NodeFlags.AwaitUsing
      );
    }
  }
  return false;
}

function containsMatchingReference(c: Checker, sourceIn: Node, target: Node): boolean {
  let source = sourceIn;
  while (isAccessExpression(source)) {
    source = getExpression(source)!;
    if (isMatchingReference(c, source, target)) return true;
  }
  return false;
}

function optionalChainContainsReference(c: Checker, sourceIn: Node, target: Node): boolean {
  let source = sourceIn;
  while (isOptionalChain(source)) {
    source = getExpression(source)!;
    if (isMatchingReference(c, source, target)) return true;
  }
  return false;
}

function getReferenceCandidate(node: Node): Node {
  switch (node.kind) {
    case SyntaxKind.ParenthesizedExpression:
      return getReferenceCandidate(getExpression(node)!);
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      switch (binary.operatorToken.kind) {
        case SyntaxKind.EqualsToken:
        case SyntaxKind.BarBarEqualsToken:
        case SyntaxKind.AmpersandAmpersandEqualsToken:
        case SyntaxKind.QuestionQuestionEqualsToken:
          return getReferenceCandidate(binary.left);
        case SyntaxKind.CommaToken:
          return getReferenceCandidate(binary.right);
      }
    }
  }
  return node;
}

export function hasMatchingArgument(c: Checker, call: Node, reference: Node): boolean {
  const args = getArguments(call);
  if (args !== undefined) {
    for (const argument of args.nodes)
      if (
        isOrContainsMatchingReference(c, reference, argument) ||
        optionalChainContainsReference(c, argument, reference)
      )
        return true;
  }
  const callee = getExpression(call)!;
  return (
    callee.kind === SyntaxKind.PropertyAccessExpression &&
    isOrContainsMatchingReference(c, reference, getExpression(callee)!)
  );
}

function isOrContainsMatchingReference(c: Checker, source: Node, target: Node): boolean {
  return isMatchingReference(c, source, target) || containsMatchingReference(c, source, target);
}

function isCallChain(node: Node): boolean {
  return node.kind === SyntaxKind.CallExpression && isOptionalChain(node);
}

// ---- Reachability

export function isReachableFlowNode(c: Checker, flow: FlowNode): boolean {
  const result = isReachableFlowNodeWorker(c, flow, false);
  c.lastFlowNode = flow;
  c.lastFlowNodeReachable = result;
  return result;
}

function isReachableFlowNodeWorker(c: Checker, start: FlowNode, noCacheCheckIn: boolean): boolean {
  let flow = start;
  let noCacheCheck = noCacheCheckIn;
  for (;;) {
    if (flow === c.lastFlowNode) return c.lastFlowNodeReachable;
    const flags = flow.flags;
    if ((flags & FlowFlags.Shared) !== 0) {
      if (!noCacheCheck) {
        const cached = c.flowNodeReachable.get(flow);
        if (cached !== undefined) return cached;
        const reachable = isReachableFlowNodeWorker(c, flow, true);
        c.flowNodeReachable.set(flow, reachable);
        return reachable;
      }
      noCacheCheck = false;
    }
    if ((flags & (FlowFlags.Assignment | FlowFlags.Condition | FlowFlags.ArrayMutation)) !== 0) flow = flow.antecedent!;
    else if ((flags & FlowFlags.Call) !== 0) {
      const signature = getEffectsSignature(c, flow.node!);
      if (signature !== undefined) {
        const predicate = getTypePredicateOfSignature(c, signature);
        if (
          predicate !== undefined &&
          predicate.kind === TypePredicateKind.AssertsIdentifier &&
          predicate.type === undefined
        ) {
          const args = getArguments(flow.node!)!.nodes;
          if (
            predicate.parameterIndex >= 0 &&
            predicate.parameterIndex < args.length &&
            isFalseExpression(args[predicate.parameterIndex]!)
          )
            return false;
        }
        if ((getReturnTypeOfSignature(c, signature).flags & TypeFlags.Never) !== 0) return false;
      }
      flow = flow.antecedent!;
    } else if ((flags & FlowFlags.BranchLabel) !== 0) {
      for (const antecedent of getBranchLabelAntecedents(c, flow))
        if (isReachableFlowNodeWorker(c, antecedent, false)) return true;
      return false;
    } else if ((flags & FlowFlags.LoopLabel) !== 0) {
      const antecedents = flow.antecedents;
      if (antecedents === undefined || antecedents.length === 0) return false;
      flow = antecedents[0]!;
    } else if ((flags & FlowFlags.SwitchClause) !== 0) {
      const clause = flow as FlowSwitchClause;
      if (clause.isEmpty() && isExhaustiveSwitchStatement(c, clause.switchStatement)) return false;
      flow = flow.antecedent!;
    } else if ((flags & FlowFlags.ReduceLabel) !== 0) {
      c.lastFlowNode = undefined;
      c.flowReduceLabels.push(flow as FlowReduceLabel);
      const result = isReachableFlowNodeWorker(c, flow.antecedent!, false);
      c.flowReduceLabels.pop();
      return result;
    } else return (flags & FlowFlags.Unreachable) === 0;
  }
}

function isFalseExpression(expr: Node): boolean {
  const node = skipParentheses(expr);
  if (node.kind === SyntaxKind.FalseKeyword) return true;
  if (node.kind === SyntaxKind.BinaryExpression) {
    const binary = node as BinaryExpression;
    if (binary.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken)
      return isFalseExpression(binary.left) || isFalseExpression(binary.right);
    if (binary.operatorToken.kind === SyntaxKind.BarBarToken)
      return isFalseExpression(binary.left) && isFalseExpression(binary.right);
  }
  return false;
}

// ---- Variables and assignments

export const enum AssignmentKind {
  None = 0,
  Definite = 1,
  Compound = 2,
}

export function getAssignmentTargetKind(node: Node): AssignmentKind {
  const target = getAssignmentTarget(node);
  if (target === undefined) return AssignmentKind.None;
  if (target.kind === SyntaxKind.BinaryExpression) {
    const op = (target as BinaryExpression).operatorToken.kind;
    return op === SyntaxKind.EqualsToken || isLogicalOrCoalescingAssignmentOperator(op)
      ? AssignmentKind.Definite
      : AssignmentKind.Compound;
  }
  if (target.kind === SyntaxKind.PrefixUnaryExpression || target.kind === SyntaxKind.PostfixUnaryExpression)
    return AssignmentKind.Compound;
  return AssignmentKind.Definite;
}

export function isInCompoundLikeAssignment(node: Node): boolean {
  const target = getAssignmentTarget(node);
  if (target === undefined || !isAssignmentExpression(target, true)) return false;
  const right = skipParentheses((target as BinaryExpression).right);
  return (
    right.kind === SyntaxKind.BinaryExpression &&
    isShiftOperatorOrHigher((right as BinaryExpression).operatorToken.kind)
  );
}

function isShiftOperatorOrHigher(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.LessThanLessThanToken:
    case SyntaxKind.GreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case SyntaxKind.AsteriskToken:
    case SyntaxKind.SlashToken:
    case SyntaxKind.PercentToken:
    case SyntaxKind.PlusToken:
    case SyntaxKind.MinusToken:
    case SyntaxKind.AsteriskAsteriskToken:
      return true;
  }
  return false;
}

function isUnreassignedVariable(c: Checker, symbol: Symbol): boolean {
  return (
    isConstantVariable(c, symbol) || (isParameterOrMutableLocalVariable(c, symbol) && !isSymbolAssigned(c, symbol))
  );
}

export function isConstantVariable(_c: Checker, symbol: Symbol): boolean {
  if ((symbol.flags & SymbolFlags.Variable) === 0 || symbol.valueDeclaration === undefined) return false;
  return (getCombinedNodeFlags(symbol.valueDeclaration) & NodeFlags.Constant) !== 0;
}

export function isParameterOrMutableLocalVariable(_c: Checker, symbol: Symbol): boolean {
  if (symbol.valueDeclaration === undefined) return false;
  const declaration = getRootDeclaration(symbol.valueDeclaration);
  return (
    declaration.kind === SyntaxKind.Parameter ||
    (declaration.kind === SyntaxKind.VariableDeclaration &&
      (declaration.parent!.kind === SyntaxKind.CatchClause || isMutableLocalVariableDeclaration(declaration)))
  );
}

export function isMutableLocalVariableDeclaration(declaration: Node): boolean {
  const list = declaration.parent!;
  if ((list.flags & NodeFlags.Let) === 0) return false;
  if ((getCombinedModifierFlags(declaration) & ModifierFlags.Export) !== 0) return false;
  const statement = list.parent!;
  return !(statement.kind === SyntaxKind.VariableStatement && isGlobalSourceFile(statement.parent!));
}

export function isSymbolAssigned(c: Checker, symbol: Symbol): boolean {
  ensureAssignmentsMarked(c, symbol);
  return c.symbolLinks(symbol).lastAssignmentPos !== 0;
}

export function isSymbolAssignedDefinitely(c: Checker, symbol: Symbol): boolean {
  ensureAssignmentsMarked(c, symbol);
  return c.symbolLinks(symbol).hasDefiniteAssignment;
}

/** Whether there are no assignments to `symbol`, or `location` is past the last one. */
export function isPastLastAssignment(c: Checker, symbol: Symbol, location: Node | undefined): boolean {
  ensureAssignmentsMarked(c, symbol);
  const pos = c.symbolLinks(symbol).lastAssignmentPos;
  return pos === 0 || (location !== undefined && pos < location.pos);
}

function isFunctionOrSourceFile(node: Node): boolean {
  return node.kind === SyntaxKind.SourceFile || isFunctionLike(node);
}

function findFunctionOrSourceFile(node: Node | undefined): Node | undefined {
  let current = node;
  while (current !== undefined && !isFunctionOrSourceFile(current)) current = current.parent;
  return current;
}

function ensureAssignmentsMarked(c: Checker, symbol: Symbol): void {
  if (c.symbolLinks(symbol).lastAssignmentPos !== 0) return;
  const parent = findFunctionOrSourceFile(symbol.valueDeclaration);
  if (parent === undefined) return;
  const links = c.nodeLinks(parent);
  if ((links.flags & NodeCheckFlags.AssignmentsMarked) !== 0) return;
  links.flags |= NodeCheckFlags.AssignmentsMarked;
  // An enclosing function already marked everything inside it.
  let outer = parent.parent;
  while (outer !== undefined) {
    if (
      isFunctionOrSourceFile(outer) &&
      ((c.existingNodeLinks(outer)?.flags ?? 0) & NodeCheckFlags.AssignmentsMarked) !== 0
    )
      return;
    outer = outer.parent;
  }
  c.assignmentMarker.visitNode(parent);
}

const maxAssignmentPos = 2147483647;

/** Records the last assignment position of parameters and mutable locals in one walk. */
export class AssignmentMarker extends NodeVisitor {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  visitNode(node: Node): boolean {
    const c = this.c;
    switch (node.kind) {
      case SyntaxKind.Identifier: {
        const kind = getAssignmentTargetKind(node);
        if (kind === AssignmentKind.None) return false;
        const symbol = getResolvedSymbol(c, node);
        if (!isParameterOrMutableLocalVariable(c, symbol)) return false;
        const links = c.symbolLinks(symbol);
        if (links.lastAssignmentPos !== maxAssignmentPos) {
          const referencing = findFunctionOrSourceFile(node);
          const declaring = findFunctionOrSourceFile(symbol.valueDeclaration);
          links.lastAssignmentPos =
            referencing === declaring ? extendAssignmentPosition(node, symbol.valueDeclaration!) : maxAssignmentPos;
        }
        if (kind === AssignmentKind.Definite) links.hasDefiniteAssignment = true;
        return false;
      }
      case SyntaxKind.ExportSpecifier: {
        const specifier = node as ExportSpecifier;
        const declaration = specifier.parent!.parent as ExportDeclaration;
        const name = specifier.propertyName ?? specifier.name;
        if (
          !specifier.isTypeOnly &&
          !declaration.isTypeOnly &&
          declaration.moduleSpecifier === undefined &&
          name.kind !== SyntaxKind.StringLiteral
        ) {
          const symbol = resolveEntityName(c, name, SymbolFlags.Value, true, true, undefined);
          if (symbol !== undefined && isParameterOrMutableLocalVariable(c, symbol))
            c.symbolLinks(symbol).lastAssignmentPos = maxAssignmentPos;
        }
        return false;
      }
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration:
        return false;
    }
    if (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode) return false;
    return node.forEachChild(this);
  }
}

function extendAssignmentPosition(nodeIn: Node, declaration: Node): number {
  let node: Node | undefined = nodeIn;
  let pos = nodeIn.pos;
  while (node !== undefined && node.pos > declaration.pos) {
    switch (node.kind) {
      case SyntaxKind.VariableStatement:
      case SyntaxKind.ExpressionStatement:
      case SyntaxKind.IfStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WithStatement:
      case SyntaxKind.SwitchStatement:
      case SyntaxKind.TryStatement:
      case SyntaxKind.ClassDeclaration:
        pos = node.end;
    }
    node = node.parent;
  }
  return pos;
}

/** The function, module block, source file or property declaration whose flow graph contains `node`. */
export function getControlFlowContainer(node: Node): Node {
  let current = node.parent!;
  for (;;) {
    if (
      (isFunctionLike(current) && getImmediatelyInvokedFunctionExpression(current) === undefined) ||
      current.kind === SyntaxKind.ModuleBlock ||
      current.kind === SyntaxKind.SourceFile ||
      current.kind === SyntaxKind.PropertyDeclaration
    )
      return current;
    current = current.parent!;
  }
}

/** Array mutations of an auto-typed array (`x.push(...)`, `x[i] = ...`) on the way to its references. */
function getTypeAtFlowArrayMutation(c: Checker, f: FlowState, flow: FlowNode): Type | undefined {
  if (f.declaredType !== c.autoType && f.declaredType !== c.autoArrayType) return undefined;
  const node = flow.node!;
  const expr =
    node.kind === SyntaxKind.CallExpression
      ? getExpression(getExpression(node)!)!
      : getExpression((node as BinaryExpression).left)!;
  if (!isMatchingReference(c, f.reference, getReferenceCandidate(expr))) return undefined;
  const flowType = getTypeAtFlowNode(c, f, flow.antecedent!);
  if ((flowType.objectFlags & ObjectFlags.EvolvingArray) === 0) return flowType;
  const incomplete = f.incomplete;
  let evolvedType = flowType;
  if (node.kind === SyntaxKind.CallExpression) {
    for (const arg of getArguments(node)!.nodes) evolvedType = addEvolvingArrayElementType(c, evolvedType, arg);
  } else {
    // The context-free type avoids rechecking the left side without caching, which blows up.
    const binary = node as BinaryExpression;
    const indexType = getContextFreeTypeOfExpression(c, (binary.left as ElementAccessExpression).argumentExpression);
    if (isTypeAssignableToKindEx(c, indexType, TypeFlags.NumberLike, false))
      evolvedType = addEvolvingArrayElementType(c, evolvedType, binary.right);
  }
  return newFlowType(c, f, evolvedType, incomplete);
}

// ---- Evolving arrays

/** The evolving array type of `let x = []` with the element types added so far. */
export function getEvolvingArrayType(c: Checker, elementType: Type): Type {
  const key = cachedTypeKey(CachedTypeKind.EvolvingArray, elementType.id);
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached;
  const evolving = newObjectType(c, ObjectFlags.EvolvingArray, undefined) as EvolvingArrayType;
  evolving.elementType = elementType;
  c.cachedTypesById.set(key, evolving);
  return evolving;
}

function getElementTypeOfEvolvingArrayType(c: Checker, t: Type): Type {
  return (t.objectFlags & ObjectFlags.EvolvingArray) !== 0 ? (t as EvolvingArrayType).elementType! : c.neverType;
}

function isEvolvingArrayTypeList(types: readonly Type[]): boolean {
  let hasEvolvingArrayType = false;
  for (const t of types) {
    if ((t.flags & TypeFlags.Never) !== 0) continue;
    if ((t.objectFlags & ObjectFlags.EvolvingArray) === 0) return false;
    hasEvolvingArrayType = true;
  }
  return hasEvolvingArrayType;
}

/**
 * Whether `node` is `x` in `x.length`, `x.push(v)`, `x.unshift(v)` or `x[n] = v` with a numeric,
 * undefined or any `n`.
 */
export function isEvolvingArrayOperationTarget(c: Checker, node: Node): boolean {
  const root = getReferenceRoot(node);
  const parent = root.parent!;
  if (parent.kind === SyntaxKind.PropertyAccessExpression) {
    const name = (parent as PropertyAccessExpression).name;
    return (
      getText(name) === 'length' ||
      (parent.parent!.kind === SyntaxKind.CallExpression &&
        name.kind === SyntaxKind.Identifier &&
        isPushOrUnshiftIdentifier(name))
    );
  }
  if (parent.kind !== SyntaxKind.ElementAccessExpression || getExpression(parent) !== root) return false;
  const grandparent = parent.parent!;
  return (
    grandparent.kind === SyntaxKind.BinaryExpression &&
    (grandparent as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken &&
    (grandparent as BinaryExpression).left === parent &&
    !isAssignmentTarget(grandparent) &&
    isTypeAssignableToKindEx(
      c,
      getTypeOfExpression(c, (parent as ElementAccessExpression).argumentExpression),
      TypeFlags.NumberLike,
      false,
    )
  );
}

function getReferenceRoot(node: Node): Node {
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.ParenthesizedExpression) return getReferenceRoot(parent);
  if (parent.kind === SyntaxKind.BinaryExpression) {
    const binary = parent as BinaryExpression;
    if (
      (binary.operatorToken.kind === SyntaxKind.EqualsToken && binary.left === node) ||
      (binary.operatorToken.kind === SyntaxKind.CommaToken && binary.right === node)
    )
      return getReferenceRoot(parent);
  }
  return node;
}

/** Adds the type of `node` to an evolving array; subtype reduction waits until it's finalized. */
function addEvolvingArrayElementType(c: Checker, evolvingArrayType: Type, node: Node): Type {
  const newElementType = getRegularTypeOfObjectLiteral(
    c,
    getBaseTypeOfLiteralType(c, getContextFreeTypeOfExpression(c, node)),
  );
  const elementType = (evolvingArrayType as EvolvingArrayType).elementType!;
  if (isTypeSubsetOf(c, newElementType, elementType)) return evolvingArrayType;
  return getEvolvingArrayType(c, getUnionType(c, [elementType, newElementType]));
}

/** The array type an evolving array settles on; `any[]` while it has no elements. */
export function finalizeEvolvingArrayType(c: Checker, t: Type): Type {
  if ((t.objectFlags & ObjectFlags.EvolvingArray) === 0) return t;
  const evolving = t as EvolvingArrayType;
  const side = sideOf(c, evolving);
  if (side.finalArrayType !== undefined) return side.finalArrayType;
  const elementType = evolving.elementType!;
  const finalArrayType =
    (elementType.flags & TypeFlags.Never) !== 0
      ? c.autoArrayType
      : createArrayType(
          c,
          (elementType.flags & TypeFlags.Union) !== 0
            ? getUnionTypeEx(c, (elementType as UnionType).types, UnionReduction.Subtype, undefined, undefined)
            : elementType,
        );
  side.finalArrayType = finalArrayType;
  return finalArrayType;
}

/** The type of an expression checked without contextual types, computed once. */
function getContextFreeTypeOfExpression(c: Checker, node: Node): Type {
  const links = c.nodeLinks(node);
  if (links.contextFreeType !== undefined) return links.contextFreeType;
  const t = checkExpressionEx(c, node, CheckMode.SkipContextSensitive);
  links.contextFreeType = t;
  return t;
}

function reportFlowControlError(c: Checker, node: Node): void {
  let block: Node | undefined = node;
  while (block !== undefined && !isFunctionOrModuleBlock(block)) block = block.parent;
  if (block === undefined) return;
  const file = getSourceFileOfNode(node);
  const span = getRangeOfTokenAtPosition(file, getStatements(block)!.pos);
  c.addDiagnostic(
    new Diagnostic(
      file.diagnosticFile(),
      span.pos,
      span.end,
      Diagnostics.The_containing_function_or_module_body_is_too_large_for_control_flow_analysis,
      [],
    ),
  );
}

function isFunctionOrModuleBlock(node: Node): boolean {
  return (
    node.kind === SyntaxKind.SourceFile ||
    node.kind === SyntaxKind.ModuleBlock ||
    (node.kind === SyntaxKind.Block && node.parent !== undefined && isFunctionLike(node.parent))
  );
}

/**
 * The type of `symbol` at `location`. A destructured variable of a const declaration or unassigned
 * parameter is narrowed by checks of its siblings: in `const { kind, payload } = action`, testing
 * `kind` narrows `payload`.
 */
export function getNarrowedTypeOfSymbol(c: Checker, symbol: Symbol, location: Node): Type {
  const t = getTypeOfSymbol(c, symbol);
  const declaration = symbol.valueDeclaration;
  if (
    declaration !== undefined &&
    declaration.kind === SyntaxKind.Parameter &&
    getType(declaration) === undefined &&
    getInitializer(declaration) === undefined &&
    getDotDotDotToken(declaration) === undefined
  )
    return getNarrowedTypeOfDependentParameter(c, t, declaration, location);
  if (
    declaration === undefined ||
    declaration.kind !== SyntaxKind.BindingElement ||
    getInitializer(declaration) !== undefined ||
    (declaration as BindingElement).dotDotDotToken !== undefined ||
    getElements(declaration.parent!)!.nodes.length < 2
  )
    return t;
  const pattern = declaration.parent!;
  const parent = pattern.parent!;
  const rootDeclaration = getRootDeclaration(parent);
  const isParameter = rootDeclaration.kind === SyntaxKind.Parameter;
  if (
    !isParameter &&
    !(
      rootDeclaration.kind === SyntaxKind.VariableDeclaration &&
      (getCombinedNodeFlags(rootDeclaration) & NodeFlags.Constant) !== 0
    )
  )
    return t;
  const links = c.nodeLinks(parent);
  if ((links.flags & NodeCheckFlags.InCheckIdentifier) !== 0) return t;
  links.flags |= NodeCheckFlags.InCheckIdentifier;
  let result = t;
  const parentType = getTypeForBindingElementParent(c, parent, CheckMode.Normal);
  const parentTypeConstraint = parentType !== undefined ? mapToBaseConstraintOrType(c, parentType) : undefined;
  if (
    parentTypeConstraint !== undefined &&
    (parentTypeConstraint.flags & TypeFlags.Union) !== 0 &&
    !(isParameter && isSomeSymbolAssigned(c, getName(rootDeclaration)!))
  ) {
    const narrowedType = getFlowTypeOfReferenceAt(
      c,
      pattern,
      parentTypeConstraint,
      parentTypeConstraint,
      undefined,
      getFlowNode(location),
    );
    // Tuple bounds aren't checked, as the narrowed parent may have fewer elements than the declared one.
    result =
      (narrowedType.flags & TypeFlags.Never) !== 0
        ? c.neverType
        : getBindingElementTypeFromParentType(c, declaration as BindingElement, narrowedType, true);
  }
  links.flags &= ~NodeCheckFlags.InCheckIdentifier;
  return result;
}

/**
 * A parameter of a function contextually typed by a rest union of tuples, as in
 * `const f: (...args: [1, string] | [2, number]) => void = (kind, data) => ...`, narrowed by checks of its
 * sibling parameters: the function is the pseudo-reference for the tuple.
 */
function getNarrowedTypeOfDependentParameter(c: Checker, t: Type, declaration: Node, location: Node): Type {
  const fn = declaration.parent!;
  const parameters = getParameters(fn)!.nodes;
  if (parameters.length < 2 || !isContextSensitiveFunctionOrObjectLiteralMethod(c, fn)) return t;
  const contextualSignature = getContextualSignature(c, fn);
  if (
    contextualSignature === undefined ||
    contextualSignature.parameters.length !== 1 ||
    !contextualSignature.hasRestParameter()
  )
    return t;
  const context = getInferenceContext(c, fn);
  const restType = getReducedApparentType(
    c,
    instantiateType(
      c,
      getTypeOfSymbol(c, contextualSignature.parameters[0]!),
      context !== undefined ? context.nonFixingMapper : undefined,
    ),
  );
  if (
    (restType.flags & TypeFlags.Union) === 0 ||
    !everyType(restType, isTupleType) ||
    someParameterAssigned(c, parameters)
  )
    return t;
  const narrowedType = getFlowTypeOfReferenceAt(c, fn, restType, restType, undefined, getFlowNode(location));
  const index = parameters.indexOf(declaration) - (isThisParameter(parameters[0]!) ? 1 : 0);
  return getIndexedAccessType(c, narrowedType, getNumberLiteralType(c, index));
}

function isThisParameter(parameter: Node): boolean {
  const name = getName(parameter);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this';
}

function someParameterAssigned(c: Checker, parameters: Node[]): boolean {
  for (const p of parameters) if (isSomeSymbolAssigned(c, getName(p)!)) return true;
  return false;
}

function isSomeSymbolAssigned(c: Checker, name: Node): boolean {
  if (name.kind === SyntaxKind.Identifier) {
    const symbol = getSymbolOfDeclaration(c, name.parent!);
    return symbol !== undefined && isSymbolAssigned(c, symbol);
  }
  for (const e of getElements(name)!.nodes) {
    const elementName = getName(e);
    if (elementName !== undefined && isSomeSymbolAssigned(c, elementName)) return true;
  }
  return false;
}
