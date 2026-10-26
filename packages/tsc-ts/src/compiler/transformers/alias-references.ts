// Which aliases (imports and `import x = ...`) a file uses as values, found as the checker's
// `markLinkedReferences` finds them: identifiers in expressions mark the aliases they resolve
// to, except where a property access of a const enum (or an enum member in an enum
// initializer) is inlined. Without types, a property access through anything but an alias of a
// namespace, enum or module counts as a use.
import {
  BinaryExpression,
  ConditionalTypeNode,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ForInOrOfStatement,
  ForStatement,
  HeritageClause,
  Identifier,
  ImportEqualsDeclaration,
  ImportTypeNode,
  LiteralTypeNode,
  MetaProperty,
  ModifierFlags,
  type Node,
  NodeFlags,
  NodeVisitor,
  PropertyAccessExpression,
  QualifiedName,
  ShorthandPropertyAssignment,
  type SourceFile,
  TypeParameterDeclaration,
  TypeReferenceNode,
  VariableDeclarationList,
  IntersectionTypeNode,
  UnionTypeNode,
  getDotDotDotToken,
  getExpression,
  getInitializer,
  getName,
  getParameters,
  getTagName,
  getType,
  getTypeArguments,
} from '../ast.js';
import { canHaveDecorators, isImportCall } from '../ast-utilities.js';
import {
  type CompilerOptions,
  JsxEmit,
  getIsolatedModules,
  getStrictOptionValue,
  shouldPreserveConstEnums,
} from '../options.js';
import { SyntaxKind } from '../syntax-kind.js';
import { getDeclarationOfAliasSymbol, type ReferenceResolver } from './reference-resolver.js';
import {
  getFirstConstructorWithBody,
  getRestParameterElementType,
  getSetAccessorValueParameter,
  nodeCanBeDecorated,
} from './decorator-utilities.js';
import { hasDecorators, hasSyntacticModifier } from './utilities.js';
import { getDeclarations, type Symbol, SymbolFlags } from '../symbol.js';

export class AliasReferences extends NodeVisitor {
  readonly options: CompilerOptions;
  readonly resolver: ReferenceResolver;
  /** Alias symbols used as values. */
  readonly referenced: Set<Symbol>;
  private readonly jsxNamespace: string;
  private readonly jsxFragmentNamespace: string;
  /** Whether the JSX runtime's module resolves, so JSX doesn't use the factory's names. */
  private readonly jsxRuntimeResolved: boolean;

  constructor(
    options: CompilerOptions,
    resolver: ReferenceResolver,
    jsxNamespace: string,
    jsxFragmentNamespace: string,
    jsxRuntimeResolved: boolean,
  ) {
    super();
    this.options = options;
    this.resolver = resolver;
    this.referenced = new Set<Symbol>();
    this.jsxNamespace = jsxNamespace;
    this.jsxFragmentNamespace = jsxFragmentNamespace;
    this.jsxRuntimeResolved = jsxRuntimeResolved;
  }

  markFile(file: SourceFile): boolean {
    file.forEachChild(this);
    return true;
  }

