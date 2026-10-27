// Writing pseudo-types (types as far as syntax decides them) as type nodes, checked against the
// checker's types: declaration emit reuses what the source wrote where it denotes the same type,
// and reports what isolatedDeclarations can't write without inference.
import {
  FunctionTypeNode,
  GetAccessorDeclaration,
  Identifier,
  KeywordTypeNode,
  LiteralTypeNode,
  MethodSignatureDeclaration,
  type Node,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertySignatureDeclaration,
  QualifiedName,
  SetAccessorDeclaration,
  StringLiteral,
  TupleTypeNode,
  TypeLiteralNode,
  TypeOperatorNode,
  TypePredicateNode,
  UnionTypeNode,
  getBody,
  NodeFlags,
  getName,
  getPostfixToken,
  getQuestionToken,
  getSymbol,
  getText,
  isDeclarationNode,
} from './ast.js';
import { isFunctionLike } from './ast-utilities.js';
import { getSourceFileOfNode, isEntityNameExpression } from './binder-utilities.js';
import type { Checker } from './checker.js';
import { ContextFlags, getContextualType, instantiateContextualType } from './checker-contextual.js';
import { getTypeOfExpression, isConstContext, isLiteralOfContextualType } from './checker-expressions.js';
import { getTypeWithFacts, TypeFacts } from './checker-flow.js';
import { getPropertiesOfType, getPropertyOfType } from './checker-members.js';
import {
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getSingleCallSignature,
  getTypePredicateOfSignature,
} from './checker-signatures.js';
import {
  getTypeOfParameter,
  getTypeOfSymbol,
  getWidenedType,
  getWriteTypeOfSymbol,
  removeMissingType,
} from './checker-symbol-types.js';
import {
  getRegularTypeOfLiteralType,
  getTypeArguments,
  getUnionType,
  isErrorType,
  isTupleType,
} from './checker-type-factory.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  ElementFlags,
  type Signature,
  Ternary,
  type TupleType,
  type Type,
  TypeFlags,
  type TypePredicate,
  TypePredicateKind,
  type TypeReference,
  type UnionType,
} from './checker-types.js';
import type { DiagnosticMessage } from './diagnostics.js';
import { NameResolver } from './name-resolver.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import {
  type NodeBuilder,
  PropertyNameKind,
  canReuseExistingJSTypeNode,
  classifyPropertyName,
  getExpandedParameters,
  isOptionalParameter,
  requiresAddingImplicitUndefined,
} from './node-builder.js';
import { tryReuseExistingNode } from './node-builder-reuse.js';
import { EmitFlags } from './printer/emit-flags.js';
import { compareTypesIdentical } from './relations.js';
import { SyntaxKind } from './syntax-kind.js';
import { NodeBuilderFlags } from './transformers/declarations-resolver.js';
import {
  DirectType,
  InferredType,
  type LiteralType,
  type MaybeConstType,
  type NoResultType,
  type ObjectLiteralType,
  PseudoChecker,
  PseudoMemberKind,
  type PseudoParameter,
  type PseudoType,
  PseudoTypeKind,
  type SignatureType,
  type TupleType as PseudoTupleType,
  type UnionType as PseudoUnionType,
  isInConstContext,
} from './transformers/declarations-pseudo.js';
import { tryGetTextOfPropertyName } from './transformers/declarations-syntactic.js';
import { TokenFlags } from './types.js';
import { CheckFlags, declarationCount, type Symbol, SymbolFlags } from './symbol.js';

/** Resolves no names: `undefined` in an expression is the undefined value, as tsgo's pseudochecker assumes. */
class NoNames extends NameResolver {
  resolve(
    _location: Node | undefined,
    _name: string,
    _meaning: SymbolFlags,
    _nameNotFoundMessage: DiagnosticMessage | undefined,
    _isUse: boolean,
    _excludeGlobals: boolean,
  ): Symbol | undefined {
    return undefined;
  }
}

/** A pseudochecker for declaration emit with the checker. */
export function newPseudoChecker(c: Checker): PseudoChecker {
  return new PseudoChecker(c.strictNullChecks, new Map<Symbol, Symbol>(), new NoNames(c.compilerOptions));
}

function isDeclaration(node: Node): boolean {
  if (node.kind === SyntaxKind.TypeParameter) return node.parent !== undefined;
  return isDeclarationNode(node);
}

function getContainingFunction(node: Node): Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if (isFunctionLike(current)) return current;
  return undefined;
}

