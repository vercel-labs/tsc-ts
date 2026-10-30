// The binder: declares a symbol for each declaration in its container's table, merges
// declarations, reports binding errors, and builds the control flow graph.
//
// Fields of `instanceof`-narrowed nodes are read through `as` casts: scriptc reads them
// statically, but reads fields of a narrowed value dynamically.
import {
  appendToList,
  BinaryExpression,
  BindingElement,
  CallExpression,
  CaseBlock,
  CaseOrDefaultClause,
  CatchClause,
  ConditionalTypeNode,
  ConditionalExpression,
  DeleteExpression,
  DoStatement,
  ElementAccessExpression,
  ExportAssignment,
  ExportDeclaration,
  ExpressionStatement,
  ForInOrOfStatement,
  ForStatement,
  FunctionExpression,
  Identifier,
  IfStatement,
  ImportClause,
  KeywordExpression,
  LabeledStatement,
  MetaProperty,
  ModifierFlags,
  ModuleDeclaration,
  getNodeId,
  type Node,
  NonNullExpression,
  NodeFlags,
  type NodeList,
  NodeVisitor,
  ParameterDeclaration,
  ParenthesizedExpression,
  PatternAmbientModule,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PropertyAccessExpression,
  QualifiedName,
  ReferenceIdentifier,
  type SourceFile,
  SwitchStatement,
  TryStatement,
  TypeAliasDeclaration,
  VariableDeclaration,
  WhileStatement,
  getArguments,
  getBody,
  getElements,
  getExpression,
  getInitializer,
  getLabel,
  getLocals,
  getModifiers,
  getName,
  getParameters,
  getPostfixToken,
  getProperties,
  getStatements,
  getSymbol,
  getText,
  isDeclarationNode,
  isLocalsContainer,
  setEndFlowNode,
  setFlowNode,
  setLocalSymbol,
  setLocals,
  setNextContainer,
  setReturnFlowNode,
  setSymbol,
  callQuestionDotToken,
  callTypeArguments,
} from './ast.js';
import {
  isAmbientModule,
  isAssignmentOperator,
  isFunctionLike,
  isGlobalScopeAugmentation,
  isInJSFile,
  isLeftHandSideExpression,
  isRequireCall,
  isStringLiteralLike,
  nodeIsMissing,
  nodeIsPresent,
} from './ast-utilities.js';
import {
  JSDeclarationKind,
  ModuleInstanceState,
  declarationNameToString,
  expressionIsAlias,
  getAssignmentDeclarationKind,
  getCombinedModifierFlags,
  getContainingClass,
  getElementOrPropertyAccessName,
  getErrorRangeForNode,
  getImmediatelyInvokedFunctionExpression,
  getModuleInstanceState,
  StatementsByName,
  getNameOfDeclaration,
  getRangeOfTokenAtPosition,
  getSourceTextOfNode,
  hasDynamicName,
  hasSyntacticModifier,
  isAssignmentTarget,
  isAsyncFunction,
  isAutoAccessorPropertyDeclaration,
  isBlockOrCatchScoped,
  isBooleanLiteral,
  isDeclarationStatementKind,
  isDestructuringAssignment,
  isDottedName,
  isEntityNameExpression,
  isEnumConst,
  isExpandoInitializer,
  isExpressionOfOptionalChainRoot,
  isExternalModule,
  isExternalOrCommonJSModule,
  isIdentifierName,
  isImplicitlyExportedJSDocDeclaration,
  isInTopLevelContext,
  isJsonSourceFile,
  isLogicalExpression,
  isLogicalOrCoalescingAssignmentExpression,
  isLogicalOrCoalescingAssignmentOperator,
  isLogicalOrCoalescingBinaryOperator,
  isModuleAugmentationExternal,
  isNullishCoalesce,
  isObjectLiteralMethod,
  isObjectLiteralOrClassExpressionMethodOrAccessor,
  isOptionalChain,
  isOptionalChainRoot,
  isOutermostOptionalChain,
  isParameterPropertyDeclaration,
  isPartOfParameterDeclaration,
  isPartOfTypeQuery,
  isPotentiallyExecutableNode,
  isPrologueDirective,
  isPropertyNameLiteral,
  isPushOrUnshiftIdentifier,
  isSignedNumericLiteral,
  isStatic,
  isStringOrNumericLiteralLike,
  isVariableDeclarationInitializedToRequire,
  moduleExportNameIsDefault,
  nodeText,
  skipParentheses,
} from './binder-utilities.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { FlowFlags, FlowNode, FlowReduceLabel, FlowSwitchClause } from './flow.js';
import { removeFileExtension } from './path.js';
import { getIdentifierToken, tokenToString } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import {
  addDeclaration,
  copyDeclarations,
  declarationCount,
  getDeclarations,
  getExports,
  getMembers,
  getSymbolId,
  InternalSymbolName,
  internalSymbolNamePrefix,
  Symbol,
  SymbolFlags,
  type SymbolTable,
} from './symbol.js';

/** How a node scopes declarations and control flow. */
export const enum ContainerFlags {
  None = 0,
  /** Sets the container and block-scope container, e.g. classes, object literals, interfaces. */
  IsContainer = 1 << 0,
  /** Sets only the block-scope container, e.g. blocks, catch clauses, `for` statements. */
  IsBlockScopedContainer = 1 << 1,
  /** Starts a new control flow graph. */
  IsControlFlowContainer = 1 << 2,
  IsFunctionLike = 1 << 3,
  IsFunctionExpression = 1 << 4,
  HasLocals = 1 << 5,
  IsInterface = 1 << 6,
  IsObjectLiteralOrClassExpressionMethodOrAccessor = 1 << 7,
  IsThisContainer = 1 << 8,
  PropagatesThisKeyword = 1 << 9,
}

export function getContainerFlags(node: Node): ContainerFlags {
  switch (node.kind) {
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.JsxAttributes:
      return ContainerFlags.IsContainer;
    case SyntaxKind.InterfaceDeclaration:
      return ContainerFlags.IsContainer | ContainerFlags.IsInterface;
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.MappedType:
    case SyntaxKind.IndexSignature:
      return ContainerFlags.IsContainer | ContainerFlags.HasLocals;
    case SyntaxKind.SourceFile:
      return ContainerFlags.IsContainer | ContainerFlags.IsControlFlowContainer | ContainerFlags.HasLocals;
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
      if (isObjectLiteralOrClassExpressionMethodOrAccessor(node))
        return (
          ContainerFlags.IsContainer |
          ContainerFlags.IsControlFlowContainer |
          ContainerFlags.HasLocals |
          ContainerFlags.IsFunctionLike |
          ContainerFlags.IsObjectLiteralOrClassExpressionMethodOrAccessor |
          ContainerFlags.IsThisContainer
        );
      return functionContainerFlags;
    case SyntaxKind.Constructor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ClassStaticBlockDeclaration:
      return functionContainerFlags;
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.ConstructorType:
      return (
        ContainerFlags.IsContainer |
        ContainerFlags.IsControlFlowContainer |
        ContainerFlags.HasLocals |
        ContainerFlags.IsFunctionLike |
        ContainerFlags.PropagatesThisKeyword
      );
    case SyntaxKind.FunctionExpression:
      return (
        ContainerFlags.IsContainer |
        ContainerFlags.IsControlFlowContainer |
        ContainerFlags.HasLocals |
        ContainerFlags.IsFunctionLike |
        ContainerFlags.IsFunctionExpression |
        ContainerFlags.IsThisContainer
      );
    case SyntaxKind.ArrowFunction:
      return (
        ContainerFlags.IsContainer |
        ContainerFlags.IsControlFlowContainer |
        ContainerFlags.HasLocals |
        ContainerFlags.IsFunctionLike |
        ContainerFlags.IsFunctionExpression |
        ContainerFlags.PropagatesThisKeyword
      );
    case SyntaxKind.ModuleBlock:
      return ContainerFlags.IsControlFlowContainer;
    case SyntaxKind.PropertyDeclaration:
      return getInitializer(node) !== undefined
        ? ContainerFlags.IsControlFlowContainer | ContainerFlags.IsThisContainer
        : ContainerFlags.None;
    case SyntaxKind.CatchClause:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.CaseBlock:
      return ContainerFlags.IsBlockScopedContainer | ContainerFlags.HasLocals;
    case SyntaxKind.Block: {
      const parent = node.parent!;
      return isFunctionLike(parent) || parent.kind === SyntaxKind.ClassStaticBlockDeclaration
        ? ContainerFlags.None
        : ContainerFlags.IsBlockScopedContainer | ContainerFlags.HasLocals;
    }
  }
  return ContainerFlags.None;
}

const functionContainerFlags =
  ContainerFlags.IsContainer |
  ContainerFlags.IsControlFlowContainer |
  ContainerFlags.HasLocals |
  ContainerFlags.IsFunctionLike |
  ContainerFlags.IsThisContainer;

/** A label in scope for `break` and `continue`. */
class ActiveLabel {
  readonly next: ActiveLabel | undefined;
  readonly name: string;
  readonly breakTarget: FlowNode;
  continueTarget: FlowNode | undefined;
  referenced: boolean;

  constructor(next: ActiveLabel | undefined, name: string, breakTarget: FlowNode) {
    this.next = next;
    this.name = name;
    this.breakTarget = breakTarget;
    this.continueTarget = undefined;
    this.referenced = false;
  }
}

/** A JavaScript `F.x = …` assignment, bound once the whole file has its declarations. */
class ExpandoAssignment {
  readonly node: Node;
  readonly container: Node;
  readonly blockScopeContainer: Node;

  constructor(node: Node, container: Node, blockScopeContainer: Node) {
    this.node = node;
    this.container = container;
    this.blockScopeContainer = blockScopeContainer;
  }
}

/** Binds `file` unless it is already bound. */
export function bindSourceFile(file: SourceFile): void {
  if (file.isBound) return;
  const binder = new Binder(file);
  binder.bind(file);
  binder.bindDeferredExpandoAssignments(binder.expandoAssignments);
  file.symbolCount = binder.symbolCount;
  file.isBound = true;
}

/** The name of a private member `#description` of the class with symbol `containingClassSymbol`. */
export function getSymbolNameForPrivateIdentifier(containingClassSymbol: Symbol, description: string): string {
  return internalSymbolNamePrefix + '#' + getSymbolId(containingClassSymbol) + '@' + description;
}

/**
 * Makes `node` the value declaration of `symbol` unless it has one already. Non-assignment
 * declarations win over JavaScript assignments, and other declarations over namespaces.
 */
export function setValueDeclaration(symbol: Symbol, node: Node): void {
  const valueDeclaration = symbol.valueDeclaration;
  if (
    valueDeclaration === undefined ||
    (isAssignmentDeclaration(valueDeclaration) && !isAssignmentDeclaration(node)) ||
    (valueDeclaration.kind !== node.kind && isEffectiveModuleDeclaration(valueDeclaration))
  )
    symbol.valueDeclaration = node;
}

function isAssignmentDeclaration(declaration: Node): boolean {
  switch (declaration.kind) {
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.Identifier:
    case SyntaxKind.CallExpression:
      return true;
  }
  return false;
}

function isEffectiveModuleDeclaration(node: Node): boolean {
  return node.kind === SyntaxKind.ModuleDeclaration || node.kind === SyntaxKind.Identifier;
}

class Binder extends NodeVisitor {
  readonly file: SourceFile;
  readonly unreachableFlow: FlowNode;
  container: Node;
  thisContainer: Node | undefined;
  blockScopeContainer: Node;
  lastContainer: Node | undefined;
  currentFlow: FlowNode;
  /**
   * `currentFlow` as an optional value, shared by the nodes that store it: natively, converting a
   * `FlowNode` to `FlowNode | undefined` allocates.
   */
  private storedFlow: FlowNode;
  private storedFlowValue: FlowNode | undefined;
  currentBreakTarget: FlowNode | undefined;
  currentContinueTarget: FlowNode | undefined;
  currentReturnTarget: FlowNode | undefined;
  currentTrueTarget: FlowNode | undefined;
  currentFalseTarget: FlowNode | undefined;
  currentExceptionTarget: FlowNode | undefined;
  preSwitchCaseFlow: FlowNode | undefined;
  activeLabelList: ActiveLabel | undefined;
  emitFlags: NodeFlags;
  seenThisKeyword: boolean;
  hasExplicitReturn: boolean;
  hasFlowEffects: boolean;
  inAssignmentPattern: boolean;
  seenParseError: boolean;
  symbolCount: number;
  readonly notConstEnumOnlyModules: Set<Symbol>;
  readonly expandoAssignments: ExpandoAssignment[];
  /** For the module instance states of the file's module declarations (`getModuleInstanceState`). */
  private readonly statementsByName: StatementsByName;

  constructor(file: SourceFile) {
    super();
    this.file = file;
    this.unreachableFlow = new FlowNode(FlowFlags.Unreachable, undefined, undefined);
    this.container = file;
    this.thisContainer = undefined;
    this.blockScopeContainer = file;
    this.lastContainer = undefined;
    this.currentFlow = this.unreachableFlow;
    this.storedFlow = this.unreachableFlow;
    this.storedFlowValue = this.unreachableFlow;
    this.currentBreakTarget = undefined;
    this.currentContinueTarget = undefined;
    this.currentReturnTarget = undefined;
    this.currentTrueTarget = undefined;
    this.currentFalseTarget = undefined;
    this.currentExceptionTarget = undefined;
    this.preSwitchCaseFlow = undefined;
    this.activeLabelList = undefined;
    this.emitFlags = NodeFlags.None;
    this.seenThisKeyword = false;
    this.hasExplicitReturn = false;
    this.hasFlowEffects = false;
    this.inAssignmentPattern = false;
    this.seenParseError = false;
    this.symbolCount = 0;
    this.notConstEnumOnlyModules = new Set<Symbol>();
    this.expandoAssignments = [];
    this.statementsByName = new StatementsByName();
  }

  visitNode(node: Node): boolean {
    this.bind(node);
    return false;
  }

  /** `currentFlow`, for storing in a node's `flowNode`. */
  currentFlowValue(): FlowNode | undefined {
    if (this.storedFlow !== this.currentFlow) {
      this.storedFlow = this.currentFlow;
      this.storedFlowValue = this.currentFlow;
    }
    return this.storedFlowValue;
  }

  newSymbol(flags: SymbolFlags, name: string): Symbol {
    this.symbolCount++;
    return new Symbol(flags, name);
  }

  // Declarations

