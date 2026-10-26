// Reusing type nodes from source in built nodes: a copy of an existing type node with its names
// checked to be accessible, or undefined if they aren't and it can't be rewritten.
import {
  ArrayTypeNode,
  CallSignatureDeclaration,
  ConstructSignatureDeclaration,
  ConstructorTypeNode,
  FunctionTypeNode,
  IndexSignatureDeclaration,
  MethodSignatureDeclaration,
  ParameterDeclaration,
  PropertyDeclaration,
  ComputedPropertyName,
  ConditionalTypeNode,
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  JSDocParameterOrPropertyTag,
  JSDocTypeExpression,
  JSDocTypeLiteral,
  JSDocVariadicType,
  PropertySignatureDeclaration,
  QualifiedName,
  TypeLiteralNode,
  UnionTypeNode,
  Identifier,
  ImportAttributes,
  ImportTypeNode,
  Token,
  IndexedAccessTypeNode,
  LiteralTypeNode,
  MappedTypeNode,
  type Node,
  NodeList,
  PropertyAccessExpression,
  SourceFile,
  StringLiteral,
  TypeOperatorNode,
  TypeParameterDeclaration,
  TypePredicateNode,
  TypeQueryNode,
  TypeReferenceNode,
  getName,
  getText,
  getType,
  getInitializer,
} from './ast.js';
import { isFunctionLike, isInJSFile, isStringLiteralLike } from './ast-utilities.js';
import {
  getSourceFileOfNode,
  getThisContainer,
  hasDynamicName,
  isExportsIdentifier,
  isIdentifierNamed,
  isModuleExportsAccessExpression,
  isPartOfParameterDeclaration,
} from './binder-utilities.js';
import {
  getDeclaredTypeOfSymbol,
  getDeclaredTypeOfTypeParameter,
  getInferTypeParameters,
} from './checker-declared-types.js';
import { getSignatureFromDeclaration } from './checker-signatures.js';
import {
  getExportSymbolOfValueSymbolIfExported,
  getFirstIdentifier,
  getSymbolOfDeclaration,
  resolveEntityName,
} from './checker-symbols.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { hasLateBindableName } from './checker-utilities.js';
import { EmitFlags } from './printer/emit-flags.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { SymbolAccessibility, SymbolTracker } from './transformers/declarations-resolver.js';
import { getMeaningOfEntityNameReference } from './transformers/declarations-syntactic.js';
import { VisitorBase } from './transformers/visitor-base.js';
import { TokenFlags } from './types.js';
import { getSymbolIfSameReference, isSymbolAccessible } from './symbol-accessibility.js';
import { NodeBuilderFlags } from './transformers/declarations-resolver.js';
import { BuilderTracker, type NodeBuilder, TrackedSymbol, canReuseExistingJSTypeNode } from './node-builder.js';
import { getSpecifierForModuleSymbol, lookupSymbolChain, symbolToTypeNode } from './node-builder-names.js';
import { getExternalModuleFileFromDeclaration } from './checker-modules.js';
import { getResolutionModeOverride } from './program-utilities.js';
import { getMappedType } from './checker-types.js';

/** Errors and names tracked while reusing a node, replayed only if the reuse succeeds. */
class RecoveryBoundary {
  hadError = false;
  readonly deferredReports: (() => boolean)[] = [];
  readonly trackedSymbols: TrackedSymbol[] = [];

  markError(report: (() => boolean) | undefined): void {
    this.hadError = true;
    if (report !== undefined) this.deferredReports.push(report);
  }
}

/** Records what the reuse reports in its boundary rather than reporting it. */
class RecoveryTracker extends SymbolTracker {
  readonly inner: SymbolTracker;
  readonly bound: RecoveryBoundary;

  constructor(inner: SymbolTracker, bound: RecoveryBoundary) {
    super();
    this.inner = inner;
    this.bound = bound;
  }

  trackSymbol(symbol: Symbol, enclosingDeclaration: Node, meaning: SymbolFlags): boolean {
    this.bound.trackedSymbols.push(new TrackedSymbol(symbol, enclosingDeclaration, meaning));
    return false;
  }

