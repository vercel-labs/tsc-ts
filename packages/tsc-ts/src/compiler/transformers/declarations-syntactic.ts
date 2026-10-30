// Answers declaration emit's queries from syntax and the binder: visibility, aliases to keep,
// overloads and enum values exactly; types from annotations and the isolatedDeclarations
// rules (literals, `as const`, annotated function expressions). Types that need inference
// are reported to the tracker and written as `any`.
import {
  AsExpression,
  BigIntLiteral,
  ObjectLiteralExpression,
  BindingElement,
  BindingPattern,
  ComputedPropertyName,
  ElementAccessExpression,
  ExportDeclaration,
  ExportSpecifier,
  ExternalModuleReference,
  FileReference,
  FunctionTypeNode,
  Identifier,
  type ImportDeclaration,
  ImportEqualsDeclaration,
  KeywordTypeNode,
  LiteralTypeNode,
  MethodSignatureDeclaration,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  NodeList,
  NodeVisitor,
  NumericLiteral,
  ParameterDeclaration,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertySignatureDeclaration,
  QualifiedName,
  SetAccessorDeclaration,
  GetAccessorDeclaration,
  HeritageClause,
  SourceFile,
  StringLiteral,
  NoSubstitutionTemplateLiteral,
  TemplateMiddle,
  TemplateTail,
  TypePredicateNode,
  TupleTypeNode,
  TypeLiteralNode,
  TypeOperatorNode,
  TypeQueryNode,
  TypeReferenceNode,
  UnionTypeNode,
  VariableDeclaration,
  type ExpressionWithTypeArguments,
  getAsteriskToken,
  getBody,
  getExpression,
  getInitializer,
  getMembers,
  getName,
  getParameters,
  getSymbol,
  getType,
  type EntityName,
} from '../ast.js';
import { isAmbientModule, isFunctionLike, nodeIsPresent } from '../ast-utilities.js';
import { ContainerFlags, getContainerFlags } from '../binder.js';
import {
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getRootDeclaration,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isEntityNameExpression,
  isExternalOrCommonJSModule,
  isGlobalSourceFile,
  isIdentifierNamed,
  isModuleAugmentationExternal,
  isParameterPropertyDeclaration,
  isStringOrNumericLiteralLike,
  skipParentheses,
} from '../binder-utilities.js';
import { NameResolver } from '../name-resolver.js';
import type { CompilerOptions } from '../options.js';
import { combinePaths, getDirectoryPath, getNormalizedAbsolutePath, normalizePath } from '../path.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import { isIdentifierText } from '../scanner.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import type { SyntacticEmitResolver } from './emit-resolver.js';
import type { TypeReferenceSerializationKind } from './type-serialization.js';
import type { Evaluation } from './reference-resolver.js';
import {
  DeclarationEmitResolver,
  NodeBuilderFlags,
  SymbolAccessibility,
  SymbolAccessibilityResult,
  type SymbolTracker,
  accessible,
} from './declarations-resolver.js';
import {
  DirectType,
  InferredType,
  LiteralType,
  MaybeConstType,
  NoResultType,
  ObjectLiteralType,
  PseudoChecker,
  PseudoMemberKind,
  type PseudoParameter,
  type PseudoType,
  PseudoTypeKind,
  SignatureType,
  TupleType,
  UnionType,
  collectReturnStatements,
  couldAlreadyReferToUndefined,
  isConstTypeReference,
  isInConstContext,
  lastRequiredParameterIndex,
  typesOf,
  undefinedType,
} from './declarations-pseudo.js';
import {
  addDeclaration,
  declarationCount,
  getDeclarations,
  setDeclarations,
  Symbol,
  SymbolFlags,
  type SymbolTable,
} from '../symbol.js';

const emptyTable: SymbolTable = new Map<string, Symbol>();

/** Name resolution without module resolution: an import may name anything. */
class DeclarationNameResolver extends NameResolver {
  /** Global symbols merged across files, by each file's symbol. */
  readonly mergedSymbols: Map<Symbol, Symbol>;

  constructor(options: CompilerOptions, mergedSymbols: Map<Symbol, Symbol>) {
    super(options);
    this.mergedSymbols = mergedSymbols;
  }

  getSymbolOfDeclaration(node: Node): Symbol | undefined {
    const symbol = getSymbol(node);
    return symbol === undefined ? undefined : (this.mergedSymbols.get(symbol) ?? symbol);
  }

  lookup(symbols: SymbolTable, name: string, meaning: SymbolFlags): Symbol | undefined {
    if ((meaning & SymbolFlags.All) === 0) return undefined;
    const symbol = symbols.get(name);
    if (symbol === undefined) return undefined;
    if ((symbol.flags & meaning) !== 0) return symbol;
    // The checker resolves the alias; an unresolvable one matches every meaning.
    return (symbol.flags & SymbolFlags.Alias) !== 0 ? symbol : undefined;
  }
}

/** How much of a file's declaration types needed inference. */
export class InferenceCounts {
  /** Types without annotations or literal initializers. */
  fallbacks: number;
  /** Of those, the ones written as `any` because only the checker knows them. */
  unresolved: number;

  constructor() {
    this.fallbacks = 0;
    this.unresolved = 0;
  }
}

/**
 * The files of a program by path and its globals merged across script files, as declaration emit
 * without the checker resolves names. Read-only once built, so checker threads can share one.
 */
export class DeclarationGlobals {
  readonly filesByPath: Map<string, SourceFile>;
  readonly globals: Map<string, Symbol>;
  /** Global symbols merged across files, by each file's symbol. */
  readonly mergedSymbols: Map<Symbol, Symbol>;

  constructor(files: readonly SourceFile[], currentDirectory: string) {
    this.filesByPath = new Map<string, SourceFile>();
    this.globals = new Map<string, Symbol>();
    this.mergedSymbols = new Map<Symbol, Symbol>();
    for (const file of files) {
      this.filesByPath.set(getNormalizedAbsolutePath(file.fileName, currentDirectory), file);
      if (!isExternalOrCommonJSModule(file) && file.locals !== undefined)
        mergeInto(this.globals, file.locals, this.mergedSymbols);
    }
  }
}

export class SyntacticDeclarationEmitResolver extends DeclarationEmitResolver {
  readonly options: CompilerOptions;
  readonly strictNullChecks: boolean;
  private readonly emitResolver: SyntacticEmitResolver;
  private readonly names: DeclarationNameResolver;
  private readonly pseudo: PseudoChecker;
  private readonly filesByPath: Map<string, SourceFile>;
  private readonly visibility: Map<Node, boolean>;
  private readonly aliasesMarked: Set<SourceFile>;
  /** Inference counts by file. */
  readonly inference: Map<SourceFile, InferenceCounts>;

  /**
   * `emitResolver` answers the queries of JavaScript emit and enum values. `indexed` is the program's
   * `DeclarationGlobals` if they were built before; otherwise they are built from `files`.
   */
  constructor(
    options: CompilerOptions,
    files: readonly SourceFile[],
    currentDirectory: string,
    emitResolver: SyntacticEmitResolver,
    indexed: DeclarationGlobals | undefined = undefined,
  ) {
    super();
    this.options = options;
    this.strictNullChecks =
      options.strictNullChecks !== undefined ? options.strictNullChecks : options.strict !== false;
    this.emitResolver = emitResolver;
    const index = indexed !== undefined ? indexed : new DeclarationGlobals(files, currentDirectory);
    this.names = new DeclarationNameResolver(options, index.mergedSymbols);
    this.pseudo = new PseudoChecker(this.strictNullChecks, index.mergedSymbols, this.names);
    this.filesByPath = index.filesByPath;
    this.visibility = new Map<Node, boolean>();
    this.aliasesMarked = new Set<SourceFile>();
    this.inference = new Map<SourceFile, InferenceCounts>();
    this.names.globals = index.globals;
  }

  // Emit queries

  markLinkedReferences(file: SourceFile): boolean {
    return this.emitResolver.markLinkedReferences(file);
  }

  isReferencedAliasDeclaration(node: Node): boolean {
    return this.emitResolver.isReferencedAliasDeclaration(node);
  }

  isValueAliasDeclaration(node: Node): boolean {
    return this.emitResolver.isValueAliasDeclaration(node);
  }

  isTopLevelValueImportEqualsWithEntityName(node: Node): boolean {
    return this.emitResolver.isTopLevelValueImportEqualsWithEntityName(node);
  }

  // Visibility

  precalculateDeclarationEmitVisibility(file: SourceFile): boolean {
    if (this.aliasesMarked.has(file)) return false;
    this.aliasesMarked.add(file);
    file.forEachChild(new AliasMarker(this));
    return true;
  }