  /**
   * Declares `node` in `symbolTable` with flags `includes`, merging with an existing symbol
   * of the same name unless its flags intersect `excludes`, which is reported as a duplicate.
   * Callers pass `parent` as read from the container rather than narrowed, so that its members
   * share the stored value (see `storedFlow`).
   */
  declareSymbol(
    symbolTable: SymbolTable,
    parent: Symbol | undefined,
    node: Node,
    includes: SymbolFlags,
    excludes: SymbolFlags,
  ): Symbol {
    return this.declareSymbolEx(symbolTable, parent, node, includes, excludes, false, false);
  }

  declareSymbolEx(
    symbolTable: SymbolTable,
    parent: Symbol | undefined,
    node: Node,
    includes: SymbolFlags,
    excludes: SymbolFlags,
    isReplaceableByMethod: boolean,
    isComputedName: boolean,
  ): Symbol {
    const isDefaultExport =
      hasSyntacticModifier(node, ModifierFlags.Default) ||
      (node.kind === SyntaxKind.ExportSpecifier && moduleExportNameIsDefault(getName(node)!));
    // The exported symbol of `export default function/class` is always named "default".
    const name = isComputedName
      ? InternalSymbolName.Computed
      : isDefaultExport && parent !== undefined
        ? InternalSymbolName.Default
        : this.getDeclarationName(node);
    let symbol: Symbol | undefined;
    if (name === InternalSymbolName.Missing) symbol = this.newSymbol(SymbolFlags.None, InternalSymbolName.Missing);
    else {
      // A new symbol starts without flags, so it can't conflict with `excludes`. A conflicting
      // existing symbol gets errors on each declaration, and `node` gets a symbol of its own.
      // A JavaScript constructor property (`isReplaceableByMethod`) always loses a conflict,
      // which allows `this.method = this.method.bind(this)`.
      symbol = symbolTable.get(name);
      if (symbol === undefined) {
        symbol = this.newSymbol(SymbolFlags.None, name);
        symbolTable.set(name, symbol);
        if (isReplaceableByMethod) symbol.flags |= SymbolFlags.ReplaceableByMethod;
      } else if (isReplaceableByMethod && (symbol.flags & SymbolFlags.ReplaceableByMethod) === 0) {
        return symbol;
      } else if ((symbol.flags & excludes) !== 0) {
        if ((symbol.flags & SymbolFlags.ReplaceableByMethod) !== 0) {
          symbol = this.newSymbol(SymbolFlags.None, name);
          symbolTable.set(name, symbol);
        } else if (
          !(
            ((includes & SymbolFlags.Variable) !== 0 && (symbol.flags & SymbolFlags.Assignment) !== 0) ||
            ((includes & SymbolFlags.Assignment) !== 0 && (symbol.flags & SymbolFlags.Variable) !== 0)
          )
        ) {
          // Assignment declarations merge with variables whatever their other flags.
          this.reportDuplicate(symbol, node, includes, isDefaultExport);
          symbol = this.newSymbol(SymbolFlags.None, name);
        }
      }
    }
    this.addDeclarationToSymbol(symbol, node, includes);
    if (symbol.parent === undefined) symbol.parent = parent;
    else if (symbol.parent !== parent) throw new Error('Existing symbol parent should match new one');
    return symbol;
  }

  reportDuplicate(symbol: Symbol, node: Node, includes: SymbolFlags, isDefaultExport: boolean): void {
    let message =
      (symbol.flags & SymbolFlags.BlockScopedVariable) !== 0
        ? Diagnostics.Cannot_redeclare_block_scoped_variable_0
        : Diagnostics.Duplicate_identifier_0;
    let messageNeedsName = true;
    if ((symbol.flags & SymbolFlags.Enum) !== 0 || (includes & SymbolFlags.Enum) !== 0) {
      message = Diagnostics.Enum_declarations_can_only_merge_with_namespace_or_other_enum_declarations;
      messageNeedsName = false;
    }
    let multipleDefaultExports = false;
    if (declarationCount(symbol) !== 0) {
      // A default export (by modifier, or `export default` assignment) after another one.
      if (isDefaultExport || (node instanceof ExportAssignment && !(node as ExportAssignment).isExportEquals)) {
        message = Diagnostics.A_module_cannot_have_multiple_default_exports;
        messageNeedsName = false;
        multipleDefaultExports = true;
      }
    }
    const declarationName = getNameOfDeclaration(node) ?? node;
    const diagnostic = this.createDiagnosticForNode(
      declarationName,
      message,
      messageNeedsName ? [this.getDisplayName(node)] : noArgs,
    );
    if (
      node instanceof TypeAliasDeclaration &&
      nodeIsMissing((node as TypeAliasDeclaration).type) &&
      hasSyntacticModifier(node, ModifierFlags.Export) &&
      (symbol.flags & (SymbolFlags.Alias | SymbolFlags.Type | SymbolFlags.Namespace)) !== 0
    ) {
      // `export type T;` may have meant `export type { T }`.
      diagnostic.addRelatedInfo(
        this.createDiagnosticForNode(node, Diagnostics.Did_you_mean_0, [
          'export type { ' + (node as TypeAliasDeclaration).name.text + ' }',
        ]),
      );
    }
    const declarations = getDeclarations(symbol);
    for (let index = 0; index < declarations.length; index++) {
      const declaration = declarations[index]!;
      const decl = getNameOfDeclaration(declaration) ?? declaration;
      const d = this.createDiagnosticForNode(
        decl,
        message,
        messageNeedsName ? [this.getDisplayName(declaration)] : noArgs,
      );
      if (multipleDefaultExports)
        d.addRelatedInfo(
          this.createDiagnosticForNode(
            declarationName,
            index === 0 ? Diagnostics.Another_export_default_is_here : Diagnostics.X_and_here,
            noArgs,
          ),
        );
      this.addDiagnostic(d);
      if (multipleDefaultExports)
        diagnostic.addRelatedInfo(
          this.createDiagnosticForNode(decl, Diagnostics.The_first_export_default_is_here, noArgs),
        );
    }
    this.addDiagnostic(diagnostic);
    // An accessor conflicting with a non-accessor or the other accessor kind makes the symbol a
    // full accessor, so later declarations conflict too.
    const accessor = symbol.flags & SymbolFlags.Accessor;
    if (accessor !== 0 && accessor !== (includes & SymbolFlags.Accessor)) symbol.flags |= SymbolFlags.Accessor;
  }

  /** The symbol name of a declaration. Computed names must be literals or well-known symbols. */
  getDeclarationName(node: Node): string {
    if (node instanceof ExportAssignment)
      return (node as ExportAssignment).isExportEquals ? InternalSymbolName.ExportEquals : InternalSymbolName.Default;
    const name = getNameOfDeclaration(node);
    if (name !== undefined) {
      if (isAmbientModule(node)) {
        if (isGlobalScopeAugmentation(node)) return InternalSymbolName.Global;
        const moduleName = nodeText(name);
        // A pattern module with import attributes has its own symbol, named after the attributes node's id: it merges
        // only with pattern modules of the same pattern and identical attributes, which the checker decides. The id
        // is written at a fixed width so that names sort in declaration order.
        const attributes = (node as ModuleDeclaration).attributes;
        if (attributes !== undefined && hasSingleStar(moduleName))
          return (
            internalSymbolNamePrefix + '"' + moduleName + '"pattern@' + String(getNodeId(attributes)).padStart(10, '0')
          );
        return '"' + moduleName + '"';
      }
      if (name.kind === SyntaxKind.PrivateIdentifier) {
        // Private names are only allowed in classes; elsewhere there is already a parse error.
        const containingClass = getContainingClass(node);
        if (containingClass === undefined) return InternalSymbolName.Missing;
        return getSymbolNameForPrivateIdentifier(getSymbol(containingClass)!, getText(name));
      }
      if (isPropertyNameLiteral(name) || name.kind === SyntaxKind.JsxNamespacedName) return nodeText(name);
      if (name.kind === SyntaxKind.ComputedPropertyName) {
        const expression = getExpression(name)!;
        // A literal computed name is just the literal.
        if (isStringOrNumericLiteralLike(expression)) return getText(expression);
        if (expression instanceof PrefixUnaryExpression && isSignedNumericLiteral(expression)) {
          const unary = expression as PrefixUnaryExpression;
          return tokenToString(unary.operator) + getText(unary.operand);
        }
        throw new Error('Only computed properties with literal names have declaration names');
      }
      return InternalSymbolName.Missing;
    }
    switch (node.kind) {
      case SyntaxKind.Constructor:
        return InternalSymbolName.Constructor;
      case SyntaxKind.FunctionType:
      case SyntaxKind.CallSignature:
        return InternalSymbolName.Call;
      case SyntaxKind.ConstructorType:
      case SyntaxKind.ConstructSignature:
        return InternalSymbolName.New;
      case SyntaxKind.IndexSignature:
        return InternalSymbolName.Index;
      case SyntaxKind.ExportDeclaration:
        return InternalSymbolName.ExportStar;
      case SyntaxKind.SourceFile:
      case SyntaxKind.BinaryExpression:
        return InternalSymbolName.ExportEquals;
    }
    return InternalSymbolName.Missing;
  }

  getDisplayName(node: Node): string {
    const name = getName(node);
    if (name !== undefined) return declarationNameToString(this.file, name);
    const declarationName = this.getDeclarationName(node);
    return declarationName !== InternalSymbolName.Missing ? declarationName : '(Missing)';
  }

  /**
   * Declares a module or namespace member. Exported members get two symbols: a local one
   * marked `ExportValue` and the export, so locals and exports of the same name conflict and
   * the checker can tell a reference to the export from its local.
   */
  declareModuleMember(node: Node, symbolFlags: SymbolFlags, symbolExcludes: SymbolFlags): Symbol {
    const container = this.container;
    const hasExportModifier =
      (getCombinedModifierFlags(node) & ModifierFlags.Export) !== 0 || isImplicitlyExportedJSDocDeclaration(node);
    if ((symbolFlags & SymbolFlags.Alias) !== 0) {
      if (
        node.kind === SyntaxKind.ExportSpecifier ||
        (node.kind === SyntaxKind.ImportEqualsDeclaration && hasExportModifier)
      ) {
        const containerSymbol = getSymbol(container);
        return this.declareSymbol(getExports(containerSymbol!), containerSymbol, node, symbolFlags, symbolExcludes);
      }
      return this.declareSymbol(this.localsOf(container), undefined, node, symbolFlags, symbolExcludes);
    }
    // Nested ambient modules (module augmentations) stay local so they never merge globally.
    if (!isAmbientModule(node) && (hasExportModifier || (container.flags & NodeFlags.ExportContext) !== 0)) {
      const containerSymbol = getSymbol(container);
      // An unnamed default export has no local symbol.
      if (
        !isLocalsContainer(container) ||
        (hasSyntacticModifier(node, ModifierFlags.Default) &&
          this.getDeclarationName(node) === InternalSymbolName.Missing)
      )
        return this.declareSymbol(getExports(containerSymbol!), containerSymbol, node, symbolFlags, symbolExcludes);
      const exportKind = (symbolFlags & SymbolFlags.Value) !== 0 ? SymbolFlags.ExportValue : SymbolFlags.None;
      const local = this.declareSymbol(this.localsOf(container), undefined, node, exportKind, symbolExcludes);
      local.exportSymbol = this.declareSymbol(
        getExports(containerSymbol!),
        containerSymbol,
        node,
        symbolFlags,
        symbolExcludes,
      );
      setLocalSymbol(node, local);
      return local;
    }
    return this.declareSymbol(this.localsOf(container), undefined, node, symbolFlags, symbolExcludes);
  }

  declareClassMember(node: Node, symbolFlags: SymbolFlags, symbolExcludes: SymbolFlags): Symbol {
    const classSymbol = getSymbol(this.container);
    const table = isStatic(node) ? getExports(classSymbol!) : getMembers(classSymbol!);
    return this.declareSymbol(table, classSymbol, node, symbolFlags, symbolExcludes);
  }

  declareSourceFileMember(node: Node, symbolFlags: SymbolFlags, symbolExcludes: SymbolFlags): Symbol {
    if (isExternalModule(this.file)) return this.declareModuleMember(node, symbolFlags, symbolExcludes);
    return this.declareSymbol(this.localsOf(this.file), undefined, node, symbolFlags, symbolExcludes);
  }

  declareSymbolAndAddToSymbolTable(node: Node, symbolFlags: SymbolFlags, symbolExcludes: SymbolFlags): Symbol {
    const container = this.container;
    switch (container.kind) {
      case SyntaxKind.ModuleDeclaration:
        return this.declareModuleMember(node, symbolFlags, symbolExcludes);
      case SyntaxKind.SourceFile:
        return this.declareSourceFileMember(node, symbolFlags, symbolExcludes);
      case SyntaxKind.ClassExpression:
      case SyntaxKind.ClassDeclaration:
        return this.declareClassMember(node, symbolFlags, symbolExcludes);
      case SyntaxKind.EnumDeclaration: {
        const enumSymbol = getSymbol(container);
        return this.declareSymbol(getExports(enumSymbol!), enumSymbol, node, symbolFlags, symbolExcludes);
      }
      case SyntaxKind.TypeLiteral:
      case SyntaxKind.ObjectLiteralExpression:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.JsxAttributes: {
        const containerSymbol = getSymbol(container);
        return this.declareSymbol(getMembers(containerSymbol!), containerSymbol, node, symbolFlags, symbolExcludes);
      }
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.ClassStaticBlockDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.MappedType:
        return this.declareSymbol(this.localsOf(container), undefined, node, symbolFlags, symbolExcludes);
    }
    throw new Error('Unhandled case in declareSymbolAndAddToSymbolTable');
  }

  /** The locals table of `container`, created if missing. */
  localsOf(container: Node): SymbolTable {
    let locals = getLocals(container);
    if (locals === undefined) {
      locals = new Map<string, Symbol>();
      setLocals(container, locals);
    }
    return locals;
  }

  addDeclarationToSymbol(symbol: Symbol, node: Node, symbolFlags: SymbolFlags): void {
    symbol.flags |= symbolFlags;
    setSymbol(node, symbol);
    if (getDeclarations(symbol).indexOf(node) < 0) addDeclaration(symbol, node);
    // A const-enum-only namespace merged with a class, function or regular enum isn't one anymore.
    if (
      (symbol.flags & SymbolFlags.ConstEnumOnlyModule) !== 0 &&
      (symbol.flags & (SymbolFlags.Function | SymbolFlags.Class | SymbolFlags.RegularEnum)) !== 0
    ) {
      symbol.flags &= ~SymbolFlags.ConstEnumOnlyModule;
      this.notConstEnumOnlyModules.add(symbol);
    }
    if ((symbolFlags & SymbolFlags.Value) !== 0) setValueDeclaration(symbol, node);
  }