  visitNode(node: Node): boolean {
    // Imports are marked by their uses.
    if (node instanceof ImportEqualsDeclaration && !hasSyntacticModifier(node, ModifierFlags.Export)) return false;
    if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.JSImportDeclaration) return false;
    this.mark(node);
    node.forEachChild(this);
    return false;
  }

  private mark(node: Node): boolean {
    // Types and declaration files don't use imports, except decorated properties.
    if (
      (node.flags & NodeFlags.Ambient) !== 0 &&
      node.kind !== SyntaxKind.PropertySignature &&
      node.kind !== SyntaxKind.PropertyDeclaration
    )
      return false;
    if (node instanceof Identifier) {
      const parent = node.parent;
      if (
        parent === undefined ||
        !(
          isExpressionNode(node) ||
          parent instanceof ShorthandPropertyAssignment ||
          (parent instanceof ImportEqualsDeclaration && parent.moduleReference === node)
        ) ||
        !shouldMarkIdentifier(node as Identifier)
      )
        return false;
      // Only the left of a property access or qualified name; the right is a property lookup.
      if (parent instanceof PropertyAccessExpression && parent.expression !== node) return false;
      if (parent instanceof QualifiedName && parent.left !== node) return false;
      if (isInsideMetaProperty(node)) return false;
      return this.markIdentifier(node as Identifier);
    }
    if (node.kind === SyntaxKind.PropertyAccessExpression || node.kind === SyntaxKind.QualifiedName) {
      for (
        let top: Node | undefined = node;
        top !== undefined && isPropertyAccessOrQualifiedName(top);
        top = top.parent
      )
        // Names in an import type's qualifier, `ns.y` in `typeof import("./b").ns.y`, are exports of the
        // imported module, not references to this file's imports.
        if (isPartOfTypeNode(top) || isImportTypeQualifierPart(top)) return false;
      return this.markProperty(node);
    }
    if (node instanceof ExportAssignment) {
      const expression = node.expression;
      if (!(expression instanceof Identifier)) return false;
      const symbol = this.resolver.resolveEntityName(expression, SymbolFlags.All, true);
      if (symbol !== undefined)
        this.markAlias(this.resolver.getExportSymbolOfValueSymbolIfExported(symbol), expression);
      return true;
    }
    switch (node.kind) {
      case SyntaxKind.JsxOpeningElement:
      case SyntaxKind.JsxSelfClosingElement:
      case SyntaxKind.JsxOpeningFragment:
        return this.markJsx(node);
    }
    if (node instanceof ImportEqualsDeclaration) {
      if (hasSyntacticModifier(node, ModifierFlags.Export)) this.markExport(node);
      return true;
    }
    if (node instanceof ExportSpecifier) return this.markExportSpecifier(node);
    if (
      this.options.emitDecoratorMetadata === true &&
      canHaveDecorators(node) &&
      hasDecorators(node) &&
      nodeCanBeDecorated(
        this.options.experimentalDecorators === true,
        node,
        node.parent,
        node.parent === undefined ? undefined : node.parent.parent,
      )
    )
      return this.markDecoratorMetadata(node);
    return false;
  }

  /** Type references that decorator metadata serializes as values use the aliases they name. */
  private markDecoratorMetadata(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.ClassDeclaration: {
        const constructor = getFirstConstructorWithBody(node);
        if (constructor !== undefined) this.markParameterTypes(constructor);
        break;
      }
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor: {
        let annotation = getAnnotatedAccessorTypeNode(node);
        if (annotation === undefined) {
          const other = this.getOtherAccessor(node);
          if (other !== undefined) annotation = getAnnotatedAccessorTypeNode(other);
        }
        this.markMetadataTypeNode(annotation);
        break;
      }
      case SyntaxKind.MethodDeclaration:
        this.markParameterTypes(node);
        this.markMetadataTypeNode(getType(node));
        break;
      case SyntaxKind.PropertyDeclaration:
        this.markMetadataTypeNode(getType(node));
        break;
      case SyntaxKind.Parameter:
        this.markMetadataTypeNode(getParameterTypeNodeForDecoratorCheck(node));
        if (node.parent !== undefined) {
          this.markParameterTypes(node.parent);
          this.markMetadataTypeNode(getType(node.parent));
        }
        break;
    }
    return true;
  }

  private markParameterTypes(node: Node): boolean {
    const parameters = getParameters(node);
    if (parameters === undefined) return false;
    for (let i = 0; i < parameters.nodes.length; i++)
      this.markMetadataTypeNode(getParameterTypeNodeForDecoratorCheck(parameters.nodes[i]!));
    return true;
  }

  private getOtherAccessor(node: Node): Node | undefined {
    const symbol = this.resolver.getSymbolOfDeclaration(node);
    if (symbol === undefined) return undefined;
    const kind = node.kind === SyntaxKind.SetAccessor ? SyntaxKind.GetAccessor : SyntaxKind.SetAccessor;
    for (const declaration of getDeclarations(symbol)) if (declaration.kind === kind) return declaration;
    return undefined;
  }

  private markMetadataTypeNode(node: Node | undefined): boolean {
    const name = this.getEntityNameForDecoratorMetadata(node);
    if (name === undefined || !(name instanceof Identifier || name instanceof QualifiedName)) return false;
    const root = firstIdentifier(name);
    const meaning = (name instanceof Identifier ? SymbolFlags.Type : SymbolFlags.Namespace) | SymbolFlags.Alias;
    const symbol = this.resolver.resolveName(root, root.text, meaning);
    if (symbol === undefined || (symbol.flags & SymbolFlags.Alias) === 0) return false;
    const target = this.resolver.resolveAlias(symbol);
    if (
      (this.resolver.getSymbolFlags(symbol, true, false) & SymbolFlags.Value) !== 0 &&
      (target === undefined || !isConstEnumOrConstEnumOnlyModule(target)) &&
      !this.resolver.isTypeOnlyAliasChain(symbol)
    )
      this.markAliasSymbol(symbol);
    return true;
  }

  /** The entity name a type serializes to, if it serializes to one: `A` of `A | null`, but nothing for `A | B`. */
  private getEntityNameForDecoratorMetadata(node: Node | undefined): Node | undefined {
    if (node === undefined) return undefined;
    switch (node.kind) {
      case SyntaxKind.IntersectionType:
      case SyntaxKind.UnionType:
        return this.getEntityNameForDecoratorMetadataFromTypeList(getTypes(node));
      case SyntaxKind.ConditionalType:
        if (node instanceof ConditionalTypeNode)
          return this.getEntityNameForDecoratorMetadataFromTypeList([node.trueType, node.falseType]);
        break;
      case SyntaxKind.ParenthesizedType:
      case SyntaxKind.NamedTupleMember:
        return this.getEntityNameForDecoratorMetadata(getType(node));
      case SyntaxKind.TypeReference:
        if (node instanceof TypeReferenceNode) return node.typeName;
        break;
    }
    return undefined;
  }

  private getEntityNameForDecoratorMetadataFromTypeList(types: Node[]): Node | undefined {
    const strictNullChecks = getStrictOptionValue(this.options, this.options.strictNullChecks);
    let common: Node | undefined = undefined;
    for (let i = 0; i < types.length; i++) {
      const type = types[i]!;
      if (type.kind === SyntaxKind.NeverKeyword) continue;
      if (
        !strictNullChecks &&
        ((type instanceof LiteralTypeNode && type.literal.kind === SyntaxKind.NullKeyword) ||
          type.kind === SyntaxKind.UndefinedKeyword)
      )
        continue;
      const name = this.getEntityNameForDecoratorMetadata(type);
      // Something like `string`, serialized as itself or `Object`.
      if (name === undefined) return undefined;
      if (common === undefined) common = name;
      else if (!(common instanceof Identifier) || !(name instanceof Identifier) || common.text !== name.text)
        return undefined;
    }
    return common;
  }

  private markIdentifier(node: Identifier): boolean {
    const symbol = this.resolver.getResolvedSymbol(node);
    if (symbol === undefined || node.text === 'arguments') return false;
    return this.markAlias(symbol, node);
  }

  private markAlias(symbol: Symbol, location: Node): boolean {
    if (!isNonLocalAlias(symbol) || isInTypeQuery(location)) return false;
    const target = this.resolver.resolveAlias(symbol);
    const flags = this.resolver.getSymbolFlags(symbol, true, false);
    if ((flags & (SymbolFlags.Value | SymbolFlags.ExportValue)) === 0) return false;
    // Uses of a const enum are inlined, unless it isn't (`isolatedModules`) or the use is an export of a preserved one.
    if (
      getIsolatedModules(this.options) ||
      (shouldPreserveConstEnums(this.options) && isExportOrExportExpression(location)) ||
      target === undefined ||
      !isConstEnumOrConstEnumOnlyModule(this.resolver.getExportSymbolOfValueSymbolIfExported(target))
    )
      this.markAliasSymbol(symbol);
    return true;
  }

  /** Marks an alias used, and for `import x = a.b`, what it names. */
  private markAliasSymbol(alias: Symbol): boolean {
    const symbol = this.resolver.getMergedSymbol(alias);
    if (this.referenced.has(symbol)) return false;
    this.referenced.add(symbol);
    const declaration = getDeclarationOfAliasSymbol(symbol);
    if (
      declaration instanceof ImportEqualsDeclaration &&
      declaration.moduleReference.kind !== SyntaxKind.ExternalModuleReference
    ) {
      const target = this.resolver.resolveAlias(symbol);
      const flags = target === undefined ? SymbolFlags.Property : this.resolver.getSymbolFlags(target, false, false);
      if ((flags & SymbolFlags.Value) !== 0) this.markIdentifier(firstIdentifier(declaration.moduleReference));
    }
    return true;
  }

  /** `Foo.Bar` uses `Foo` unless `Bar` is a const enum (or a namespace of them), or an enum member inlined in an enum. */
  private markProperty(node: Node): boolean {
    if (isPartOfImportEqualsModuleReference(node)) return false;
    const left = leftOf(node);
    if (!(left instanceof Identifier)) return false;
    const parentSymbol = this.resolver.getResolvedSymbol(left as Identifier);
    if (parentSymbol === undefined) return false;
    if (
      getIsolatedModules(this.options) ||
      (shouldPreserveConstEnums(this.options) && isExportOrExportExpression(node))
    )
      return this.markAlias(parentSymbol, node);
    const right = rightOf(node);
    const property = right instanceof Identifier ? this.getPropertyOfAlias(parentSymbol, right.text) : undefined;
    if (
      property !== undefined &&
      (isConstEnumOrConstEnumOnlyModule(property) ||
        ((property.flags & SymbolFlags.EnumMember) !== 0 &&
          node.parent !== undefined &&
          node.parent.kind === SyntaxKind.EnumMember))
    )
      return false;
    return this.markAlias(parentSymbol, node);
  }

  /** A member of the namespace, enum or module an alias names, the type of the alias without a checker. */
  private getPropertyOfAlias(symbol: Symbol, name: string): Symbol | undefined {
    if ((symbol.flags & SymbolFlags.Alias) === 0) return undefined;
    const target = this.resolver.resolveAlias(symbol);
    if (target === undefined || (target.flags & (SymbolFlags.Namespace | SymbolFlags.Module)) === 0) return undefined;
    const member = this.resolver.getExportOfSymbol(target, name);
    return member === undefined ? undefined : this.resolver.resolveAlias(member);
  }

  private markJsx(node: Node): boolean {
    if (this.jsxRuntimeResolved) return false;
    const fragment = node.kind === SyntaxKind.JsxOpeningFragment;
    const location = fragment ? node : jsxTagName(node);
    const namespace = fragment ? this.jsxFragmentNamespace : this.jsxNamespace;
    // `@jsxFrag null` has no fragment factory.
    if (fragment && namespace === 'null') return false;
    let flags = SymbolFlags.Value;
    if (this.options.jsx === JsxEmit.Preserve || this.options.jsx === JsxEmit.ReactNative) flags &= ~SymbolFlags.Enum;
    const symbol = this.resolver.resolveName(location, namespace, flags);
    if (
      symbol !== undefined &&
      (symbol.flags & SymbolFlags.Alias) !== 0 &&
      !this.resolver.isTypeOnlyAliasSymbol(symbol)
    )
      this.markAliasSymbol(symbol);
    return true;
  }

  private markExport(node: Node): boolean {
    const symbol = this.resolver.getSymbolOfDeclaration(node);
    if (symbol === undefined) return false;
    const target = this.resolver.resolveAlias(symbol);
    if (
      target === undefined ||
      ((this.resolver.getSymbolFlags(symbol, true, false) & SymbolFlags.Value) !== 0 &&
        !isConstEnumOrConstEnumOnlyModule(target))
    )
      this.markAliasSymbol(symbol);
    return true;
  }

  private markExportSpecifier(node: ExportSpecifier): boolean {
    const declaration = node.parent === undefined ? undefined : node.parent.parent;
    if (
      !(declaration instanceof ExportDeclaration) ||
      declaration.moduleSpecifier !== undefined ||
      node.isTypeOnly ||
      declaration.isTypeOnly
    )
      return false;
    const exported = node.propertyName !== undefined ? node.propertyName : node.name;
    if (!(exported instanceof Identifier)) return false;
    const symbol = this.resolver.resolveName(
      exported,
      exported.text,
      SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias,
    );
    // Globals aren't imports.
    if (symbol !== undefined && this.resolver.isGlobalSymbol(symbol)) return false;
    const target =
      symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0 ? this.resolver.resolveAlias(symbol) : symbol;
    if (target === undefined || (this.resolver.getSymbolFlags(target, false, false) & SymbolFlags.Value) !== 0) {
      this.markExport(node);
      this.markIdentifier(exported);
    }
    return true;
  }
}