export function containsNonMissingUndefinedType(c: Checker, t: Type): boolean {
  const candidate = (t.flags & TypeFlags.Union) !== 0 ? typesOfUnion(t)[0]! : t;
  return (candidate.flags & TypeFlags.Undefined) !== 0 && candidate !== c.missingType;
}

function typesOfUnion(t: Type): Type[] {
  return (t as UnionType).types;
}

export function getRegularTypeOfExpression(c: Checker, node: Node): Type {
  const parent = node.parent;
  let expr = node;
  if (
    (parent instanceof QualifiedName && parent.right === node) ||
    (parent instanceof PropertyAccessExpression && parent.name === node)
  )
    expr = parent;
  // Rechecks the expression, as tsgo does, unless its type needed control flow analysis.
  return getRegularTypeOfLiteralType(c, getTypeOfExpression(c, expr));
}

function keyword(b: NodeBuilder, kind: SyntaxKind): Node {
  return b.created(new KeywordTypeNode(kind));
}

/**
 * Like `pseudoTypeToNode`, but an inferred pseudo-type (or an annotation that can't be reused)
 * reports its fallback and is written from the checker's type.
 */
export function pseudoTypeToNodeWithCheckerFallback(
  b: NodeBuilder,
  t: PseudoType,
  checkerType: Type,
): Node | undefined {
  if (t instanceof InferredType) {
    if (!b.suppressReportInferenceFallback) {
      if (t.errorNodes.length > 0) for (const n of t.errorNodes) b.tracker.reportInferenceFallback(n);
      else b.tracker.reportInferenceFallback(t.expression);
    }
    return typeToTypeNodeSuppressed(b, checkerType);
  }
  if (t instanceof DirectType) {
    if (!canReuseExistingJSTypeNode(b, t.typeNode, checkerType)) {
      if (!b.suppressReportInferenceFallback) b.tracker.reportInferenceFallback(t.typeNode);
      return typeToTypeNodeSuppressed(b, checkerType);
    }
  }
  return pseudoTypeToNode(b, t);
}

function typeToTypeNodeSuppressed(b: NodeBuilder, t: Type): Node | undefined {
  const old = b.suppressReportInferenceFallback;
  b.suppressReportInferenceFallback = true;
  const result = b.typeToTypeNode(t);
  b.suppressReportInferenceFallback = old;
  return result;
}