  /** Marks the declarations an export names visible, following `import x = a.b` chains. */
  markLinkedAliases(node: Node): boolean {
    const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias;
    const parent = node.parent!;
    let symbol: Symbol | undefined = undefined;
    if (node.kind !== SyntaxKind.StringLiteral && parent.kind === SyntaxKind.ExportAssignment)
      symbol = this.resolveName(node, getIdentifierText(node), meaning);
    else if (parent instanceof ExportSpecifier) {
      const declaration = parent.parent!.parent!;
      if (
        declaration instanceof ExportDeclaration &&
        declaration.moduleSpecifier === undefined &&
        node instanceof Identifier &&
        node.text !== 'default'
      )
        symbol = this.resolveName(node, node.text, meaning);
    }
    const visited = new Set<Symbol>();
    while (symbol !== undefined && !visited.has(symbol)) {
      visited.add(symbol);
      let next: Symbol | undefined = undefined;
      for (const declaration of getDeclarations(symbol)) {
        this.visibility.set(declaration, true);
        if (
          declaration instanceof ImportEqualsDeclaration &&
          !(declaration.moduleReference instanceof ExternalModuleReference)
        ) {
          const first = getFirstIdentifier(declaration.moduleReference);
          next = this.resolveName(declaration, getIdentifierText(first), meaning);
        }
      }
      symbol = next;
    }
    return true;
  }

  isDeclarationVisible(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
    const cached = this.visibility.get(node);
    if (cached !== undefined) return cached;
    const visible = this.determineIfDeclarationIsVisible(node);
    this.visibility.set(node, visible);
    return visible;
  }