/** Whether `node` is the qualifier of an import type, or a part of one. */
function isImportTypeQualifierPart(node: Node): boolean {
  let current = node;
  let parent = current.parent;
  while (parent !== undefined && parent.kind === SyntaxKind.QualifiedName) {
    current = parent;
    parent = parent.parent;
  }
  return parent instanceof ImportTypeNode && parent.qualifier === current;
}

function isPropertyAccessOrQualifiedName(node: Node): boolean {
  return node.kind === SyntaxKind.PropertyAccessExpression || node.kind === SyntaxKind.QualifiedName;
}

function leftOf(node: Node): Node | undefined {
  if (node instanceof PropertyAccessExpression) return node.expression;
  if (node instanceof QualifiedName) return node.left;
  return undefined;
}

function rightOf(node: Node): Node | undefined {
  if (node instanceof PropertyAccessExpression) return node.name;
  if (node instanceof QualifiedName) return node.right;
  return undefined;
}

function isConstEnumOrConstEnumOnlyModule(symbol: Symbol): boolean {
  return (symbol.flags & SymbolFlags.ConstEnum) !== 0 || (symbol.flags & SymbolFlags.ConstEnumOnlyModule) !== 0;
}

function isNonLocalAlias(symbol: Symbol): boolean {
  return (symbol.flags & (SymbolFlags.Alias | SymbolFlags.Value)) === SymbolFlags.Alias;
}