  reportInferenceFallback(node: Node): boolean {
    return this.inner.reportInferenceFallback(node);
  }

  reportCyclicStructureError(): boolean {
    const inner = this.inner;
    this.bound.markError(() => inner.reportCyclicStructureError());
    return false;
  }

  reportInaccessibleThisError(): boolean {
    const inner = this.inner;
    this.bound.markError(() => inner.reportInaccessibleThisError());
    return false;
  }

  reportInaccessibleUniqueSymbolError(): boolean {
    const inner = this.inner;
    this.bound.markError(() => inner.reportInaccessibleUniqueSymbolError());
    return false;
  }

  reportLikelyUnsafeImportRequiredError(specifier: string, symbolName: string): boolean {
    const inner = this.inner;
    this.bound.markError(() => inner.reportLikelyUnsafeImportRequiredError(specifier, symbolName));
    return false;
  }

  reportNonSerializableProperty(propertyName: string): boolean {
    const inner = this.inner;
    this.bound.markError(() => inner.reportNonSerializableProperty(propertyName));
    return false;
  }

  reportPrivateInBaseOfClassExpression(propertyName: string): boolean {
    const inner = this.inner;
    this.bound.markError(() => inner.reportPrivateInBaseOfClassExpression(propertyName));
    return false;
  }

  reportTruncationError(): boolean {
    return this.inner.reportTruncationError();
  }

  reportNonlocalAugmentation(containingFile: SourceFile, parentSymbol: Symbol, augmentingSymbol: Symbol): boolean {
    return this.inner.reportNonlocalAugmentation(containingFile, parentSymbol, augmentingSymbol);
  }

  pushErrorFallbackNode(node: Node): boolean {
    return this.inner.pushErrorFallbackNode(node);
  }

  popErrorFallbackNode(): boolean {
    return this.inner.popErrorFallbackNode();
  }
}

/** A copy of the existing type node `existing` for the builder's location, or undefined if it can't be reused. */
export function tryReuseExistingNode(b: NodeBuilder, existing: Node): Node | undefined {
  const bound = new RecoveryBoundary();
  const oldTracker = b.tracker;
  const oldTrackedSymbols = b.trackedSymbols;
  const oldEncounteredError = b.encounteredError;
  const oldApproximateLength = b.approximateLength;
  b.tracker = new BuilderTracker(b.reports, new RecoveryTracker(oldTracker, bound));
  b.trackedSymbols = [];
  const transformed = new ExistingNodeReuser(b, bound).visitNode(existing);
  b.tracker = oldTracker;
  b.trackedSymbols = oldTrackedSymbols;
  b.encounteredError = oldEncounteredError;
  b.approximateLength = oldApproximateLength;
  for (const report of bound.deferredReports) report();
  if (bound.hadError) return undefined;
  for (const tracked of bound.trackedSymbols)
    b.trackSymbol(tracked.symbol, tracked.enclosingDeclaration, tracked.meaning);
  b.approximateLength += existing.end - existing.pos;
  return transformed;
}

/** The result of naming an existing entity name at the builder's location. */
class TrackedName {
  readonly introducesError: boolean;
  readonly node: Node;

  constructor(introducesError: boolean, node: Node) {
    this.introducesError = introducesError;
    this.node = node;
  }
}

/** Copies an existing node tree, checking and tracking the names it uses. */
class ExistingNodeReuser extends VisitorBase {
  readonly b: NodeBuilder;
  readonly bound: RecoveryBoundary;

  constructor(b: NodeBuilder, bound: RecoveryBoundary) {
    super(b.context);
    this.b = b;
    this.bound = bound;
  }

  // Lists from other files lose their positions.
  visitNodes(list: NodeList | undefined): NodeList | undefined {
    if (list === undefined) return undefined;
    const nodes = this.visitArray(list.nodes);
    const result = new NodeList(-1, -1, nodes === list.nodes ? nodes.slice() : nodes);
    return result;
  }