  private determineIfDeclarationIsVisible(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.JSDocCallbackTag:
      case SyntaxKind.JSDocTypedefTag: {
        // Top-level JSDoc type aliases are exported.
        const host = node.parent?.parent?.parent;
        return host !== undefined && host.kind === SyntaxKind.SourceFile;
      }
      case SyntaxKind.BindingElement:
        return this.isDeclarationVisible(node.parent!.parent!);
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.ImportEqualsDeclaration: {
        if (
          node instanceof VariableDeclaration &&
          node.name instanceof BindingPattern &&
          node.name.elements.nodes.length === 0
        )
          return false;
        if (isExternalModuleAugmentation(node) || isImplicitlyExportedJSDocDeclaration(node)) return true;
        const parent = getDeclarationContainer(node);
        // Unexported declarations are visible only in global files; ambient module members are exported.
        if (
          (getCombinedModifierFlags(node) & ModifierFlags.Export) === 0 &&
          !(
            node.kind !== SyntaxKind.ImportEqualsDeclaration &&
            parent.kind !== SyntaxKind.SourceFile &&
            (parent.flags & NodeFlags.Ambient) !== 0
          )
        )
          return isGlobalSourceFile(parent);
        return this.isDeclarationVisible(parent);
      }
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertySignature:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
        if (this.getEffectiveDeclarationFlags(node, ModifierFlags.Private | ModifierFlags.Protected) !== 0)
          return false;
        return this.isDeclarationVisible(node.parent!);
      case SyntaxKind.Constructor:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.CallSignature:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.Parameter:
      case SyntaxKind.ModuleBlock:
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.TypeLiteral:
      case SyntaxKind.TypeReference:
      case SyntaxKind.ArrayType:
      case SyntaxKind.TupleType:
      case SyntaxKind.UnionType:
      case SyntaxKind.IntersectionType:
      case SyntaxKind.ParenthesizedType:
      case SyntaxKind.NamedTupleMember:
        return this.isDeclarationVisible(node.parent!);
      // Imports are visible only once something refers to them.
      case SyntaxKind.ImportClause:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportSpecifier:
        return false;
      case SyntaxKind.TypeParameter:
      case SyntaxKind.SourceFile:
      case SyntaxKind.NamespaceExportDeclaration:
        return true;
      case SyntaxKind.ExportAssignment:
        return false;
      case SyntaxKind.ExportSpecifier: {
        const declaration = node.parent!.parent!;
        if (declaration instanceof ExportDeclaration && declaration.moduleSpecifier === undefined)
          return this.isDeclarationVisible(declaration.parent!);
        return false;
      }
    }
    return false;
  }

  isEntityNameVisible(entityName: Node, enclosingDeclaration: Node): SymbolAccessibilityResult {
    if ((entityName.flags & NodeFlags.Synthesized) !== 0)
      return new SymbolAccessibilityResult(SymbolAccessibility.NotAccessible, [], '', undefined, '');
    const meaning = getMeaningOfEntityNameReference(entityName);
    const first = getFirstIdentifier(entityName);
    const text = getIdentifierText(first);
    const symbol = this.resolveName(enclosingDeclaration, text, meaning);
    if (symbol !== undefined && (symbol.flags & SymbolFlags.TypeParameter) !== 0 && (meaning & SymbolFlags.Type) !== 0)
      return accessible([]);
    if (symbol === undefined && (first.kind === SyntaxKind.ThisKeyword || text === 'this')) return accessible([]);
    if (symbol === undefined)
      return new SymbolAccessibilityResult(SymbolAccessibility.NotResolved, [], text, first, '');
    const visible = this.hasVisibleDeclarations(symbol, true);
    if (visible !== undefined) return visible;
    return new SymbolAccessibilityResult(SymbolAccessibility.NotAccessible, [], text, first, '');
  }

  isSymbolAccessible(
    symbol: Symbol,
    _enclosingDeclaration: Node,
    _meaning: SymbolFlags,
    shouldComputeAliasesToMakeVisible: boolean,
  ): SymbolAccessibilityResult {
    if ((symbol.flags & SymbolFlags.TypeParameter) !== 0) return accessible([]);
    const visible = this.hasVisibleDeclarations(symbol, shouldComputeAliasesToMakeVisible);
    if (visible !== undefined) return visible;
    return new SymbolAccessibilityResult(SymbolAccessibility.NotAccessible, [], symbol.name, undefined, '');
  }

  /** Accessible if every declaration is visible or can be made so by keeping an unexported statement. */
  private hasVisibleDeclarations(
    symbol: Symbol,
    shouldComputeAliasesToMakeVisible: boolean,
  ): SymbolAccessibilityResult | undefined {
    const aliases: Node[] = [];
    for (const declaration of getDeclarations(symbol)) {
      if (declaration.kind === SyntaxKind.Identifier || this.isDeclarationVisible(declaration)) continue;
      let statement: Node | undefined = undefined;
      // Imports and unexported declarations can name types if their parent is visible.
      const anyImport = getAnyImportSyntax(declaration);
      if (
        anyImport !== undefined &&
        !hasSyntacticModifier(anyImport, ModifierFlags.Export) &&
        this.isDeclarationVisible(anyImport.parent!)
      )
        statement = anyImport;
      else if (
        declaration instanceof VariableDeclaration &&
        declaration.parent!.parent!.kind === SyntaxKind.VariableStatement &&
        !hasSyntacticModifier(declaration.parent!.parent!, ModifierFlags.Export) &&
        this.isDeclarationVisible(declaration.parent!.parent!.parent!)
      )
        statement = declaration.parent!.parent!;
      else if (
        isLateVisibilityPaintedStatement(declaration) &&
        !hasSyntacticModifier(declaration, ModifierFlags.Export) &&
        this.isDeclarationVisible(declaration.parent!)
      )
        statement = declaration;
      else if (declaration instanceof BindingElement && (symbol.flags & SymbolFlags.BlockScopedVariable) !== 0) {
        const root = getRootDeclaration(declaration);
        if (root.kind === SyntaxKind.Parameter) return undefined;
        const variableStatement = root.parent?.parent;
        if (variableStatement === undefined || variableStatement.kind !== SyntaxKind.VariableStatement)
          return undefined;
        // Already exported: nothing to keep.
        if (hasSyntacticModifier(variableStatement, ModifierFlags.Export)) continue;
        if (!this.isDeclarationVisible(variableStatement.parent!)) return undefined;
        statement = variableStatement;
      }
      if (statement === undefined) return undefined;
      if (shouldComputeAliasesToMakeVisible) {
        this.visibility.set(declaration, true);
        if (aliases.indexOf(statement) < 0) aliases.push(statement);
      }
    }
    return accessible(aliases);
  }

  isNameResolvable(location: Node, name: string): boolean {
    return this.resolveName(location, name, SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace) !== undefined;
  }

  // Modules aren't resolved, so no import is known to be needed by an augmentation.
  isImportRequiredByAugmentation(_node: ImportDeclaration): boolean {
    return false;
  }

  // Declarations

  getEffectiveDeclarationFlags(node: Node, flags: ModifierFlags): ModifierFlags {
    let result = getCombinedModifierFlags(node);
    const parent = node.parent;
    // Class and interface members are never implicitly exported or ambient.
    if (
      parent !== undefined &&
      parent.kind !== SyntaxKind.InterfaceDeclaration &&
      parent.kind !== SyntaxKind.ClassDeclaration &&
      parent.kind !== SyntaxKind.ClassExpression &&
      (node.flags & NodeFlags.Ambient) !== 0
    ) {
      const container = getEnclosingContainer(node);
      if (
        container !== undefined &&
        (container.flags & NodeFlags.ExportContext) !== 0 &&
        (result & ModifierFlags.Ambient) === 0 &&
        !(parent.kind === SyntaxKind.ModuleBlock && isGlobalScopeAugmentation(parent.parent!))
      )
        result |= ModifierFlags.Export;
      result |= ModifierFlags.Ambient;
    }
    return result & flags;
  }

  isImplementationOfOverload(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0 || !nodeIsPresent(getBody(node))) return false;
    if (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor) return false;
    const symbol = this.getSymbolOfDeclaration(node);
    if (symbol === undefined) return false;
    const signatures: Node[] = [];
    const declarations = getDeclarations(symbol);
    for (let i = 0; i < declarations.length; i++) {
      const declaration = declarations[i]!;
      if (!isFunctionLike(declaration)) continue;
      // An implementation directly after an overload of the same kind isn't a signature.
      if (i > 0 && getBody(declaration) !== undefined) {
        const previous = declarations[i - 1]!;
        if (
          declaration.parent === previous.parent &&
          declaration.kind === previous.kind &&
          declaration.pos === previous.end
        )
          continue;
      }
      signatures.push(declaration);
    }
    if (signatures.length > 1) return true;
    return signatures.length === 1 && signatures[0] !== node && (signatures[0].flags & NodeFlags.JSDoc) === 0;
  }

  isLateBound(node: Node): boolean {
    const name = getName(node);
    if (!(name instanceof ComputedPropertyName)) return false;
    return this.isLateBindableExpression(name.expression);
  }

  /** Whether a computed name's expression has a unique symbol or literal type, as far as declarations say. */
  private isLateBindableExpression(expression: Node): boolean {
    if (!isEntityNameExpression(expression, false)) return false;
    const declaration = this.getEntityDeclaration(expression);
    return declaration !== undefined && hasLiteralOrUniqueSymbolType(declaration);
  }

  /** The declaration `a` or `a.b.c` names: a variable, a member of a namespace, class or enum, or of an object type or literal. */
  private getEntityDeclaration(node: Node): Node | undefined {
    if (node instanceof Identifier) {
      const symbol = this.resolveName(node, node.text, SymbolFlags.Value | SymbolFlags.ExportValue);
      if (symbol === undefined) return undefined;
      const resolved = symbol.exportSymbol ?? symbol;
      return resolved.valueDeclaration ?? (declarationCount(resolved) > 0 ? resolved.declaration! : undefined);
    }
    if (!(node instanceof PropertyAccessExpression) || !(node.name instanceof Identifier)) return undefined;
    const name = node.name.text;
    const left = node.expression;
    if (left.kind === SyntaxKind.Identifier || left.kind === SyntaxKind.PropertyAccessExpression) {
      const symbol = this.resolveEntityNameExpression(left, SymbolFlags.Value | SymbolFlags.Namespace);
      if (symbol !== undefined && (symbol.flags & SymbolFlags.Alias) === 0) {
        const member = (symbol.exports ?? emptyTable).get(name);
        if (member !== undefined) return member.valueDeclaration;
      }
    }
    // A member of a variable's object type or object literal.
    const container = this.getEntityDeclaration(left);
    if (!(container instanceof VariableDeclaration)) return undefined;
    const members =
      container.type instanceof TypeLiteralNode
        ? container.type.members.nodes
        : container.initializer !== undefined
          ? objectLiteralProperties(container.initializer)
          : [];
    for (const member of members) {
      const memberName = getName(member);
      if (memberName !== undefined && tryGetTextOfPropertyName(memberName) === name) return member;
    }
    return undefined;
  }

  isDefinitelyReferenceToGlobalSymbolObject(node: Node): boolean {
    if (!(node instanceof PropertyAccessExpression) || !(node.name instanceof Identifier)) return false;
    const expression = node.expression;
    if (expression instanceof Identifier)
      return expression.text === 'Symbol' && this.isGlobalValue(expression, 'Symbol');
    if (!(expression instanceof PropertyAccessExpression) || !(expression.expression instanceof Identifier))
      return false;
    return (
      expression.expression.text === 'globalThis' &&
      isIdentifierNamed(expression.name, 'Symbol') &&
      this.resolveName(expression.expression, 'globalThis', SymbolFlags.Value) === undefined
    );
  }

  /** Whether `name` at `location` resolves to a declaration of a global file. */
  private isGlobalValue(location: Node, name: string): boolean {
    const symbol = this.resolveName(location, name, SymbolFlags.Value);
    return symbol !== undefined && this.pseudo.getMergedSymbol(symbol) === this.names.globals.get(name);
  }

  isLiteralConstDeclaration(node: Node): boolean {
    if ((node.flags & NodeFlags.Synthesized) !== 0) return false;
    const isConst =
      node instanceof VariableDeclaration
        ? (getCombinedNodeFlags(node) & NodeFlags.Const) !== 0
        : (getCombinedModifierFlags(node) & ModifierFlags.Readonly) !== 0 &&
          !isParameterPropertyDeclaration(node, node.parent!);
    if (!isConst || getType(node) !== undefined) return false;
    const initializer = getInitializer(node);
    // A fresh literal type; enum members are too, but need the checker to tell apart.
    return initializer !== undefined && literalOf(skipParentheses(initializer)) !== undefined;
  }

  isOptionalParameter(node: Node): boolean {
    if (!(node instanceof ParameterDeclaration)) return false;
    if (node.questionToken !== undefined) return true;
    if (node.initializer === undefined) return false;
    const parameters = getParameters(node.parent!)!.nodes;
    return parameters.indexOf(node) >= lastRequiredParameterIndex(parameters);
  }

  requiresAddingImplicitUndefined(node: Node, enclosingDeclaration: Node | undefined): boolean {
    if (node === undefined || !(node instanceof ParameterDeclaration) || (node.flags & NodeFlags.Synthesized) !== 0)
      return false;
    const required =
      this.isRequiredInitializedParameter(node, enclosingDeclaration) ||
      this.isOptionalUninitializedParameterProperty(node);
    return required && !this.declaredTypeContainsUndefined(node);
  }

  private isRequiredInitializedParameter(node: ParameterDeclaration, enclosingDeclaration: Node | undefined): boolean {
    if (!this.strictNullChecks || this.isOptionalParameter(node) || node.initializer === undefined) return false;
    if (hasSyntacticModifier(node, ModifierFlags.ParameterPropertyModifier))
      return enclosingDeclaration !== undefined && isFunctionLike(enclosingDeclaration);
    return true;
  }

  private isOptionalUninitializedParameterProperty(node: ParameterDeclaration): boolean {
    return (
      this.strictNullChecks &&
      this.isOptionalParameter(node) &&
      node.initializer === undefined &&
      hasSyntacticModifier(node, ModifierFlags.ParameterPropertyModifier)
    );
  }

  /** Whether an annotation includes `undefined`, or names something unresolved (an error type). */
  private declaredTypeContainsUndefined(node: ParameterDeclaration): boolean {
    const type = node.type;
    return type !== undefined && this.typeContainsUndefined(type, node);
  }

  private typeContainsUndefined(type: Node, location: Node): boolean {
    switch (type.kind) {
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
        return true;
      case SyntaxKind.ParenthesizedType:
        return this.typeContainsUndefined(getType(type)!, location);
      case SyntaxKind.UnionType:
        for (const member of typesOf(type)) if (this.typeContainsUndefined(member, location)) return true;
        return false;
      case SyntaxKind.TypeReference: {
        // An unresolved name or import is an error type, which counts as containing `undefined`.
        const symbol = this.resolveName(
          location,
          getIdentifierText(getFirstIdentifier((type as TypeReferenceNode).typeName)),
          SymbolFlags.Type | SymbolFlags.Namespace,
        );
        return symbol === undefined || (symbol.flags & SymbolFlags.Alias) !== 0;
      }
    }
    return false;
  }

  isExpandoFunctionDeclaration(node: Node): boolean {
    return this.getExpandoPropertyDeclarations(node).length > 0;
  }

  getExpandoPropertyDeclarations(node: Node): Node[] {
    const result: Node[] = [];
    let host: Node | undefined = node;
    // Properties assigned to a function-valued variable are bound to the function.
    if (node instanceof VariableDeclaration) host = node.initializer;
    else if (node.kind !== SyntaxKind.FunctionDeclaration) host = undefined;
    if (host === undefined || !isFunctionLike(host)) return result;
    const symbol = getSymbol(host);
    if (symbol === undefined || symbol.exports === undefined) return result;
    for (const property of symbol.exports.values())
      if ((property.flags & SymbolFlags.Assignment) !== 0 && property.valueDeclaration !== undefined)
        result.push(property.valueDeclaration);
    return result;
  }

  // Emit queries answered by the reference resolver.

  getReferencedExportContainer(node: Identifier, prefixLocals: boolean): Node | undefined {
    return this.emitResolver.getReferencedExportContainer(node, prefixLocals);
  }

  getReferencedImportDeclaration(node: Identifier): Node | undefined {
    return this.emitResolver.getReferencedImportDeclaration(node);
  }

  getReferencedValueDeclaration(node: Identifier): Node | undefined {
    return this.emitResolver.getReferencedValueDeclaration(node);
  }

  getReferencedValueDeclarations(node: Identifier): Node[] | undefined {
    return this.emitResolver.getReferencedValueDeclarations(node);
  }

  getEnumMemberValue(member: Node): Evaluation {
    return this.emitResolver.getEnumMemberValue(member);
  }

  getConstantValue(node: Node): Evaluation {
    return this.emitResolver.getConstantValue(node);
  }

  setReferencedImportDeclaration(name: Identifier, declaration: Node): void {
    this.emitResolver.setReferencedImportDeclaration(name, declaration);
  }

  getJsxFactoryEntity(file: SourceFile): EntityName | undefined {
    return this.emitResolver.getJsxFactoryEntity(file);
  }

  getJsxFragmentFactoryEntity(file: SourceFile): EntityName | undefined {
    return this.emitResolver.getJsxFragmentFactoryEntity(file);
  }

  getTypeReferenceSerializationKind(typeName: Node, location: Node | undefined): TypeReferenceSerializationKind {
    return this.emitResolver.getTypeReferenceSerializationKind(typeName, location);
  }

  getSourceFileFromReference(file: SourceFile, reference: FileReference): SourceFile | undefined {
    const path = normalizePath(combinePaths(getDirectoryPath(file.fileName), reference.fileName));
    for (const candidate of [path, path + '.ts', path + '.tsx', path + '.d.ts']) {
      const found = this.filesByPath.get(candidate);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // JavaScript members need the checker.

  getReferencedMemberValueDeclaration(node: Node): Node | undefined {
    const symbol = getSymbol(node);
    return symbol === undefined ? undefined : symbol.valueDeclaration;
  }

  isThisPropertyAssignmentDeclarationRedundant(_node: Node): boolean {
    return false;
  }

  getElementAccessExpressionName(node: Node): string {
    if (!(node instanceof ElementAccessExpression)) return '';
    const argument = node.argumentExpression;
    return isStringOrNumericLiteralLike(argument) ? literalText(argument) : '';
  }

  // Type nodes

  createTypeOfDeclaration(
    context: EmitContext,
    declaration: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    if ((declaration.flags & NodeFlags.Synthesized) !== 0) return undefined;
    const writer = new PseudoTypeWriter(this, context, tracker, enclosingDeclaration, flags);
    const isAccessor = declaration.kind === SyntaxKind.GetAccessor || declaration.kind === SyntaxKind.SetAccessor;
    this.pseudo.uncertain = 0;
    let type = isAccessor ? this.pseudo.getTypeOfAccessor(declaration) : this.pseudo.getTypeOfDeclaration(declaration);
    if (
      declaration.kind === SyntaxKind.Parameter &&
      this.requiresAddingImplicitUndefined(declaration, enclosingDeclaration) &&
      !this.pseudoContainsUndefined(type)
    )
      type = new UnionType([type, undefinedType]);
    const result = writer.write(type);
    // Declarations merged across files have the type of their first declaration.
    if (this.pseudo.uncertain > 0 || this.hasMergedDeclarations(declaration)) this.countFallback(declaration, true);
    return result;
  }

  private hasMergedDeclarations(declaration: Node): boolean {
    const symbol = getSymbol(declaration);
    return symbol !== undefined && declarationCount(this.pseudo.getMergedSymbol(symbol)) > declarationCount(symbol);
  }

  /** Whether a parameter's pseudo-type already has `undefined`, so none is added. */
  private pseudoContainsUndefined(type: PseudoType): boolean {
    if (type instanceof UnionType) {
      for (const member of type.types) if (this.pseudoContainsUndefined(member)) return true;
      return false;
    }
    if (type instanceof DirectType)
      return couldAlreadyReferToUndefined(type) && type.typeNode.kind !== SyntaxKind.TypeReference;
    return type.kind === PseudoTypeKind.Undefined;
  }

  createReturnTypeOfSignatureDeclaration(
    context: EmitContext,
    signature: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    if ((signature.flags & NodeFlags.Synthesized) !== 0) return undefined;
    const type = this.pseudo.getReturnTypeOfSignature(signature);
    const writer = new PseudoTypeWriter(this, context, tracker, enclosingDeclaration, flags);
    if (type instanceof InferredType && type.isSignatureReturn && type.errorNodes.length === 0) {
      // A body without returned values is `void`, as the checker infers.
      const inferredVoid = isTriviallyVoid(signature);
      if (inferredVoid) {
        writer.reportFallback(type, false);
        return context.factory.created(new KeywordTypeNode(SyntaxKind.VoidKeyword));
      }
    }
    if (type instanceof NoResultType && getBody(signature) === undefined && signature.kind !== SyntaxKind.GetAccessor) {
      // A signature without a body or annotation returns `any`.
      writer.reportFallback(type, false);
      return undefined;
    }
    return writer.write(type);
  }

  createTypeParametersOfSignatureDeclaration(
    _context: EmitContext,
    signature: Node,
    _enclosingDeclaration: Node,
    _flags: NodeBuilderFlags,
    _tracker: SymbolTracker,
  ): Node[] | undefined {
    this.countFallback(signature, true);
    return undefined;
  }

  createLiteralConstValue(context: EmitContext, node: Node, _tracker: SymbolTracker): Node | undefined {
    const initializer = node.kind === SyntaxKind.ExportAssignment ? getExpression(node) : getInitializer(node);
    if (initializer === undefined) return undefined;
    const literal = literalOf(skipParentheses(initializer));
    if (literal === undefined) {
      this.countFallback(node, true);
      return undefined;
    }
    const factory = context.factory;
    switch (literal.kind) {
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        return factory.createKeywordExpression(literal.kind);
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return factory.createStringLiteral(literalText(literal), TokenFlags.None);
      case SyntaxKind.BigIntLiteral:
        return factory.created(new BigIntLiteral((literal as BigIntLiteral).text, TokenFlags.None));
      case SyntaxKind.NumericLiteral:
        return createNumberExpression(context, Number((literal as NumericLiteral).text));
      case SyntaxKind.PrefixUnaryExpression: {
        const unary = literal as PrefixUnaryExpression;
        const operand = unary.operand;
        if (operand instanceof BigIntLiteral)
          return factory.created(
            new BigIntLiteral(
              unary.operator === SyntaxKind.MinusToken ? '-' + operand.text : operand.text,
              TokenFlags.None,
            ),
          );
        const value = Number((operand as NumericLiteral).text);
        return createNumberExpression(context, unary.operator === SyntaxKind.MinusToken ? -value : value);
      }
    }
    return undefined;
  }

  createTypeOfExpression(
    context: EmitContext,
    expression: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node | undefined {
    const writer = new PseudoTypeWriter(this, context, tracker, enclosingDeclaration, flags);
    this.countFallback(expression, true);
    // An expression's own type: literals aren't widened.
    const type = this.pseudo.getTypeOfExpression(expression);
    return writer.write(type instanceof MaybeConstType ? type.constType : type);
  }

  createLateBoundIndexSignatures(
    context: EmitContext,
    container: Node,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
    tracker: SymbolTracker,
  ): Node[] {
    // These come from computed names whose types aren't literals or unique symbols; only the
    // checker knows them. Writing them reports their members' types that need inference.
    const members = getMembers(container);
    if (members === undefined) return [];
    const writer = new PseudoTypeWriter(this, context, tracker, enclosingDeclaration, flags);
    for (const member of members.nodes) {
      const name = getName(member);
      if (!(name instanceof ComputedPropertyName) || !isEntityNameExpression(name.expression, false)) continue;
      if (this.isLateBindableExpression(name.expression)) continue;
      this.countFallback(member, true);
      if (isFunctionLike(member) && getType(member) === undefined && member.kind !== SyntaxKind.SetAccessor)
        writer.write(this.pseudo.getReturnTypeOfSignature(member));
      else if (member.kind === SyntaxKind.PropertyDeclaration && getType(member) === undefined)
        writer.write(this.pseudo.getTypeOfDeclaration(member));
    }
    return [];
  }

  tryJSTypeNodeToTypeNode(
    _context: EmitContext,
    typeNode: Node,
    _enclosingDeclaration: Node,
    _flags: NodeBuilderFlags,
    _tracker: SymbolTracker,
  ): Node | undefined {
    // JSDoc types are rewritten with their meaning (`String` is `string`), which needs symbols.
    this.countFallback(typeNode, true);
    return undefined;
  }

  // Helpers

  /** The symbol of a declaration, merged with same-named globals of other files. */
  getSymbolOfDeclaration(node: Node): Symbol | undefined {
    const symbol = getSymbol(node);
    return symbol === undefined ? undefined : this.pseudo.getMergedSymbol(symbol);
  }

  resolveName(location: Node, name: string, meaning: SymbolFlags): Symbol | undefined {
    return this.names.resolve(location, name, meaning, undefined, false, false);
  }

  /** The symbol of `a` or `a.b.c`, looking members up in namespace and enum exports. */
  resolveEntityNameExpression(node: Node, meaning: SymbolFlags): Symbol | undefined {
    if (node instanceof Identifier) return this.resolveName(node, node.text, meaning);
    let left: Node | undefined = undefined;
    let right: Node | undefined = undefined;
    if (node instanceof PropertyAccessExpression) {
      left = node.expression;
      right = node.name;
    } else if (node instanceof QualifiedName) {
      left = node.left;
      right = node.right;
    }
    if (left !== undefined && right !== undefined) {
      const namespace = this.resolveEntityNameExpression(left, SymbolFlags.Namespace);
      if (namespace === undefined || (namespace.flags & SymbolFlags.Alias) !== 0 || !(right instanceof Identifier))
        return undefined;
      const member = (namespace.exports ?? emptyTable).get(right.text);
      return member !== undefined && (member.flags & meaning) !== 0 ? member : undefined;
    }
    return undefined;
  }

  /** Records a type that needed inference; `unresolved` if it's written as `any`. */
  countFallback(node: Node, unresolved: boolean): boolean {
    const file = getSourceFileOfNode(node);
    let counts = this.inference.get(file);
    if (counts === undefined) {
      counts = new InferenceCounts();
      this.inference.set(file, counts);
    }
    counts.fallbacks++;
    if (unresolved) counts.unresolved++;
    return true;
  }
}

/** Writes pseudo-types as type nodes; types that need inference make the result undefined. */
class PseudoTypeWriter {
  readonly resolver: SyntacticDeclarationEmitResolver;
  readonly context: EmitContext;
  readonly tracker: SymbolTracker;
  readonly enclosingDeclaration: Node;
  readonly flags: NodeBuilderFlags;
  /** Whether a reused node names something that can't be named where it's written. */
  private reuseFailed: boolean;

  constructor(
    resolver: SyntacticDeclarationEmitResolver,
    context: EmitContext,
    tracker: SymbolTracker,
    enclosingDeclaration: Node,
    flags: NodeBuilderFlags,
  ) {
    this.resolver = resolver;
    this.context = context;
    this.tracker = tracker;
    this.enclosingDeclaration = enclosingDeclaration;
    this.flags = flags;
    this.reuseFailed = false;
  }

  /** Reports where inference was needed, as the checker's node builder does. */
  reportFallback(type: PseudoType, unresolved: boolean): boolean {
    let location: Node;
    if (type instanceof InferredType) {
      if (type.errorNodes.length > 0) {
        for (const node of type.errorNodes) this.tracker.reportInferenceFallback(node);
        return this.resolver.countFallback(type.errorNodes[0]!, unresolved);
      }
      const expression = type.expression;
      const parent = expression.parent;
      location =
        isEntityNameExpression(expression, false) && parent !== undefined && isDeclarationKind(parent.kind)
          ? parent
          : expression;
    } else if (type instanceof NoResultType) location = type.declaration;
    else return false;
    this.tracker.reportInferenceFallback(location);
    return this.resolver.countFallback(location, unresolved);
  }

  write(type: PseudoType): Node | undefined {
    const factory = this.context.factory;
    switch (type.kind) {
      case PseudoTypeKind.Direct:
        return this.reuseTypeNode((type as DirectType).typeNode);
      case PseudoTypeKind.Inferred: {
        const inferred = type as InferredType;
        // A body without returned values is `void`, as the checker infers.
        if (inferred.isSignatureReturn && inferred.errorNodes.length === 0 && isTriviallyVoid(inferred.expression)) {
          this.reportFallback(type, false);
          return this.keyword(SyntaxKind.VoidKeyword);
        }
        this.reportFallback(type, true);
        return undefined;
      }
      case PseudoTypeKind.NoResult:
        this.reportFallback(type, true);
        return undefined;
      case PseudoTypeKind.MaybeConstLocation: {
        const maybe = type as MaybeConstType;
        return this.write(isInConstContext(maybe.node) ? maybe.constType : maybe.regularType);
      }
      case PseudoTypeKind.Union:
        if (type instanceof UnionType) {
          const narrowed: UnionType = type;
          return this.writeUnion(narrowed);
        }
        break;
      case PseudoTypeKind.Undefined:
        return this.keyword(this.resolver.strictNullChecks ? SyntaxKind.UndefinedKeyword : SyntaxKind.AnyKeyword);
      case PseudoTypeKind.Null:
        if (!this.resolver.strictNullChecks) return this.keyword(SyntaxKind.AnyKeyword);
        return factory.created(new LiteralTypeNode(factory.createKeywordExpression(SyntaxKind.NullKeyword)));
      case PseudoTypeKind.Any:
        return this.keyword(SyntaxKind.AnyKeyword);
      case PseudoTypeKind.String:
        return this.keyword(SyntaxKind.StringKeyword);
      case PseudoTypeKind.Number:
        return this.keyword(SyntaxKind.NumberKeyword);
      case PseudoTypeKind.BigInt:
        return this.keyword(SyntaxKind.BigIntKeyword);
      case PseudoTypeKind.Boolean:
        return this.keyword(SyntaxKind.BooleanKeyword);
      case PseudoTypeKind.False:
        return factory.created(new LiteralTypeNode(factory.createKeywordExpression(SyntaxKind.FalseKeyword)));
      case PseudoTypeKind.True:
        return factory.created(new LiteralTypeNode(factory.createKeywordExpression(SyntaxKind.TrueKeyword)));
      case PseudoTypeKind.SingleCallSignature:
        if (type instanceof SignatureType) {
          const narrowed: SignatureType = type;
          return this.writeSignature(narrowed);
        }
        break;
      case PseudoTypeKind.Tuple:
        if (type instanceof TupleType) {
          const narrowed: TupleType = type;
          return this.writeTuple(narrowed);
        }
        break;
      case PseudoTypeKind.ObjectLiteral:
        if (type instanceof ObjectLiteralType) {
          const narrowed: ObjectLiteralType = type;
          return this.writeObjectLiteral(narrowed);
        }
        break;
      case PseudoTypeKind.StringLiteral:
      case PseudoTypeKind.NumericLiteral:
      case PseudoTypeKind.BigIntLiteral:
        return factory.created(new LiteralTypeNode(this.reuseNode((type as LiteralType).node)));
    }
    return undefined;
  }

  private keyword(kind: SyntaxKind): Node {
    return this.context.factory.created(new KeywordTypeNode(kind));
  }

  private writeUnion(type: UnionType): Node | undefined {
    const result: Node[] = [];
    let hasElided = false;
    let failed = false;
    for (const member of type.types) {
      if (
        !this.resolver.strictNullChecks &&
        (member.kind === PseudoTypeKind.Undefined || member.kind === PseudoTypeKind.Null)
      ) {
        hasElided = true;
        continue;
      }
      const node = this.write(member);
      if (node === undefined) failed = true;
      else appendUnionMember(result, node);
    }
    if (failed) return undefined;
    if (result.length === 1) return result[0]!;
    if (result.length === 0) return this.keyword(hasElided ? SyntaxKind.AnyKeyword : SyntaxKind.NeverKeyword);
    return this.context.factory.created(new UnionTypeNode(this.context.factory.createNodeList(result)));
  }

  private writeSignature(type: SignatureType): Node | undefined {
    const factory = this.context.factory;
    const typeParameters: Node[] = [];
    for (const parameter of type.typeParameters) typeParameters.push(this.reuseNode(parameter));
    const parameters = this.writeParameters(type.parameters);
    const returnType = this.write(type.returnType);
    if (parameters === undefined || returnType === undefined) return undefined;
    return factory.created(
      new FunctionTypeNode(
        typeParameters.length > 0 ? factory.createNodeList(typeParameters) : undefined,
        parameters,
        returnType,
      ),
    );
  }

  // Writers of composite types write every part, so each part needing inference is reported.

  private writeParameters(parameters: PseudoParameter[]): NodeList | undefined {
    const result: Node[] = [];
    let failed = false;
    for (const parameter of parameters) {
      const node = this.writeParameter(parameter);
      if (node === undefined) failed = true;
      else result.push(node);
    }
    return failed ? undefined : this.context.factory.createNodeList(result);
  }

  private writeParameter(parameter: PseudoParameter): Node | undefined {
    const factory = this.context.factory;
    const type = this.write(parameter.type);
    if (type === undefined) return undefined;
    const result = factory.created(
      new ParameterDeclaration(
        undefined,
        parameter.rest ? factory.createToken(SyntaxKind.DotDotDotToken) : undefined,
        this.cloneParameterName(parameter.name),
        parameter.optional ? factory.createToken(SyntaxKind.QuestionToken) : undefined,
        type,
        undefined,
      ),
    );
    const original = parameter.name.parent;
    if (original !== undefined && original.kind === SyntaxKind.Parameter)
      this.context.assignCommentRange(result, original);
    return result;
  }

  /** Parameter names are rewritten from scratch: identifiers as is, binding patterns without initializers. */
  private cloneParameterName(name: Node): Node {
    // Rewritten names have no source positions.
    const clone = name.deepClone();
    clearPositions(clone);
    if (clone instanceof BindingPattern) {
      stripBindingInitializers(clone);
      this.context.setEmitFlags(clone, EmitFlags.SingleLine | EmitFlags.NoAsciiEscaping);
    } else this.context.setEmitFlags(clone, EmitFlags.NoAsciiEscaping);
    return clone;
  }

  private writeTuple(type: TupleType): Node | undefined {
    const factory = this.context.factory;
    const elements: Node[] = [];
    let failed = false;
    for (const element of type.elements) {
      const node = this.write(element);
      if (node === undefined) failed = true;
      else elements.push(node);
    }
    if (failed) return undefined;
    const tuple = factory.created(new TupleTypeNode(factory.createNodeList(elements)));
    this.context.addEmitFlags(tuple, EmitFlags.SingleLine);
    // `as const` arrays are readonly.
    return factory.created(new TypeOperatorNode(SyntaxKind.ReadonlyKeyword, tuple));
  }

  private writeObjectLiteral(type: ObjectLiteralType): Node | undefined {
    const factory = this.context.factory;
    const members = type.members;
    if (members.length === 0) {
      const empty = factory.created(new TypeLiteralNode(factory.createNodeList([])));
      this.context.addEmitFlags(empty, EmitFlags.SingleLine);
      return empty;
    }
    const isConst = isInConstContext(members[0].name.parent!.parent!);
    const result: Node[] = [];
    let failed = false;
    for (const member of members) {
      const modifiers =
        isConst || (member.kind === PseudoMemberKind.Property && member.readonly)
          ? factory.createModifierList([factory.createToken(SyntaxKind.ReadonlyKeyword)])
          : undefined;
      let node: Node | undefined = undefined;
      switch (member.kind) {
        case PseudoMemberKind.Method: {
          const typeParameters: Node[] = [];
          for (const parameter of member.typeParameters) typeParameters.push(this.reuseNode(parameter));
          const typeParameterList = typeParameters.length > 0 ? factory.createNodeList(typeParameters) : undefined;
          const parameters = this.writeParameters(member.parameters);
          const returnType = this.write(member.type);
          if (parameters === undefined || returnType === undefined) break;
          node = isConst
            ? factory.created(
                new PropertySignatureDeclaration(
                  modifiers,
                  this.reuseName(member.name, false),
                  undefined,
                  factory.created(new FunctionTypeNode(typeParameterList, parameters, returnType)),
                  undefined,
                ),
              )
            : factory.created(
                new MethodSignatureDeclaration(
                  modifiers,
                  this.reuseName(member.name, true),
                  undefined,
                  typeParameterList,
                  parameters,
                  returnType,
                ),
              );
          break;
        }
        case PseudoMemberKind.Property: {
          const propertyType = this.write(member.type);
          if (propertyType === undefined) break;
          node = factory.created(
            new PropertySignatureDeclaration(
              modifiers,
              this.reuseName(member.name, false),
              undefined,
              propertyType,
              undefined,
            ),
          );
          break;
        }
        case PseudoMemberKind.SetAccessor: {
          const parameters = this.writeParameters(member.parameters);
          if (parameters === undefined) break;
          node = factory.created(
            new SetAccessorDeclaration(
              undefined,
              this.reuseName(member.name, false),
              undefined,
              parameters,
              undefined,
              undefined,
              undefined,
            ),
          );
          break;
        }
        case PseudoMemberKind.GetAccessor: {
          const accessorType = this.write(member.type);
          if (accessorType === undefined) break;
          node = factory.created(
            new GetAccessorDeclaration(
              undefined,
              this.reuseName(member.name, false),
              undefined,
              factory.createNodeList([]),
              accessorType,
              undefined,
              undefined,
            ),
          );
          break;
        }
      }
      if (node === undefined) {
        failed = true;
        continue;
      }
      const declaration = member.name.parent!;
      this.context.setCommentRange(node, declaration.pos, declaration.end);
      result.push(node);
    }
    if (failed) return undefined;
    const literal = factory.created(new TypeLiteralNode(factory.createNodeList(result)));
    if ((this.flags & NodeBuilderFlags.MultilineObjectLiterals) === 0)
      this.context.addEmitFlags(literal, EmitFlags.SingleLine);
    return literal;
  }

  /** A property name, as an identifier when it can be one. */
  private reuseName(name: Node, isMethod: boolean): Node {
    const result = this.reuseNode(name);
    const text = tryGetTextOfPropertyName(result);
    if (text === undefined) return result;
    const kind = classifyPropertyName(text, result.kind === SyntaxKind.StringLiteral, isMethod);
    if (result.kind === SyntaxKind.Identifier && kind === PropertyNameKind.Identifier) return result;
    if (result.kind === SyntaxKind.StringLiteral && kind === PropertyNameKind.StringLiteral) return result;
    let renamed: Node;
    if (kind === PropertyNameKind.Identifier) renamed = this.context.factory.createIdentifier(text);
    else if (kind === PropertyNameKind.StringLiteral)
      renamed = this.context.factory.createStringLiteral(text, TokenFlags.None);
    else return result;
    this.context.setOriginal(renamed, result);
    renamed.pos = result.pos;
    renamed.end = result.end;
    return renamed;
  }

  /** A copy of an expression or type parameter from the source. */
  private reuseNode(node: Node): Node {
    this.trackEntityNames(node);
    const clone = node.deepClone();
    styleReusedNodes(this.context, clone);
    return clone;
  }

  /** A copy of an annotation, with the names it uses checked and their imports kept; undefined if one can't be named. */
  reuseTypeNode(node: Node): Node | undefined {
    const failed = this.reuseFailed;
    this.reuseFailed = false;
    const result = this.reuseNode(node);
    const reused = !this.reuseFailed;
    this.reuseFailed = failed || !reused;
    if (reused) return result;
    // The checker writes the type the annotation denotes instead.
    this.tracker.reportInferenceFallback(node);
    this.resolver.countFallback(node, true);
    return undefined;
  }

  private trackEntityNames(node: Node): boolean {
    this.markJSDocType(node);
    node.forEachChild(new EntityNameTracker(this));
    return this.trackEntityName(node);
  }

  /** JSDoc types such as `?T` can't be reused as written. */
  markJSDocType(node: Node): boolean {
    if (node.kind >= SyntaxKind.FirstJSDocNode && node.kind <= SyntaxKind.LastJSDocNode) this.reuseFailed = true;
    return true;
  }

  trackEntityName(node: Node): boolean {
    let name: Node | undefined = undefined;
    if (node instanceof TypeReferenceNode) name = node.typeName;
    else if (node instanceof TypeQueryNode) name = node.exprName;
    else if (node.kind === SyntaxKind.ExpressionWithTypeArguments)
      name = (node as ExpressionWithTypeArguments).expression;
    if (name === undefined || !(isEntityNameExpression(name, false) || name instanceof QualifiedName)) return false;
    const first = getFirstIdentifier(name);
    if (!(first instanceof Identifier)) return false;
    const meaning = getMeaningOfEntityNameReference(name);
    const symbol = this.resolver.resolveName(first, first.text, meaning);
    if (symbol === undefined || isSignatureLocal(symbol)) return false;
    // `typeof x` in the declaration of `x` is circular.
    const declaration = symbol.valueDeclaration;
    if (
      node instanceof TypeQueryNode &&
      declaration !== undefined &&
      declaration.pos <= node.pos &&
      node.end <= declaration.end &&
      getSourceFileOfNode(declaration) === getSourceFileOfNode(node)
    ) {
      this.reuseFailed = true;
      return false;
    }
    const result = this.resolver.isSymbolAccessible(symbol, this.enclosingDeclaration, meaning, false);
    if (result.accessibility !== SymbolAccessibility.Accessible) {
      this.reuseFailed = true;
      return false;
    }
    return this.tracker.trackSymbol(symbol, this.enclosingDeclaration, meaning);
  }
}

/** Parameters and type parameters are in scope where the signature's types are written. */
function isSignatureLocal(symbol: Symbol): boolean {
  const declaration = symbol.valueDeclaration ?? (declarationCount(symbol) > 0 ? symbol.declaration : undefined);
  return (
    declaration !== undefined &&
    (declaration.kind === SyntaxKind.Parameter || declaration.kind === SyntaxKind.TypeParameter)
  );
}

class EntityNameTracker extends NodeVisitor {
  readonly writer: PseudoTypeWriter;

  constructor(writer: PseudoTypeWriter) {
    super();
    this.writer = writer;
  }

  visitNode(node: Node): boolean {
    this.writer.markJSDocType(node);
    this.writer.trackEntityName(node);
    return node.forEachChild(this);
  }
}

/** Single-line tuples and mapped types, and string literals without escapes, as tsgo's node reuse. */
function styleReusedNodes(context: EmitContext, node: Node): boolean {
  const kind = node.kind;
  if (kind === SyntaxKind.TupleType || kind === SyntaxKind.MappedType) context.addEmitFlags(node, EmitFlags.SingleLine);
  else if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral)
    context.addEmitFlags(node, EmitFlags.NoAsciiEscaping);
  node.forEachChild(new ReusedNodeStyler(context));
  return true;
}

class ReusedNodeStyler extends NodeVisitor {
  readonly context: EmitContext;

  constructor(context: EmitContext) {
    super();
    this.context = context;
  }

  visitNode(node: Node): boolean {
    styleReusedNodes(this.context, node);
    return false;
  }
}

function clearPositions(node: Node): boolean {
  node.pos = -1;
  node.end = -1;
  node.forEachChild(new PositionClearer());
  return true;
}

class PositionClearer extends NodeVisitor {
  visitNode(node: Node): boolean {
    clearPositions(node);
    return false;
  }
}

function stripBindingInitializers(pattern: BindingPattern): boolean {
  for (const element of pattern.elements.nodes) {
    if (!(element instanceof BindingElement)) continue;
    element.initializer = undefined;
    if (element.name instanceof BindingPattern) stripBindingInitializers(element.name);
  }
  return true;
}

function appendUnionMember(result: Node[], node: Node): boolean {
  if (node instanceof UnionTypeNode) {
    for (const member of node.types.nodes) appendUnionMember(result, member);
    return true;
  }
  if (node.kind === SyntaxKind.UndefinedKeyword)
    for (const existing of result) if (existing.kind === SyntaxKind.UndefinedKeyword) return false;
  result.push(node);
  return true;
}

const enum PropertyNameKind {
  Identifier,
  NumericLiteral,
  StringLiteral,
}

function classifyPropertyName(name: string, stringNamed: boolean, isMethod: boolean): PropertyNameKind {
  if (isMethod && name === 'new') return PropertyNameKind.StringLiteral;
  if (isIdentifierText(name)) return PropertyNameKind.Identifier;
  return !stringNamed && String(Number(name)) === name && Number(name) >= 0
    ? PropertyNameKind.NumericLiteral
    : PropertyNameKind.StringLiteral;
}

export function tryGetTextOfPropertyName(name: Node): string | undefined {
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return literalText(name);
    case SyntaxKind.ComputedPropertyName: {
      const expression = (name as ComputedPropertyName).expression;
      return isStringOrNumericLiteralLike(expression) ? literalText(expression) : undefined;
    }
  }
  return undefined;
}