function shouldMarkIdentifier(node: Identifier): boolean {
  const parent = node.parent!;
  // The left of a property access is marked with the access.
  if (parent instanceof PropertyAccessExpression && parent.expression === node) return false;
  // Names in type-only exports.
  if (parent instanceof ExportSpecifier && parent.isTypeOnly) return false;
  const grandparent = parent.parent;
  const exportDeclaration = grandparent === undefined ? undefined : grandparent.parent;
  return !(exportDeclaration instanceof ExportDeclaration && exportDeclaration.isTypeOnly);
}

function isInsideMetaProperty(node: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current instanceof MetaProperty) return true;
  return false;
}

function isInTypeQuery(node: Node): boolean {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    if (current.kind === SyntaxKind.TypeQuery) return true;
    if (current.kind !== SyntaxKind.Identifier && current.kind !== SyntaxKind.QualifiedName) return false;
  }
  return false;
}

function isExportOrExportExpression(location: Node): boolean {
  for (let node: Node | undefined = location; node !== undefined; node = node.parent) {
    const parent: Node | undefined = node.parent;
    if (parent === undefined) return false;
    if (parent instanceof ExportAssignment && parent.expression === node && isEntityNameExpression(node)) return true;
    if (parent instanceof ExportSpecifier && (parent.name === node || parent.propertyName === node)) return true;
  }
  return false;
}