  visit(node: Node): Node | undefined {
    const b = this.b;
    const bound = this.bound;
    // After an error in a sibling the result is discarded anyway.
    if (bound.hadError) return node;
    const trackedTop = b.trackedSymbols.length;
    const reportsTop = bound.deferredReports.length;
    const hadError = bound.hadError;
    let exit: (() => void) | undefined = undefined;
    if (isFunctionLike(node)) {
      const signature = getSignatureFromDeclaration(b.c, node);
      exit = b.enterNewScope(node, signature.parameters, signature.typeParameters, undefined, undefined);
    } else if (node instanceof MappedTypeNode) {
      const symbol = getSymbolOfDeclaration(b.c, node.typeParameter)!;
      exit = b.enterNewScope(node, undefined, [getDeclaredTypeOfTypeParameter(b.c, symbol)], undefined, undefined);
    }
    let result = this.visitWorker(node);
    if (exit !== undefined) exit();
    // As tsgo, an unchanged subtree is copied without positions; the root gets them back below.
    if (result === node && result !== undefined) result = node.pos < 0 ? node.deepClone() : b.deepCloneNode(node);
    if (result !== undefined) result = b.setTextRange(result, node);
    if (bound.hadError) {
      if (isTypeNode(node) && node.kind !== SyntaxKind.TypePredicate) {
        bound.hadError = hadError;
        b.trackedSymbols.length = trackedTop;
        bound.deferredReports.length = reportsTop;
        // As tsgo: the type of the node, without checking it matches the expected type here.
        return b.typeToTypeNode(b.getTypeFromTypeNode(node, false));
      }
      return b.setTextRange(node, node);
    }
    return result;
  }

  /** JSDoc type syntax as TypeScript types, or undefined for other nodes. */
  private visitJSDocType(node: Node): Node | undefined {
    const b = this.b;
    if (node instanceof JSDocTypeExpression) return this.visitNode(node.type);
    if (node.kind === SyntaxKind.JSDocAllType) return b.keyword(SyntaxKind.AnyKeyword);
    if (node instanceof JSDocNullableType)
      return b.created(
        new UnionTypeNode(
          b.list([
            this.visitNode(node.type)!,
            b.created(new LiteralTypeNode(b.factory.createKeywordExpression(SyntaxKind.NullKeyword))),
          ]),
        ),
      );
    if (node instanceof JSDocOptionalType)
      return b.created(new UnionTypeNode(b.list([this.visitNode(node.type)!, b.keyword(SyntaxKind.UndefinedKeyword)])));
    if (node instanceof JSDocNonNullableType) return this.visitNode(node.type);
    if (node instanceof JSDocVariadicType) return b.created(new ArrayTypeNode(this.visitNode(node.type)!));
    if (node instanceof JSDocTypeLiteral) {
      const members: Node[] = [];
      for (const t of node.jsdocPropertyTags ?? []) {
        if (!(t instanceof JSDocParameterOrPropertyTag)) continue;
        if (t.kind !== SyntaxKind.JSDocPropertyTag && t.kind !== SyntaxKind.JSDocParameterTag) continue;
        const n = t.name;
        const targetName = n instanceof QualifiedName ? n.right : n;
        const name = this.visitNode(targetName)!;
        const optional =
          t.isBracketed || (t.typeExpression !== undefined && t.typeExpression.kind === SyntaxKind.JSDocOptionalType);
        const type = t.typeExpression === undefined ? undefined : this.visitNode(t.typeExpression);
        members.push(
          b.created(
            new PropertySignatureDeclaration(
              undefined,
              name,
              optional ? b.token(SyntaxKind.QuestionToken) : undefined,
              type,
              undefined,
            ),
          ),
        );
      }
      return b.created(new TypeLiteralNode(b.list(members)));
    }
    return undefined;
  }