/** The type node of a pseudo-type, reporting the fallbacks its structure implies. */
export function pseudoTypeToNode(b: NodeBuilder, t: PseudoType): Node | undefined {
  const c = b.c;
  switch (t.kind) {
    case PseudoTypeKind.Direct:
      return reuseTypeNode(b, (t as DirectType).typeNode);
    case PseudoTypeKind.Inferred: {
      const inferred = t as InferredType;
      const node = inferred.expression;
      if (inferred.errorNodes.length > 0) for (const n of inferred.errorNodes) b.tracker.reportInferenceFallback(n);
      else if (isEntityNameExpression(node, false) && node.parent !== undefined && isDeclaration(node.parent))
        b.tracker.reportInferenceFallback(node.parent);
      else b.tracker.reportInferenceFallback(node);
      if (inferred.isSignatureReturn)
        return b.serializeReturnTypeForSignatureEx(getSignatureFromDeclaration(c, node), false);
      const parent = node.parent!;
      // The declaration's type is widened as the checker widens it.
      if (parent.kind === SyntaxKind.ReturnStatement) {
        const enclosing = getContainingFunction(node)!;
        if (isAccessorKind(enclosing)) return b.serializeTypeForDeclaration(enclosing, undefined, undefined, false);
        return b.serializeReturnTypeForSignatureEx(getSignatureFromDeclaration(c, enclosing), false);
      }
      if (parent.kind === SyntaxKind.ArrowFunction && getBody(parent) === node)
        return b.serializeReturnTypeForSignatureEx(getSignatureFromDeclaration(c, parent), false);
      if (isDeclaration(parent)) return b.serializeTypeForDeclaration(parent, undefined, undefined, false);
      return b.typeToTypeNode(getTypeOfExpression(c, node));
    }
    case PseudoTypeKind.NoResult: {
      const node = (t as NoResultType).declaration;
      b.tracker.reportInferenceFallback(node);
      if (isFunctionLike(node) && !isAccessorKind(node))
        return b.serializeReturnTypeForSignatureEx(getSignatureFromDeclaration(c, node), false);
      return b.serializeTypeForDeclaration(node, undefined, undefined, false);
    }
    case PseudoTypeKind.MaybeConstLocation: {
      const d = t as MaybeConstType;
      let inConstContext = isConstContext(c, d.node);
      if (!inConstContext && isInConstContext(d.node)) {
        // The contextual type only counts where syntax also finds a const context.
        const contextualType = getContextualType(c, d.node);
        const constType = pseudoTypeToType(b, d.constType);
        if (
          constType !== undefined &&
          isLiteralOfContextualType(
            c,
            constType,
            instantiateContextualType(c, contextualType, d.node, ContextFlags.None),
          )
        )
          inConstContext = true;
      }
      return pseudoTypeToNode(b, inConstContext ? d.constType : d.regularType);
    }
    case PseudoTypeKind.Union: {
      const res: Node[] = [];
      let hasElidedType = false;
      let hasUndefined = false;
      const append = (node: Node | undefined): void => {
        if (node === undefined) return;
        if (node instanceof UnionTypeNode) {
          for (const member of node.types.nodes) append(member);
          return;
        }
        if (node.kind === SyntaxKind.UndefinedKeyword) {
          if (hasUndefined) return;
          hasUndefined = true;
        }
        res.push(node);
      };
      for (const m of (t as PseudoUnionType).types) {
        if (!c.strictNullChecks && (m.kind === PseudoTypeKind.Undefined || m.kind === PseudoTypeKind.Null)) {
          hasElidedType = true;
          continue;
        }
        append(pseudoTypeToNode(b, m));
      }
      if (res.length === 1) return res[0]!;
      if (res.length === 0) return keyword(b, hasElidedType ? SyntaxKind.AnyKeyword : SyntaxKind.NeverKeyword);
      return b.created(new UnionTypeNode(b.list(res)));
    }
    case PseudoTypeKind.Undefined:
      return keyword(b, c.strictNullChecks ? SyntaxKind.UndefinedKeyword : SyntaxKind.AnyKeyword);
    case PseudoTypeKind.Null:
      if (!c.strictNullChecks) return keyword(b, SyntaxKind.AnyKeyword);
      return b.created(new LiteralTypeNode(b.factory.createKeywordExpression(SyntaxKind.NullKeyword)));
    case PseudoTypeKind.Any:
      return keyword(b, SyntaxKind.AnyKeyword);
    case PseudoTypeKind.String:
      return keyword(b, SyntaxKind.StringKeyword);
    case PseudoTypeKind.Number:
      return keyword(b, SyntaxKind.NumberKeyword);
    case PseudoTypeKind.BigInt:
      return keyword(b, SyntaxKind.BigIntKeyword);
    case PseudoTypeKind.Boolean:
      return keyword(b, SyntaxKind.BooleanKeyword);
    case PseudoTypeKind.False:
      return b.created(new LiteralTypeNode(b.factory.createKeywordExpression(SyntaxKind.FalseKeyword)));
    case PseudoTypeKind.True:
      return b.created(new LiteralTypeNode(b.factory.createKeywordExpression(SyntaxKind.TrueKeyword)));
    case PseudoTypeKind.SingleCallSignature: {
      const d = t as SignatureType;
      const signature = getSignatureFromDeclaration(c, d.signature);
      const expandedParams = getExpandedParameters(c, signature, true)[0]!;
      const cleanup = b.enterNewScope(
        d.signature,
        expandedParams,
        signature.typeParameters,
        signature.parameters,
        signature.mapper,
      );
      const typeParams = reuseTypeParameters(b, d.typeParameters);
      const params = pseudoParametersToNodes(b, d.parameters);
      const returnType = pseudoTypeToNode(b, d.returnType);
      cleanup();
      return b.created(new FunctionTypeNode(typeParams, b.list(params), returnType));
    }
    case PseudoTypeKind.Tuple: {
      const res: Node[] = [];
      for (const e of (t as PseudoTupleType).elements) {
        const node = pseudoTypeToNode(b, e);
        if (node !== undefined) res.push(node);
      }
      // `as const` arrays are readonly.
      const result = b.created(new TupleTypeNode(b.list(res)));
      b.context.addEmitFlags(result, EmitFlags.SingleLine);
      return b.created(new TypeOperatorNode(SyntaxKind.ReadonlyKeyword, result));
    }
    case PseudoTypeKind.ObjectLiteral:
      return objectLiteralToNode(b, t as ObjectLiteralType);
    case PseudoTypeKind.StringLiteral:
    case PseudoTypeKind.NumericLiteral:
    case PseudoTypeKind.BigIntLiteral: {
      const reused = reuseNode(b, (t as LiteralType).node);
      return reused === undefined ? undefined : b.created(new LiteralTypeNode(reused));
    }
  }
  return undefined;
}