function isEntityNameExpression(node: Node): boolean {
  if (node instanceof Identifier) return true;
  return (
    node instanceof PropertyAccessExpression &&
    node.name instanceof Identifier &&
    isEntityNameExpression(node.expression)
  );
}

function isPartOfImportEqualsModuleReference(node: Node): boolean {
  let child: Node = node;
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current instanceof ImportEqualsDeclaration)
      return (
        current.moduleReference === child ||
        (child.pos >= current.moduleReference.pos && child.end <= current.moduleReference.end)
      );
    child = current;
  }
  return false;
}

function firstIdentifier(node: Node): Identifier {
  let current = node;
  for (;;) {
    if (current instanceof QualifiedName) current = current.left;
    else if (current instanceof PropertyAccessExpression) current = current.expression;
    else break;
  }
  return current as Identifier;
}

function jsxTagName(node: Node): Node {
  const tagName = getTagName(node);
  return tagName !== undefined ? tagName : node;
}

// Expression positions, as tsgo's `IsExpressionNode` decides them.

export function isExpressionNode(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.ConditionalExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.OmittedExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.AwaitExpression:
      return true;
    case SyntaxKind.MetaProperty: {
      const parent = node.parent;
      return !(parent !== undefined && isImportCall(parent) && getExpression(parent) === node);
    }
    case SyntaxKind.ExpressionWithTypeArguments:
      return !(node.parent instanceof HeritageClause);
    case SyntaxKind.QualifiedName: {
      let current = node;
      while (current.parent !== undefined && current.parent.kind === SyntaxKind.QualifiedName) current = current.parent;
      const parent = current.parent;
      return parent !== undefined && (parent.kind === SyntaxKind.TypeQuery || isJsxTagName(current));
    }
    case SyntaxKind.PrivateIdentifier: {
      const parent = node.parent;
      return (
        parent instanceof BinaryExpression && parent.left === node && parent.operatorToken.kind === SyntaxKind.InKeyword
      );
    }
    case SyntaxKind.Identifier: {
      const parent = node.parent;
      if (parent !== undefined && (parent.kind === SyntaxKind.TypeQuery || isJsxTagName(node))) return true;
      return isInExpressionContext(node);
    }
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.ThisKeyword:
      return isInExpressionContext(node);
  }
  return false;
}

