// `emitDecoratorMetadata`: adds `__metadata("design:type", ...)`, `"design:paramtypes"` and
// `"design:returntype"` decorators to decorated declarations, from their type annotations.
// Runs before types are erased; the legacy decorator transform emits them.
import {
  ArrayLiteralExpression,
  BinaryExpression,
  ClassDeclaration,
  ClassExpression,
  ConditionalExpression,
  ConditionalTypeNode,
  Decorator,
  GetAccessorDeclaration,
  Identifier,
  IntersectionTypeNode,
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  LiteralTypeNode,
  MethodDeclaration,
  type ModifierList,
  type Node,
  ParameterDeclaration,
  ParenthesizedExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  PropertyDeclaration,
  QualifiedName,
  SetAccessorDeclaration,
  SourceFile,
  StringLiteral,
  TypeOfExpression,
  TypeOperatorNode,
  TypePredicateNode,
  TypeReferenceNode,
  UnionTypeNode,
  VoidExpression,
  getBody,
  getMembers,
  getParameters,
  getText,
  getType,
} from '../ast.js';
import { isFunctionLike } from '../ast-utilities.js';
import { isAsyncFunction, isClassLike } from '../binder-utilities.js';
import { type CompilerOptions, ScriptTarget, getEmitScriptTarget, getStrictOptionValue } from '../options.js';
import { createMetadataHelper } from '../printer/decorator-helpers.js';
import type { EmitContext } from '../printer/emit-context.js';
import { isModifier } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  getRestParameterElementType,
  getSetAccessorValueParameter,
  skipTypeParentheses,
  classElementOrClassElementParameterIsDecorated,
  classOrConstructorParameterIsDecorated,
  getAllAccessorDeclarations,
  getFirstConstructorWithBody,
} from './decorator-utilities.js';
import type { EmitResolver } from './emit-resolver.js';
import { TypeReferenceSerializationKind } from './type-serialization.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { hasDecorators, isThisParameter } from './utilities.js';

export class DecoratorMetadata extends Transformer {
  private readonly legacyDecorators: boolean;
  private readonly facts: SyntaxFacts;
  private readonly serializer: MetadataSerializer;
  /** The class, or object literal, whose members are visited. */
  private parentClass: Node | undefined;