function objectLiteralToNode(b: NodeBuilder, t: ObjectLiteralType): Node {
  const c = b.c;
  const elements = t.members;
  if (elements.length === 0) {
    const empty = b.created(new TypeLiteralNode(b.list([])));
    b.context.addEmitFlags(empty, EmitFlags.SingleLine);
    return empty;
  }
  // The checker's const context, which includes const type parameters' contexts.
  const isConst = isConstContext(c, elements[0].name.parent!.parent!);
  const newElements: Node[] = [];
  const savedFlags = b.flags;
  // As `createTypeNodeFromObjectType`, so inaccessible `this` in members is reported.
  b.flags |= NodeBuilderFlags.InObjectTypeLiteral;
  for (const e of elements) {
    const modifiers =
      isConst || (e.kind === PseudoMemberKind.Property && e.readonly)
        ? b.modifierList([b.token(SyntaxKind.ReadonlyKeyword)])
        : undefined;
    let cleanup: (() => void) | undefined = undefined;
    if (e.kind !== PseudoMemberKind.Property && e.signature !== undefined) {
      const signature = getSignatureFromDeclaration(c, e.signature);
      const expandedParams = getExpandedParameters(c, signature, true)[0]!;
      cleanup = b.enterNewScope(
        e.signature,
        expandedParams,
        signature.typeParameters,
        signature.parameters,
        signature.mapper,
      );
    }
    let newProp: Node;
    switch (e.kind) {
      case PseudoMemberKind.Method: {
        const typeParams = reuseTypeParameters(b, e.typeParameters);
        if (isConst) {
          newProp = b.created(
            new PropertySignatureDeclaration(
              modifiers,
              reuseName(b, e.name, false),
              undefined,
              b.created(
                new FunctionTypeNode(
                  typeParams,
                  b.list(pseudoParametersToNodes(b, e.parameters)),
                  pseudoTypeToNode(b, e.type),
                ),
              ),
              undefined,
            ),
          );
          break;
        }
        newProp = b.created(
          new MethodSignatureDeclaration(
            modifiers,
            reuseName(b, e.name, true),
            undefined,
            typeParams,
            b.list(pseudoParametersToNodes(b, e.parameters)),
            pseudoTypeToNode(b, e.type),
          ),
        );
        break;
      }
      case PseudoMemberKind.Property:
        newProp = b.created(
          new PropertySignatureDeclaration(
            modifiers,
            reuseName(b, e.name, false),
            undefined,
            pseudoTypeToNode(b, e.type),
            undefined,
          ),
        );
        break;
      case PseudoMemberKind.SetAccessor:
        newProp = b.created(
          new SetAccessorDeclaration(
            undefined,
            reuseName(b, e.name, false),
            undefined,
            b.list(e.parameters.length > 0 ? [pseudoParameterToNode(b, e.parameters[0]!)] : []),
            undefined,
            undefined,
            undefined,
          ),
        );
        break;
      default:
        newProp = b.created(
          new GetAccessorDeclaration(
            undefined,
            reuseName(b, e.name, false),
            undefined,
            b.list([]),
            pseudoTypeToNode(b, e.type),
            undefined,
            undefined,
          ),
        );
        break;
    }
    if (b.enclosingFile === getSourceFileOfNode(e.name)) {
      const declaration = e.name.parent!;
      b.context.setCommentRange(newProp, declaration.pos, declaration.end);
    }
    newElements.push(newProp);
    if (cleanup !== undefined) cleanup();
  }
  b.flags = savedFlags;
  const result = b.created(new TypeLiteralNode(b.list(newElements)));
  if ((b.flags & NodeBuilderFlags.MultilineObjectLiterals) === 0) b.context.addEmitFlags(result, EmitFlags.SingleLine);
  return result;
}

function reuseTypeParameters(b: NodeBuilder, typeParameters: Node[]) {
  if (typeParameters.length === 0) return undefined;
  const res: Node[] = [];
  for (const tp of typeParameters) {
    const reused = reuseNode(b, tp);
    if (reused !== undefined) res.push(reused);
  }
  return b.list(res);
}

function pseudoParametersToNodes(b: NodeBuilder, params: PseudoParameter[]): Node[] {
  const res: Node[] = [];
  for (const p of params) res.push(pseudoParameterToNode(b, p));
  return res;
}