/** Whether a declaration's type is a literal or `unique symbol`: a computed name it names is late-bound. */
function hasLiteralOrUniqueSymbolType(declaration: Node): boolean {
  if (declaration.kind === SyntaxKind.EnumMember) return true;
  const type = getType(declaration);
  if (type !== undefined)
    return (
      (type instanceof TypeOperatorNode && type.operator === SyntaxKind.UniqueKeyword) ||
      type.kind === SyntaxKind.LiteralType
    );
  const initializer = getInitializer(declaration);
  if (initializer === undefined) return false;
  const value = skipParentheses(initializer);
  // `x as const` has a literal type wherever it is.
  if (value instanceof AsExpression && isConstTypeReference(value.type))
    return isStringOrNumericLiteralLike(skipParentheses(value.expression));
  if (declaration instanceof VariableDeclaration) {
    if ((getCombinedNodeFlags(declaration) & NodeFlags.Const) === 0) return false;
    // `const sym = Symbol()` is a unique symbol.
    if (value.kind === SyntaxKind.CallExpression && isIdentifierNamed(getExpression(value)!, 'Symbol')) return true;
    return isStringOrNumericLiteralLike(value);
  }
  if (declaration.kind === SyntaxKind.PropertyDeclaration)
    return hasSyntacticModifier(declaration, ModifierFlags.Readonly) && isStringOrNumericLiteralLike(value);
  if (declaration.kind === SyntaxKind.PropertyAssignment)
    return isInConstContext(value) && isStringOrNumericLiteralLike(value);
  return false;
}