  bindAnonymousDeclaration(node: Node, symbolFlags: SymbolFlags, name: string): Symbol {
    const symbol = this.newSymbol(symbolFlags, name);
    if ((symbolFlags & (SymbolFlags.EnumMember | SymbolFlags.ClassMember)) !== 0)
      symbol.parent = getSymbol(this.container);
    this.addDeclarationToSymbol(symbol, node, symbolFlags);
    return symbol;
  }

  bindBlockScopedDeclaration(node: Node, symbolFlags: SymbolFlags, symbolExcludes: SymbolFlags): Symbol {
    const blockScopeContainer = this.blockScopeContainer;
    switch (blockScopeContainer.kind) {
      case SyntaxKind.ModuleDeclaration:
        return this.declareModuleMember(node, symbolFlags, symbolExcludes);
      case SyntaxKind.SourceFile:
        if (isExternalOrCommonJSModule(this.file)) return this.declareModuleMember(node, symbolFlags, symbolExcludes);
        break;
    }
    return this.declareSymbol(this.localsOf(blockScopeContainer), undefined, node, symbolFlags, symbolExcludes);
  }

  // Diagnostics

  createDiagnosticForNode(node: Node, message: DiagnosticMessage, args: readonly string[]): Diagnostic {
    const range = getErrorRangeForNode(this.file, node);
    return new Diagnostic(this.file.diagnosticFile(), range.pos, range.end, message, args);
  }

  errorOnNode(node: Node, message: DiagnosticMessage, args: readonly string[]): void {
    this.addDiagnostic(this.createDiagnosticForNode(node, message, args));
  }

  errorOnFirstToken(node: Node, message: DiagnosticMessage, args: readonly string[]): void {
    const range = getRangeOfTokenAtPosition(this.file, node.pos);
    this.addDiagnostic(new Diagnostic(this.file.diagnosticFile(), range.pos, range.end, message, args));
  }

  addDiagnostic(diagnostic: Diagnostic): void {
    this.file.bindDiagnostics = appendToList(this.file.bindDiagnostics, diagnostic);
  }

  // Traversal

  bindOptional(node: Node | undefined): void {
    if (node !== undefined) this.bind(node);
  }