function pseudoParameterToNode(b: NodeBuilder, p: PseudoParameter): Node {
  const original = p.name.parent!;
  const parameter = b.created(
    new ParameterDeclaration(
      undefined,
      p.rest ? b.token(SyntaxKind.DotDotDotToken) : undefined,
      // Parameter names are always written from scratch.
      b.parameterToParameterDeclarationName(getSymbol(original)!, original),
      p.optional ? b.token(SyntaxKind.QuestionToken) : undefined,
      pseudoTypeToNode(b, p.type),
      undefined,
    ),
  );
  if (original.kind === SyntaxKind.Parameter) b.setCommentRange(parameter, original);
  return parameter;
}

function reuseNode(b: NodeBuilder, node: Node): Node | undefined {
  return tryReuseExistingNode(b, node);
}

function reuseName(b: NodeBuilder, node: Node, isMethod: boolean): Node {
  const res = reuseNode(b, node);
  if (res === undefined) return node;
  const text = tryGetTextOfPropertyName(res);
  if (text === undefined) return res;
  const kind = classifyPropertyName(text, res.kind === SyntaxKind.StringLiteral, isMethod);
  if (res.kind === SyntaxKind.Identifier && kind === PropertyNameKind.Identifier) return res;
  if (res.kind === SyntaxKind.StringLiteral && kind === PropertyNameKind.StringLiteral) return res;
  let renamed: Node;
  if (kind === PropertyNameKind.Identifier) renamed = b.identifier(text);
  else if (kind === PropertyNameKind.StringLiteral) renamed = b.created(new StringLiteral(text, TokenFlags.None));
  else return res;
  b.context.setOriginal(renamed, res);
  return b.setTextRange(renamed, res);
}

/** A copy of an annotation; when its names can't be written here, the type it denotes. */
function reuseTypeNode(b: NodeBuilder, node: Node): Node | undefined {
  const r = reuseNode(b, node);
  if (r !== undefined) return r;
  b.tracker.reportInferenceFallback(node);
  const t = b.getTypeFromTypeNode(node, false);
  return b.typeToTypeNode(t);
}

/**
 * Whether a pseudo-type denotes `type_`. Reports the parts that need inference when
 * `reportErrors`; an error type matches anything.
 */