function isInExpressionContext(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  switch (parent.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.EnumMember:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.BindingElement:
      return getInitializer(parent) === node;
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.IfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TemplateSpan:
    case SyntaxKind.ComputedPropertyName:
    case SyntaxKind.SatisfiesExpression:
      return getExpression(parent) === node;
    case SyntaxKind.ForStatement:
      if (!(parent instanceof ForStatement)) return false;
      return (
        (parent.initializer === node && !(parent.initializer instanceof VariableDeclarationList)) ||
        parent.condition === node ||
        parent.incrementor === node
      );
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      if (!(parent instanceof ForInOrOfStatement)) return false;
      return (
        (parent.initializer === node && !(parent.initializer instanceof VariableDeclarationList)) ||
        parent.expression === node
      );
    case SyntaxKind.Decorator:
    case SyntaxKind.JsxExpression:
    case SyntaxKind.JsxSpreadAttribute:
    case SyntaxKind.SpreadAssignment:
      return true;
    case SyntaxKind.ExpressionWithTypeArguments:
      return getExpression(parent) === node && !isPartOfTypeNode(parent);
    case SyntaxKind.ShorthandPropertyAssignment:
      return parent instanceof ShorthandPropertyAssignment && parent.objectAssignmentInitializer === node;
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
      // The name of a function or class expression is a declaration name, not an expression.
      return getName(parent) !== node;
  }
  return isExpressionNode(parent);
}