  constructor(context: EmitContext, options: CompilerOptions, resolver: EmitResolver, facts: SyntaxFacts) {
    super(context);
    this.legacyDecorators = options.experimentalDecorators === true;
    this.facts = facts;
    this.serializer = new MetadataSerializer(
      context,
      resolver,
      getEmitScriptTarget(options),
      getStrictOptionValue(options, options.strictNullChecks),
    );
    this.parentClass = undefined;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsDecorators)) return node;
    switch (node.kind) {
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        return this.visitClass(node);
      case SyntaxKind.ObjectLiteralExpression: {
        // Members of an object literal are not class elements and get no metadata.
        const saved = this.parentClass;
        this.parentClass = node;
        const updated = this.visitEachChild(node);
        this.parentClass = saved;
        return updated;
      }
      case SyntaxKind.PropertyDeclaration:
        if (node instanceof PropertyDeclaration) {
          if (!hasDecorators(node)) return this.visitEachChild(node);
          return this.factory.updatePropertyDeclaration(
            node,
            this.injectClassElementTypeMetadata(this.visitModifiers(node.modifiers), node),
            this.visitNode(node.name)!,
            node.postfixToken,
            this.visitNode(node.type),
            this.visitNode(node.initializer),
          );
        }
        break;
      case SyntaxKind.MethodDeclaration:
        if (node instanceof MethodDeclaration) {
          if (!hasDecorators(node) && !hasDecoratedParameter(node)) return this.visitEachChild(node);
          return this.factory.updateMethodDeclaration(
            node,
            this.injectClassElementTypeMetadata(this.visitModifiers(node.modifiers), node),
            node.asteriskToken,
            this.visitNode(node.name)!,
            node.postfixToken,
            this.visitNodes(node.typeParameters),
            this.visitNodes(node.parameters)!,
            this.visitNode(node.type),
            this.visitNode(node.fullSignature),
            this.visitNode(node.body),
          );
        }
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration) {
          if (!hasDecorators(node) && !hasDecoratedParameter(node)) return this.visitEachChild(node);
          return this.factory.updateSetAccessorDeclaration(
            node,
            this.injectClassElementTypeMetadata(this.visitModifiers(node.modifiers), node),
            this.visitNode(node.name)!,
            this.visitNodes(node.typeParameters),
            this.visitNodes(node.parameters)!,
            this.visitNode(node.type),
            this.visitNode(node.fullSignature),
            this.visitNode(node.body),
          );
        }
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration) {
          if (!hasDecorators(node)) return this.visitEachChild(node);
          return this.factory.updateGetAccessorDeclaration(
            node,
            this.injectClassElementTypeMetadata(this.visitModifiers(node.modifiers), node),
            this.visitNode(node.name)!,
            this.visitNodes(node.typeParameters),
            this.visitNodes(node.parameters)!,
            this.visitNode(node.type),
            this.visitNode(node.fullSignature),
            this.visitNode(node.body),
          );
        }
        break;
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) {
          this.parentClass = undefined;
          this.serializer.currentLexicalScope = node;
          const updated = this.visitEachChild(node);
          const helpers = this.context.readEmitHelpers();
          for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(updated, helpers[i]!);
          this.serializer.currentLexicalScope = undefined;
          return updated;
        }
        break;
      case SyntaxKind.ModuleBlock:
      case SyntaxKind.Block:
      case SyntaxKind.CaseBlock: {
        const saved = this.serializer.currentLexicalScope;
        this.serializer.currentLexicalScope = node;
        const updated = this.visitEachChild(node);
        this.serializer.currentLexicalScope = saved;
        return updated;
      }
    }
    return this.visitEachChild(node);
  }

  private visitClass(node: Node): Node {
    const saved = this.parentClass;
    this.parentClass = node;
    let result: Node = node;
    if (!classOrConstructorParameterIsDecorated(this.legacyDecorators, node)) result = this.visitEachChild(node);
    else if (node instanceof ClassDeclaration)
      result = this.factory.updateClassDeclaration(
        node as ClassDeclaration,
        this.injectClassTypeMetadata(this.visitModifiers(node.modifiers), node),
        node.name,
        this.visitNodes(node.typeParameters),
        this.visitNodes(node.heritageClauses),
        this.visitNodes(node.members)!,
      );
    else if (node instanceof ClassExpression)
      result = this.factory.updateClassExpression(
        node as ClassExpression,
        this.injectClassTypeMetadata(this.visitModifiers(node.modifiers), node),
        node.name,
        this.visitNodes(node.typeParameters),
        this.visitNodes(node.heritageClauses),
        this.visitNodes(node.members)!,
      );
    this.parentClass = saved;
    return result;
  }

  /** The modifiers with metadata after the decorators: `export`/`default` first, other modifiers last. */
  private injectClassTypeMetadata(list: ModifierList | undefined, node: Node): ModifierList | undefined {
    const metadata = this.getTypeMetadata(node, node);
    if (metadata.length === 0) return list;
    if (list === undefined || list.nodes.length === 0) return this.metadataOnly(list, metadata);
    const original = list.nodes;
    const modifiers: Node[] = [];
    if (isExportOrDefault(original[0]!)) {
      modifiers.push(original[0]!);
      if (original.length > 1 && isExportOrDefault(original[1]!)) modifiers.push(original[1]!);
    }
    const rest = modifiers.length;
    for (let i = 0; i < original.length; i++) if (original[i] instanceof Decorator) modifiers.push(original[i]!);
    for (let i = 0; i < metadata.length; i++) modifiers.push(metadata[i]!);
    for (let i = rest; i < original.length; i++) if (isModifier(original[i]!)) modifiers.push(original[i]!);
    return this.withRange(modifiers, list);
  }

  private injectClassElementTypeMetadata(list: ModifierList | undefined, node: Node): ModifierList | undefined {
    const container = this.parentClass;
    if (container === undefined || !isClassLike(container)) return list;
    if (!classElementOrClassElementParameterIsDecorated(this.legacyDecorators, node, container)) return list;
    const metadata = this.getTypeMetadata(node, container);
    if (metadata.length === 0) return list;
    if (list === undefined || list.nodes.length === 0) return this.metadataOnly(list, metadata);
    const original = list.nodes;
    const modifiers: Node[] = [];
    for (let i = 0; i < original.length; i++) if (original[i] instanceof Decorator) modifiers.push(original[i]!);
    for (let i = 0; i < metadata.length; i++) modifiers.push(metadata[i]!);
    for (let i = 0; i < original.length; i++) if (isModifier(original[i]!)) modifiers.push(original[i]!);
    return this.withRange(modifiers, list);
  }

  private metadataOnly(list: ModifierList | undefined, metadata: Node[]): ModifierList {
    const result = this.factory.createModifierList(metadata);
    if (list !== undefined) {
      result.pos = list.pos;
      result.end = list.end;
    }
    return result;
  }

  private withRange(modifiers: Node[], list: ModifierList): ModifierList {
    const result = this.factory.createModifierList(modifiers);
    result.pos = list.pos;
    result.end = list.end;
    return result;
  }

  /** Metadata decorators for a declaration; none for standard decorators. */
  private getTypeMetadata(node: Node, container: Node): Node[] {
    const decorators: Node[] = [];
    if (!this.legacyDecorators) return decorators;
    const factory = this.factory;
    const serializer = this.serializer;
    serializer.currentNameScope = container;
    switch (node.kind) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.PropertyDeclaration:
        decorators.push(
          factory.created(
            new Decorator(
              createMetadataHelper(factory, 'design:type', serializer.serializeTypeOfNode(node, container)),
            ),
          ),
        );
    }
    if (shouldAddParamTypesMetadata(node))
      decorators.push(
        factory.created(
          new Decorator(
            createMetadataHelper(
              factory,
              'design:paramtypes',
              serializer.serializeParameterTypesOfNode(node, container),
            ),
          ),
        ),
      );
    if (node.kind === SyntaxKind.MethodDeclaration)
      decorators.push(
        factory.created(
          new Decorator(createMetadataHelper(factory, 'design:returntype', serializer.serializeReturnTypeOfNode(node))),
        ),
      );
    serializer.currentNameScope = undefined;
    return decorators;
  }
}