export function pseudoTypeEquivalentToType(
  b: NodeBuilder,
  t: PseudoType,
  type_: Type | undefined,
  isOptionalAnnotated: boolean,
  reportErrors: boolean,
): boolean {
  const c = b.c;
  if (type_ !== undefined && isErrorType(c, type_)) return true;
  const typeFromPseudo = pseudoTypeToType(b, t);
  if (typeFromPseudo === type_) return true;
  let undefinedStripped = type_;
  if (isOptionalAnnotated && type_ !== undefined) undefinedStripped = getTypeWithFacts(c, type_, TypeFacts.NEUndefined);
  if (typeFromPseudo !== undefined && type_ !== undefined) {
    if (isOptionalAnnotated) {
      if (undefinedStripped === typeFromPseudo) return true;
      if (
        (typeFromPseudo.flags & TypeFlags.Union) !== 0 &&
        (undefinedStripped!.flags & TypeFlags.Union) !== 0 &&
        compareTypesIdentical(c, typeFromPseudo, undefinedStripped!) === Ternary.True
      )
        return true;
    }
    // Freshness differs, such as `true` in `as const`.
    if (getRegularTypeOfLiteralType(c, typeFromPseudo) === getRegularTypeOfLiteralType(c, type_)) return true;
    if (
      (typeFromPseudo.flags & TypeFlags.Union) !== 0 &&
      (type_.flags & TypeFlags.Union) !== 0 &&
      compareTypesIdentical(c, typeFromPseudo, type_) === Ternary.True
    )
      return true;
  }
  switch (t.kind) {
    case PseudoTypeKind.Inferred: {
      const inferred = t as InferredType;
      if (reportErrors) {
        if (inferred.errorNodes.length > 0) for (const n of inferred.errorNodes) b.tracker.reportInferenceFallback(n);
        else b.tracker.reportInferenceFallback(inferred.expression);
      }
      return false;
    }
    case PseudoTypeKind.ObjectLiteral: {
      if (undefinedStripped === undefined) return false;
      const pt = t as ObjectLiteralType;
      const targetProps = getPropertiesOfType(c, undefinedStripped);
      // Accessor pairs are two members but one property.
      let targetDeclCount = 0;
      for (const prop of targetProps) targetDeclCount += declarationCount(prop);
      if (pt.members.length !== targetDeclCount) return false;
      for (const e of pt.members) {
        let targetProp: Symbol | undefined = undefined;
        const elemSymbol = getSymbol(e.name.parent!);
        if (elemSymbol !== undefined) targetProp = getPropertyOfType(c, undefinedStripped, elemSymbol.name);
        if (targetProp === undefined) {
          for (const prop of targetProps) {
            const vd = prop.valueDeclaration;
            if (vd !== undefined && getName(vd) === e.name) {
              targetProp = prop;
              break;
            }
          }
          if (targetProp === undefined) {
            if (reportErrors) b.tracker.reportInferenceFallback(e.name.parent!);
            return false;
          }
        }
        const targetIsOptional = (targetProp.flags & SymbolFlags.Optional) !== 0;
        if (e.optional !== targetIsOptional) {
          if (reportErrors) b.tracker.reportInferenceFallback(e.name.parent!);
          return false;
        }
        const propType = removeMissingType(c, getTypeOfSymbol(c, targetProp), targetIsOptional);
        switch (e.kind) {
          case PseudoMemberKind.Property:
            if (!pseudoTypeEquivalentToType(b, e.type, propType, e.optional, false)) {
              if (reportErrors) {
                if (e.type instanceof InferredType && e.type.errorNodes.length > 0)
                  for (const n of e.type.errorNodes) b.tracker.reportInferenceFallback(n);
                else if (!isStructuralPseudoType(e.type)) b.tracker.reportInferenceFallback(e.name.parent!);
              }
              return false;
            }
            break;
          case PseudoMemberKind.Method: {
            const targetSig = getSingleCallSignature(c, propType);
            if (targetSig === undefined) continue;
            if (!pseudoParametersEquivalentToParameters(b, e.parameters, targetSig, reportErrors, e.name.parent!))
              return false;
            const targetPredicate = getTypePredicateOfSignature(c, targetSig);
            if (targetPredicate !== undefined) {
              if (!pseudoReturnTypeMatchesPredicate(b, e.type, targetPredicate)) {
                if (reportErrors) b.tracker.reportInferenceFallback(e.name.parent!);
                return false;
              }
            } else if (!pseudoTypeEquivalentToType(b, e.type, getReturnTypeOfSignature(c, targetSig), false, false)) {
              if (reportErrors) b.tracker.reportInferenceFallback(e.name.parent!);
              return false;
            }
            break;
          }
          case PseudoMemberKind.GetAccessor:
            if (!pseudoTypeEquivalentToType(b, e.type, propType, false, false)) {
              if (reportErrors) b.tracker.reportInferenceFallback(e.name.parent!);
              return false;
            }
            break;
          case PseudoMemberKind.SetAccessor: {
            const writeType = getWriteTypeOfSymbol(c, targetProp);
            const parameterType = e.parameters.length > 0 ? e.parameters[0].type : undefined;
            if (parameterType === undefined || !pseudoTypeEquivalentToType(b, parameterType, writeType, false, false)) {
              if (reportErrors) b.tracker.reportInferenceFallback(e.name.parent!);
              return false;
            }
            break;
          }
        }
      }
      return true;
    }
    case PseudoTypeKind.Tuple: {
      if (undefinedStripped === undefined || !isTupleType(undefinedStripped)) return false;
      const pt = t as PseudoTupleType;
      const tupleTarget = (undefinedStripped as TypeReference).target as TupleType;
      // `as const` arrays have only required elements.
      if ((tupleTarget.combinedFlags & ElementFlags.NonRequired) !== 0) return false;
      const elementTypes = getTypeArguments(c, undefinedStripped as TypeReference);
      if (pt.elements.length !== elementTypes.length) return false;
      for (let i = 0; i < pt.elements.length; i++)
        if (!pseudoTypeEquivalentToType(b, pt.elements[i]!, elementTypes[i]!, false, reportErrors)) return false;
      return true;
    }
    case PseudoTypeKind.SingleCallSignature: {
      if (undefinedStripped === undefined) return false;
      const targetSig = getSingleCallSignature(c, undefinedStripped);
      if (targetSig === undefined) return false;
      const pt = t as SignatureType;
      const targetTypeParameters = targetSig.typeParameters;
      if ((targetTypeParameters === undefined ? 0 : targetTypeParameters.length) !== pt.typeParameters.length) {
        if (reportErrors) b.tracker.reportInferenceFallback(pt.signature);
        return false;
      }
      if (!pseudoParametersEquivalentToParameters(b, pt.parameters, targetSig, reportErrors, pt.signature))
        return false;
      const targetPredicate = getTypePredicateOfSignature(c, targetSig);
      if (targetPredicate !== undefined) {
        if (!pseudoReturnTypeMatchesPredicate(b, pt.returnType, targetPredicate)) {
          if (reportErrors) b.tracker.reportInferenceFallback(pt.signature);
          return false;
        }
      } else if (
        !pseudoTypeEquivalentToType(b, pt.returnType, getReturnTypeOfSignature(c, targetSig), false, reportErrors)
      )
        return false;
      return true;
    }
    case PseudoTypeKind.NoResult:
      if (reportErrors) b.tracker.reportInferenceFallback((t as NoResultType).declaration);
      return false;
  }
  return false;
}