/** The properties of an object literal, through `as const`. */
function objectLiteralProperties(node: Node): Node[] {
  let current = skipParentheses(node);
  if (current instanceof AsExpression && isConstTypeReference(current.type))
    current = skipParentheses(current.expression);
  return current instanceof ObjectLiteralExpression ? current.properties.nodes : [];
}

/** Whether a function's body returns no values, so its inferred return type is `void`. */
function isTriviallyVoid(fn: Node): boolean {
  const body = getBody(fn);
  if (body === undefined || body.kind !== SyntaxKind.Block) return false;
  if (hasSyntacticModifier(fn, ModifierFlags.Async) || getAsteriskToken(fn) !== undefined) return false;
  for (const statement of collectReturnStatements(body)) if (statement.expression !== undefined) return false;
  switch (fn.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
      return true;
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      // Without an implicit return, function expressions return `never`.
      return (fn.flags & NodeFlags.HasImplicitReturn) !== 0;
  }
  return false;
}

function createNumberExpression(context: EmitContext, value: number): Node {
  const factory = context.factory;
  if (value !== value) return factory.createIdentifier('NaN');
  if (value === Infinity) return factory.createIdentifier('Infinity');
  if (value === -Infinity)
    return factory.created(new PrefixUnaryExpression(SyntaxKind.MinusToken, factory.createIdentifier('Infinity')));
  if (value < 0)
    return factory.created(
      new PrefixUnaryExpression(SyntaxKind.MinusToken, factory.createNumericLiteral(String(-value))),
    );
  return factory.createNumericLiteral(String(value));
}