function shouldAddParamTypesMetadata(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return getFirstConstructorWithBody(node) !== undefined;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return true;
  }
  return false;
}

function isExportOrDefault(node: Node): boolean {
  return node.kind === SyntaxKind.ExportKeyword || node.kind === SyntaxKind.DefaultKeyword;
}

function hasDecoratedParameter(node: Node): boolean {
  const parameters = getParameters(node)!.nodes;
  const first = parameters.length > 0 && isThisParameter(parameters[0]!) ? 1 : 0;
  for (let i = first; i < parameters.length; i++) if (hasDecorators(parameters[i]!)) return true;
  return false;
}

/**
 * Serializes type annotations as the runtime values `Reflect.metadata` records: `Function`,
 * `Array`, `Boolean`, `String`, `Number`, `BigInt`, `Symbol`, `Object`, `void 0`, or the class a
 * type reference names. Type references need the resolver to tell classes from other types.
 */
export class MetadataSerializer {
  private readonly context: EmitContext;
  private readonly resolver: EmitResolver;
  private readonly target: ScriptTarget;
  private readonly strictNullChecks: boolean;
  currentLexicalScope: Node | undefined;
  currentNameScope: Node | undefined;
  private serializingConditionalTypeBranch: boolean;

  constructor(context: EmitContext, resolver: EmitResolver, target: ScriptTarget, strictNullChecks: boolean) {
    this.context = context;
    this.resolver = resolver;
    this.target = target;
    this.strictNullChecks = strictNullChecks;
    this.currentLexicalScope = undefined;
    this.currentNameScope = undefined;
    this.serializingConditionalTypeBranch = false;
  }