function pseudoParametersEquivalentToParameters(
  b: NodeBuilder,
  paramsIn: PseudoParameter[],
  targetSig: Signature,
  reportErrors: boolean,
  nonParamErrorLocation: Node,
): boolean {
  const c = b.c;
  let params = paramsIn;
  const thisParameter = targetSig.thisParameter;
  if (thisParameter !== undefined && params.length === 0) {
    if (reportErrors) b.tracker.reportInferenceFallback(nonParamErrorLocation);
    return false;
  } else if (thisParameter !== undefined && isThisIdentifier(params[0].name)) {
    const paramType = getTypeOfParameter(c, thisParameter);
    if (!pseudoTypeEquivalentToType(b, params[0].type, paramType, params[0].optional, false)) {
      if (reportErrors) b.tracker.reportInferenceFallback(params[0].name.parent!);
      return false;
    }
    params = params.slice(1);
  } else if (thisParameter !== undefined) {
    if (reportErrors) b.tracker.reportInferenceFallback(nonParamErrorLocation);
    return false;
  }
  if (targetSig.parameters.length !== params.length) {
    if (reportErrors) b.tracker.reportInferenceFallback(nonParamErrorLocation);
    return false;
  }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const targetParam = targetSig.parameters[i]!;
    const vd = targetParam.valueDeclaration;
    if (p.optional !== (vd !== undefined && isOptionalParameter(c, vd))) {
      if (reportErrors) b.tracker.reportInferenceFallback(p.name.parent!);
      return false;
    }
    const paramType = getTypeOfParameter(c, targetParam);
    if (!pseudoTypeEquivalentToType(b, p.type, paramType, p.optional, false)) {
      if (reportErrors) b.tracker.reportInferenceFallback(p.name.parent!);
      return false;
    }
  }
  return true;
}

function isThisIdentifier(node: Node): boolean {
  return node instanceof Identifier && getText(node) === 'this';
}

function isStructuralPseudoType(t: PseudoType): boolean {
  switch (t.kind) {
    case PseudoTypeKind.ObjectLiteral:
    case PseudoTypeKind.Tuple:
    case PseudoTypeKind.SingleCallSignature:
      return true;
    case PseudoTypeKind.MaybeConstLocation: {
      const d = t as MaybeConstType;
      return isStructuralPseudoType(d.constType) || isStructuralPseudoType(d.regularType);
    }
  }
  return false;
}

/** Whether a pseudo return type is a type predicate annotation matching `predicate`. */
export function pseudoReturnTypeMatchesPredicate(b: NodeBuilder, rt: PseudoType, predicate: TypePredicate): boolean {
  if (!(rt instanceof DirectType)) return false;
  const node = rt.typeNode;
  if (!(node instanceof TypePredicateNode)) return false;
  const isAsserts = node.assertsModifier !== undefined;
  const predicateIsAsserts =
    predicate.kind === TypePredicateKind.AssertsThis || predicate.kind === TypePredicateKind.AssertsIdentifier;
  if (isAsserts !== predicateIsAsserts) return false;
  const isThis = node.parameterName.kind === SyntaxKind.ThisType;
  const predicateIsThis = predicate.kind === TypePredicateKind.This || predicate.kind === TypePredicateKind.AssertsThis;
  if (isThis !== predicateIsThis) return false;
  if (!isThis && getText(node.parameterName) !== predicate.parameterName) return false;
  if (predicate.type !== undefined) {
    if (node.type === undefined) return false;
    const fromNode = getTypeFromTypeNode(b.c, node.type);
    if (fromNode !== predicate.type && compareTypesIdentical(b.c, fromNode, predicate.type) !== Ternary.True)
      return false;
  } else if (node.type !== undefined) return false;
  return true;
}