  private attachSymbolToLeftmostIdentifier(leftmost: Node, node: Node, symbol: Symbol | undefined): Node {
    if (node === leftmost) {
      let name: Node | undefined = undefined;
      if (symbol !== undefined && (symbol.flags & SymbolFlags.TypeParameter) !== 0)
        name = this.b.typeParameterToName(getDeclaredTypeOfSymbol(this.b.c, symbol));
      if (name === undefined) name = this.b.identifier(getText(node));
      name = this.b.setTextRange(name, node);
      this.context.addEmitFlags(name, EmitFlags.NoAsciiEscaping);
      return name;
    }
    const copy = new LeftmostRenamer(this, leftmost, symbol).visitEachChild(node);
    return this.b.setTextRange(copy, node);
  }

  renameLeftmost(leftmost: Node, node: Node, symbol: Symbol | undefined): Node {
    return this.attachSymbolToLeftmostIdentifier(leftmost, node, symbol);
  }

  private trackExistingEntityName(node: Node): TrackedName {
    const b = this.b;
    const c = b.c;
    const enclosingDeclaration = b.enclosingDeclaration;
    const leftmost = getFirstIdentifier(node);
    const leftmostParent = leftmost.parent;
    if (
      isInJSFile(node) &&
      (isExportsIdentifier(leftmost) ||
        (leftmostParent !== undefined && isModuleExportsAccessExpression(leftmostParent)) ||
        (leftmostParent instanceof QualifiedName &&
          isIdentifierNamed(leftmostParent.left, 'module') &&
          isExportsIdentifier(leftmostParent.right)))
    )
      return new TrackedName(true, b.setTextRange(b.deepCloneNode(node), node));
    const meaning = getMeaningOfEntityNameReference(node);
    if (leftmost.kind === SyntaxKind.ThisKeyword || getText(leftmost) === 'this') {
      // `this` isn't bound: find its symbol directly.
      const container = getThisContainer(leftmost, false, false);
      const sym = container === undefined ? undefined : getSymbolOfDeclaration(c, container);
      let introducesError = false;
      if (isSymbolAccessible(c, sym, leftmost, meaning, false).accessibility !== SymbolAccessibility.Accessible) {
        introducesError = true;
        b.tracker.reportInaccessibleThisError();
      }
      return new TrackedName(introducesError, this.attachSymbolToLeftmostIdentifier(leftmost, node, sym));
    }
    let sym = resolveEntityName(c, leftmost, meaning, true, true, undefined);
    if (enclosingDeclaration !== undefined && !(sym !== undefined && (sym.flags & SymbolFlags.TypeParameter) !== 0)) {
      if (sym !== undefined) sym = getExportSymbolOfValueSymbolIfExported(c, sym);
      // A transplanted declaration's names must mean the same at both locations.
      const symAtLocation = resolveEntityName(c, leftmost, meaning, true, true, enclosingDeclaration);
      if (
        symAtLocation === c.unknownSymbol ||
        (symAtLocation === undefined && sym !== undefined) ||
        (symAtLocation !== undefined &&
          sym !== undefined &&
          getSymbolIfSameReference(c, getExportSymbolOfValueSymbolIfExported(c, symAtLocation), sym) === undefined)
      ) {
        if (symAtLocation !== c.unknownSymbol) b.tracker.reportInferenceFallback(node);
        return new TrackedName(true, b.setTextRange(b.deepCloneNode(node), node));
      }
      sym = symAtLocation;
    }
    if (sym !== undefined) {
      // A parameter resolvable here is visible.
      if (
        (sym.flags & SymbolFlags.FunctionScopedVariable) !== 0 &&
        sym.valueDeclaration !== undefined &&
        (isPartOfParameterDeclaration(sym.valueDeclaration) ||
          sym.valueDeclaration.kind === SyntaxKind.JSDocParameterTag)
      )
        return new TrackedName(false, this.attachSymbolToLeftmostIdentifier(leftmost, node, sym));
      let introducesError = false;
      if (
        (sym.flags & SymbolFlags.TypeParameter) === 0 &&
        !isDeclarationName(node) &&
        isSymbolAccessible(c, sym, enclosingDeclaration, meaning, false).accessibility !==
          SymbolAccessibility.Accessible
      ) {
        b.tracker.reportInferenceFallback(node);
        introducesError = true;
      } else b.trackSymbol(sym, enclosingDeclaration, meaning);
      return new TrackedName(introducesError, this.attachSymbolToLeftmostIdentifier(leftmost, node, sym));
    }
    return new TrackedName(false, b.setTextRange(b.deepCloneNode(node), node));
  }