  bind(node: Node): void {
    // Declare the node's symbol in the exports or members of the container's symbol, or in
    // the container's locals; anonymous declarations like type literals go in no table.
    switch (node.kind) {
      case SyntaxKind.Identifier:
        if (node instanceof ReferenceIdentifier) node.flowNode = this.currentFlowValue();
        this.checkContextualIdentifier(node as Identifier);
        break;
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.SuperKeyword:
        if (node.kind === SyntaxKind.ThisKeyword) this.seenThisKeyword = true;
        if (node instanceof KeywordExpression) (node as KeywordExpression).flowNode = this.currentFlowValue();
        break;
      case SyntaxKind.QualifiedName:
        if (isPartOfTypeQuery(node)) (node as QualifiedName).flowNode = this.currentFlowValue();
        break;
      case SyntaxKind.MetaProperty:
        (node as MetaProperty).flowNode = this.currentFlowValue();
        break;
      case SyntaxKind.PrivateIdentifier:
        this.checkPrivateIdentifier(node);
        break;
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        if (isNarrowableReference(node)) setFlowNode(node, this.currentFlowValue());
        break;
      case SyntaxKind.BinaryExpression:
        switch (getAssignmentDeclarationKind(node)) {
          case JSDeclarationKind.ModuleExports:
            this.bindModuleExportsAssignment(node as BinaryExpression);
            break;
          case JSDeclarationKind.ExportsProperty:
            this.bindExportsOrObjectDefineProperty(node);
            break;
          case JSDeclarationKind.Property:
            this.bindExpandoPropertyAssignment(node);
            break;
          case JSDeclarationKind.ThisProperty:
            this.bindThisPropertyAssignment(node as BinaryExpression);
            break;
        }
        this.checkStrictModeBinaryExpression(node as BinaryExpression);
        break;
      case SyntaxKind.CatchClause:
        this.checkStrictModeCatchClause(node as CatchClause);
        break;
      case SyntaxKind.DeleteExpression:
        this.checkStrictModeDeleteExpression(node as DeleteExpression);
        break;
      case SyntaxKind.PostfixUnaryExpression:
        this.checkStrictModeEvalOrArguments(node, (node as PostfixUnaryExpression).operand);
        break;
      case SyntaxKind.PrefixUnaryExpression: {
        const operator = (node as PrefixUnaryExpression).operator;
        if (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken)
          this.checkStrictModeEvalOrArguments(node, (node as PrefixUnaryExpression).operand);
        break;
      }
      case SyntaxKind.WithStatement:
        this.errorOnFirstToken(node, Diagnostics.X_with_statements_are_not_allowed_in_strict_mode, noArgs);
        break;
      case SyntaxKind.LabeledStatement: {
        const statement = (node as LabeledStatement).statement;
        if (isDeclarationStatementKind(statement.kind) || statement.kind === SyntaxKind.VariableStatement)
          this.errorOnFirstToken((node as LabeledStatement).label, Diagnostics.A_label_is_not_allowed_here, noArgs);
        break;
      }
      case SyntaxKind.ThisType:
        this.seenThisKeyword = true;
        break;
      case SyntaxKind.TypeParameter:
        this.bindTypeParameter(node);
        break;
      case SyntaxKind.Parameter:
        this.bindParameter(node as ParameterDeclaration);
        break;
      case SyntaxKind.VariableDeclaration:
        this.bindVariableDeclarationOrBindingElement(node);
        break;
      case SyntaxKind.BindingElement:
        (node as BindingElement).flowNode = this.currentFlowValue();
        this.bindVariableDeclarationOrBindingElement(node);
        break;
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertySignature: {
        const isAutoAccessor = isAutoAccessorPropertyDeclaration(node);
        this.bindPropertyOrMethodOrAccessor(
          node,
          (isAutoAccessor ? SymbolFlags.Accessor : SymbolFlags.Property) | optionalSymbolFlag(node),
          isAutoAccessor ? SymbolFlags.AccessorExcludes : SymbolFlags.PropertyExcludes,
        );
        break;
      }
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
        this.bindPropertyOrMethodOrAccessor(node, SymbolFlags.Property, SymbolFlags.PropertyExcludes);
        break;
      case SyntaxKind.EnumMember:
        this.bindPropertyOrMethodOrAccessor(node, SymbolFlags.EnumMember, SymbolFlags.EnumMemberExcludes);
        break;
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.IndexSignature:
        this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.Signature, SymbolFlags.None);
        break;
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
        this.bindPropertyOrMethodOrAccessor(
          node,
          SymbolFlags.Method | optionalSymbolFlag(node),
          isObjectLiteralMethod(node) ? SymbolFlags.Value : SymbolFlags.MethodExcludes,
        );
        break;
      case SyntaxKind.FunctionDeclaration:
        this.bindFunctionDeclaration(node);
        break;
      case SyntaxKind.Constructor:
        this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.Constructor, SymbolFlags.None);
        break;
      case SyntaxKind.GetAccessor:
        this.bindPropertyOrMethodOrAccessor(node, SymbolFlags.GetAccessor, SymbolFlags.GetAccessorExcludes);
        break;
      case SyntaxKind.SetAccessor:
        this.bindPropertyOrMethodOrAccessor(node, SymbolFlags.SetAccessor, SymbolFlags.SetAccessorExcludes);
        break;
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
        this.bindFunctionOrConstructorType(node);
        break;
      case SyntaxKind.TypeLiteral:
      case SyntaxKind.MappedType:
        this.bindAnonymousDeclaration(node, SymbolFlags.TypeLiteral, InternalSymbolName.Type);
        break;
      case SyntaxKind.ObjectLiteralExpression:
        this.bindAnonymousDeclaration(node, SymbolFlags.ObjectLiteral, InternalSymbolName.Object);
        break;
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
        this.bindFunctionExpression(node);
        break;
      case SyntaxKind.ClassExpression:
      case SyntaxKind.ClassDeclaration:
        this.bindClassLikeDeclaration(node);
        break;
      case SyntaxKind.InterfaceDeclaration:
        this.bindBlockScopedDeclaration(node, SymbolFlags.Interface, SymbolFlags.InterfaceExcludes);
        break;
      case SyntaxKind.CallExpression:
        switch (getAssignmentDeclarationKind(node)) {
          case JSDeclarationKind.ObjectDefinePropertyValue:
            this.bindExpandoPropertyAssignment(node);
            break;
          case JSDeclarationKind.ObjectDefinePropertyExports:
            this.bindExportsOrObjectDefineProperty(node);
            break;
        }
        // Only to detect CommonJS modules.
        if (isInJSFile(node) && this.file.commonJSModuleIndicator === undefined && isRequireCall(node, false))
          this.setCommonJSModuleIndicator(node);
        break;
      case SyntaxKind.TypeAliasDeclaration:
        this.bindBlockScopedDeclaration(node, SymbolFlags.TypeAlias, SymbolFlags.TypeAliasExcludes);
        break;
      case SyntaxKind.JSTypeAliasDeclaration:
        // Top-level ones are bound by bindContainer, after CommonJS module indicators.
        if (this.blockScopeContainer.kind !== SyntaxKind.SourceFile)
          this.bindBlockScopedDeclaration(node, SymbolFlags.TypeAlias, SymbolFlags.TypeAliasExcludes);
        break;
      case SyntaxKind.EnumDeclaration:
        if (isEnumConst(node))
          this.bindBlockScopedDeclaration(node, SymbolFlags.ConstEnum, SymbolFlags.ConstEnumExcludes);
        else this.bindBlockScopedDeclaration(node, SymbolFlags.RegularEnum, SymbolFlags.RegularEnumExcludes);
        break;
      case SyntaxKind.ModuleDeclaration:
        this.bindModuleDeclaration(node as ModuleDeclaration);
        break;
      case SyntaxKind.ImportEqualsDeclaration:
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.ExportSpecifier:
        this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.Alias, SymbolFlags.AliasExcludes);
        break;
      case SyntaxKind.NamespaceExportDeclaration:
        this.bindNamespaceExportDeclaration(node);
        break;
      case SyntaxKind.ImportClause:
        if ((node as ImportClause).name !== undefined)
          this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.Alias, SymbolFlags.AliasExcludes);
        break;
      case SyntaxKind.ExportDeclaration:
        this.bindExportDeclaration(node as ExportDeclaration);
        break;
      case SyntaxKind.ExportAssignment:
        this.bindExportAssignment(node as ExportAssignment);
        break;
      case SyntaxKind.SourceFile:
        this.bindSourceFileIfExternalModule(node as SourceFile);
        break;
      case SyntaxKind.JsxAttributes:
        this.bindAnonymousDeclaration(node, SymbolFlags.ObjectLiteral, InternalSymbolName.JSXAttributes);
        break;
      case SyntaxKind.JsxAttribute:
        this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.Property, SymbolFlags.PropertyExcludes);
        break;
    }
    // Then bind the children, tracking the current container. Tokens have no children.
    let thisNodeOrAnySubnodesHasError = (node.flags & NodeFlags.ThisNodeHasError) !== 0;
    if (node.kind > SyntaxKind.LastToken) {
      const saveSeenParseError = this.seenParseError;
      this.seenParseError = false;
      const containerFlags = getContainerFlags(node);
      if (containerFlags === ContainerFlags.None) this.bindChildren(node);
      else this.bindContainer(node, containerFlags);
      if (this.seenParseError) thisNodeOrAnySubnodesHasError = true;
      this.seenParseError = saveSeenParseError;
    }
    if (thisNodeOrAnySubnodesHasError) {
      node.flags |= NodeFlags.ThisNodeOrAnySubNodesHasError;
      this.seenParseError = true;
    }
  }

  /**
   * Binds the children of a container. Containers are chained in declaration order for the
   * checker's local name lookups.
   */
  bindContainer(node: Node, containerFlags: ContainerFlags): void {
    const saveContainer = this.container;
    const saveThisContainer = this.thisContainer;
    const saveBlockScopeContainer = this.blockScopeContainer;
    // Locals are created on first use, so block-scoped containers without declarations stay cheap.
    if ((containerFlags & ContainerFlags.IsContainer) !== 0) {
      this.container = node;
      this.blockScopeContainer = node;
      if ((containerFlags & ContainerFlags.HasLocals) !== 0) this.addToContainerChain(node);
    } else if ((containerFlags & ContainerFlags.IsBlockScopedContainer) !== 0) {
      this.blockScopeContainer = node;
      this.addToContainerChain(node);
    }
    if ((containerFlags & ContainerFlags.IsThisContainer) !== 0) this.thisContainer = node;
    if ((containerFlags & ContainerFlags.IsControlFlowContainer) !== 0)
      this.bindControlFlowContainer(node, containerFlags);
    else if ((containerFlags & ContainerFlags.IsInterface) !== 0) {
      const saveSeenThisKeyword = this.seenThisKeyword;
      this.seenThisKeyword = false;
      this.bindChildren(node);
      // ContainsThis can't overlap with HasExtendedUnicodeEscape, which is for identifiers.
      if (this.seenThisKeyword) node.flags |= NodeFlags.ContainsThis;
      else node.flags &= ~NodeFlags.ContainsThis;
      this.seenThisKeyword = saveSeenThisKeyword;
    } else this.bindChildren(node);
    if (node.kind === SyntaxKind.SourceFile) this.finishSourceFile(node as SourceFile);
    else if (isAmbientModule(node)) this.bindCommonJSTypeExports(getSymbol(node));
    this.container = saveContainer;
    this.thisContainer = saveThisContainer;
    this.blockScopeContainer = saveBlockScopeContainer;
  }

  bindControlFlowContainer(node: Node, containerFlags: ContainerFlags): void {
    const saveCurrentFlow = this.currentFlow;
    const saveBreakTarget = this.currentBreakTarget;
    const saveContinueTarget = this.currentContinueTarget;
    const saveReturnTarget = this.currentReturnTarget;
    const saveExceptionTarget = this.currentExceptionTarget;
    const saveActiveLabelList = this.activeLabelList;
    const saveHasExplicitReturn = this.hasExplicitReturn;
    const saveSeenThisKeyword = this.seenThisKeyword;
    // A non-async, non-generator IIFE is part of the containing control flow; its returns act
    // like breaks to a label past the body.
    const isImmediatelyInvoked =
      ((containerFlags & ContainerFlags.IsFunctionExpression) !== 0 &&
        !hasSyntacticModifier(node, ModifierFlags.Async) &&
        !isGeneratorFunctionExpression(node) &&
        getImmediatelyInvokedFunctionExpression(node) !== undefined) ||
      node.kind === SyntaxKind.ClassStaticBlockDeclaration;
    if (!isImmediatelyInvoked) {
      const flowStart = new FlowNode(FlowFlags.Start, undefined, undefined);
      this.currentFlow = flowStart;
      if (
        (containerFlags &
          (ContainerFlags.IsFunctionExpression | ContainerFlags.IsObjectLiteralOrClassExpressionMethodOrAccessor)) !==
        0
      )
        flowStart.node = node;
    }
    // IIFEs and constructors get a return graph; constructors use it to check property initialization.
    this.currentReturnTarget =
      isImmediatelyInvoked || node.kind === SyntaxKind.Constructor ? this.createBranchLabel() : undefined;
    this.currentExceptionTarget = undefined;
    this.currentBreakTarget = undefined;
    this.currentContinueTarget = undefined;
    this.activeLabelList = undefined;
    this.hasExplicitReturn = false;
    this.seenThisKeyword = false;
    this.bindChildren(node);
    node.flags &= ~(NodeFlags.ReachabilityAndEmitFlags | NodeFlags.ContainsThis);
    if (
      (this.currentFlow.flags & FlowFlags.Unreachable) === 0 &&
      (containerFlags & ContainerFlags.IsFunctionLike) !== 0 &&
      node.kind !== SyntaxKind.ClassStaticBlockDeclaration &&
      nodeIsPresent(getBody(node))
    ) {
      node.flags |= NodeFlags.HasImplicitReturn;
      if (this.hasExplicitReturn) node.flags |= NodeFlags.HasExplicitReturn;
      setEndFlowNode(node, this.currentFlow);
    }
    if (this.seenThisKeyword) node.flags |= NodeFlags.ContainsThis;
    if (node.kind === SyntaxKind.SourceFile) {
      node.flags |= this.emitFlags;
    }
    const returnTarget = this.currentReturnTarget;
    if (returnTarget !== undefined) {
      this.addAntecedent(returnTarget, this.currentFlow);
      this.currentFlow = this.finishFlowLabel(returnTarget);
      if (node.kind === SyntaxKind.Constructor || node.kind === SyntaxKind.ClassStaticBlockDeclaration)
        setReturnFlowNode(node, this.currentFlow);
    }
    if (!isImmediatelyInvoked) this.currentFlow = saveCurrentFlow;
    this.currentBreakTarget = saveBreakTarget;
    this.currentContinueTarget = saveContinueTarget;
    this.currentReturnTarget = saveReturnTarget;
    this.currentExceptionTarget = saveExceptionTarget;
    this.activeLabelList = saveActiveLabelList;
    this.hasExplicitReturn = saveHasExplicitReturn;
    this.seenThisKeyword =
      (containerFlags & ContainerFlags.PropagatesThisKeyword) !== 0
        ? saveSeenThisKeyword || this.seenThisKeyword
        : saveSeenThisKeyword;
  }

  finishSourceFile(file: SourceFile): void {
    if (isInJSFile(file)) {
      // Top-level @typedef aliases wait until CommonJS module indicators are known.
      for (const statement of file.statements.nodes)
        if (statement.kind === SyntaxKind.JSTypeAliasDeclaration)
          this.bindBlockScopedDeclaration(statement, SymbolFlags.TypeAlias, SymbolFlags.TypeAliasExcludes);
      if (file.commonJSModuleIndicator !== undefined) {
        this.declareCommonJSVariable('module');
        this.declareCommonJSVariable('exports');
      }
    }
    if (isExternalOrCommonJSModule(file)) this.bindCommonJSTypeExports(file.symbol);
  }

  declareCommonJSVariable(name: string): void {
    const locals = this.localsOf(this.file);
    if (locals.has(name)) return;
    const symbol = this.newSymbol(SymbolFlags.FunctionScopedVariable | SymbolFlags.ModuleExports, name);
    addDeclaration(symbol, this.file);
    symbol.valueDeclaration = this.file;
    if (name === 'module') {
      const exportsProperty = this.newSymbol(SymbolFlags.ModuleExports | SymbolFlags.Property, 'exports');
      copyDeclarations(exportsProperty, symbol);
      exportsProperty.valueDeclaration = this.file;
      exportsProperty.parent = symbol;
      getMembers(symbol).set('exports', exportsProperty);
    }
    locals.set(name, symbol);
  }

  addToContainerChain(next: Node): void {
    const last = this.lastContainer;
    if (last !== undefined) setNextContainer(last, next);
    this.lastContainer = next;
  }

  bindChildren(node: Node): void {
    const saveInAssignmentPattern = this.inAssignmentPattern;
    // Most nodes can't be in an assignment pattern; those that can restore it below.
    this.inAssignmentPattern = false;
    if (this.currentFlow === this.unreachableFlow) {
      setFlowNode(node, undefined);
      if (isPotentiallyExecutableNode(node)) node.flags |= NodeFlags.Unreachable;
      node.forEachChild(this);
      this.inAssignmentPattern = saveInAssignmentPattern;
      return;
    }
    if (node.kind >= SyntaxKind.FirstStatement && node.kind <= SyntaxKind.LastStatement)
      setFlowNode(node, this.currentFlowValue());
    switch (node.kind) {
      case SyntaxKind.WhileStatement:
        this.bindWhileStatement(node as WhileStatement);
        break;
      case SyntaxKind.DoStatement:
        this.bindDoStatement(node as DoStatement);
        break;
      case SyntaxKind.ForStatement:
        this.bindForStatement(node as ForStatement);
        break;
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        this.bindForInOrForOfStatement(node as ForInOrOfStatement);
        break;
      case SyntaxKind.IfStatement:
        this.bindIfStatement(node as IfStatement);
        break;
      case SyntaxKind.ReturnStatement:
        this.bindOptional(getExpression(node));
        if (this.currentReturnTarget !== undefined) this.addAntecedent(this.currentReturnTarget, this.currentFlow);
        this.currentFlow = this.unreachableFlow;
        this.hasExplicitReturn = true;
        this.hasFlowEffects = true;
        break;
      case SyntaxKind.ThrowStatement:
        this.bindOptional(getExpression(node));
        this.currentFlow = this.unreachableFlow;
        this.hasFlowEffects = true;
        break;
      case SyntaxKind.BreakStatement:
        this.bindBreakOrContinueStatement(getLabel(node), true);
        break;
      case SyntaxKind.ContinueStatement:
        this.bindBreakOrContinueStatement(getLabel(node), false);
        break;
      case SyntaxKind.TryStatement:
        this.bindTryStatement(node as TryStatement);
        break;
      case SyntaxKind.SwitchStatement:
        this.bindSwitchStatement(node as SwitchStatement);
        break;
      case SyntaxKind.CaseBlock:
        this.bindCaseBlock(node as CaseBlock);
        break;
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause:
        this.bindCaseOrDefaultClause(node as CaseOrDefaultClause);
        break;
      case SyntaxKind.ExpressionStatement: {
        const expression = (node as ExpressionStatement).expression;
        this.bind(expression);
        this.maybeBindExpressionFlowIfCall(expression);
        break;
      }
      case SyntaxKind.LabeledStatement:
        this.bindLabeledStatement(node as LabeledStatement);
        break;
      case SyntaxKind.PrefixUnaryExpression:
        this.bindPrefixUnaryExpressionFlow(node as PrefixUnaryExpression);
        break;
      case SyntaxKind.PostfixUnaryExpression: {
        node.forEachChild(this);
        const operator = (node as PostfixUnaryExpression).operator;
        if (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken)
          this.bindAssignmentTargetFlow((node as PostfixUnaryExpression).operand);
        break;
      }
      case SyntaxKind.BinaryExpression:
        if (isDestructuringAssignment(node)) {
          // Carry the assignment pattern state into initializers of the pattern.
          this.inAssignmentPattern = saveInAssignmentPattern;
          this.bindDestructuringAssignmentFlow(node as BinaryExpression);
          return;
        }
        this.bindBinaryExpressionFlow(node as BinaryExpression);
        break;
      case SyntaxKind.DeleteExpression:
        node.forEachChild(this);
        if ((node as DeleteExpression).expression.kind === SyntaxKind.PropertyAccessExpression)
          this.bindAssignmentTargetFlow((node as DeleteExpression).expression);
        break;
      case SyntaxKind.ConditionalExpression:
        this.bindConditionalExpressionFlow(node as ConditionalExpression);
        break;
      case SyntaxKind.VariableDeclaration:
        node.forEachChild(this);
        if (
          (node as VariableDeclaration).initializer !== undefined ||
          isForInOrOfStatementKind(node.parent!.parent!.kind)
        )
          this.bindInitializedVariableFlow(node);
        break;
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
      case SyntaxKind.NonNullExpression:
        if (isOptionalChain(node)) this.bindOptionalChainFlow(node);
        else node.forEachChild(this);
        break;
      case SyntaxKind.CallExpression:
        this.bindCallExpressionFlow(node as CallExpression);
        break;
      case SyntaxKind.SourceFile:
        this.bindEachStatementFunctionsFirst((node as SourceFile).statements);
        this.bind((node as SourceFile).endOfFileToken);
        break;
      case SyntaxKind.Block:
      case SyntaxKind.ModuleBlock:
        this.bindEachStatementFunctionsFirst(getStatements(node)!);
        break;
      case SyntaxKind.BindingElement: {
        // The initializer runs before the binding pattern.
        const element = node as BindingElement;
        this.bindOptional(element.dotDotDotToken);
        this.bindOptional(element.propertyName);
        this.bindInitializer(element.initializer);
        this.bindOptional(element.name);
        break;
      }
      case SyntaxKind.Parameter: {
        const parameter = node as ParameterDeclaration;
        this.bindNodes(parameter.modifiers);
        this.bindOptional(parameter.dotDotDotToken);
        this.bindOptional(parameter.questionToken);
        this.bindOptional(parameter.type);
        this.bindInitializer(parameter.initializer);
        this.bind(parameter.name);
        break;
      }
      case SyntaxKind.ObjectLiteralExpression:
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.SpreadElement:
        this.inAssignmentPattern = saveInAssignmentPattern;
        node.forEachChild(this);
        break;
      default:
        node.forEachChild(this);
    }
    this.inAssignmentPattern = saveInAssignmentPattern;
  }

  bindNodes(list: NodeList | undefined): void {
    if (list === undefined) return;
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) this.bind(nodes[i]!);
  }

  bindEachStatementFunctionsFirst(statements: NodeList): void {
    const nodes = statements.nodes;
    for (let i = 0; i < nodes.length; i++) if (nodes[i]!.kind === SyntaxKind.FunctionDeclaration) this.bind(nodes[i]!);
    for (let i = 0; i < nodes.length; i++) if (nodes[i]!.kind !== SyntaxKind.FunctionDeclaration) this.bind(nodes[i]!);
  }

  // Flow graph

  createBranchLabel(): FlowNode {
    return new FlowNode(FlowFlags.BranchLabel, undefined, undefined);
  }

  createLoopLabel(): FlowNode {
    return new FlowNode(FlowFlags.LoopLabel, undefined, undefined);
  }

  createFlowCondition(flags: FlowFlags, antecedent: FlowNode, expression: Node | undefined): FlowNode {
    if ((antecedent.flags & FlowFlags.Unreachable) !== 0) return antecedent;
    if (expression === undefined) return (flags & FlowFlags.TrueCondition) !== 0 ? antecedent : this.unreachableFlow;
    if (
      ((expression.kind === SyntaxKind.TrueKeyword && (flags & FlowFlags.FalseCondition) !== 0) ||
        (expression.kind === SyntaxKind.FalseKeyword && (flags & FlowFlags.TrueCondition) !== 0)) &&
      !isExpressionOfOptionalChainRoot(expression) &&
      !isNullishCoalesce(expression.parent!)
    )
      return this.unreachableFlow;
    if (!isNarrowingExpression(expression)) return antecedent;
    setFlowNodeReferenced(antecedent);
    return new FlowNode(flags, expression, antecedent);
  }

  createFlowMutation(flags: FlowFlags, antecedent: FlowNode, node: Node): FlowNode {
    setFlowNodeReferenced(antecedent);
    this.hasFlowEffects = true;
    const result = new FlowNode(flags, node, antecedent);
    if (this.currentExceptionTarget !== undefined) this.addAntecedent(this.currentExceptionTarget, result);
    return result;
  }

  createFlowSwitchClause(
    antecedent: FlowNode,
    switchStatement: Node,
    clauseStart: number,
    clauseEnd: number,
  ): FlowNode {
    setFlowNodeReferenced(antecedent);
    return new FlowSwitchClause(antecedent, switchStatement, clauseStart, clauseEnd);
  }

  createFlowCall(antecedent: FlowNode, node: Node): FlowNode {
    setFlowNodeReferenced(antecedent);
    this.hasFlowEffects = true;
    return new FlowNode(FlowFlags.Call, node, antecedent);
  }

  /** Adds `antecedent` to the end of the label's antecedents, unless unreachable or already there. */
  addAntecedent(label: FlowNode, antecedent: FlowNode): void {
    if ((antecedent.flags & FlowFlags.Unreachable) !== 0) return;
    const antecedents = label.antecedents;
    if (antecedents === undefined) label.antecedents = [antecedent];
    else {
      if (antecedents.indexOf(antecedent) >= 0) return;
      antecedents.push(antecedent);
    }
    setFlowNodeReferenced(antecedent);
  }

  /** The label, its only antecedent, or unreachable if it has none. */
  finishFlowLabel(label: FlowNode): FlowNode {
    const antecedents = label.antecedents;
    if (antecedents === undefined) return this.unreachableFlow;
    if (antecedents.length === 1) return antecedents[0]!;
    return label;
  }

  setContinueTarget(node: Node, target: FlowNode): FlowNode {
    let label = this.activeLabelList;
    let current = node;
    while (label !== undefined && current.parent!.kind === SyntaxKind.LabeledStatement) {
      label.continueTarget = target;
      label = label.next;
      current = current.parent!;
    }
    return target;
  }

  /** Binds `node` with `trueTarget` and `falseTarget` as the condition's targets. */
  bindWithTargets(node: Node | undefined, trueTarget: FlowNode | undefined, falseTarget: FlowNode | undefined): void {
    const savedTrueTarget = this.currentTrueTarget;
    const savedFalseTarget = this.currentFalseTarget;
    this.currentTrueTarget = trueTarget;
    this.currentFalseTarget = falseTarget;
    this.bindOptional(node);
    this.currentTrueTarget = savedTrueTarget;
    this.currentFalseTarget = savedFalseTarget;
  }

  bindCondition(node: Node | undefined, trueTarget: FlowNode, falseTarget: FlowNode): void {
    this.bindWithTargets(node, trueTarget, falseTarget);
    if (
      node === undefined ||
      (!isLogicalOrCoalescingAssignmentExpression(skipParentheses(node)) &&
        !isLogicalExpression(node) &&
        !(isOptionalChain(node) && isOutermostOptionalChain(node)))
    ) {
      this.addAntecedent(trueTarget, this.createFlowCondition(FlowFlags.TrueCondition, this.currentFlow, node));
      this.addAntecedent(falseTarget, this.createFlowCondition(FlowFlags.FalseCondition, this.currentFlow, node));
    }
  }

  bindIterativeStatement(node: Node, breakTarget: FlowNode, continueTarget: FlowNode): void {
    const saveBreakTarget = this.currentBreakTarget;
    const saveContinueTarget = this.currentContinueTarget;
    this.currentBreakTarget = breakTarget;
    this.currentContinueTarget = continueTarget;
    this.bind(node);
    this.currentBreakTarget = saveBreakTarget;
    this.currentContinueTarget = saveContinueTarget;
  }

  bindAssignmentTargetFlow(node: Node): void {
    switch (node.kind) {
      case SyntaxKind.ArrayLiteralExpression:
        for (const element of getElements(node)!.nodes) {
          if (element.kind === SyntaxKind.SpreadElement) this.bindAssignmentTargetFlow(getExpression(element)!);
          else this.bindDestructuringTargetFlow(element);
        }
        break;
      case SyntaxKind.ObjectLiteralExpression:
        for (const property of getProperties(node)!.nodes) {
          switch (property.kind) {
            case SyntaxKind.PropertyAssignment:
              this.bindDestructuringTargetFlow(getInitializer(property)!);
              break;
            case SyntaxKind.ShorthandPropertyAssignment:
              this.bindAssignmentTargetFlow(getName(property)!);
              break;
            case SyntaxKind.SpreadAssignment:
              this.bindAssignmentTargetFlow(getExpression(property)!);
              break;
          }
        }
        break;
      default:
        if (isNarrowableReference(node))
          this.currentFlow = this.createFlowMutation(FlowFlags.Assignment, this.currentFlow, node);
    }
  }

  bindDestructuringTargetFlow(node: Node): void {
    if (node instanceof BinaryExpression && (node as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken)
      this.bindAssignmentTargetFlow((node as BinaryExpression).left);
    else this.bindAssignmentTargetFlow(node);
  }

  bindWhileStatement(node: WhileStatement): void {
    const preWhileLabel = this.setContinueTarget(node, this.createLoopLabel());
    const preBodyLabel = this.createBranchLabel();
    const postWhileLabel = this.createBranchLabel();
    this.addAntecedent(preWhileLabel, this.currentFlow);
    this.currentFlow = preWhileLabel;
    this.bindCondition(node.expression, preBodyLabel, postWhileLabel);
    this.currentFlow = this.finishFlowLabel(preBodyLabel);
    this.bindIterativeStatement(node.statement, postWhileLabel, preWhileLabel);
    this.addAntecedent(preWhileLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(postWhileLabel);
  }

  bindDoStatement(node: DoStatement): void {
    const preDoLabel = this.createLoopLabel();
    const preConditionLabel = this.setContinueTarget(node, this.createBranchLabel());
    const postDoLabel = this.createBranchLabel();
    this.addAntecedent(preDoLabel, this.currentFlow);
    this.currentFlow = preDoLabel;
    this.bindIterativeStatement(node.statement, postDoLabel, preConditionLabel);
    this.addAntecedent(preConditionLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(preConditionLabel);
    this.bindCondition(node.expression, preDoLabel, postDoLabel);
    this.currentFlow = this.finishFlowLabel(postDoLabel);
  }

  bindForStatement(node: ForStatement): void {
    this.bindOptional(node.initializer);
    if (this.currentFlow === this.unreachableFlow) {
      // An initializer that ends the flow (a throwing IIFE) would leave the loop label only the
      // incrementor's back edge: a cycle with no entry. Bind the rest as unreachable.
      this.bindOptional(node.condition);
      this.bind(node.statement);
      this.bindOptional(node.incrementor);
      return;
    }
    const preLoopLabel = this.setContinueTarget(node, this.createLoopLabel());
    const preBodyLabel = this.createBranchLabel();
    const preIncrementorLabel = this.createBranchLabel();
    const postLoopLabel = this.createBranchLabel();
    this.addAntecedent(preLoopLabel, this.currentFlow);
    this.currentFlow = preLoopLabel;
    this.bindCondition(node.condition, preBodyLabel, postLoopLabel);
    this.currentFlow = this.finishFlowLabel(preBodyLabel);
    this.bindIterativeStatement(node.statement, postLoopLabel, preIncrementorLabel);
    this.addAntecedent(preIncrementorLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(preIncrementorLabel);
    this.bindOptional(node.incrementor);
    this.addAntecedent(preLoopLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(postLoopLabel);
  }

  bindForInOrForOfStatement(node: ForInOrOfStatement): void {
    this.bind(node.expression);
    if (this.currentFlow === this.unreachableFlow) {
      // As for a `for` initializer: an expression that ends the flow leaves the loop unreachable.
      this.bind(node.initializer);
      this.bind(node.statement);
      return;
    }
    const preLoopLabel = this.setContinueTarget(node, this.createLoopLabel());
    const postLoopLabel = this.createBranchLabel();
    this.addAntecedent(preLoopLabel, this.currentFlow);
    this.currentFlow = preLoopLabel;
    if (node.kind === SyntaxKind.ForOfStatement) this.bindOptional(node.awaitModifier);
    this.addAntecedent(postLoopLabel, this.currentFlow);
    this.bind(node.initializer);
    if (node.initializer.kind !== SyntaxKind.VariableDeclarationList) this.bindAssignmentTargetFlow(node.initializer);
    this.bindIterativeStatement(node.statement, postLoopLabel, preLoopLabel);
    this.addAntecedent(preLoopLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(postLoopLabel);
  }

  bindIfStatement(node: IfStatement): void {
    const thenLabel = this.createBranchLabel();
    const elseLabel = this.createBranchLabel();
    const postIfLabel = this.createBranchLabel();
    this.bindCondition(node.expression, thenLabel, elseLabel);
    this.currentFlow = this.finishFlowLabel(thenLabel);
    this.bind(node.thenStatement);
    this.addAntecedent(postIfLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(elseLabel);
    this.bindOptional(node.elseStatement);
    this.addAntecedent(postIfLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(postIfLabel);
  }

  bindBreakOrContinueStatement(label: Node | undefined, isBreak: boolean): void {
    this.bindOptional(label);
    if (label !== undefined) {
      const name = getText(label);
      let activeLabel = this.activeLabelList;
      while (activeLabel !== undefined && activeLabel.name !== name) activeLabel = activeLabel.next;
      if (activeLabel !== undefined) {
        activeLabel.referenced = true;
        this.bindBreakOrContinueFlow(isBreak ? activeLabel.breakTarget : activeLabel.continueTarget);
      }
    } else this.bindBreakOrContinueFlow(isBreak ? this.currentBreakTarget : this.currentContinueTarget);
  }

  bindBreakOrContinueFlow(flowLabel: FlowNode | undefined): void {
    if (flowLabel === undefined) return;
    this.addAntecedent(flowLabel, this.currentFlow);
    this.currentFlow = this.unreachableFlow;
    this.hasFlowEffects = true;
  }

  /**
   * Any code in a `try` block may throw, but only mutations change narrowed types, so the
   * exception label collects the mutations (and the flow before them) as antecedents of the
   * `catch` or `finally` block.
   */
  bindTryStatement(node: TryStatement): void {
    const saveReturnTarget = this.currentReturnTarget;
    const saveExceptionTarget = this.currentExceptionTarget;
    const normalExitLabel = this.createBranchLabel();
    const returnLabel = this.createBranchLabel();
    let exceptionLabel = this.createBranchLabel();
    if (node.finallyBlock !== undefined) this.currentReturnTarget = returnLabel;
    this.addAntecedent(exceptionLabel, this.currentFlow);
    this.currentExceptionTarget = exceptionLabel;
    this.bind(node.tryBlock);
    this.addAntecedent(normalExitLabel, this.currentFlow);
    if (node.catchClause !== undefined) {
      // The catch clause starts with the exceptions of the try block and acts like a second try block.
      this.currentFlow = this.finishFlowLabel(exceptionLabel);
      exceptionLabel = this.createBranchLabel();
      this.addAntecedent(exceptionLabel, this.currentFlow);
      this.currentExceptionTarget = exceptionLabel;
      this.bind(node.catchClause);
      this.addAntecedent(normalExitLabel, this.currentFlow);
    }
    this.currentReturnTarget = saveReturnTarget;
    this.currentExceptionTarget = saveExceptionTarget;
    if (node.finallyBlock === undefined) {
      this.currentFlow = this.finishFlowLabel(normalExitLabel);
      return;
    }
    // The finally block is reached by normal completion of the try or catch block, by returns in
    // them, and by exceptions in them. Analysis that starts past the finally block only considers
    // normal completion, and returns from an IIFE only the returns, so ReduceLabel nodes give the
    // finally label a reduced set of antecedents for those paths.
    const finallyLabel = this.createBranchLabel();
    finallyLabel.antecedents = combineFlowLists(
      normalExitLabel.antecedents,
      combineFlowLists(exceptionLabel.antecedents, returnLabel.antecedents),
    );
    this.currentFlow = finallyLabel;
    this.bind(node.finallyBlock);
    if ((this.currentFlow.flags & FlowFlags.Unreachable) !== 0) {
      // An unreachable end of the finally block makes the end of the try statement unreachable.
      this.currentFlow = this.unreachableFlow;
      return;
    }
    // Returns in the try or catch block of an IIFE continue through the finally block.
    if (this.currentReturnTarget !== undefined && returnLabel.antecedents !== undefined)
      this.addAntecedent(
        this.currentReturnTarget,
        new FlowReduceLabel(finallyLabel, returnLabel.antecedents, this.currentFlow),
      );
    // So do exceptions, to an enclosing try statement.
    if (this.currentExceptionTarget !== undefined && exceptionLabel.antecedents !== undefined)
      this.addAntecedent(
        this.currentExceptionTarget,
        new FlowReduceLabel(finallyLabel, exceptionLabel.antecedents, this.currentFlow),
      );
    // `try { return 1; } finally { … }` ends unreachable.
    this.currentFlow =
      normalExitLabel.antecedents !== undefined
        ? new FlowReduceLabel(finallyLabel, normalExitLabel.antecedents, this.currentFlow)
        : this.unreachableFlow;
  }

  bindSwitchStatement(node: SwitchStatement): void {
    const postSwitchLabel = this.createBranchLabel();
    this.bind(node.expression);
    const saveBreakTarget = this.currentBreakTarget;
    const savePreSwitchCaseFlow = this.preSwitchCaseFlow;
    this.currentBreakTarget = postSwitchLabel;
    this.preSwitchCaseFlow = this.currentFlow;
    this.bind(node.caseBlock);
    this.addAntecedent(postSwitchLabel, this.currentFlow);
    let hasDefault = false;
    for (const clause of node.caseBlock.clauses.nodes) if (clause.kind === SyntaxKind.DefaultClause) hasDefault = true;
    if (!hasDefault)
      this.addAntecedent(postSwitchLabel, this.createFlowSwitchClause(this.preSwitchCaseFlow, node, 0, 0));
    this.currentBreakTarget = saveBreakTarget;
    this.preSwitchCaseFlow = savePreSwitchCaseFlow;
    this.currentFlow = this.finishFlowLabel(postSwitchLabel);
  }

  bindCaseBlock(node: CaseBlock): void {
    const switchStatement = node.parent as SwitchStatement;
    const clauses = node.clauses.nodes;
    const switchExpression = switchStatement.expression;
    const isNarrowingSwitch =
      switchExpression.kind === SyntaxKind.TrueKeyword || isNarrowingExpression(switchExpression);
    let fallthroughFlow = this.unreachableFlow;
    for (let i = 0; i < clauses.length; i++) {
      const clauseStart = i;
      while ((clauses[i]! as CaseOrDefaultClause).statements.nodes.length === 0 && i + 1 < clauses.length) {
        if (fallthroughFlow === this.unreachableFlow) this.currentFlow = this.preSwitchCaseFlow!;
        this.bind(clauses[i]!);
        i++;
      }
      const preCaseLabel = this.createBranchLabel();
      const preCaseFlow = isNarrowingSwitch
        ? this.createFlowSwitchClause(this.preSwitchCaseFlow!, switchStatement, clauseStart, i + 1)
        : this.preSwitchCaseFlow!;
      this.addAntecedent(preCaseLabel, preCaseFlow);
      this.addAntecedent(preCaseLabel, fallthroughFlow);
      this.currentFlow = this.finishFlowLabel(preCaseLabel);
      const clause = clauses[i]! as CaseOrDefaultClause;
      this.bind(clause);
      fallthroughFlow = this.currentFlow;
      if ((this.currentFlow.flags & FlowFlags.Unreachable) === 0 && i !== clauses.length - 1)
        clause.fallthroughFlowNode = this.currentFlow;
    }
  }

  bindCaseOrDefaultClause(node: CaseOrDefaultClause): void {
    if (node.expression !== undefined) {
      const saveCurrentFlow = this.currentFlow;
      this.currentFlow = this.preSwitchCaseFlow!;
      this.bind(node.expression);
      this.currentFlow = saveCurrentFlow;
    }
    this.bindNodes(node.statements);
  }

  /** A top-level or comma call with a dotted callee may be an assertion, so it joins the flow graph. */
  maybeBindExpressionFlowIfCall(node: Node): void {
    if (node instanceof CallExpression) {
      const call: CallExpression = node;
      const callee = call.expression;
      if (callee.kind !== SyntaxKind.SuperKeyword && isDottedName(callee))
        this.currentFlow = this.createFlowCall(this.currentFlow, node);
    }
  }

  bindLabeledStatement(node: LabeledStatement): void {
    const postStatementLabel = this.createBranchLabel();
    const activeLabel = new ActiveLabel(this.activeLabelList, node.label.text, postStatementLabel);
    this.activeLabelList = activeLabel;
    this.bind(node.label);
    this.bind(node.statement);
    // An unused label; the checker decides whether to report it.
    if (!activeLabel.referenced) node.label.flags |= NodeFlags.Unreachable;
    this.activeLabelList = activeLabel.next;
    this.addAntecedent(postStatementLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(postStatementLabel);
  }

  bindPrefixUnaryExpressionFlow(node: PrefixUnaryExpression): void {
    if (node.operator === SyntaxKind.ExclamationToken) {
      const saveTrueTarget = this.currentTrueTarget;
      this.currentTrueTarget = this.currentFalseTarget;
      this.currentFalseTarget = saveTrueTarget;
      node.forEachChild(this);
      this.currentFalseTarget = this.currentTrueTarget;
      this.currentTrueTarget = saveTrueTarget;
    } else {
      node.forEachChild(this);
      if (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
        this.bindAssignmentTargetFlow(node.operand);
    }
  }

  bindDestructuringAssignmentFlow(node: BinaryExpression): void {
    if (this.inAssignmentPattern) {
      this.inAssignmentPattern = false;
      this.bind(node.operatorToken);
      this.bind(node.right);
      this.inAssignmentPattern = true;
      this.bind(node.left);
      this.bindOptional(node.type);
    } else {
      this.inAssignmentPattern = true;
      this.bind(node.left);
      this.bindOptional(node.type);
      this.inAssignmentPattern = false;
      this.bind(node.operatorToken);
      this.bind(node.right);
    }
    this.bindAssignmentTargetFlow(node.left);
  }

  bindBinaryExpressionFlow(node: BinaryExpression): void {
    const operator = node.operatorToken.kind;
    if (isLogicalOrCoalescingBinaryOperator(operator) || isLogicalOrCoalescingAssignmentOperator(operator)) {
      if (isTopLevelLogicalExpression(node)) {
        const postExpressionLabel = this.createBranchLabel();
        const saveCurrentFlow = this.currentFlow;
        const saveHasFlowEffects = this.hasFlowEffects;
        this.hasFlowEffects = false;
        this.bindLogicalLikeExpression(node, postExpressionLabel, postExpressionLabel);
        this.currentFlow = this.hasFlowEffects ? this.finishFlowLabel(postExpressionLabel) : saveCurrentFlow;
        this.hasFlowEffects = this.hasFlowEffects || saveHasFlowEffects;
      } else this.bindLogicalLikeExpression(node, this.currentTrueTarget!, this.currentFalseTarget!);
      return;
    }
    this.bind(node.left);
    this.bindOptional(node.type);
    if (operator === SyntaxKind.CommaToken) this.maybeBindExpressionFlowIfCall(node.left);
    this.bind(node.operatorToken);
    this.bind(node.right);
    if (operator === SyntaxKind.CommaToken) this.maybeBindExpressionFlowIfCall(node.right);
    if (isAssignmentOperator(operator) && !isAssignmentTarget(node)) {
      this.bindAssignmentTargetFlow(node.left);
      const left = node.left;
      if (
        operator === SyntaxKind.EqualsToken &&
        left instanceof ElementAccessExpression &&
        isNarrowableOperand((left as ElementAccessExpression).expression)
      )
        this.currentFlow = this.createFlowMutation(FlowFlags.ArrayMutation, this.currentFlow, node);
    }
  }

  bindLogicalLikeExpression(node: BinaryExpression, trueTarget: FlowNode, falseTarget: FlowNode): void {
    const preRightLabel = this.createBranchLabel();
    const operator = node.operatorToken.kind;
    if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.AmpersandAmpersandEqualsToken)
      this.bindCondition(node.left, preRightLabel, falseTarget);
    else this.bindCondition(node.left, trueTarget, preRightLabel);
    this.currentFlow = this.finishFlowLabel(preRightLabel);
    this.bind(node.operatorToken);
    if (isLogicalOrCoalescingAssignmentOperator(operator)) {
      this.bindWithTargets(node.right, trueTarget, falseTarget);
      this.bindAssignmentTargetFlow(node.left);
      this.addAntecedent(trueTarget, this.createFlowCondition(FlowFlags.TrueCondition, this.currentFlow, node));
      this.addAntecedent(falseTarget, this.createFlowCondition(FlowFlags.FalseCondition, this.currentFlow, node));
    } else this.bindCondition(node.right, trueTarget, falseTarget);
  }

  bindConditionalExpressionFlow(node: ConditionalExpression): void {
    const trueLabel = this.createBranchLabel();
    const falseLabel = this.createBranchLabel();
    const postExpressionLabel = this.createBranchLabel();
    const saveCurrentFlow = this.currentFlow;
    const saveHasFlowEffects = this.hasFlowEffects;
    this.hasFlowEffects = false;
    this.bindCondition(node.condition, trueLabel, falseLabel);
    this.currentFlow = this.finishFlowLabel(trueLabel);
    this.bind(node.questionToken);
    this.bind(node.whenTrue);
    this.addAntecedent(postExpressionLabel, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(falseLabel);
    this.bind(node.colonToken);
    this.bind(node.whenFalse);
    this.addAntecedent(postExpressionLabel, this.currentFlow);
    this.currentFlow = this.hasFlowEffects ? this.finishFlowLabel(postExpressionLabel) : saveCurrentFlow;
    this.hasFlowEffects = this.hasFlowEffects || saveHasFlowEffects;
  }

  bindInitializedVariableFlow(node: Node): void {
    const name = getName(node);
    if (
      name !== undefined &&
      (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
    ) {
      for (const element of getElements(name)!.nodes) this.bindInitializedVariableFlow(element);
    } else this.currentFlow = this.createFlowMutation(FlowFlags.Assignment, this.currentFlow, node);
  }

  bindOptionalChainFlow(node: Node): void {
    if (isTopLevelLogicalExpression(node)) {
      const postExpressionLabel = this.createBranchLabel();
      const saveCurrentFlow = this.currentFlow;
      const saveHasFlowEffects = this.hasFlowEffects;
      this.bindOptionalChain(node, postExpressionLabel, postExpressionLabel);
      this.currentFlow = this.hasFlowEffects ? this.finishFlowLabel(postExpressionLabel) : saveCurrentFlow;
      this.hasFlowEffects = this.hasFlowEffects || saveHasFlowEffects;
    } else this.bindOptionalChain(node, this.currentTrueTarget!, this.currentFalseTarget!);
  }

  /**
   * Binds an optional chain like a logical expression: `a?.b.c` as `a && a.b.c`. The chain's
   * root is the first condition and the rest of the chain is its true branch.
   */
  bindOptionalChain(node: Node, trueTarget: FlowNode, falseTarget: FlowNode): void {
    const preChainLabel = isOptionalChainRoot(node) ? this.createBranchLabel() : undefined;
    this.bindOptionalExpression(getExpression(node)!, preChainLabel ?? trueTarget, falseTarget);
    if (preChainLabel !== undefined) this.currentFlow = this.finishFlowLabel(preChainLabel);
    const savedTrueTarget = this.currentTrueTarget;
    const savedFalseTarget = this.currentFalseTarget;
    this.currentTrueTarget = trueTarget;
    this.currentFalseTarget = falseTarget;
    this.bindOptionalChainRest(node);
    this.currentTrueTarget = savedTrueTarget;
    this.currentFalseTarget = savedFalseTarget;
    if (isOutermostOptionalChain(node)) {
      this.addAntecedent(trueTarget, this.createFlowCondition(FlowFlags.TrueCondition, this.currentFlow, node));
      this.addAntecedent(falseTarget, this.createFlowCondition(FlowFlags.FalseCondition, this.currentFlow, node));
    }
  }

  bindOptionalExpression(node: Node, trueTarget: FlowNode, falseTarget: FlowNode): void {
    this.bindWithTargets(node, trueTarget, falseTarget);
    if (!isOptionalChain(node) || isOutermostOptionalChain(node)) {
      this.addAntecedent(trueTarget, this.createFlowCondition(FlowFlags.TrueCondition, this.currentFlow, node));
      this.addAntecedent(falseTarget, this.createFlowCondition(FlowFlags.FalseCondition, this.currentFlow, node));
    }
  }

  bindOptionalChainRest(node: Node): void {
    if (node instanceof PropertyAccessExpression) {
      this.bindOptional((node as PropertyAccessExpression).questionDotToken);
      this.bind((node as PropertyAccessExpression).name);
    } else if (node instanceof ElementAccessExpression) {
      this.bindOptional((node as ElementAccessExpression).questionDotToken);
      this.bind((node as ElementAccessExpression).argumentExpression);
    } else if (node instanceof CallExpression) {
      this.bindOptional(callQuestionDotToken(node as CallExpression));
      this.bindNodes(callTypeArguments(node as CallExpression));
      this.bindNodes((node as CallExpression).arguments);
    }
  }

  bindCallExpressionFlow(node: CallExpression): void {
    if (isOptionalChain(node)) this.bindOptionalChainFlow(node);
    else {
      // An IIFE's flow node includes the evaluation of its arguments.
      const callee = skipParentheses(node.expression);
      if (callee.kind === SyntaxKind.FunctionExpression || callee.kind === SyntaxKind.ArrowFunction) {
        this.bindNodes(callTypeArguments(node));
        this.bindNodes(node.arguments);
        this.bind(node.expression);
      } else {
        node.forEachChild(this);
        if (node.expression.kind === SyntaxKind.SuperKeyword)
          this.currentFlow = this.createFlowCall(this.currentFlow, node);
      }
    }
    const callee = node.expression;
    if (!(callee instanceof PropertyAccessExpression)) return;
    // Typed locals keep scriptc's field reads static after `instanceof`.
    const access: PropertyAccessExpression = callee;
    if (
      access.name.kind === SyntaxKind.Identifier &&
      isNarrowableOperand(access.expression) &&
      isPushOrUnshiftIdentifier(access.name)
    )
      this.currentFlow = this.createFlowMutation(FlowFlags.ArrayMutation, this.currentFlow, node);
  }

  /** Binds a parameter or binding element initializer, which only runs when the value is `undefined`. */
  bindInitializer(node: Node | undefined): void {
    if (node === undefined) return;
    const entryFlow = this.currentFlow;
    this.bind(node);
    if (entryFlow === this.unreachableFlow || entryFlow === this.currentFlow) return;
    const exitFlow = this.createBranchLabel();
    this.addAntecedent(exitFlow, entryFlow);
    this.addAntecedent(exitFlow, this.currentFlow);
    this.currentFlow = this.finishFlowLabel(exitFlow);
  }

  // Declarations by kind

  bindSourceFileIfExternalModule(file: SourceFile): void {
    this.setExportContextFlag(file);
    if (isExternalOrCommonJSModule(file)) this.bindSourceFileAsExternalModule(file);
    else if (isJsonSourceFile(file)) {
      this.bindSourceFileAsExternalModule(file);
      // The equivalent of `module.exports = {…}`.
      const originalSymbol = file.symbol!;
      this.declareSymbol(getExports(originalSymbol), originalSymbol, file, SymbolFlags.Property, SymbolFlags.All);
      file.symbol = originalSymbol;
    }
  }

  bindSourceFileAsExternalModule(file: SourceFile): void {
    this.bindAnonymousDeclaration(file, SymbolFlags.ValueModule, '"' + removeFileExtension(file.fileName) + '"');
  }

  bindModuleDeclaration(node: ModuleDeclaration): void {
    this.setExportContextFlag(node);
    if (isAmbientModule(node)) {
      if (hasSyntacticModifier(node, ModifierFlags.Export))
        this.errorOnFirstToken(
          node,
          Diagnostics.X_export_modifier_cannot_be_applied_to_ambient_modules_and_module_augmentations_since_they_are_always_visible,
          noArgs,
        );
      if (isModuleAugmentationExternal(node)) {
        this.declareModuleSymbol(node);
        return;
      }
      const symbol = this.declareSymbolAndAddToSymbolTable(
        node,
        SymbolFlags.ValueModule,
        SymbolFlags.ValueModuleExcludes,
      );
      const name = node.name;
      if (name.kind === SyntaxKind.StringLiteral) {
        const text = getText(name);
        const starIndex = text.indexOf('*');
        if (starIndex >= 0 && text.indexOf('*', starIndex + 1) >= 0)
          this.errorOnFirstToken(name, Diagnostics.Pattern_0_can_have_at_most_one_Asterisk_character, [text]);
        else if (starIndex >= 0)
          this.file.patternAmbientModules = appendToList(
            this.file.patternAmbientModules,
            new PatternAmbientModule(text, starIndex, symbol),
          );
        else if (node.attributes !== undefined)
          this.errorOnNode(
            name,
            Diagnostics.An_ambient_module_declaration_with_import_attributes_must_use_a_pattern_name_with_an_Asterisk_character,
            noArgs,
          );
      }
      return;
    }
    const state = this.declareModuleSymbol(node);
    if (state === ModuleInstanceState.NonInstantiated) return;
    const symbol = getSymbol(node)!;
    // A namespace merged with a function, class or regular enum isn't const-enum-only.
    const constEnumOnlyModule =
      (symbol.flags & (SymbolFlags.Function | SymbolFlags.Class | SymbolFlags.RegularEnum)) === 0 &&
      state === ModuleInstanceState.ConstEnumOnly &&
      !this.notConstEnumOnlyModules.has(symbol);
    if (constEnumOnlyModule) symbol.flags |= SymbolFlags.ConstEnumOnlyModule;
    else {
      symbol.flags &= ~SymbolFlags.ConstEnumOnlyModule;
      this.notConstEnumOnlyModules.add(symbol);
    }
  }

  declareModuleSymbol(node: ModuleDeclaration): ModuleInstanceState {
    const state = getModuleInstanceState(node, this.statementsByName);
    const instantiated = state !== ModuleInstanceState.NonInstantiated;
    this.declareSymbolAndAddToSymbolTable(
      node,
      instantiated ? SymbolFlags.ValueModule : SymbolFlags.NamespaceModule,
      instantiated ? SymbolFlags.ValueModuleExcludes : SymbolFlags.NamespaceModuleExcludes,
    );
    return state;
  }

  bindNamespaceExportDeclaration(node: Node): void {
    const parent = node.parent!;
    if (getModifiers(node) !== undefined) this.errorOnNode(node, Diagnostics.Modifiers_cannot_appear_here, noArgs);
    if (parent.kind !== SyntaxKind.SourceFile)
      this.errorOnNode(node, Diagnostics.Global_module_exports_may_only_appear_at_top_level, noArgs);
    else if (!isExternalModule(parent as SourceFile))
      this.errorOnNode(node, Diagnostics.Global_module_exports_may_only_appear_in_module_files, noArgs);
    else if (!(parent as SourceFile).isDeclarationFile)
      this.errorOnNode(node, Diagnostics.Global_module_exports_may_only_appear_in_declaration_files, noArgs);
    else {
      const file = this.file;
      let globalExports = file.globalExports;
      if (globalExports === undefined) {
        globalExports = new Map<string, Symbol>();
        file.globalExports = globalExports;
      }
      this.declareSymbol(globalExports, file.symbol, node, SymbolFlags.Alias, SymbolFlags.AliasExcludes);
    }
  }

  bindExportDeclaration(node: ExportDeclaration): void {
    const containerSymbol = getSymbol(this.container);
    if (containerSymbol === undefined)
      // `export *` in a block.
      this.bindAnonymousDeclaration(node, SymbolFlags.ExportStar, this.getDeclarationName(node));
    else if (node.exportClause === undefined)
      // All `export *` declarations go in one symbol.
      this.declareSymbol(getExports(containerSymbol), containerSymbol, node, SymbolFlags.ExportStar, SymbolFlags.None);
    else if (node.exportClause.kind === SyntaxKind.NamespaceExport)
      this.declareSymbol(
        getExports(containerSymbol),
        containerSymbol,
        node.exportClause,
        SymbolFlags.Alias,
        SymbolFlags.AliasExcludes,
      );
  }

  bindExportAssignment(node: ExportAssignment): void {
    const containerSymbol = getSymbol(this.container);
    if (containerSymbol === undefined) {
      // An export assignment in a block.
      this.bindAnonymousDeclaration(node, SymbolFlags.Value, this.getDeclarationName(node));
      return;
    }
    // `export default x` aliases x; anything else exported as default is a property.
    const flags = expressionIsAlias(node.expression) ? SymbolFlags.Alias : SymbolFlags.Property;
    const symbol = this.declareSymbol(getExports(containerSymbol), containerSymbol, node, flags, SymbolFlags.All);
    if (node.isExportEquals) setValueDeclaration(symbol, node);
  }

  /** Ambient files and modules without export declarations export every declaration implicitly. */
  setExportContextFlag(node: Node): void {
    if ((node.flags & NodeFlags.Ambient) !== 0 && !hasExportDeclarations(node)) node.flags |= NodeFlags.ExportContext;
    else node.flags &= ~NodeFlags.ExportContext;
  }

  bindFunctionDeclaration(node: Node): void {
    if (!this.file.isDeclarationFile && (node.flags & NodeFlags.Ambient) === 0 && isAsyncFunction(node))
      this.emitFlags |= NodeFlags.HasAsyncFunctions;
    this.checkStrictModeFunctionName(node);
    this.bindBlockScopedDeclaration(node, SymbolFlags.Function, SymbolFlags.FunctionExcludes);
  }

  bindFunctionExpression(node: Node): void {
    if (!this.file.isDeclarationFile && (node.flags & NodeFlags.Ambient) === 0 && isAsyncFunction(node))
      this.emitFlags |= NodeFlags.HasAsyncFunctions;
    setFlowNode(node, this.currentFlowValue());
    let bindingName: string = InternalSymbolName.Function;
    if (node instanceof FunctionExpression) {
      const name = (node as FunctionExpression).name;
      if (name !== undefined) {
        this.checkStrictModeFunctionName(node);
        bindingName = name.text;
      }
    }
    this.bindAnonymousDeclaration(node, SymbolFlags.Function, bindingName);
  }

  bindClassLikeDeclaration(node: Node): void {
    if (node.kind === SyntaxKind.ClassDeclaration)
      this.bindBlockScopedDeclaration(node, SymbolFlags.Class, SymbolFlags.ClassExcludes);
    else {
      const name = getName(node);
      this.bindAnonymousDeclaration(
        node,
        SymbolFlags.Class,
        name !== undefined ? getText(name) : InternalSymbolName.Class,
      );
    }
    // Every class has a static `prototype` property; declaring another one is an error, checked
    // here because the class may merge with a namespace that exports `prototype`.
    const symbol = getSymbol(node)!;
    const prototypeSymbol = this.newSymbol(SymbolFlags.Property | SymbolFlags.Prototype, 'prototype');
    const exports = getExports(symbol);
    const existing = exports.get('prototype');
    if (existing !== undefined)
      this.errorOnNode(existing.declaration!, Diagnostics.Duplicate_identifier_0, ['prototype']);
    exports.set('prototype', prototypeSymbol);
    prototypeSymbol.parent = symbol;
  }

  bindPropertyOrMethodOrAccessor(node: Node, symbolFlags: SymbolFlags, symbolExcludes: SymbolFlags): void {
    if (!this.file.isDeclarationFile && (node.flags & NodeFlags.Ambient) === 0 && isAsyncFunction(node))
      this.emitFlags |= NodeFlags.HasAsyncFunctions;
    if (isObjectLiteralOrClassExpressionMethodOrAccessor(node)) setFlowNode(node, this.currentFlowValue());
    if (hasDynamicName(node)) this.bindAnonymousDeclaration(node, symbolFlags, InternalSymbolName.Computed);
    else this.declareSymbolAndAddToSymbolTable(node, symbolFlags, symbolExcludes);
  }

  /** Binds `(…) => T` like `{ (…): T }`: a type literal symbol whose only member is the signature. */
  bindFunctionOrConstructorType(node: Node): void {
    const symbol = this.newSymbol(SymbolFlags.Signature, this.getDeclarationName(node));
    this.addDeclarationToSymbol(symbol, node, SymbolFlags.Signature);
    const typeLiteralSymbol = this.newSymbol(SymbolFlags.TypeLiteral, InternalSymbolName.Type);
    this.addDeclarationToSymbol(typeLiteralSymbol, node, SymbolFlags.TypeLiteral);
    getMembers(typeLiteralSymbol).set(symbol.name, symbol);
  }

  bindVariableDeclarationOrBindingElement(node: Node): void {
    const name = getName(node);
    this.checkStrictModeEvalOrArguments(node, name);
    if (
      name === undefined ||
      name.kind === SyntaxKind.ObjectBindingPattern ||
      name.kind === SyntaxKind.ArrayBindingPattern
    )
      return;
    if (isVariableDeclarationInitializedToRequire(node))
      this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.Alias, SymbolFlags.AliasExcludes);
    else if (isBlockOrCatchScoped(node))
      this.bindBlockScopedDeclaration(node, SymbolFlags.BlockScopedVariable, SymbolFlags.BlockScopedVariableExcludes);
    else if (isPartOfParameterDeclaration(node))
      // Parameter excludes report duplicates like `function f([a, a]) {}`.
      this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.FunctionScopedVariable, SymbolFlags.ParameterExcludes);
    else
      this.declareSymbolAndAddToSymbolTable(
        node,
        SymbolFlags.FunctionScopedVariable,
        SymbolFlags.FunctionScopedVariableExcludes,
      );
  }

  bindParameter(node: ParameterDeclaration): void {
    // `eval` and `arguments` can't be parameter names in strict mode.
    if ((node.flags & NodeFlags.Ambient) === 0) this.checkStrictModeEvalOrArguments(node, node.name);
    const name = node.name;
    if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern) {
      const index = getParameters(node.parent!)!.nodes.indexOf(node);
      this.bindAnonymousDeclaration(node, SymbolFlags.FunctionScopedVariable, '__' + index);
    } else
      this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.FunctionScopedVariable, SymbolFlags.ParameterExcludes);
    // A parameter property also declares a property of the class.
    if (isParameterPropertyDeclaration(node, node.parent!)) {
      const classSymbol = getSymbol(node.parent!.parent!)!;
      const flags = SymbolFlags.Property | (node.questionToken !== undefined ? SymbolFlags.Optional : SymbolFlags.None);
      this.declareSymbol(getMembers(classSymbol), classSymbol, node, flags, SymbolFlags.PropertyExcludes);
    }
  }

  bindTypeParameter(node: Node): void {
    const parent = node.parent!;
    if (parent.kind !== SyntaxKind.InferType) {
      this.declareSymbolAndAddToSymbolTable(node, SymbolFlags.TypeParameter, SymbolFlags.TypeParameterExcludes);
      return;
    }
    // `infer T` declares T in the conditional type whose extends clause contains it.
    let container: Node | undefined;
    for (let current: Node | undefined = parent; current !== undefined; current = current.parent) {
      const p = current.parent;
      if (p !== undefined && p.kind === SyntaxKind.ConditionalType && getExtendsType(p) === current) {
        container = p;
        break;
      }
    }
    if (container !== undefined)
      this.declareSymbol(
        this.localsOf(container),
        undefined,
        node,
        SymbolFlags.TypeParameter,
        SymbolFlags.TypeParameterExcludes,
      );
    else this.bindAnonymousDeclaration(node, SymbolFlags.TypeParameter, this.getDeclarationName(node));
  }

  // JavaScript

  setCommonJSModuleIndicator(node: Node): boolean {
    const file = this.file;
    if (file.externalModuleIndicator !== undefined && file.externalModuleIndicator !== file) return false;
    if (file.commonJSModuleIndicator === undefined) {
      file.commonJSModuleIndicator = node;
      if (file.externalModuleIndicator === undefined) this.bindSourceFileAsExternalModule(file);
    }
    return true;
  }

  bindModuleExportsAssignment(node: BinaryExpression): void {
    if (!this.setCommonJSModuleIndicator(node)) return;
    const fileSymbol = this.file.symbol!;
    const flags = expressionIsAlias(node.right) ? SymbolFlags.Alias : SymbolFlags.Property;
    const symbol = this.declareSymbol(getExports(fileSymbol), fileSymbol, node, flags, SymbolFlags.None);
    setValueDeclaration(symbol, node);
  }

  bindExportsOrObjectDefineProperty(node: Node): void {
    if (!this.setCommonJSModuleIndicator(node)) return;
    const fileSymbol = this.file.symbol!;
    const flags =
      node instanceof BinaryExpression && expressionIsAlias((node as BinaryExpression).right)
        ? SymbolFlags.Alias
        : SymbolFlags.FunctionScopedVariable;
    this.declareSymbol(getExports(fileSymbol), fileSymbol, node, flags, SymbolFlags.FunctionScopedVariableExcludes);
  }

  bindExpandoPropertyAssignment(node: Node): void {
    this.expandoAssignments.push(new ExpandoAssignment(node, this.container, this.blockScopeContainer));
  }

  bindDeferredExpandoAssignments(assignments: readonly ExpandoAssignment[]): void {
    for (const assignment of assignments) {
      this.container = assignment.container;
      this.blockScopeContainer = assignment.blockScopeContainer;
      this.bindDeferredExpandoAssignment(assignment.node);
    }
  }

  bindDeferredExpandoAssignment(node: Node): void {
    const target =
      node instanceof BinaryExpression
        ? getExpression((node as BinaryExpression).left)!
        : getArguments(node)!.nodes[0]!;
    const symbol = getInitializerSymbol(
      this.lookupEntity(target, this.blockScopeContainer) ?? this.lookupEntity(target, this.container),
    );
    if (symbol === undefined) return;
    if (hasDynamicName(node)) {
      this.bindAnonymousDeclaration(node, SymbolFlags.Property | SymbolFlags.Assignment, InternalSymbolName.Computed);
      this.addLateBoundAssignmentDeclarationToSymbol(node, symbol);
      return;
    }
    // Expandos are declared only where no other declaration has the name.
    const exports = getExports(symbol);
    const existing = exports.get(this.getDeclarationName(node));
    if (existing === undefined || (existing.flags & SymbolFlags.Assignment) !== 0)
      this.declareSymbol(
        exports,
        symbol,
        node,
        SymbolFlags.Property | SymbolFlags.Assignment,
        SymbolFlags.PropertyExcludes,
      );
  }

  addLateBoundAssignmentDeclarationToSymbol(node: Node, symbol: Symbol): void {
    const exports = getExports(symbol);
    let assignmentSymbol = exports.get(InternalSymbolName.AssignmentDeclaration);
    if (assignmentSymbol === undefined) {
      assignmentSymbol = this.newSymbol(SymbolFlags.None, InternalSymbolName.AssignmentDeclaration);
      exports.set(InternalSymbolName.AssignmentDeclaration, assignmentSymbol);
    }
    addDeclaration(assignmentSymbol, node);
  }

  /**
   * With an `export=` symbol, its module's exports with a type or namespace meaning are also
   * exports of the `export=` symbol, which makes it a namespace.
   */
  bindCommonJSTypeExports(moduleSymbol: Symbol | undefined): void {
    if (moduleSymbol === undefined) return;
    const moduleExports = moduleSymbol.exports;
    if (moduleExports === undefined) return;
    const exportEquals = moduleExports.get(InternalSymbolName.ExportEquals);
    if (exportEquals === undefined) return;
    for (const symbol of moduleExports.values()) {
      if (
        symbol.name !== InternalSymbolName.ExportEquals &&
        (symbol.flags & (SymbolFlags.Type | SymbolFlags.Namespace)) !== 0
      ) {
        getExports(exportEquals).set(symbol.name, symbol);
        exportEquals.flags |= SymbolFlags.NamespaceModule;
      }
    }
  }

  bindThisPropertyAssignment(node: BinaryExpression): void {
    if (!isInJSFile(node)) return;
    const left = node.left;
    const thisContainer = this.thisContainer;
    if (
      (left instanceof PropertyAccessExpression &&
        (left as PropertyAccessExpression).name.kind === SyntaxKind.PrivateIdentifier) ||
      thisContainer === undefined
    )
      return;
    const symbolTable = this.thisSymbolTable();
    if (symbolTable !== undefined) {
      const classSymbol = getSymbol(thisContainer.parent!);
      if (hasDynamicName(node)) {
        this.declareSymbolEx(symbolTable, classSymbol, node, SymbolFlags.Property, SymbolFlags.None, true, true);
        this.addLateBoundAssignmentDeclarationToSymbol(node, classSymbol!);
      } else
        this.declareSymbolEx(
          symbolTable,
          classSymbol,
          node,
          SymbolFlags.Property | SymbolFlags.Assignment,
          SymbolFlags.None,
          true,
          false,
        );
    } else if (
      thisContainer.kind !== SyntaxKind.FunctionDeclaration &&
      thisContainer.kind !== SyntaxKind.FunctionExpression
    )
      throw new Error('Unhandled case in bindThisPropertyAssignment');
  }

  /** For `this.x` in a class member, the class's members, or exports if the member is static. */
  thisSymbolTable(): SymbolTable | undefined {
    const thisContainer = this.thisContainer;
    if (thisContainer === undefined) return undefined;
    switch (thisContainer.kind) {
      case SyntaxKind.Constructor:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.ClassStaticBlockDeclaration: {
        const classSymbol = getSymbol(thisContainer.parent!)!;
        return isStatic(thisContainer) ? getExports(classSymbol) : getMembers(classSymbol);
      }
    }
    return undefined;
  }

  lookupEntity(node: Node, container: Node): Symbol | undefined {
    if (node.kind === SyntaxKind.Identifier) return lookupName(getText(node), container);
    const expression = getExpression(node)!;
    if (expression.kind === SyntaxKind.ThisKeyword) {
      const symbolTable = this.thisSymbolTable();
      if (symbolTable === undefined) return undefined;
      const name = getElementOrPropertyAccessName(node);
      return name !== undefined ? symbolTable.get(getText(name)) : undefined;
    }
    const symbol = getInitializerSymbol(this.lookupEntity(expression, container));
    if (symbol !== undefined && symbol.exports !== undefined) {
      const name = getElementOrPropertyAccessName(node);
      if (name !== undefined) return symbol.exports.get(getText(name));
    }
    return undefined;
  }

  // Strict mode

  /** Reports reserved words used as identifiers, and `await`/`yield` where they are keywords. */
  checkContextualIdentifier(node: Identifier): void {
    // Only words starting with a, i, l, p, s or y can be future reserved words, await or yield.
    const text = node.text;
    const first = text.charCodeAt(0);
    if (first !== 0x61 && first !== 0x69 && first !== 0x6c && first !== 0x70 && first !== 0x73 && first !== 0x79)
      return;
    if (
      this.file.diagnostics.length !== 0 ||
      (node.flags & (NodeFlags.Ambient | NodeFlags.JSDoc)) !== 0 ||
      isIdentifierName(node)
    )
      return;
    const originalKeywordKind = getIdentifierToken(text);
    if (originalKeywordKind === SyntaxKind.Identifier) return;
    if (
      originalKeywordKind >= SyntaxKind.FirstFutureReservedWord &&
      originalKeywordKind <= SyntaxKind.LastFutureReservedWord
    )
      this.errorOnNode(node, this.getStrictModeIdentifierMessage(node), [declarationNameToString(this.file, node)]);
    else if (originalKeywordKind === SyntaxKind.AwaitKeyword) {
      if (isExternalModule(this.file) && isInTopLevelContext(node))
        this.errorOnNode(node, Diagnostics.Identifier_expected_0_is_a_reserved_word_at_the_top_level_of_a_module, [
          declarationNameToString(this.file, node),
        ]);
      else if ((node.flags & NodeFlags.AwaitContext) !== 0)
        this.errorOnNode(node, Diagnostics.Identifier_expected_0_is_a_reserved_word_that_cannot_be_used_here, [
          declarationNameToString(this.file, node),
        ]);
    } else if (originalKeywordKind === SyntaxKind.YieldKeyword && (node.flags & NodeFlags.YieldContext) !== 0)
      this.errorOnNode(node, Diagnostics.Identifier_expected_0_is_a_reserved_word_that_cannot_be_used_here, [
        declarationNameToString(this.file, node),
      ]);
  }

  checkPrivateIdentifier(node: Node): void {
    if (getText(node) === '#constructor' && this.file.diagnostics.length === 0)
      this.errorOnNode(node, Diagnostics.X_constructor_is_a_reserved_word, [declarationNameToString(this.file, node)]);
  }

  getStrictModeIdentifierMessage(node: Node): DiagnosticMessage {
    if (getContainingClass(node) !== undefined)
      return Diagnostics.Identifier_expected_0_is_a_reserved_word_in_strict_mode_Class_definitions_are_automatically_in_strict_mode;
    if (this.file.externalModuleIndicator !== undefined)
      return Diagnostics.Identifier_expected_0_is_a_reserved_word_in_strict_mode_Modules_are_automatically_in_strict_mode;
    return Diagnostics.Identifier_expected_0_is_a_reserved_word_in_strict_mode;
  }

  checkStrictModeFunctionName(node: Node): void {
    if ((node.flags & NodeFlags.Ambient) === 0) this.checkStrictModeEvalOrArguments(node, getName(node));
  }

  checkStrictModeBinaryExpression(node: BinaryExpression): void {
    // `eval` and `arguments` can't be assigned to.
    if (isLeftHandSideExpression(node.left) && isAssignmentOperator(node.operatorToken.kind))
      this.checkStrictModeEvalOrArguments(node, node.left);
  }

  checkStrictModeCatchClause(node: CatchClause): void {
    const declaration = node.variableDeclaration;
    if (declaration !== undefined) this.checkStrictModeEvalOrArguments(node, declaration.name);
  }

  checkStrictModeDeleteExpression(node: DeleteExpression): void {
    // Deleting a variable, parameter or function name is an error in strict mode.
    if (node.expression.kind === SyntaxKind.Identifier)
      this.errorOnNode(node.expression, Diagnostics.X_delete_cannot_be_called_on_an_identifier_in_strict_mode, noArgs);
  }

  checkStrictModeEvalOrArguments(contextNode: Node, name: Node | undefined): void {
    if (name === undefined || name.kind !== SyntaxKind.Identifier) return;
    const text = getText(name);
    if (text !== 'eval' && text !== 'arguments') return;
    let message: DiagnosticMessage;
    if (getContainingClass(contextNode) !== undefined)
      message =
        Diagnostics.Code_contained_in_a_class_is_evaluated_in_JavaScript_s_strict_mode_which_does_not_allow_this_use_of_0_For_more_information_see_https_Colon_Slash_Slashdeveloper_mozilla_org_Slashen_US_Slashdocs_SlashWeb_SlashJavaScript_SlashReference_SlashStrict_mode;
    else if (this.file.externalModuleIndicator !== undefined)
      message = Diagnostics.Invalid_use_of_0_Modules_are_automatically_in_strict_mode;
    else message = Diagnostics.Invalid_use_of_0_in_strict_mode;
    this.errorOnNode(name, message, [text]);
  }
}

const noArgs: readonly string[] = [];

function optionalSymbolFlag(node: Node): SymbolFlags {
  const postfixToken = getPostfixToken(node);
  return postfixToken !== undefined && postfixToken.kind === SyntaxKind.QuestionToken
    ? SymbolFlags.Optional
    : SymbolFlags.None;
}

function getExtendsType(node: Node): Node | undefined {
  return node instanceof ConditionalTypeNode ? (node as ConditionalTypeNode).extendsType : undefined;
}

function isGeneratorFunctionExpression(node: Node): boolean {
  return node instanceof FunctionExpression && (node as FunctionExpression).asteriskToken !== undefined;
}

function isForInOrOfStatementKind(kind: SyntaxKind): boolean {
  return kind === SyntaxKind.ForInStatement || kind === SyntaxKind.ForOfStatement;
}

function hasExportDeclarations(node: Node): boolean {
  let statements: NodeList | undefined;
  if (node.kind === SyntaxKind.SourceFile) statements = (node as SourceFile).statements;
  else if (node instanceof ModuleDeclaration) {
    const body = (node as ModuleDeclaration).body;
    if (body !== undefined && body.kind === SyntaxKind.ModuleBlock) statements = getStatements(body);
  }
  if (statements === undefined) return false;
  for (const statement of statements.nodes)
    if (statement.kind === SyntaxKind.ExportDeclaration || statement.kind === SyntaxKind.ExportAssignment) return true;
  return false;
}

/** The symbol in `container`'s locals or its symbol's exports, preferring a local's export symbol. */
function lookupName(name: string, container: Node): Symbol | undefined {
  if (isLocalsContainer(container)) {
    const locals = getLocals(container);
    const local = locals !== undefined ? locals.get(name) : undefined;
    if (local !== undefined) return local.exportSymbol ?? local;
  }
  if (isDeclarationNode(container)) {
    const symbol = getSymbol(container);
    if (symbol !== undefined && symbol.exports !== undefined) return symbol.exports.get(name);
  }
  return undefined;
}

/**
 * For `fn.x = …`: the symbol that gets expando properties when `fn` is a function, a const
 * (or JavaScript) variable initialized with a function or class, or a JavaScript class.
 */
function getInitializerSymbol(symbol: Symbol | undefined): Symbol | undefined {
  if (symbol === undefined) return undefined;
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined) return undefined;
  if (
    declaration.kind === SyntaxKind.FunctionDeclaration ||
    (isInJSFile(declaration) && declaration.kind === SyntaxKind.ClassDeclaration)
  )
    return symbol;
  if (declaration instanceof VariableDeclaration) {
    if (((declaration as VariableDeclaration).parent!.flags & NodeFlags.Const) !== 0 || isInJSFile(declaration)) {
      const initializer = (declaration as VariableDeclaration).initializer;
      if (isExpandoInitializer(declaration, initializer)) return getSymbol(initializer!);
    }
    return undefined;
  }
  if (declaration instanceof BinaryExpression && isInJSFile(declaration)) {
    const initializer = (declaration as BinaryExpression).right;
    if (isExpandoInitializer(declaration, initializer)) return getSymbol(initializer);
  }
  return undefined;
}

function setFlowNodeReferenced(flow: FlowNode): void {
  // Referenced on first use, Shared after that.
  flow.flags |= (flow.flags & FlowFlags.Referenced) === 0 ? FlowFlags.Referenced : FlowFlags.Shared;
}

function combineFlowLists(head: FlowNode[] | undefined, tail: FlowNode[] | undefined): FlowNode[] | undefined {
  if (head === undefined) return tail;
  return tail === undefined ? head.slice() : head.concat(tail);
}

function isStatementCondition(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.IfStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.DoStatement:
      return getExpression(parent) === node;
    case SyntaxKind.ForStatement:
      return (parent as ForStatement).condition === node;
    case SyntaxKind.ConditionalExpression:
      return (parent as ConditionalExpression).condition === node;
  }
  return false;
}

function isTopLevelLogicalExpression(node: Node): boolean {
  let current = node;
  for (;;) {
    const parent = current.parent!;
    if (
      parent.kind === SyntaxKind.ParenthesizedExpression ||
      (parent instanceof PrefixUnaryExpression &&
        (parent as PrefixUnaryExpression).operator === SyntaxKind.ExclamationToken)
    )
      current = parent;
    else break;
  }
  const parent = current.parent!;
  return (
    !isStatementCondition(current) &&
    !isLogicalExpression(parent) &&
    !(isOptionalChain(parent) && getExpression(parent) === current)
  );
}

// Narrowing

function isNarrowingExpression(expression: Node): boolean {
  switch (expression.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.ThisKeyword:
      return true;
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
      return containsNarrowableReference(expression);
    case SyntaxKind.CallExpression:
      return hasNarrowableArgument(expression as CallExpression);
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.TypeOfExpression:
      return isNarrowingExpression(getExpression(expression)!);
    case SyntaxKind.BinaryExpression:
      return isNarrowingBinaryExpression(expression as BinaryExpression);
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = expression as PrefixUnaryExpression;
      return unary.operator === SyntaxKind.ExclamationToken && isNarrowingExpression(unary.operand);
    }
  }
  return false;
}

function containsNarrowableReference(expression: Node): boolean {
  if (isNarrowableReference(expression)) return true;
  if ((expression.flags & NodeFlags.OptionalChain) !== 0) {
    switch (expression.kind) {
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
      case SyntaxKind.CallExpression:
      case SyntaxKind.NonNullExpression:
        return containsNarrowableReference(getExpression(expression)!);
    }
  }
  return false;
}

/** A reference whose type control flow analysis can narrow. */
export function isNarrowableReference(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.MetaProperty:
      return true;
    case SyntaxKind.PropertyAccessExpression:
      return isNarrowableReference((node as PropertyAccessExpression).expression);
    case SyntaxKind.ParenthesizedExpression:
      return isNarrowableReference((node as ParenthesizedExpression).expression);
    case SyntaxKind.NonNullExpression:
      return isNarrowableReference((node as NonNullExpression).expression);
    case SyntaxKind.ElementAccessExpression: {
      const access = node as ElementAccessExpression;
      return (
        isStringOrNumericLiteralLike(access.argumentExpression) ||
        (isEntityNameExpression(access.argumentExpression, false) && isNarrowableReference(access.expression))
      );
    }
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      const operator = binary.operatorToken.kind;
      return (
        (operator === SyntaxKind.CommaToken && isNarrowableReference(binary.right)) ||
        (isAssignmentOperator(operator) && isLeftHandSideExpression(binary.left))
      );
    }
  }
  return false;
}

function hasNarrowableArgument(call: CallExpression): boolean {
  for (const argument of call.arguments.nodes) if (containsNarrowableReference(argument)) return true;
  const callee = call.expression;
  return (
    callee instanceof PropertyAccessExpression &&
    containsNarrowableReference((callee as PropertyAccessExpression).expression)
  );
}

function isNarrowingBinaryExpression(expression: BinaryExpression): boolean {
  switch (expression.operatorToken.kind) {
    case SyntaxKind.EqualsToken:
    case SyntaxKind.BarBarEqualsToken:
    case SyntaxKind.AmpersandAmpersandEqualsToken:
    case SyntaxKind.QuestionQuestionEqualsToken:
      return containsNarrowableReference(expression.left);
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken: {
      const left = skipParentheses(expression.left);
      const right = skipParentheses(expression.right);
      return (
        isNarrowableOperand(left) ||
        isNarrowableOperand(right) ||
        isNarrowingTypeOfOperands(right, left) ||
        isNarrowingTypeOfOperands(left, right) ||
        (isBooleanLiteral(right) && isNarrowingExpression(left)) ||
        (isBooleanLiteral(left) && isNarrowingExpression(right))
      );
    }
    case SyntaxKind.InstanceOfKeyword:
      return isNarrowableOperand(expression.left);
    case SyntaxKind.InKeyword:
    case SyntaxKind.CommaToken:
      return isNarrowingExpression(expression.right);
  }
  return false;
}

function isNarrowableOperand(expression: Node): boolean {
  if (expression.kind === SyntaxKind.ParenthesizedExpression) return isNarrowableOperand(getExpression(expression)!);
  if (expression instanceof BinaryExpression) {
    const binary = expression as BinaryExpression;
    const operator = binary.operatorToken.kind;
    if (operator === SyntaxKind.EqualsToken) return isNarrowableOperand(binary.left);
    if (operator === SyntaxKind.CommaToken) return isNarrowableOperand(binary.right);
  }
  return containsNarrowableReference(expression);
}

function isNarrowingTypeOfOperands(expression1: Node, expression2: Node): boolean {
  return (
    expression1.kind === SyntaxKind.TypeOfExpression &&
    isNarrowableOperand(getExpression(expression1)!) &&
    isStringLiteralLike(expression2)
  );
}

/** The `"use strict"` prologue directive of `statements`, if any. */
export function findUseStrictPrologue(file: SourceFile, statements: readonly Node[]): Node | undefined {
  for (const statement of statements) {
    if (!isPrologueDirective(statement)) return undefined;
    // Exactly `"use strict"` or `'use strict'`, without escapes.
    const text = getSourceTextOfNode(file, (statement as ExpressionStatement).expression);
    if (text === '"use strict"' || text === "'use strict'") return statement;
  }
  return undefined;
}

/** Whether a module name is a pattern with exactly one `*`. */
function hasSingleStar(text: string): boolean {
  const star = text.indexOf('*');
  return star >= 0 && text.indexOf('*', star + 1) < 0;
}