/** The type a pseudo-type denotes, for the kinds that map to one directly. */
export function pseudoTypeToType(b: NodeBuilder, t: PseudoType): Type | undefined {
  const c = b.c;
  switch (t.kind) {
    case PseudoTypeKind.Direct:
      return getTypeFromTypeNode(c, (t as DirectType).typeNode);
    case PseudoTypeKind.Inferred: {
      const inferred = t as InferredType;
      if (inferred.isSignatureReturn)
        return getReturnTypeOfSignature(c, getSignatureFromDeclaration(c, inferred.expression));
      return getWidenedType(c, getRegularTypeOfExpression(c, inferred.expression));
    }
    case PseudoTypeKind.NoResult:
      return undefined;
    case PseudoTypeKind.MaybeConstLocation: {
      const d = t as MaybeConstType;
      return pseudoTypeToType(b, isConstContext(c, d.node) ? d.constType : d.regularType);
    }
    case PseudoTypeKind.Union: {
      const res: Type[] = [];
      let hasElidedType = false;
      for (const m of (t as PseudoUnionType).types) {
        if (!c.strictNullChecks && (m.kind === PseudoTypeKind.Undefined || m.kind === PseudoTypeKind.Null)) {
          hasElidedType = true;
          continue;
        }
        const mt = pseudoTypeToType(b, m);
        if (mt === undefined) return undefined;
        res.push(mt);
      }
      if (res.length === 1) return res[0]!;
      if (res.length === 0) return hasElidedType ? c.anyType : c.neverType;
      return getUnionType(c, res);
    }
    case PseudoTypeKind.Undefined:
      return c.undefinedWideningType;
    case PseudoTypeKind.Null:
      return c.nullWideningType;
    case PseudoTypeKind.Any:
      return c.anyType;
    case PseudoTypeKind.String:
      return c.stringType;
    case PseudoTypeKind.Number:
      return c.numberType;
    case PseudoTypeKind.BigInt:
      return c.bigintType;
    case PseudoTypeKind.Boolean:
      return c.booleanType;
    case PseudoTypeKind.False:
      return c.falseType;
    case PseudoTypeKind.True:
      return c.trueType;
    case PseudoTypeKind.StringLiteral:
    case PseudoTypeKind.NumericLiteral:
    case PseudoTypeKind.BigIntLiteral:
      return getRegularTypeOfExpression(c, (t as LiteralType).node);
  }
  return undefined;
}

/**
 * Whether the type written for a parameter or property needs `| undefined`: a parameter
 * initialized before a required one, or an optional property of a reverse mapped type.
 */
export function requiresAddingImplicitUndefinedForDeclaration(
  c: Checker,
  declaration: Node,
  symbolIn: Symbol | undefined,
  enclosingDeclaration: Node | undefined,
): boolean {
  if ((declaration.flags & NodeFlags.Synthesized) !== 0) return false;
  switch (declaration.kind) {
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.JSDocPropertyTag: {
      const symbol = symbolIn ?? getSymbolOfDeclaration(c, declaration);
      if (symbol === undefined) return false;
      const t = getTypeOfSymbol(c, symbol);
      return (
        (symbol.flags & SymbolFlags.Property) !== 0 &&
        (symbol.flags & SymbolFlags.Optional) !== 0 &&
        hasQuestionToken(declaration) &&
        (symbol.checkFlags & CheckFlags.ReverseMapped) !== 0 &&
        c.symbolLinks(symbol).reverseMappedMappedType !== undefined &&
        containsNonMissingUndefinedType(c, t)
      );
    }
    case SyntaxKind.Parameter:
      return requiresAddingImplicitUndefined(c, declaration, enclosingDeclaration);
  }
  return false;
}

/** Declarations whose type the builder writes from the declaration, as tsgo's `HasInferredType`. */
export function hasInferredTypeKind(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.BindingElement:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      return true;
  }
  return false;
}

export function isAccessorKind(node: Node): boolean {
  return node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor;
}

/** Whether a declaration is marked optional with `?`, as tsgo's `HasQuestionToken`. */
export function hasQuestionToken(node: Node): boolean {
  const token = getQuestionToken(node) ?? getPostfixToken(node);
  return token !== undefined && token.kind === SyntaxKind.QuestionToken;
}