  serializeTypeOfNode(node: Node, container: Node): Node {
    const factory = this.context.factory;
    switch (node.kind) {
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.Parameter:
        return this.serializeTypeNode(getType(node));
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        return this.serializeTypeNode(getAccessorTypeNode(node, container));
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.MethodDeclaration:
        return factory.createIdentifier('Function');
    }
    return factory.createVoidZero();
  }

  serializeParameterTypesOfNode(node: Node, container: Node): Node {
    const factory = this.context.factory;
    let declaration: Node | undefined = undefined;
    if (isClassLike(node)) declaration = getFirstConstructorWithBody(node);
    else if (isFunctionLike(node) && getBody(node) !== undefined) declaration = node;
    const expressions: Node[] = [];
    if (declaration !== undefined) {
      const parameters = getParametersOfDecoratedDeclaration(declaration, container);
      for (let i = 0; i < parameters.length; i++) {
        const parameter = parameters[i]!;
        if (i === 0 && isThisParameter(parameter)) continue;
        if (parameter instanceof ParameterDeclaration && parameter.dotDotDotToken !== undefined)
          expressions.push(this.serializeTypeNode(getRestParameterElementType(parameter.type)));
        else expressions.push(this.serializeTypeOfNode(parameter, container));
      }
    }
    return factory.created(new ArrayLiteralExpression(factory.createNodeList(expressions), false));
  }

  serializeReturnTypeOfNode(node: Node): Node {
    const factory = this.context.factory;
    const type = getType(node);
    if (isFunctionLike(node) && type !== undefined) return this.serializeTypeNode(type);
    if (isAsyncFunction(node)) return factory.createIdentifier('Promise');
    return factory.createVoidZero();
  }

  private serializeTypeNode(type: Node | undefined): Node {
    const factory = this.context.factory;
    if (type === undefined) return factory.createIdentifier('Object');
    const node = skipTypeParentheses(type);
    switch (node.kind) {
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NeverKeyword:
        return factory.createVoidZero();
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
        return factory.createIdentifier('Function');
      case SyntaxKind.ArrayType:
      case SyntaxKind.TupleType:
        return factory.createIdentifier('Array');
      case SyntaxKind.TypePredicate:
        if (node instanceof TypePredicateNode && node.assertsModifier !== undefined) return factory.createVoidZero();
        return factory.createIdentifier('Boolean');
      case SyntaxKind.BooleanKeyword:
        return factory.createIdentifier('Boolean');
      case SyntaxKind.TemplateLiteralType:
      case SyntaxKind.StringKeyword:
        return factory.createIdentifier('String');
      case SyntaxKind.ObjectKeyword:
        return factory.createIdentifier('Object');
      case SyntaxKind.LiteralType:
        if (node instanceof LiteralTypeNode) return this.serializeLiteralOfLiteralTypeNode(node.literal);
        break;
      case SyntaxKind.NumberKeyword:
        return factory.createIdentifier('Number');
      case SyntaxKind.BigIntKeyword:
        return this.serializeBigIntConstructor();
      case SyntaxKind.SymbolKeyword:
        return factory.createIdentifier('Symbol');
      case SyntaxKind.TypeReference:
        if (node instanceof TypeReferenceNode) return this.serializeTypeReferenceNode(node);
        break;
      case SyntaxKind.IntersectionType:
        if (node instanceof IntersectionTypeNode)
          return this.serializeUnionOrIntersectionConstituents(node.types.nodes, true);
        break;
      case SyntaxKind.UnionType:
        if (node instanceof UnionTypeNode)
          return this.serializeUnionOrIntersectionConstituents(node.types.nodes, false);
        break;
      case SyntaxKind.ConditionalType:
        if (node instanceof ConditionalTypeNode) {
          const saved = this.serializingConditionalTypeBranch;
          this.serializingConditionalTypeBranch = true;
          const result = this.serializeUnionOrIntersectionConstituents([node.trueType, node.falseType], false);
          this.serializingConditionalTypeBranch = saved;
          return result;
        }
        break;
      case SyntaxKind.TypeOperator:
        // `unique symbol` falls back to `Object` as in tsgo.
        if (node instanceof TypeOperatorNode && node.operator === SyntaxKind.ReadonlyKeyword)
          return this.serializeTypeNode(node.type);
        break;
      case SyntaxKind.JSDocNullableType:
        if (node instanceof JSDocNullableType) return this.serializeTypeNode(node.type);
        break;
      case SyntaxKind.JSDocNonNullableType:
        if (node instanceof JSDocNonNullableType) return this.serializeTypeNode(node.type);
        break;
      case SyntaxKind.JSDocOptionalType:
        if (node instanceof JSDocOptionalType) return this.serializeTypeNode(node.type);
        break;
    }
    return factory.createIdentifier('Object');
  }