  /** A reference to the type `node` names, written from its symbol. */
  private serializeTypeName(node: Node, isTypeOf: boolean, typeArguments: NodeList | undefined): Node | undefined {
    const b = this.b;
    const meaning = isTypeOf ? SymbolFlags.Value : SymbolFlags.Type;
    const symbol = resolveEntityName(b.c, node, meaning, true, false, node);
    if (symbol === undefined) return undefined;
    if (
      isSymbolAccessible(b.c, symbol, b.enclosingDeclaration, meaning, false).accessibility !==
      SymbolAccessibility.Accessible
    )
      return undefined;
    return symbolToTypeNode(b, symbol, meaning, typeArguments);
  }

  private tryVisitIndexedAccess(node: IndexedAccessTypeNode): Node | undefined {
    const objectType = this.tryVisitSimpleTypeNode(node.objectType);
    if (objectType === undefined) return undefined;
    return this.b.setTextRange(
      this.factory.updateIndexedAccessTypeNode(node, objectType, this.visitNode(node.indexType)!),
      node,
    );
  }

  private tryVisitKeyOf(node: TypeOperatorNode): Node | undefined {
    const t = this.tryVisitSimpleTypeNode(node.type);
    if (t === undefined) return undefined;
    return this.b.setTextRange(this.factory.updateTypeOperatorNode(node, node.operator, t), node);
  }

  private tryVisitTypeQuery(node: TypeQueryNode): Node | undefined {
    const name = this.trackExistingEntityName(node.exprName);
    if (!name.introducesError)
      return this.b.setTextRange(
        this.factory.updateTypeQueryNode(node, name.node, this.visitNodes(node.typeArguments)),
        node,
      );
    const serialized = this.serializeTypeName(node.exprName, true, this.visitNodes(node.typeArguments));
    return serialized === undefined ? undefined : this.b.setTextRange(serialized, node.exprName);
  }

  private tryVisitTypeReference(node: TypeReferenceNode): Node | undefined {
    const b = this.b;
    if (isConstTypeReference(node)) return undefined;
    getTypeFromTypeNode(b.c, node);
    const symbol = b.c.resolvedSymbols.get(node.id);
    if (symbol === undefined) return undefined;
    if ((symbol.flags & SymbolFlags.TypeParameter) !== 0) {
      const declaredType = getDeclaredTypeOfSymbol(b.c, symbol);
      // A type parameter remapped by the scope.
      if (b.mapper !== undefined && getMappedType(declaredType, b.mapper) !== declaredType) return undefined;
    }
    if (!canReuseExistingJSTypeNode(b, node, b.getTypeFromTypeNode(node, false)!)) return undefined;
    const name = this.trackExistingEntityName(node.typeName);
    if (!name.introducesError)
      return b.setTextRange(
        this.factory.updateTypeReferenceNode(node, name.node, this.visitNodes(node.typeArguments)),
        node,
      );
    const serialized = this.serializeTypeName(node.typeName, false, this.visitNodes(node.typeArguments));
    return serialized === undefined ? undefined : b.setTextRange(serialized, node.typeName);
  }

  private tryVisitSimpleTypeNode(node: Node): Node | undefined {
    // As tsgo, parenthesized types are kept.
    const inner = node;
    if (inner instanceof TypeReferenceNode) return this.tryVisitTypeReference(inner);
    if (inner instanceof TypeQueryNode) return this.tryVisitTypeQuery(inner);
    if (inner instanceof IndexedAccessTypeNode) return this.tryVisitIndexedAccess(inner);
    if (inner instanceof TypeOperatorNode && inner.operator === SyntaxKind.KeyOfKeyword)
      return this.tryVisitKeyOf(inner);
    return this.visitNode(node);
  }