/** The literal a const declaration's initializer is, if it has a literal type. */
function literalOf(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.BigIntLiteral:
      return node;
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = node as PrefixUnaryExpression;
      const operand = unary.operand.kind;
      if (
        unary.operator === SyntaxKind.MinusToken &&
        (operand === SyntaxKind.NumericLiteral || operand === SyntaxKind.BigIntLiteral)
      )
        return node;
      if (unary.operator === SyntaxKind.PlusToken && operand === SyntaxKind.NumericLiteral) return node;
      return undefined;
    }
  }
  return undefined;
}

function literalText(node: Node): string {
  if (node instanceof Identifier) return node.text;
  if (node instanceof PrivateIdentifier) return node.text;
  if (node instanceof StringLiteral) return node.text;
  if (node instanceof NumericLiteral) return node.text;
  if (node instanceof NoSubstitutionTemplateLiteral) return node.text;
  if (node instanceof BigIntLiteral) return node.text;
  if (node instanceof TemplateMiddle) return node.text;
  if (node instanceof TemplateTail) return node.text;
  return '';
}

function getIdentifierText(node: Node): string {
  return node instanceof Identifier ? node.text : '';
}

function getFirstIdentifier(node: Node): Node {
  let current = node;
  for (;;) {
    if (current instanceof QualifiedName) current = current.left;
    else if (current instanceof PropertyAccessExpression) current = current.expression;
    else return current;
  }
}