  private serializeUnionOrIntersectionConstituents(types: Node[], isIntersection: boolean): Node {
    const factory = this.context.factory;
    let serialized: Node | undefined = undefined;
    for (let i = 0; i < types.length; i++) {
      const type = skipTypeParentheses(types[i]!);
      if (type.kind === SyntaxKind.NeverKeyword) {
        // `never` reduces an intersection and is elided from a union.
        if (isIntersection) return factory.createVoidZero();
        continue;
      }
      if (type.kind === SyntaxKind.UnknownKeyword) {
        if (!isIntersection) return factory.createIdentifier('Object');
        continue;
      }
      if (type.kind === SyntaxKind.AnyKeyword) return factory.createIdentifier('Object');
      // Without strict null checks, `null` and `undefined` are elided as before they existed.
      if (!this.strictNullChecks && (isNullLiteralType(type) || type.kind === SyntaxKind.UndefinedKeyword)) continue;
      const constituent = this.serializeTypeNode(type);
      if (constituent instanceof Identifier && constituent.text === 'Object') return constituent;
      if (serialized === undefined) serialized = constituent;
      else if (!this.equateSerializedTypeNodes(serialized, constituent)) return factory.createIdentifier('Object');
    }
    return serialized !== undefined ? serialized : factory.createVoidZero();
  }

  private serializeLiteralOfLiteralTypeNode(node: Node): Node {
    const factory = this.context.factory;
    switch (node.kind) {
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return factory.createIdentifier('String');
      case SyntaxKind.PrefixUnaryExpression:
        if (node instanceof PrefixUnaryExpression) return this.serializeLiteralOfLiteralTypeNode(node.operand);
        break;
      case SyntaxKind.NumericLiteral:
        return factory.createIdentifier('Number');
      case SyntaxKind.BigIntLiteral:
        return this.serializeBigIntConstructor();
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        return factory.createIdentifier('Boolean');
      case SyntaxKind.NullKeyword:
        return factory.createVoidZero();
    }
    return factory.createIdentifier('Object');
  }