  private visitWorker(node: Node): Node | undefined {
    const b = this.b;
    const factory = this.factory;
    const bound = this.bound;
    const jsdoc = this.visitJSDocType(node);
    if (jsdoc !== undefined) return jsdoc;
    if (node instanceof TypeReferenceNode && node.typeName instanceof Identifier && node.typeName.text === '') {
      const replacement = b.keyword(SyntaxKind.AnyKeyword);
      this.context.setOriginal(replacement, node);
      return replacement;
    }
    // `this` types are copied as they are.
    if (node.kind === SyntaxKind.ThisType) return node;
    if (node instanceof TypeParameterDeclaration) {
      const name = this.trackExistingEntityName(node.name);
      return factory.updateTypeParameterDeclaration(
        node,
        this.visitModifiers(node.modifiers),
        name.node as Identifier,
        this.visitNode(node.constraint),
        this.visitNode(node.expression),
        this.visitNode(node.defaultType),
      );
    }
    if (node instanceof IndexedAccessTypeNode) {
      const result = this.tryVisitIndexedAccess(node);
      if (result !== undefined) return result;
      bound.markError(undefined);
      return node;
    }
    if (node instanceof TypeReferenceNode) {
      const result = this.tryVisitTypeReference(node);
      if (result !== undefined) return result;
      bound.markError(undefined);
      return node;
    }
    if (node instanceof TypeQueryNode) {
      const result = this.tryVisitTypeQuery(node);
      if (result !== undefined) return result;
      bound.markError(undefined);
      return node;
    }
    if (node instanceof TypeOperatorNode) {
      if (node.operator === SyntaxKind.UniqueKeyword && node.type.kind === SyntaxKind.SymbolKeyword) {
        const nonFakeEnclosing = b.getEnclosingDeclarationIgnoringFakeScope();
        let sameScope = false;
        for (let current: Node | undefined = node; current !== undefined; current = current.parent)
          if (current === nonFakeEnclosing) sameScope = true;
        if (!sameScope) {
          bound.markError(undefined);
          return node;
        }
      } else if (node.operator === SyntaxKind.KeyOfKeyword) {
        const result = this.tryVisitKeyOf(node);
        if (result !== undefined) return result;
        bound.markError(undefined);
        return node;
      }
    }
    if (node instanceof ImportTypeNode && isLiteralImportType(node)) {
      // The deprecated `assert` keyword isn't reused.
      if (node.attributes !== undefined && node.attributes.token === SyntaxKind.AssertKeyword) {
        bound.markError(undefined);
        return node;
      }
      if (b.getTypeFromTypeNode(node, true) === undefined) {
        bound.markError(undefined);
        return node;
      }
      const originalSpecifier = (node.argument as LiteralTypeNode).literal;
      const specifier = getModuleSpecifierOverride(b, node, originalSpecifier);
      let argument: Node;
      if (specifier === '') argument = this.visitNode(node.argument)!;
      else {
        const literal = factory.createStringLiteral(specifier, TokenFlags.None);
        b.context.setOriginal(literal, originalSpecifier);
        argument = factory.created(new LiteralTypeNode(literal));
      }
      return factory.updateImportTypeNode(
        node,
        node.isTypeOf,
        argument,
        node.attributes === undefined ? undefined : asImportAttributes(this.visitNode(node.attributes)),
        this.visitNode(node.qualifier),
        this.visitNodes(node.typeArguments),
      );
    }
    const name = getName(node);
    if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName && !hasLateBindableName(b.c, node)) {
      if (!hasDynamicName(node)) return this.visitEachChild(node);
      return undefined;
    }
    if (
      (isFunctionLike(node) && getType(node) === undefined) ||
      ((node.kind === SyntaxKind.PropertyDeclaration ||
        node.kind === SyntaxKind.PropertySignature ||
        node.kind === SyntaxKind.Parameter) &&
        getType(node) === undefined &&
        getInitializer(node) === undefined)
    ) {
      // Untyped declarations get `any`.
      let visited = this.visitEachChild(node);
      if (visited === node) visited = b.setTextRange(node.deepClone(), node);
      withAnyType(b, visited);
      return visited;
    }
    if (node instanceof ComputedPropertyName && isEntityNameExpressionNode(node.expression)) {
      const tracked = this.trackExistingEntityName(node.expression);
      if (!tracked.introducesError) return factory.updateComputedPropertyName(node, tracked.node);
      bound.markError(undefined);
      return this.visitEachChild(node);
    }
    if (node instanceof TypePredicateNode) {
      let parameterName: Node;
      if (node.parameterName instanceof Identifier) {
        const tracked = this.trackExistingEntityName(node.parameterName);
        if (tracked.introducesError) bound.markError(undefined);
        parameterName = tracked.node;
      } else parameterName = node.parameterName.deepClone();
      return factory.updateTypePredicateNode(
        node,
        node.assertsModifier === undefined ? undefined : asToken(this.visitNode(node.assertsModifier)),
        parameterName,
        this.visitNode(node.type),
      );
    }
    if (node instanceof ConditionalTypeNode) {
      const checkType = this.visitNode(node.checkType)!;
      const exit = b.enterNewScope(node, undefined, getInferTypeParameters(b.c, node), undefined, undefined);
      const extendsType = this.visitNode(node.extendsType)!;
      const trueType = this.visitNode(node.trueType)!;
      exit();
      const falseType = this.visitNode(node.falseType)!;
      return factory.updateConditionalTypeNode(node, checkType, extendsType, trueType, falseType);
    }
    // Tuples, type literals and mapped types are written on one line.
    if (
      node.kind === SyntaxKind.TupleType ||
      ((b.flags & NodeBuilderFlags.MultilineObjectLiterals) === 0 && node.kind === SyntaxKind.TypeLiteral) ||
      node.kind === SyntaxKind.MappedType
    ) {
      let result = this.visitEachChild(node);
      if (result === node) result = b.setTextRange(node.deepClone(), node);
      this.context.addEmitFlags(result, EmitFlags.SingleLine);
      return result;
    }
    if (isStringLiteralLike(node)) {
      // The literal's characters are kept rather than escaped.
      const copy = node.deepClone();
      if (
        copy instanceof StringLiteral &&
        (b.flags & NodeBuilderFlags.UseSingleQuotesForStringLiteralType) !== 0 &&
        (copy.tokenFlags & TokenFlags.SingleQuote) === 0
      ) {
        const literal = copy as StringLiteral;
        literal.tokenFlags = literal.tokenFlags | TokenFlags.SingleQuote;
      }
      this.context.addEmitFlags(copy, EmitFlags.NoAsciiEscaping);
      return copy;
    }
    return this.visitEachChild(node);
  }
}