function isJsxTagName(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  switch (parent.kind) {
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxClosingElement:
      return getTagName(parent) === node;
  }
  return false;
}

export function isPartOfTypeNode(node: Node): boolean {
  const kind = node.kind;
  if (kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode) return true;
  switch (kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.NeverKeyword:
      return true;
    case SyntaxKind.VoidKeyword:
      return node.parent !== undefined && node.parent.kind !== SyntaxKind.VoidExpression;
    case SyntaxKind.ExpressionWithTypeArguments:
      return isPartOfTypeExpressionWithTypeArguments(node);
    case SyntaxKind.TypeParameter:
      return (
        node.parent !== undefined &&
        (node.parent.kind === SyntaxKind.MappedType || node.parent.kind === SyntaxKind.InferType)
      );
    case SyntaxKind.Identifier: {
      const parent = node.parent;
      if (parent instanceof QualifiedName && parent.right === node) return isPartOfTypeNodeInParent(parent);
      if (parent instanceof PropertyAccessExpression && parent.name === node) return isPartOfTypeNodeInParent(parent);
      return isPartOfTypeNodeInParent(node);
    }
    case SyntaxKind.QualifiedName:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ThisKeyword:
      return isPartOfTypeNodeInParent(node);
  }
  return false;
}

function isPartOfTypeNodeInParent(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined || parent.kind === SyntaxKind.TypeQuery) return false;
  if (parent instanceof ImportTypeNode) return !parent.isTypeOf;
  if (parent.kind >= SyntaxKind.FirstTypeNode && parent.kind <= SyntaxKind.LastTypeNode) return true;
  switch (parent.kind) {
    case SyntaxKind.ExpressionWithTypeArguments:
      return isPartOfTypeExpressionWithTypeArguments(parent);
    case SyntaxKind.TypeParameter:
      return parent instanceof TypeParameterDeclaration && parent.constraint === node;
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.Constructor:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.TypeAssertionExpression:
      return getType(parent) === node;
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression: {
      const typeArguments = getTypeArguments(parent);
      return typeArguments !== undefined && typeArguments.nodes.indexOf(node) >= 0;
    }
  }
  return false;
}

function isPartOfTypeExpressionWithTypeArguments(node: Node): boolean {
  const parent = node.parent;
  if (parent instanceof HeritageClause) {
    const container = parent.parent;
    const classLike =
      container !== undefined &&
      (container.kind === SyntaxKind.ClassDeclaration || container.kind === SyntaxKind.ClassExpression);
    return !classLike || parent.token === SyntaxKind.ImplementsKeyword;
  }
  return (
    parent !== undefined &&
    (parent.kind === SyntaxKind.JSDocImplementsTag || parent.kind === SyntaxKind.JSDocAugmentsTag)
  );
}

function getParameterTypeNodeForDecoratorCheck(node: Node): Node | undefined {
  const type = getType(node);
  return getDotDotDotToken(node) !== undefined ? getRestParameterElementType(type) : type;
}

/** The type annotation of a getter, or of a setter's parameter. */
function getAnnotatedAccessorTypeNode(node: Node): Node | undefined {
  if (node.kind === SyntaxKind.GetAccessor) return getType(node);
  const parameter = getSetAccessorValueParameter(node);
  return parameter === undefined ? undefined : getType(parameter);
}

function getTypes(node: Node): Node[] {
  if (node instanceof UnionTypeNode) return node.types.nodes;
  if (node instanceof IntersectionTypeNode) return node.types.nodes;
  return [];
}