  /** The class a type reference names, or the constructor of what the resolver says it is. */
  private serializeTypeReferenceNode(node: TypeReferenceNode): Node {
    const factory = this.context.factory;
    const scope = this.currentNameScope !== undefined ? this.currentNameScope : this.currentLexicalScope;
    const location = scope === undefined ? undefined : this.context.parseNode(scope);
    const typeName = this.context.parseNode(node.typeName);
    const kind =
      typeName === undefined
        ? TypeReferenceSerializationKind.Unknown
        : this.resolver.getTypeReferenceSerializationKind(typeName, location);
    switch (kind) {
      case TypeReferenceSerializationKind.Unknown: {
        // An unresolved reference in a conditional type branch is like `any`.
        if (this.serializingConditionalTypeBranch) return factory.createIdentifier('Object');
        // `typeof (_a = typeof A !== "undefined" && A) === "function" ? _a : Object`
        const serialized = this.serializeEntityNameAsExpressionFallback(node.typeName);
        const temp = factory.createTempVariable(0);
        this.context.addVariableDeclaration(temp);
        return factory.createConditionalExpression(
          factory.createTypeCheck(factory.createAssignment(temp, serialized), 'function'),
          temp,
          factory.createIdentifier('Object'),
        );
      }
      case TypeReferenceSerializationKind.TypeWithConstructSignatureAndValue:
        return this.serializeEntityNameAsExpression(node.typeName);
      case TypeReferenceSerializationKind.VoidNullableOrNeverType:
        return factory.createVoidZero();
      case TypeReferenceSerializationKind.BigIntLikeType:
        return this.serializeBigIntConstructor();
      case TypeReferenceSerializationKind.BooleanType:
        return factory.createIdentifier('Boolean');
      case TypeReferenceSerializationKind.NumberLikeType:
        return factory.createIdentifier('Number');
      case TypeReferenceSerializationKind.StringLikeType:
        return factory.createIdentifier('String');
      case TypeReferenceSerializationKind.ArrayLikeType:
        return factory.createIdentifier('Array');
      case TypeReferenceSerializationKind.ESSymbolType:
        return factory.createIdentifier('Symbol');
      case TypeReferenceSerializationKind.TypeWithCallSignature:
        return factory.createIdentifier('Function');
      case TypeReferenceSerializationKind.Promise:
        return factory.createIdentifier('Promise');
    }
    return factory.createIdentifier('Object');
  }

  private serializeBigIntConstructor(): Node {
    const factory = this.context.factory;
    if (this.target >= ScriptTarget.ES2020) return factory.createIdentifier('BigInt');
    return factory.createConditionalExpression(
      factory.createTypeCheck(factory.createIdentifier('BigInt'), 'function'),
      factory.createIdentifier('BigInt'),
      factory.createIdentifier('Object'),
    );
  }

  /** An entity name as an expression; identifiers act as parse-tree references for the module transforms. */
  private serializeEntityNameAsExpression(node: Node): Node {
    const factory = this.context.factory;
    if (node instanceof Identifier) {
      const name = factory.cloneIdentifier(node);
      name.pos = node.pos;
      name.end = node.end;
      this.context.unsetOriginal(name);
      const scope = this.currentLexicalScope;
      name.parent = scope === undefined ? undefined : this.context.parseNode(scope);
      return name;
    }
    if (node instanceof QualifiedName)
      return factory.createPropertyAccessExpression(this.serializeEntityNameAsExpression(node.left), node.right);
    return node;
  }

  /** An entity name guarded so that it doesn't throw if it isn't defined at runtime. */
  private serializeEntityNameAsExpressionFallback(node: Node): Node {
    const factory = this.context.factory;
    // A -> typeof A !== "undefined" && A
    if (node instanceof Identifier) {
      const copied = this.serializeEntityNameAsExpression(node);
      return this.createCheckedValue(copied, copied);
    }
    if (!(node instanceof QualifiedName)) return node;
    // A.B -> typeof A !== "undefined" && A.B
    if (node.left instanceof Identifier)
      return this.createCheckedValue(
        this.serializeEntityNameAsExpression(node.left),
        this.serializeEntityNameAsExpression(node),
      );
    // A.B.C -> typeof A !== "undefined" && (_a = A.B) !== void 0 && _a.C
    const left = this.serializeEntityNameAsExpressionFallback(node.left);
    const temp = factory.createTempVariable(0);
    this.context.addVariableDeclaration(temp);
    const check = left instanceof BinaryExpression ? left.left : left;
    const value = left instanceof BinaryExpression ? left.right : left;
    return factory.createBinaryExpression(
      factory.createBinaryExpression(
        check,
        SyntaxKind.AmpersandAmpersandToken,
        factory.createBinaryExpression(
          factory.createAssignment(temp, value),
          SyntaxKind.ExclamationEqualsEqualsToken,
          factory.createVoidZero(),
        ),
      ),
      SyntaxKind.AmpersandAmpersandToken,
      factory.createPropertyAccessExpression(temp, node.right),
    );
  }