/** Renames the leftmost identifier of an entity name, copying the rest. */
class LeftmostRenamer extends VisitorBase {
  readonly owner: ExistingNodeReuser;
  readonly leftmost: Node;
  readonly symbol: Symbol | undefined;

  constructor(owner: ExistingNodeReuser, leftmost: Node, symbol: Symbol | undefined) {
    super(owner.context);
    this.owner = owner;
    this.leftmost = leftmost;
    this.symbol = symbol;
  }

  visit(node: Node): Node | undefined {
    return this.owner.renameLeftmost(this.leftmost, node, this.symbol);
  }
}

/** Gives a copied declaration or signature without a type the type `any`; false for other kinds. */
function withAnyType(b: NodeBuilder, node: Node): boolean {
  const any = b.keyword(SyntaxKind.AnyKeyword);
  if (node instanceof PropertyDeclaration) {
    node.type = any;
    node.initializer = undefined;
  } else if (node instanceof PropertySignatureDeclaration) {
    node.type = any;
    node.initializer = undefined;
  } else if (node instanceof ParameterDeclaration) {
    node.modifiers = undefined;
    node.type = any;
    node.initializer = undefined;
  } else if (node instanceof MethodSignatureDeclaration) node.type = any;
  else if (node instanceof CallSignatureDeclaration) node.type = any;
  else if (node instanceof ConstructSignatureDeclaration) node.type = any;
  else if (node instanceof IndexSignatureDeclaration) node.type = any;
  else if (node instanceof FunctionTypeNode) node.type = any;
  else if (node instanceof ConstructorTypeNode) node.type = any;
  else return false;
  return true;
}