/** What a reference to an entity name means: a value, a namespace or a type. */
export function getMeaningOfEntityNameReference(entityName: Node): SymbolFlags {
  const parent = entityName.parent!;
  if (
    parent.kind === SyntaxKind.TypeQuery ||
    (parent.kind === SyntaxKind.ExpressionWithTypeArguments && !isPartOfTypeNode(parent)) ||
    parent.kind === SyntaxKind.ComputedPropertyName ||
    (parent.kind === SyntaxKind.TypePredicate && getTypePredicateParameterName(parent) === entityName) ||
    parent.kind === SyntaxKind.BinaryExpression
  )
    return SymbolFlags.Value | SymbolFlags.ExportValue;
  if (
    entityName.kind === SyntaxKind.QualifiedName ||
    entityName.kind === SyntaxKind.PropertyAccessExpression ||
    parent.kind === SyntaxKind.ImportEqualsDeclaration ||
    (parent instanceof QualifiedName && parent.left === entityName) ||
    (parent instanceof PropertyAccessExpression && parent.expression === entityName) ||
    (parent instanceof ElementAccessExpression && parent.expression === entityName)
  )
    return SymbolFlags.Namespace;
  return SymbolFlags.Type;
}

function getTypePredicateParameterName(node: Node): Node | undefined {
  return node instanceof TypePredicateNode ? node.parameterName : undefined;
}