  /** `typeof left !== "undefined" && right` */
  private createCheckedValue(left: Node, right: Node): Node {
    const factory = this.context.factory;
    return factory.createBinaryExpression(
      factory.createBinaryExpression(
        factory.created(new TypeOfExpression(left)),
        SyntaxKind.ExclamationEqualsEqualsToken,
        factory.createStringLiteral('undefined', TokenFlags.None),
      ),
      SyntaxKind.AmpersandAmpersandToken,
      right,
    );
  }

  private equateSerializedTypeNodes(left: Node, right: Node): boolean {
    // Temporaries of fallbacks.
    if (left instanceof Identifier && this.context.hasAutoGenerateInfo(left))
      return right instanceof Identifier && this.context.hasAutoGenerateInfo(right);
    if (left instanceof Identifier) return right instanceof Identifier && left.text === right.text;
    if (left instanceof PropertyAccessExpression)
      return (
        right instanceof PropertyAccessExpression &&
        this.equateSerializedTypeNodes(left.expression, right.expression) &&
        this.equateSerializedTypeNodes(left.name, right.name)
      );
    if (left instanceof VoidExpression)
      return (
        right instanceof VoidExpression &&
        left.expression.kind === SyntaxKind.NumericLiteral &&
        right.expression.kind === SyntaxKind.NumericLiteral &&
        getText(left.expression) === '0' &&
        getText(right.expression) === '0'
      );
    if (left instanceof StringLiteral) return right instanceof StringLiteral && left.text === right.text;
    if (left instanceof TypeOfExpression)
      return right instanceof TypeOfExpression && this.equateSerializedTypeNodes(left.expression, right.expression);
    if (left instanceof ParenthesizedExpression)
      return (
        right instanceof ParenthesizedExpression && this.equateSerializedTypeNodes(left.expression, right.expression)
      );
    if (left instanceof ConditionalExpression)
      return (
        right instanceof ConditionalExpression &&
        this.equateSerializedTypeNodes(left.condition, right.condition) &&
        this.equateSerializedTypeNodes(left.whenTrue, right.whenTrue) &&
        this.equateSerializedTypeNodes(left.whenFalse, right.whenFalse)
      );
    if (left instanceof BinaryExpression)
      return (
        right instanceof BinaryExpression &&
        left.operatorToken.kind === right.operatorToken.kind &&
        this.equateSerializedTypeNodes(left.left, right.left) &&
        this.equateSerializedTypeNodes(left.right, right.right)
      );
    return false;
  }
}

/** The type annotation of an accessor pair: the setter's parameter, else the getter's return. */
function getAccessorTypeNode(node: Node, container: Node): Node | undefined {
  const accessors = getAllAccessorDeclarations(getMembers(container)!.nodes, node);
  if (accessors.setAccessor !== undefined) {
    const parameter = getSetAccessorValueParameter(accessors.setAccessor);
    return parameter === undefined ? undefined : getType(parameter);
  }
  if (accessors.getAccessor !== undefined) return getType(accessors.getAccessor);
  return undefined;
}

/** A getter's metadata uses the parameters of its setter. */
function getParametersOfDecoratedDeclaration(node: Node, container: Node): Node[] {
  if (node.kind === SyntaxKind.GetAccessor) {
    const accessors = getAllAccessorDeclarations(getMembers(container)!.nodes, node);
    if (accessors.setAccessor !== undefined) return getParameters(accessors.setAccessor)!.nodes;
  }
  return getParameters(node)!.nodes;
}

function isNullLiteralType(node: Node): boolean {
  return node instanceof LiteralTypeNode && node.literal.kind === SyntaxKind.NullKeyword;
}