function asImportAttributes(node: Node | undefined): ImportAttributes | undefined {
  if (node === undefined) return undefined;
  if (node instanceof ImportAttributes) return node as ImportAttributes;
  return undefined;
}

function asToken(node: Node | undefined): Token | undefined {
  if (node === undefined) return undefined;
  if (node instanceof Token) return node as Token;
  return undefined;
}

function isConstTypeReference(node: TypeReferenceNode): boolean {
  return node.typeName instanceof Identifier && node.typeName.text === 'const' && node.typeArguments === undefined;
}

/**
 * The specifier an `import("…")` type copied from another file takes in the file being written,
 * or `''` to keep it.
 */
function getModuleSpecifierOverride(b: NodeBuilder, parent: ImportTypeNode, literal: Node): string {
  const c = b.c;
  if (b.enclosingFile === getSourceFileOfNode(literal)) return '';
  const mode = getResolutionModeOverride(parent.attributes);
  const originalName = getText(literal);
  let name = originalName;
  getTypeFromTypeNode(c, parent);
  const nodeSymbol = c.resolvedSymbols.get(parent.id);
  const meaning = parent.isTypeOf ? SymbolFlags.Value : SymbolFlags.Type;
  const parentSymbol =
    nodeSymbol !== undefined &&
    isSymbolAccessible(c, nodeSymbol, b.enclosingDeclaration, meaning, false).accessibility ===
      SymbolAccessibility.Accessible
      ? lookupSymbolChain(b, nodeSymbol, meaning, true)[0]
      : undefined;
  if (parentSymbol !== undefined && isExternalModuleSymbol(parentSymbol))
    name = getSpecifierForModuleSymbol(b, parentSymbol, mode).specifier;
  else {
    const targetFile = getExternalModuleFileFromDeclaration(c, parent);
    if (targetFile !== undefined && targetFile.symbol !== undefined)
      name = getSpecifierForModuleSymbol(b, targetFile.symbol, mode).specifier;
  }
  if (name.includes('/node_modules/')) {
    b.encounteredError = true;
    b.tracker.reportLikelyUnsafeImportRequiredError(name, '');
  }
  return name !== originalName ? name : '';
}

function isExternalModuleSymbol(symbol: Symbol): boolean {
  return symbol.isExternalModule();
}

function isLiteralImportType(node: ImportTypeNode): boolean {
  return node.argument instanceof LiteralTypeNode && node.argument.literal.kind === SyntaxKind.StringLiteral;
}

function isEntityNameExpressionNode(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const name = getName(node);
    return (
      name !== undefined &&
      name.kind === SyntaxKind.Identifier &&
      isEntityNameExpressionNode((node as PropertyAccessExpression).expression)
    );
  }
  return false;
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    node.kind !== SyntaxKind.SourceFile &&
    getName(parent) === node &&
    parent.kind !== SyntaxKind.TypeReference
  );
}

function isTypeNode(node: Node): boolean {
  return (
    (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode) ||
    node.kind === SyntaxKind.AnyKeyword ||
    node.kind === SyntaxKind.UnknownKeyword ||
    node.kind === SyntaxKind.NumberKeyword ||
    node.kind === SyntaxKind.BigIntKeyword ||
    node.kind === SyntaxKind.ObjectKeyword ||
    node.kind === SyntaxKind.BooleanKeyword ||
    node.kind === SyntaxKind.StringKeyword ||
    node.kind === SyntaxKind.SymbolKeyword ||
    node.kind === SyntaxKind.VoidKeyword ||
    node.kind === SyntaxKind.UndefinedKeyword ||
    node.kind === SyntaxKind.NeverKeyword ||
    node.kind === SyntaxKind.IntrinsicKeyword ||
    node.kind === SyntaxKind.ExpressionWithTypeArguments
  );
}