/** Whether a heritage clause element is a type: an interface's `extends` or a class's `implements`. */
function isPartOfTypeNode(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (parent instanceof HeritageClause)
    return (
      !(parent.parent!.kind === SyntaxKind.ClassDeclaration || parent.parent!.kind === SyntaxKind.ClassExpression) ||
      parent.token === SyntaxKind.ImplementsKeyword
    );
  return (
    parent !== undefined &&
    (parent.kind === SyntaxKind.JSDocImplementsTag || parent.kind === SyntaxKind.JSDocAugmentsTag)
  );
}

function isDeclarationKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.BindingElement:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.EnumMember:
      return true;
  }
  return false;
}

export function getAnyImportSyntax(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.ImportEqualsDeclaration:
      return node;
    case SyntaxKind.ImportClause:
      return node.parent;
    case SyntaxKind.NamespaceImport:
      return node.parent?.parent;
    case SyntaxKind.ImportSpecifier:
      return node.parent?.parent?.parent;
  }
  return undefined;
}

export function isLateVisibilityPaintedStatement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.EnumDeclaration:
      return true;
  }
  return false;
}

/** The node whose scope holds a declaration: a source file, module block or other container. */
export function getDeclarationContainer(node: Node): Node {
  let current: Node | undefined = getRootDeclaration(node);
  while (current !== undefined) {
    switch (current.kind) {
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.VariableDeclarationList:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportClause:
        current = current.parent;
        continue;
    }
    return current.parent!;
  }
  throw new Error('A declaration has no container');
}

function getEnclosingContainer(node: Node): Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent)
    if ((getContainerFlags(current) & ContainerFlags.IsContainer) !== 0) return current;
  return undefined;
}

function isGlobalScopeAugmentation(node: Node): boolean {
  return node instanceof ModuleDeclaration && node.keyword === SyntaxKind.GlobalKeyword;
}

export function isExternalModuleAugmentation(node: Node): boolean {
  return isAmbientModule(node) && isModuleAugmentationExternal(node);
}

function isImplicitlyExportedJSDocDeclaration(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined || parent.kind !== SyntaxKind.SourceFile) return false;
  if (!isExternalOrCommonJSModule(parent as SourceFile)) return false;
  if (node.kind === SyntaxKind.JSTypeAliasDeclaration) return true;
  return node.kind === SyntaxKind.ModuleDeclaration && (node.flags & NodeFlags.Reparsed) !== 0;
}

/** Merges global symbol tables as the checker does; conflicting declarations stay apart. */
function mergeInto(target: Map<string, Symbol>, source: SymbolTable, mergedSymbols: Map<Symbol, Symbol>): boolean {
  for (const [name, symbol] of source) {
    const existing = target.get(name);
    if (existing === undefined) {
      target.set(name, symbol);
      continue;
    }
    if (
      (existing.flags & getExcludedSymbolFlags(symbol.flags)) !== 0 &&
      ((existing.flags | symbol.flags) & SymbolFlags.Assignment) === 0
    )
      continue;
    let merged = existing;
    if (mergedSymbols.get(existing) !== existing) {
      // The first merge replaces the first file's symbol with a copy.
      merged = new Symbol(existing.flags, name);
      setDeclarations(merged, getDeclarations(existing).slice());
      merged.valueDeclaration = existing.valueDeclaration;
      merged.exports = copyTable(existing.exports);
      merged.members = copyTable(existing.members);
      mergedSymbols.set(existing, merged);
      mergedSymbols.set(merged, merged);
      target.set(name, merged);
    }
    merged.flags |= symbol.flags;
    for (const declaration of getDeclarations(symbol)) addDeclaration(merged, declaration);
    merged.valueDeclaration ??= symbol.valueDeclaration;
    if (symbol.exports !== undefined) {
      merged.exports ??= new Map<string, Symbol>();
      mergeInto(merged.exports, symbol.exports, mergedSymbols);
    }
    if (symbol.members !== undefined) {
      merged.members ??= new Map<string, Symbol>();
      mergeInto(merged.members, symbol.members, mergedSymbols);
    }
    mergedSymbols.set(symbol, merged);
  }
  return true;
}

function copyTable(table: SymbolTable | undefined): SymbolTable | undefined {
  return table === undefined ? undefined : new Map<string, Symbol>(table);
}

/** The flags a declaration with `flags` conflicts with. */
function getExcludedSymbolFlags(flags: SymbolFlags): SymbolFlags {
  let result = SymbolFlags.None;
  if ((flags & SymbolFlags.BlockScopedVariable) !== 0) result |= SymbolFlags.BlockScopedVariableExcludes;
  if ((flags & SymbolFlags.FunctionScopedVariable) !== 0) result |= SymbolFlags.FunctionScopedVariableExcludes;
  if ((flags & SymbolFlags.Property) !== 0) result |= SymbolFlags.PropertyExcludes;
  if ((flags & SymbolFlags.EnumMember) !== 0) result |= SymbolFlags.EnumMemberExcludes;
  if ((flags & SymbolFlags.Function) !== 0) result |= SymbolFlags.FunctionExcludes;
  if ((flags & SymbolFlags.Class) !== 0) result |= SymbolFlags.ClassExcludes;
  if ((flags & SymbolFlags.Interface) !== 0) result |= SymbolFlags.InterfaceExcludes;
  if ((flags & SymbolFlags.RegularEnum) !== 0) result |= SymbolFlags.RegularEnumExcludes;
  if ((flags & SymbolFlags.ConstEnum) !== 0) result |= SymbolFlags.ConstEnumExcludes;
  if ((flags & SymbolFlags.ValueModule) !== 0) result |= SymbolFlags.ValueModuleExcludes;
  if ((flags & SymbolFlags.Method) !== 0) result |= SymbolFlags.MethodExcludes;
  if ((flags & SymbolFlags.GetAccessor) !== 0) result |= SymbolFlags.GetAccessorExcludes;
  if ((flags & SymbolFlags.SetAccessor) !== 0) result |= SymbolFlags.SetAccessorExcludes;
  if ((flags & SymbolFlags.TypeParameter) !== 0) result |= SymbolFlags.TypeParameterExcludes;
  if ((flags & SymbolFlags.TypeAlias) !== 0) result |= SymbolFlags.TypeAliasExcludes;
  if ((flags & SymbolFlags.Alias) !== 0) result |= SymbolFlags.AliasExcludes;
  return result;
}

class AliasMarker extends NodeVisitor {
  readonly resolver: SyntacticDeclarationEmitResolver;

  constructor(resolver: SyntacticDeclarationEmitResolver) {
    super();
    this.resolver = resolver;
  }

  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.ExportAssignment: {
        const expression = getExpression(node)!;
        if (expression instanceof Identifier) this.resolver.markLinkedAliases(expression);
        return false;
      }
      case SyntaxKind.ExportSpecifier:
        if (node instanceof ExportSpecifier) this.resolver.markLinkedAliases(node.propertyName ?? node.name);
        return false;
      // Exports are statements of files and namespaces.
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.ModuleBlock:
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.NamedExports:
        return node.forEachChild(this);
    }
    return false;
  }
}
