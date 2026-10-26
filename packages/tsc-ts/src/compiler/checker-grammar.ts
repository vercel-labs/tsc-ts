// Grammar checks: errors for syntax the parser accepts but the language disallows.
//
// `checkGrammarSourceFile` walks a file once after it is type checked and runs the grammar checks
// of each node in the order tsgo's checker runs them. Checks that need types read the checker's
// caches. Errors reported with `grammarError*` are dropped when the file has parse errors.
import {
  type ArrowFunction,
  type BinaryExpression,
  type BindingElement,
  type CallExpression,
  type CatchClause,
  type ComputedPropertyName,
  type ConditionalTypeNode,
  type ConstructorDeclaration,
  type Decorator,
  ElementAccessExpression,
  type ExportAssignment,
  type ExportDeclaration,
  type ExportSpecifier,
  type ExpressionWithTypeArguments,
  type ForInOrOfStatement,
  type ForStatement,
  type HeritageClause,
  Identifier,
  type ImportAttribute,
  type ImportAttributes,
  type ImportClause,
  type ImportDeclaration,
  type ImportEqualsDeclaration,
  type ImportTypeNode,
  type IndexSignatureDeclaration,
  type LabeledStatement,
  type MappedTypeNode,
  type MetaProperty,
  ModifierFlags,
  type ModifierList,
  type ModuleDeclaration,
  type NamedTupleMember,
  type Node,
  NodeFlags,
  type NodeList,
  NodeVisitor,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type LiteralTypeNode,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  type PropertyDeclaration,
  type PropertySignatureDeclaration,
  type ShorthandPropertyAssignment,
  type SourceFile,
  StringLiteral,
  type SwitchStatement,
  type TaggedTemplateExpression,
  type ThrowStatement,
  type TupleTypeNode,
  type TypeLiteralNode,
  type TypeOperatorNode,
  type TypeParameterDeclaration,
  type TypeReferenceNode,
  type VariableDeclaration,
  type VariableDeclarationList,
  type VariableStatement,
  type WithStatement,
  getAsteriskToken,
  getBody,
  getElements,
  getExpression,
  getHeritageClauses,
  getInitializer,
  getLabel,
  getIsTypeOnly,
  getLocals,
  getMembers,
  getModifiers,
  getName,
  getNodeId,
  getParameters,
  getPostfixToken,
  getStatements,
  getText,
  getType,
  getTypeArguments,
  getTypeParameters,
  isDeclarationNode,
  callQuestionDotToken,
  callTypeArguments,
} from './ast.js';
import {
  canHaveDecorators,
  canHaveIllegalDecorators,
  getExternalModuleName,
  getTextOfNodeFromSourceText,
  isAmbientModule,
  isFunctionLike,
  isFunctionLikeDeclarationKind,
  isImportDeferMetaProperty,
  isImportPhaseMetaProperty,
  isImportSourceMetaProperty,
  isModifierKind,
  isSourcePhaseImportCall,
  isStringLiteralLike,
  modifierToFlag,
  nodeIsPresent,
  isInJSFile,
} from './ast-utilities.js';
import {
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getContainingClass,
  getRangeOfTokenAtPosition,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isAutoAccessorPropertyDeclaration,
  isClassLike,
  isDynamicName,
  isEntityNameExpression,
  isExternalModule,
  isInTopLevelContext,
  isModuleAugmentationExternal,
  isPrivateIdentifierClassElementDeclaration,
  isStatic,
  skipParentheses,
} from './binder-utilities.js';
import { findUseStrictPrologue } from './binder.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { ElementFlags, type Type, TypeFlags, type UnionType } from './checker-types.js';
import { checkComputedPropertyName, checkExpressionCached, getTypeOfExpression } from './checker-expressions.js';
import { isArrayLikeType } from './checker-members.js';
import { getNullableType } from './checker-symbol-types.js';
import { getTupleElementFlags, getTypeFromTypeNode } from './checker-type-nodes.js';
import { isArrayType, isTupleType, tupleTargetOf } from './checker-type-factory.js';
import { isGenericType } from './checker-type-operators.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName, isValidIndexKeyType } from './checker-utilities.js';
import { getSymbolOfDeclaration, resolveAlias } from './checker-symbols.js';
import { Diagnostics } from './diagnostic-messages.js';
import { Diagnostic, DiagnosticCategory, type DiagnosticMessage, messageCategory } from './diagnostics.js';
import {
  ModuleKind,
  ScriptTarget,
  getEmitModuleKind,
  supportsDeferredImports,
  supportsSourcePhaseImports,
} from './options.js';
import { getEmitSyntaxForModuleSpecifierExpression } from './checker-modules.js';
import { fileExtensionIsOneOf, isExternalModuleNameRelative } from './path.js';
import {
  SourceFileMetadata,
  getEmitModuleFormatOfFile,
  getImpliedNodeFormatForEmit,
  resolutionModeAttribute,
} from './program-utilities.js';
import { CharacterCodes } from './character-codes.js';
import { Scanner, ScannerErrorReporter, skipTrivia, tokenToString } from './scanner.js';
import { typeToString } from './type-printer.js';
import type { ScriptTarget as LanguageTarget } from './types.js';
import { SyntaxKind } from './syntax-kind.js';
import { getDeclarations, SymbolFlags } from './symbol.js';

/** Runs the grammar checks of every node of `file`. */
export function checkGrammarSourceFile(c: Checker, file: SourceFile): void {
  const g = new GrammarChecker(c, file);
  if ((file.flags & NodeFlags.Ambient) !== 0) checkGrammarTopLevelElementsForRequiredDeclareModifier(g, file);
  file.forEachChild(g);
}

/** The grammar checker of the file of `node`, for grammar checks run while checking expressions. */
function grammarCheckerOf(c: Checker, node: Node): GrammarChecker {
  const file = getSourceFileOfNode(node);
  const cached = c.grammarChecker;
  if (cached !== undefined && cached.file === file) return cached;
  const g = new GrammarChecker(c, file);
  c.grammarChecker = g;
  return g;
}

/** Checks the grammar of an object literal each time it is checked, as tsgo does. */
export function checkGrammarObjectLiteralOfExpression(
  c: Checker,
  node: ObjectLiteralExpression,
  inDestructuring: boolean,
): void {
  checkGrammarObjectLiteralExpression(grammarCheckerOf(c, node), node, inDestructuring);
}

/** Reports a trailing comma after the rest element of a destructuring assignment. */
export function checkGrammarRestTrailingComma(c: Checker, node: Node, list: NodeList): void {
  checkGrammarForDisallowedTrailingComma(
    grammarCheckerOf(c, node),
    list,
    Diagnostics.A_rest_parameter_or_binding_pattern_may_not_have_a_trailing_comma,
  );
}

/** Checks the grammar of a function expression or arrow function each time it is checked. */
export function checkGrammarFunctionExpression(c: Checker, node: Node): void {
  const g = grammarCheckerOf(c, node);
  if (!checkGrammarFunctionLikeDeclaration(g, node) && node.kind === SyntaxKind.FunctionExpression)
    checkGrammarForGenerator(g, node);
}

/** Checks the grammar of an `await` expression each time it is checked. */
export function checkGrammarAwaitExpression(c: Checker, node: Node): void {
  checkGrammarAwaitOrAwaitUsing(grammarCheckerOf(c, node), node);
}

/** Checks the grammar of a `yield` expression each time it is checked. */
export function checkGrammarYieldOfExpression(c: Checker, node: Node): void {
  checkGrammarYieldExpression(grammarCheckerOf(c, node), node);
}

/** Per-file state of the grammar walk. */
export class GrammarChecker extends NodeVisitor {
  readonly c: Checker;
  readonly file: SourceFile;
  /** Grammar errors are only reported in files without parse errors. */
  readonly hasParseErrors: boolean;
  readonly moduleKind: ModuleKind;
  readonly metadata: SourceFileMetadata;
  readonly legacyDecorators: boolean;
  /** Blocks and statements that already reported a statement in an ambient context. */
  readonly reportedAmbientStatements = new Set<number>();
  private scanner: Scanner | undefined = undefined;

  constructor(c: Checker, file: SourceFile) {
    super();
    this.c = c;
    this.file = file;
    this.hasParseErrors = file.diagnostics.length > 0;
    this.moduleKind = getEmitModuleKind(c.compilerOptions);
    this.metadata = c.host.getSourceFileMetadata(file) ?? new SourceFileMetadata('', '', ModuleKind.None);
    this.legacyDecorators = c.compilerOptions.experimentalDecorators === true;
  }

  visitNode(node: Node): boolean {
    if (checkGrammarNode(this, node)) node.forEachChild(this);
    return false;
  }

  /** A scanner over the file's text, for rescanning tokens. */
  getScanner(): Scanner {
    let scanner = this.scanner;
    if (scanner === undefined) {
      scanner = new Scanner(this.file.text);
      scanner.setLanguageVariant(this.file.languageVariant);
      // The scanner's target enum has the same values as the option's.
      scanner.setScriptTarget(this.c.languageVersion as number as LanguageTarget);
      this.scanner = scanner;
    }
    return scanner;
  }
}

// ---- Reporting

function grammarErrorOnNode(g: GrammarChecker, node: Node, message: DiagnosticMessage, ...args: string[]): boolean {
  if (g.hasParseErrors) return false;
  g.c.error(node, message, ...args);
  return true;
}

function grammarErrorOnFirstToken(
  g: GrammarChecker,
  node: Node,
  message: DiagnosticMessage,
  ...args: string[]
): boolean {
  if (g.hasParseErrors) return false;
  const range = getRangeOfTokenAtPosition(g.file, node.pos);
  g.c.addDiagnostic(new Diagnostic(g.file.diagnosticFile(), range.pos, range.end, message, args));
  return true;
}

function grammarErrorAtPos(
  g: GrammarChecker,
  start: number,
  length: number,
  message: DiagnosticMessage,
  ...args: string[]
): boolean {
  if (g.hasParseErrors) return false;
  g.c.addDiagnostic(new Diagnostic(g.file.diagnosticFile(), start, start + length, message, args));
  return true;
}

/** A diagnostic at the first token of `node`. */
function diagnosticAtFirstToken(g: GrammarChecker, node: Node, message: DiagnosticMessage): Diagnostic {
  const range = getRangeOfTokenAtPosition(g.file, node.pos);
  return new Diagnostic(g.file.diagnosticFile(), range.pos, range.end, message);
}

function addRelated(diagnostic: Diagnostic, node: Node, message: DiagnosticMessage): void {
  diagnostic.relatedInformation.push(createDiagnosticForNode(node, message, []));
}

// ---- Dispatch

/** Runs the grammar checks of `node`; returns whether its children are checked too. */
function checkGrammarNode(g: GrammarChecker, node: Node): boolean {
  switch (node.kind) {
    // Declarations and members
    case SyntaxKind.TypeParameter: {
      checkGrammarModifiers(g, node);
      const expression = (node as TypeParameterDeclaration).expression;
      if (expression !== undefined) grammarErrorOnFirstToken(g, expression, Diagnostics.Type_expected);
      return true;
    }
    case SyntaxKind.Parameter:
      checkGrammarModifiers(g, node);
      checkGrammarDecorators(g, node);
      return true;
    case SyntaxKind.PropertySignature:
      checkGrammarPropertyDeclaration(g, node);
      return true;
    case SyntaxKind.PropertyDeclaration:
      checkGrammarPropertyDeclaration(g, node);
      checkGrammarDecorators(g, node);
      return true;
    case SyntaxKind.ConstructorType:
    case SyntaxKind.FunctionType:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
      checkGrammarFunctionLikeDeclaration(g, node);
      return true;
    case SyntaxKind.IndexSignature:
      if (!checkGrammarModifiers(g, node)) checkGrammarIndexSignatureParameters(g, node as IndexSignatureDeclaration);
      return true;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      checkGrammarMethodDeclaration(g, node);
      return true;
    case SyntaxKind.ClassStaticBlockDeclaration:
      checkGrammarModifiers(g, node);
      return true;
    case SyntaxKind.Constructor:
      checkGrammarFunctionLikeDeclaration(g, node);
      if (!checkGrammarConstructorTypeParameters(g, node as ConstructorDeclaration)) {
        const type = (node as ConstructorDeclaration).type;
        if (type !== undefined)
          grammarErrorOnNode(g, type, Diagnostics.Type_annotation_cannot_appear_on_a_constructor_declaration);
      }
      return true;
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      checkGrammarAccessorDeclaration(g, node);
      return true;
    case SyntaxKind.FunctionDeclaration:
      checkGrammarDecorators(g, node);
      checkGrammarFunctionLikeDeclaration(g, node);
      checkGrammarForGenerator(g, node);
      return true;
    case SyntaxKind.ClassDeclaration:
      checkGrammarClassDeclaration(g, node);
      return true;
    case SyntaxKind.ClassExpression:
      checkGrammarClassLikeDeclaration(g, node);
      return true;
    case SyntaxKind.InterfaceDeclaration:
      checkGrammarInterfaceDeclaration(g, node);
      return true;
    case SyntaxKind.TypeAliasDeclaration:
      checkGrammarModifiers(g, node);
      if (!containerAllowsBlockScopedVariable(node.parent!))
        grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_can_only_be_declared_inside_a_block, 'type');
      return true;
    case SyntaxKind.EnumDeclaration:
      checkGrammarModifiers(g, node);
      return true;
    case SyntaxKind.ModuleDeclaration:
      return checkGrammarModuleDeclaration(g, node as ModuleDeclaration);
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      checkGrammarImportDeclaration(g, node as ImportDeclaration);
      return false;
    case SyntaxKind.ImportEqualsDeclaration:
      checkGrammarImportEqualsDeclaration(g, node as ImportEqualsDeclaration);
      return false;
    case SyntaxKind.ExportDeclaration:
      checkGrammarExportDeclaration(g, node as ExportDeclaration);
      return false;
    case SyntaxKind.ExportAssignment:
      return checkGrammarExportAssignment(g, node as ExportAssignment);
    case SyntaxKind.VariableDeclaration:
      // Catch clause variables are checked with the clause.
      if (node.parent!.kind !== SyntaxKind.CatchClause) checkGrammarVariableDeclaration(g, node as VariableDeclaration);
      return true;
    case SyntaxKind.BindingElement:
      checkGrammarBindingElement(g, node as BindingElement);
      return true;
    // Statements
    case SyntaxKind.Block:
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.TryStatement:
      checkGrammarStatementInAmbientContext(g, node);
      return true;
    case SyntaxKind.IfStatement: {
      checkGrammarStatementInAmbientContext(g, node);
      return true;
    }
    case SyntaxKind.VariableStatement:
      checkGrammarVariableStatement(g, node as VariableStatement);
      return true;
    case SyntaxKind.ForStatement: {
      const initializer = (node as ForStatement).initializer;
      if (
        !checkGrammarStatementInAmbientContext(g, node) &&
        initializer !== undefined &&
        initializer.kind === SyntaxKind.VariableDeclarationList
      )
        checkGrammarVariableDeclarationList(g, initializer as VariableDeclarationList);
      return true;
    }
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      checkGrammarForInOrForOfStatement(g, node as ForInOrOfStatement);
      return true;
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
      if (!checkGrammarStatementInAmbientContext(g, node)) checkGrammarBreakOrContinueStatement(g, node);
      return true;
    case SyntaxKind.ReturnStatement:
      return checkGrammarReturnStatement(g, node);
    case SyntaxKind.WithStatement:
      checkGrammarWithStatement(g, node as WithStatement);
      return false;
    case SyntaxKind.SwitchStatement:
      checkGrammarSwitchStatement(g, node as SwitchStatement);
      return true;
    case SyntaxKind.LabeledStatement:
      checkGrammarLabeledStatement(g, node as LabeledStatement);
      return true;
    case SyntaxKind.ThrowStatement: {
      const expression = (node as ThrowStatement).expression;
      if (
        !checkGrammarStatementInAmbientContext(g, node) &&
        expression instanceof Identifier &&
        (expression as Identifier).text.length === 0
      )
        grammarErrorAtPos(g, expression.pos, 0, Diagnostics.Line_break_not_permitted_here);
      return true;
    }
    case SyntaxKind.CatchClause:
      checkGrammarCatchClause(g, node as CatchClause);
      return true;
    // Type nodes
    case SyntaxKind.TypeReference:
      checkGrammarTypeReference(g, node as TypeReferenceNode);
      return true;
    case SyntaxKind.TypeQuery:
      checkGrammarTypeArguments(g, getTypeArguments(node));
      return true;
    case SyntaxKind.TypeOperator:
      checkGrammarTypeOperatorNode(g, node as TypeOperatorNode);
      return true;
    case SyntaxKind.InferType:
      checkGrammarInferType(g, node);
      return true;
    case SyntaxKind.ImportType:
      checkGrammarImportAttributes(g, node);
      return true;
    case SyntaxKind.TupleType:
      checkGrammarTupleType(g, node as TupleTypeNode);
      return true;
    case SyntaxKind.NamedTupleMember:
      checkGrammarNamedTupleMember(g, node as NamedTupleMember);
      return true;
    case SyntaxKind.JSDocNonNullableType:
    case SyntaxKind.JSDocNullableType:
    case SyntaxKind.JSDocAllType:
    case SyntaxKind.JSDocTypeLiteral:
      checkGrammarJSDocTypeInTypeScript(g, node);
      return true;
    case SyntaxKind.MappedType: {
      const members = (node as MappedTypeNode).members;
      if (members !== undefined && members.nodes.length > 0)
        grammarErrorOnNode(g, members.nodes[0]!, Diagnostics.A_mapped_type_may_not_declare_properties_or_methods);
      return true;
    }
    // Expressions
    case SyntaxKind.ExpressionWithTypeArguments:
      // Heritage clause elements are checked with their class or interface.
      if (node.parent!.kind !== SyntaxKind.HeritageClause) checkGrammarExpressionWithTypeArguments(g, node);
      return true;
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      // Checked by the checker each time the function is checked.
      return true;
    case SyntaxKind.ObjectLiteralExpression:
      // Checked by the checker each time the literal is checked.
      return true;
    case SyntaxKind.CallExpression:
      checkGrammarCallExpression(g, node as CallExpression);
      return true;
    case SyntaxKind.NewExpression:
      checkGrammarTypeArguments(g, getTypeArguments(node));
      return true;
    case SyntaxKind.TaggedTemplateExpression:
      if (!checkGrammarTaggedTemplateChain(g, node as TaggedTemplateExpression))
        checkGrammarTypeArguments(g, getTypeArguments(node));
      return true;
    case SyntaxKind.MetaProperty:
      checkGrammarMetaProperty(g, node as MetaProperty);
      return true;
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.BinaryExpression:
      // Checked by the checker each time the expression is checked.
      return true;
    case SyntaxKind.PrivateIdentifier:
      checkGrammarPrivateIdentifierExpression(g, node);
      return false;
    case SyntaxKind.BigIntLiteral:
      checkGrammarBigIntLiteral(g, node);
      return false;
    case SyntaxKind.RegularExpressionLiteral:
      checkGrammarRegularExpressionLiteral(g, node);
      return false;
    case SyntaxKind.Decorator: {
      // Decorators are only checked on valid targets.
      const target = node.parent!;
      return (
        canHaveDecorators(target) &&
        nodeCanBeDecorated(g.legacyDecorators, target, target.parent, target.parent!.parent)
      );
    }
  }
  return true;
}

// ---- Modifiers and decorators

function checkGrammarModifiers(g: GrammarChecker, node: Node): boolean {
  const modifiers = getModifiers(node);
  if (modifiers === undefined) return false;
  if (reportObviousDecoratorErrors(g, node, modifiers) || reportObviousModifierErrors(g, node, modifiers)) return true;
  if (isThisParameter(node))
    return grammarErrorOnFirstToken(
      g,
      node,
      Diagnostics.Neither_decorators_nor_modifiers_may_be_applied_to_this_parameters,
    );
  const blockScopeKind =
    node.kind === SyntaxKind.VariableStatement
      ? (node as VariableStatement).declarationList.flags & NodeFlags.BlockScoped
      : NodeFlags.None;
  const parent = node.parent!;
  let lastStatic: Node | undefined;
  let lastDeclare: Node | undefined;
  let lastAsync: Node | undefined;
  let lastOverride: Node | undefined;
  let firstDecorator: Node | undefined;
  let flags = ModifierFlags.None;
  let sawExportBeforeDecorators = false;
  // Decorators and modifiers come in four chunks: leading decorators, leading modifiers,
  // trailing decorators and trailing modifiers. Leading and trailing decorators can't both appear.
  let hasLeadingDecorators = false;
  for (const modifier of modifiers.nodes) {
    if (modifier.kind === SyntaxKind.Decorator) {
      if (!nodeCanBeDecorated(g.legacyDecorators, node, parent, parent.parent)) {
        if (node.kind === SyntaxKind.MethodDeclaration && !nodeIsPresent(getBody(node)))
          return grammarErrorOnFirstToken(
            g,
            node,
            Diagnostics.A_decorator_can_only_decorate_a_method_implementation_not_an_overload,
          );
        return grammarErrorOnFirstToken(g, node, Diagnostics.Decorators_are_not_valid_here);
      } else if (g.legacyDecorators && (node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor)) {
        const first = getFirstAccessorOfPair(g.c, node);
        if (first !== node && hasDecorators(first))
          return grammarErrorOnFirstToken(
            g,
            node,
            Diagnostics.Decorators_cannot_be_applied_to_multiple_get_Slashset_accessors_of_the_same_name,
          );
      }
      // Decorators can only follow `export` and `default`.
      if ((flags & ~(ModifierFlags.ExportDefault | ModifierFlags.Decorator)) !== 0)
        return grammarErrorOnNode(g, modifier, Diagnostics.Decorators_are_not_valid_here);
      if (hasLeadingDecorators && (flags & ModifierFlags.Modifier) !== 0) {
        if (g.hasParseErrors) return false;
        const diagnostic = g.c.error(
          modifier,
          Diagnostics.Decorators_may_not_appear_after_export_or_export_default_if_they_also_appear_before_export,
        );
        addRelated(diagnostic, firstDecorator!, Diagnostics.Decorator_used_before_export_here);
        return true;
      }
      flags |= ModifierFlags.Decorator;
      if ((flags & ModifierFlags.Modifier) === 0) hasLeadingDecorators = true;
      else if ((flags & ModifierFlags.Export) !== 0) sawExportBeforeDecorators = true;
      if (firstDecorator === undefined) firstDecorator = modifier;
      continue;
    }
    const kind = modifier.kind;
    const reparsed = (modifier.flags & NodeFlags.Reparsed) !== 0;
    if (kind !== SyntaxKind.ReadonlyKeyword) {
      if (node.kind === SyntaxKind.PropertySignature || node.kind === SyntaxKind.MethodSignature)
        return grammarErrorOnNode(
          g,
          modifier,
          Diagnostics.X_0_modifier_cannot_appear_on_a_type_member,
          tokenToString(kind),
        );
      if (node.kind === SyntaxKind.IndexSignature && (kind !== SyntaxKind.StaticKeyword || !isClassLike(parent)))
        return grammarErrorOnNode(
          g,
          modifier,
          Diagnostics.X_0_modifier_cannot_appear_on_an_index_signature,
          tokenToString(kind),
        );
    }
    if (
      kind !== SyntaxKind.InKeyword &&
      kind !== SyntaxKind.OutKeyword &&
      kind !== SyntaxKind.ConstKeyword &&
      node.kind === SyntaxKind.TypeParameter
    )
      return grammarErrorOnNode(
        g,
        modifier,
        Diagnostics.X_0_modifier_cannot_appear_on_a_type_parameter,
        tokenToString(kind),
      );
    switch (kind) {
      case SyntaxKind.ConstKeyword:
        if (node.kind !== SyntaxKind.EnumDeclaration && node.kind !== SyntaxKind.TypeParameter)
          return grammarErrorOnNode(g, node, Diagnostics.A_class_member_cannot_have_the_0_keyword, tokenToString(kind));
        if (node.kind === SyntaxKind.TypeParameter && !isConstTypeParameterContainer(parent))
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_can_only_appear_on_a_type_parameter_of_a_function_method_or_class,
            tokenToString(kind),
          );
        break;
      case SyntaxKind.OverrideKeyword:
        // Parameters that aren't parameter properties are reported by the parameter check.
        if ((flags & ModifierFlags.Override) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'override');
        if ((flags & ModifierFlags.Ambient) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'override',
            'declare',
          );
        if ((flags & ModifierFlags.Readonly) !== 0 && !reparsed)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_must_precede_1_modifier,
            'override',
            'readonly',
          );
        if ((flags & ModifierFlags.Accessor) !== 0 && !reparsed)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_must_precede_1_modifier,
            'override',
            'accessor',
          );
        if ((flags & ModifierFlags.Async) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, 'override', 'async');
        flags |= ModifierFlags.Override;
        lastOverride = modifier;
        break;
      case SyntaxKind.PublicKeyword:
      case SyntaxKind.ProtectedKeyword:
      case SyntaxKind.PrivateKeyword: {
        const text = tokenToString(kind);
        if ((flags & ModifierFlags.AccessibilityModifier) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.Accessibility_modifier_already_seen);
        if ((flags & ModifierFlags.Override) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, text, 'override');
        if ((flags & ModifierFlags.Static) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, text, 'static');
        if ((flags & ModifierFlags.Accessor) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, text, 'accessor');
        if ((flags & ModifierFlags.Readonly) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, text, 'readonly');
        if ((flags & ModifierFlags.Async) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, text, 'async');
        if (parent.kind === SyntaxKind.ModuleBlock || parent.kind === SyntaxKind.SourceFile)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_a_module_or_namespace_element,
            text,
          );
        if ((flags & ModifierFlags.Abstract) !== 0) {
          if (kind === SyntaxKind.PrivateKeyword)
            return grammarErrorOnNode(
              g,
              modifier,
              Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
              text,
              'abstract',
            );
          if (!reparsed)
            return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, text, 'abstract');
        } else if (isPrivateIdentifierClassElementDeclaration(node))
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.An_accessibility_modifier_cannot_be_used_with_a_private_identifier,
          );
        flags |= modifierToFlag(kind);
        break;
      }
      case SyntaxKind.StaticKeyword:
        if ((flags & ModifierFlags.Static) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'static');
        if ((flags & ModifierFlags.Readonly) !== 0 && !reparsed)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_must_precede_1_modifier,
            'static',
            'readonly',
          );
        if ((flags & ModifierFlags.Async) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, 'static', 'async');
        if ((flags & ModifierFlags.Accessor) !== 0 && !reparsed)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_must_precede_1_modifier,
            'static',
            'accessor',
          );
        if (parent.kind === SyntaxKind.ModuleBlock || parent.kind === SyntaxKind.SourceFile)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_a_module_or_namespace_element,
            'static',
          );
        if (node.kind === SyntaxKind.Parameter)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_cannot_appear_on_a_parameter, 'static');
        if ((flags & ModifierFlags.Abstract) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'static',
            'abstract',
          );
        if ((flags & ModifierFlags.Override) !== 0 && !reparsed)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_must_precede_1_modifier,
            'static',
            'override',
          );
        flags |= ModifierFlags.Static;
        lastStatic = modifier;
        break;
      case SyntaxKind.AccessorKeyword:
        if ((flags & ModifierFlags.Accessor) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'accessor');
        if ((flags & ModifierFlags.Readonly) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'accessor',
            'readonly',
          );
        if ((flags & ModifierFlags.Ambient) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'accessor',
            'declare',
          );
        if (node.kind !== SyntaxKind.PropertyDeclaration)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_accessor_modifier_can_only_appear_on_a_property_declaration,
          );
        flags |= ModifierFlags.Accessor;
        break;
      case SyntaxKind.ReadonlyKeyword:
        if ((flags & ModifierFlags.Readonly) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'readonly');
        // Parameters that aren't parameter properties are reported by the parameter check.
        if (
          node.kind !== SyntaxKind.PropertyDeclaration &&
          node.kind !== SyntaxKind.PropertySignature &&
          node.kind !== SyntaxKind.IndexSignature &&
          node.kind !== SyntaxKind.Parameter
        )
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_readonly_modifier_can_only_appear_on_a_property_declaration_or_index_signature,
          );
        if ((flags & ModifierFlags.Accessor) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'readonly',
            'accessor',
          );
        flags |= ModifierFlags.Readonly;
        break;
      case SyntaxKind.ExportKeyword:
        if (
          g.c.compilerOptions.verbatimModuleSyntax === true &&
          (node.flags & NodeFlags.Ambient) === 0 &&
          node.kind !== SyntaxKind.TypeAliasDeclaration &&
          node.kind !== SyntaxKind.InterfaceDeclaration &&
          node.kind !== SyntaxKind.ModuleDeclaration &&
          parent.kind === SyntaxKind.SourceFile &&
          getEmitModuleFormat(g) === ModuleKind.CommonJS
        )
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.A_top_level_export_modifier_cannot_be_used_on_value_declarations_in_a_CommonJS_module_when_verbatimModuleSyntax_is_enabled,
          );
        if ((flags & ModifierFlags.Export) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'export');
        if ((flags & ModifierFlags.Ambient) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, 'export', 'declare');
        if ((flags & ModifierFlags.Abstract) !== 0 && !reparsed)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_must_precede_1_modifier,
            'export',
            'abstract',
          );
        if ((flags & ModifierFlags.Async) !== 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, 'export', 'async');
        if (isClassLike(parent) && node.kind !== SyntaxKind.JSTypeAliasDeclaration)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_class_elements_of_this_kind,
            'export',
          );
        if (node.kind === SyntaxKind.Parameter)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_cannot_appear_on_a_parameter, 'export');
        if (blockScopeKind === NodeFlags.Using)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_a_using_declaration,
            'export',
          );
        if (blockScopeKind === NodeFlags.AwaitUsing)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_an_await_using_declaration,
            'export',
          );
        flags |= ModifierFlags.Export;
        break;
      case SyntaxKind.DefaultKeyword: {
        const container = parent.kind === SyntaxKind.SourceFile ? parent : parent.parent!;
        if (container.kind === SyntaxKind.ModuleDeclaration && !isAmbientModule(container))
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.A_default_export_can_only_be_used_in_an_ECMAScript_style_module,
          );
        if (blockScopeKind === NodeFlags.Using)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_a_using_declaration,
            'default',
          );
        if (blockScopeKind === NodeFlags.AwaitUsing)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_an_await_using_declaration,
            'default',
          );
        if ((flags & ModifierFlags.Export) === 0 && !reparsed)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, 'export', 'default');
        if (sawExportBeforeDecorators)
          return grammarErrorOnNode(g, firstDecorator!, Diagnostics.Decorators_are_not_valid_here);
        flags |= ModifierFlags.Default;
        break;
      }
      case SyntaxKind.DeclareKeyword:
        if ((flags & ModifierFlags.Ambient) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'declare');
        if ((flags & ModifierFlags.Async) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_in_an_ambient_context,
            'async',
          );
        if ((flags & ModifierFlags.Override) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_in_an_ambient_context,
            'override',
          );
        if (isClassLike(parent) && node.kind !== SyntaxKind.PropertyDeclaration)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_class_elements_of_this_kind,
            'declare',
          );
        if (node.kind === SyntaxKind.Parameter)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_cannot_appear_on_a_parameter, 'declare');
        if (blockScopeKind === NodeFlags.Using)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_a_using_declaration,
            'declare',
          );
        if (blockScopeKind === NodeFlags.AwaitUsing)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_appear_on_an_await_using_declaration,
            'declare',
          );
        if ((parent.flags & NodeFlags.Ambient) !== 0 && parent.kind === SyntaxKind.ModuleBlock)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.A_declare_modifier_cannot_be_used_in_an_already_ambient_context,
          );
        if (isPrivateIdentifierClassElementDeclaration(node))
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_a_private_identifier,
            'declare',
          );
        if ((flags & ModifierFlags.Accessor) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'declare',
            'accessor',
          );
        flags |= ModifierFlags.Ambient;
        lastDeclare = modifier;
        break;
      case SyntaxKind.AbstractKeyword: {
        if ((flags & ModifierFlags.Abstract) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'abstract');
        if (node.kind !== SyntaxKind.ClassDeclaration && node.kind !== SyntaxKind.ConstructorType) {
          if (
            node.kind !== SyntaxKind.MethodDeclaration &&
            node.kind !== SyntaxKind.PropertyDeclaration &&
            node.kind !== SyntaxKind.GetAccessor &&
            node.kind !== SyntaxKind.SetAccessor
          )
            return grammarErrorOnNode(
              g,
              modifier,
              Diagnostics.X_abstract_modifier_can_only_appear_on_a_class_method_or_property_declaration,
            );
          if (!(parent.kind === SyntaxKind.ClassDeclaration && hasSyntacticModifier(parent, ModifierFlags.Abstract)))
            return grammarErrorOnNode(
              g,
              modifier,
              node.kind === SyntaxKind.PropertyDeclaration
                ? Diagnostics.Abstract_properties_can_only_appear_within_an_abstract_class
                : Diagnostics.Abstract_methods_can_only_appear_within_an_abstract_class,
            );
          if ((flags & ModifierFlags.Static) !== 0)
            return grammarErrorOnNode(
              g,
              modifier,
              Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
              'static',
              'abstract',
            );
          if ((flags & ModifierFlags.Private) !== 0)
            return grammarErrorOnNode(
              g,
              modifier,
              Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
              'private',
              'abstract',
            );
          if ((flags & ModifierFlags.Async) !== 0 && lastAsync !== undefined)
            return grammarErrorOnNode(
              g,
              lastAsync,
              Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
              'async',
              'abstract',
            );
          if ((flags & ModifierFlags.Override) !== 0 && !reparsed)
            return grammarErrorOnNode(
              g,
              modifier,
              Diagnostics.X_0_modifier_must_precede_1_modifier,
              'abstract',
              'override',
            );
          if ((flags & ModifierFlags.Accessor) !== 0 && !reparsed)
            return grammarErrorOnNode(
              g,
              modifier,
              Diagnostics.X_0_modifier_must_precede_1_modifier,
              'abstract',
              'accessor',
            );
        }
        const name = getName(node);
        if (name !== undefined && name.kind === SyntaxKind.PrivateIdentifier)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_a_private_identifier,
            'abstract',
          );
        flags |= ModifierFlags.Abstract;
        break;
      }
      case SyntaxKind.AsyncKeyword:
        if ((flags & ModifierFlags.Async) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, 'async');
        if ((flags & ModifierFlags.Ambient) !== 0 || (parent.flags & NodeFlags.Ambient) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_in_an_ambient_context,
            'async',
          );
        if (node.kind === SyntaxKind.Parameter)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_cannot_appear_on_a_parameter, 'async');
        if ((flags & ModifierFlags.Abstract) !== 0)
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_with_1_modifier,
            'async',
            'abstract',
          );
        flags |= ModifierFlags.Async;
        lastAsync = modifier;
        break;
      case SyntaxKind.InKeyword:
      case SyntaxKind.OutKeyword: {
        const inOutFlag = kind === SyntaxKind.InKeyword ? ModifierFlags.In : ModifierFlags.Out;
        const inOutText = kind === SyntaxKind.InKeyword ? 'in' : 'out';
        if (
          node.kind !== SyntaxKind.TypeParameter ||
          !(
            parent.kind === SyntaxKind.InterfaceDeclaration ||
            isClassLike(parent) ||
            parent.kind === SyntaxKind.TypeAliasDeclaration ||
            parent.kind === SyntaxKind.JSTypeAliasDeclaration
          )
        )
          return grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_can_only_appear_on_a_type_parameter_of_a_class_interface_or_type_alias,
            inOutText,
          );
        if ((flags & inOutFlag) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_already_seen, inOutText);
        if ((inOutFlag & ModifierFlags.In) !== 0 && (flags & ModifierFlags.Out) !== 0)
          return grammarErrorOnNode(g, modifier, Diagnostics.X_0_modifier_must_precede_1_modifier, 'in', 'out');
        flags |= inOutFlag;
        break;
      }
    }
  }
  if (node.kind === SyntaxKind.Constructor) {
    if ((flags & ModifierFlags.Static) !== 0)
      return grammarErrorOnNode(
        g,
        lastStatic!,
        Diagnostics.X_0_modifier_cannot_appear_on_a_constructor_declaration,
        'static',
      );
    if ((flags & ModifierFlags.Override) !== 0)
      return grammarErrorOnNode(
        g,
        lastOverride!,
        Diagnostics.X_0_modifier_cannot_appear_on_a_constructor_declaration,
        'override',
      );
    if ((flags & ModifierFlags.Async) !== 0)
      return grammarErrorOnNode(
        g,
        lastAsync!,
        Diagnostics.X_0_modifier_cannot_appear_on_a_constructor_declaration,
        'async',
      );
    return false;
  }
  if (
    (node.kind === SyntaxKind.ImportDeclaration ||
      node.kind === SyntaxKind.JSImportDeclaration ||
      node.kind === SyntaxKind.ImportEqualsDeclaration) &&
    (flags & ModifierFlags.Ambient) !== 0
  )
    return grammarErrorOnNode(
      g,
      lastDeclare!,
      Diagnostics.A_0_modifier_cannot_be_used_with_an_import_declaration,
      'declare',
    );
  if (node.kind === SyntaxKind.Parameter && (flags & ModifierFlags.ParameterPropertyModifier) !== 0) {
    const parameter = node as ParameterDeclaration;
    if (isBindingPattern(parameter.name))
      return grammarErrorOnNode(g, node, Diagnostics.A_parameter_property_may_not_be_declared_using_a_binding_pattern);
    if (parameter.dotDotDotToken !== undefined)
      return grammarErrorOnNode(g, node, Diagnostics.A_parameter_property_cannot_be_declared_using_a_rest_parameter);
  }
  if ((flags & ModifierFlags.Async) !== 0) return checkGrammarAsyncModifier(g, node, lastAsync!);
  return false;
}

function isConstTypeParameterContainer(parent: Node): boolean {
  switch (parent.kind) {
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.MethodSignature:
      return true;
  }
  return isFunctionLikeDeclarationKind(parent.kind) || isClassLike(parent);
}

function reportObviousModifierErrors(g: GrammarChecker, node: Node, modifiers: ModifierList): boolean {
  const modifier = findFirstIllegalModifier(node, modifiers);
  return modifier !== undefined && grammarErrorOnFirstToken(g, modifier, Diagnostics.Modifiers_cannot_appear_here);
}

function findFirstModifier(modifiers: ModifierList): Node | undefined {
  for (const modifier of modifiers.nodes) if (isModifierKind(modifier.kind)) return modifier;
  return undefined;
}

function findFirstModifierExcept(modifiers: ModifierList, allowedModifier: SyntaxKind): Node | undefined {
  const modifier = findFirstModifier(modifiers);
  return modifier !== undefined && modifier.kind !== allowedModifier ? modifier : undefined;
}

function findFirstIllegalModifier(node: Node, modifiers: ModifierList): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.Constructor:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.Parameter:
    case SyntaxKind.TypeParameter:
    case SyntaxKind.JSTypeAliasDeclaration:
      return undefined;
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.MissingDeclaration:
      return findFirstModifier(modifiers);
  }
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.ModuleBlock || parent.kind === SyntaxKind.SourceFile) return undefined;
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
      return findFirstModifierExcept(modifiers, SyntaxKind.AsyncKeyword);
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ConstructorType:
      return findFirstModifierExcept(modifiers, SyntaxKind.AbstractKeyword);
    case SyntaxKind.VariableStatement:
      if (((node as VariableStatement).declarationList.flags & NodeFlags.Using) !== 0)
        return findFirstModifierExcept(modifiers, SyntaxKind.AwaitKeyword);
      return findFirstModifier(modifiers);
    case SyntaxKind.EnumDeclaration:
      return findFirstModifierExcept(modifiers, SyntaxKind.ConstKeyword);
  }
  // Class expressions, interfaces and type aliases.
  return findFirstModifier(modifiers);
}

function reportObviousDecoratorErrors(g: GrammarChecker, node: Node, modifiers: ModifierList): boolean {
  if (!canHaveIllegalDecorators(node)) return false;
  for (const modifier of modifiers.nodes)
    if (modifier.kind === SyntaxKind.Decorator)
      return grammarErrorOnFirstToken(g, modifier, Diagnostics.Decorators_are_not_valid_here);
  return false;
}

function checkGrammarAsyncModifier(g: GrammarChecker, node: Node, asyncModifier: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return false;
  }
  return grammarErrorOnNode(g, asyncModifier, Diagnostics.X_0_modifier_cannot_be_used_here, 'async');
}

function hasDecorators(node: Node): boolean {
  const modifiers = getModifiers(node);
  if (modifiers === undefined) return false;
  for (const modifier of modifiers.nodes) if (modifier.kind === SyntaxKind.Decorator) return true;
  return false;
}

/** Whether `node` is a valid decorator target. */
function nodeCanBeDecorated(
  legacy: boolean,
  node: Node,
  parent: Node | undefined,
  grandparent: Node | undefined,
): boolean {
  const name = getName(node);
  // Legacy decorators don't support private names.
  if (legacy && name !== undefined && name.kind === SyntaxKind.PrivateIdentifier) return false;
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
      return true;
    case SyntaxKind.ClassExpression:
      return !legacy;
    case SyntaxKind.PropertyDeclaration:
      return (
        parent !== undefined &&
        (legacy
          ? parent.kind === SyntaxKind.ClassDeclaration
          : isClassLike(parent) && !hasSyntacticModifier(node, ModifierFlags.Abstract | ModifierFlags.Ambient))
      );
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
      return (
        parent !== undefined &&
        getBody(node) !== undefined &&
        (legacy ? parent.kind === SyntaxKind.ClassDeclaration : isClassLike(parent))
      );
    case SyntaxKind.Parameter:
      if (!legacy || parent === undefined || getBody(parent) === undefined) return false;
      return (
        (parent.kind === SyntaxKind.Constructor ||
          parent.kind === SyntaxKind.MethodDeclaration ||
          parent.kind === SyntaxKind.SetAccessor) &&
        getThisParameter(parent) !== node &&
        grandparent !== undefined &&
        grandparent.kind === SyntaxKind.ClassDeclaration
      );
  }
  return false;
}

/** The first of the get/set accessor pair `node` belongs to. */
function getFirstAccessorOfPair(c: Checker, node: Node): Node {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return node;
  const otherKind = node.kind === SyntaxKind.GetAccessor ? SyntaxKind.SetAccessor : SyntaxKind.GetAccessor;
  for (const declaration of getDeclarations(symbol))
    if (declaration.kind === otherKind && declaration.pos < node.pos) return declaration;
  return node;
}

/** The decorator checks of `checkDecorators`. */
function checkGrammarDecorators(g: GrammarChecker, node: Node): void {
  if (!canHaveDecorators(node) || !hasDecorators(node)) return;
  if (!nodeCanBeDecorated(g.legacyDecorators, node, node.parent, node.parent!.parent)) return;
  for (const modifier of getModifiers(node)!.nodes)
    if (modifier.kind === SyntaxKind.Decorator) checkGrammarDecorator(g, modifier as Decorator);
}

function checkGrammarDecorator(g: GrammarChecker, decorator: Decorator): boolean {
  if (g.hasParseErrors) return false;
  let node: Node = decorator.expression;
  // `@(expression)`
  if (node.kind === SyntaxKind.ParenthesizedExpression) return false;
  let canHaveCallExpression = true;
  let errorNode: Node | undefined;
  for (;;) {
    // Non-null assertions and instantiation expressions are allowed.
    if (node.kind === SyntaxKind.ExpressionWithTypeArguments || node.kind === SyntaxKind.NonNullExpression) {
      node = getExpression(node)!;
      continue;
    }
    // `@member.expression(arguments)`
    if (node.kind === SyntaxKind.CallExpression) {
      const call = node as CallExpression;
      if (!canHaveCallExpression) errorNode = node;
      // A `?.` token comes first, so it wins over an earlier error node.
      if (callQuestionDotToken(call) !== undefined) errorNode = callQuestionDotToken(call);
      node = call.expression;
      canHaveCallExpression = false;
      continue;
    }
    // `@identifier`, `@member.name` and `@member.#name`
    if (node.kind === SyntaxKind.PropertyAccessExpression) {
      const access = node as PropertyAccessExpression;
      if (access.questionDotToken !== undefined) errorNode = access.questionDotToken;
      node = access.expression;
      canHaveCallExpression = false;
      continue;
    }
    if (node.kind !== SyntaxKind.Identifier) errorNode = node;
    break;
  }
  if (errorNode === undefined) return false;
  const diagnostic = g.c.error(
    decorator.expression,
    Diagnostics.Expression_must_be_enclosed_in_parentheses_to_be_used_as_a_decorator,
  );
  addRelated(diagnostic, errorNode, Diagnostics.Invalid_syntax_in_decorator);
  return true;
}

// ---- Functions and parameters

function checkGrammarFunctionLikeDeclaration(g: GrammarChecker, node: Node): boolean {
  // Short-circuits to prevent cascading errors.
  return (
    checkGrammarModifiers(g, node) ||
    checkGrammarTypeParameterList(g, getTypeParameters(node)) ||
    checkGrammarParameterList(g, getParameters(node)!) ||
    checkGrammarArrowFunction(g, node) ||
    (isFunctionLikeDeclarationKind(node.kind) && checkGrammarForUseStrictSimpleParameterList(g, node))
  );
}

function checkGrammarForDisallowedTrailingComma(
  g: GrammarChecker,
  list: NodeList | undefined,
  message: DiagnosticMessage,
): boolean {
  return list !== undefined && list.hasTrailingComma() && grammarErrorAtPos(g, list.end - 1, 1, message);
}

function checkGrammarTypeParameterList(g: GrammarChecker, typeParameters: NodeList | undefined): boolean {
  if (typeParameters === undefined || typeParameters.nodes.length !== 0) return false;
  const start = typeParameters.pos - 1;
  const end = skipTrivia(g.file.text, typeParameters.end) + 1;
  return grammarErrorAtPos(g, start, end - start, Diagnostics.Type_parameter_list_cannot_be_empty);
}

function checkGrammarParameterList(g: GrammarChecker, parameters: NodeList): boolean {
  let seenOptionalParameter = false;
  const count = parameters.nodes.length;
  for (let i = 0; i < count; i++) {
    const parameter = parameters.nodes[i]! as ParameterDeclaration;
    if (parameter.dotDotDotToken !== undefined) {
      if (i !== count - 1)
        return grammarErrorOnNode(
          g,
          parameter.dotDotDotToken,
          Diagnostics.A_rest_parameter_must_be_last_in_a_parameter_list,
        );
      if ((parameter.flags & NodeFlags.Ambient) === 0)
        checkGrammarForDisallowedTrailingComma(
          g,
          parameters,
          Diagnostics.A_rest_parameter_or_binding_pattern_may_not_have_a_trailing_comma,
        );
      if (parameter.questionToken !== undefined)
        return grammarErrorOnNode(g, parameter.questionToken, Diagnostics.A_rest_parameter_cannot_be_optional);
      if (parameter.initializer !== undefined)
        return grammarErrorOnNode(g, parameter.name, Diagnostics.A_rest_parameter_cannot_have_an_initializer);
    } else if (parameter.questionToken !== undefined) {
      seenOptionalParameter = true;
      // A reparsed `?` comes from a bracketed `@param` name.
      if ((parameter.questionToken.flags & NodeFlags.Reparsed) === 0 && parameter.initializer !== undefined)
        return grammarErrorOnNode(g, parameter.name, Diagnostics.Parameter_cannot_have_question_mark_and_initializer);
    } else if (seenOptionalParameter && parameter.initializer === undefined) {
      return grammarErrorOnNode(
        g,
        parameter.name,
        Diagnostics.A_required_parameter_cannot_follow_an_optional_parameter,
      );
    }
  }
  return false;
}

function checkGrammarForUseStrictSimpleParameterList(g: GrammarChecker, node: Node): boolean {
  if (g.c.languageVersion < ScriptTarget.ES2016) return false;
  const body = getBody(node);
  if (body === undefined || body.kind !== SyntaxKind.Block) return false;
  const useStrictDirective = findUseStrictPrologue(g.file, getStatements(body)!.nodes);
  if (useStrictDirective === undefined) return false;
  const nonSimpleParameters: Node[] = [];
  for (const parameter of getParameters(node)!.nodes) {
    const p = parameter as ParameterDeclaration;
    if (p.initializer !== undefined || isBindingPattern(p.name) || p.dotDotDotToken !== undefined)
      nonSimpleParameters.push(parameter);
  }
  if (nonSimpleParameters.length === 0) return false;
  for (const parameter of nonSimpleParameters) {
    const diagnostic = g.c.error(parameter, Diagnostics.This_parameter_is_not_allowed_with_use_strict_directive);
    addRelated(diagnostic, useStrictDirective, Diagnostics.X_use_strict_directive_used_here);
  }
  const diagnostic = g.c.error(
    useStrictDirective,
    Diagnostics.X_use_strict_directive_cannot_be_used_with_non_simple_parameter_list,
  );
  for (let i = 0; i < nonSimpleParameters.length; i++)
    addRelated(
      diagnostic,
      nonSimpleParameters[i]!,
      i === 0 ? Diagnostics.Non_simple_parameter_declared_here : Diagnostics.X_and_here,
    );
  return true;
}

function checkGrammarArrowFunction(g: GrammarChecker, node: Node): boolean {
  if (node.kind !== SyntaxKind.ArrowFunction) return false;
  const arrow = node as ArrowFunction;
  const typeParameters = arrow.typeParameters;
  if (typeParameters !== undefined) {
    const nodes = typeParameters.nodes;
    const hasConstraint = nodes.length > 0 && (nodes[0]! as TypeParameterDeclaration).constraint !== undefined;
    if (
      !(nodes.length > 1 || typeParameters.hasTrailingComma() || hasConstraint) &&
      fileExtensionIsOneOf(g.file.fileName, ['.mts', '.cts'])
    )
      grammarErrorOnNode(
        g,
        nodes[0]!,
        Diagnostics.This_syntax_is_reserved_in_files_with_the_mts_or_cts_extension_Add_a_trailing_comma_or_explicit_constraint,
      );
  }
  const arrowToken = arrow.equalsGreaterThanToken;
  if (arrowToken === undefined) return false;
  return (
    hasLineBreak(g.file.text, arrowToken.pos, arrowToken.end) &&
    grammarErrorOnNode(g, arrowToken, Diagnostics.Line_terminator_not_permitted_before_arrow)
  );
}

/**
 * Whether a line starts in `(pos, end]`, so that `pos` and `end` are on different lines: after an
 * LF, LS or PS, or a CR that no LF follows (`computeLineStarts`), without the file's line starts.
 */
function hasLineBreak(text: string, pos: number, end: number): boolean {
  for (let i = pos; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || c === 0x2028 || c === 0x2029) return true;
    if (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a) return true;
  }
  return false;
}

function checkGrammarForGenerator(g: GrammarChecker, node: Node): boolean {
  const asteriskToken = getAsteriskToken(node);
  if (asteriskToken === undefined) return false;
  if ((node.flags & NodeFlags.Ambient) !== 0)
    return grammarErrorOnNode(g, asteriskToken, Diagnostics.Generators_are_not_allowed_in_an_ambient_context);
  if (getBody(node) === undefined)
    return grammarErrorOnNode(g, asteriskToken, Diagnostics.An_overload_signature_cannot_be_declared_as_a_generator);
  return false;
}

function isThisParameter(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter) return false;
  const name = (node as ParameterDeclaration).name;
  return name instanceof Identifier && name.text === 'this';
}

function getThisParameter(signature: Node): Node | undefined {
  const parameters = getParameters(signature);
  if (parameters === undefined || parameters.nodes.length === 0) return undefined;
  const first = parameters.nodes[0]!;
  return isThisParameter(first) ? first : undefined;
}

function isBindingPattern(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern)
  );
}

// ---- Signatures and members

function checkGrammarIndexSignatureParameters(g: GrammarChecker, node: IndexSignatureDeclaration): boolean {
  const parameters = node.parameters.nodes;
  if (parameters.length === 0)
    return grammarErrorOnNode(g, node, Diagnostics.An_index_signature_must_have_exactly_one_parameter);
  const parameter = parameters[0]! as ParameterDeclaration;
  if (parameters.length !== 1)
    return grammarErrorOnNode(g, parameter.name, Diagnostics.An_index_signature_must_have_exactly_one_parameter);
  checkGrammarForDisallowedTrailingComma(
    g,
    node.parameters,
    Diagnostics.An_index_signature_cannot_have_a_trailing_comma,
  );
  if (parameter.dotDotDotToken !== undefined)
    return grammarErrorOnNode(g, parameter.dotDotDotToken, Diagnostics.An_index_signature_cannot_have_a_rest_parameter);
  if (parameter.modifiers !== undefined)
    return grammarErrorOnNode(
      g,
      parameter.name,
      Diagnostics.An_index_signature_parameter_cannot_have_an_accessibility_modifier,
    );
  if (parameter.questionToken !== undefined)
    return grammarErrorOnNode(
      g,
      parameter.questionToken,
      Diagnostics.An_index_signature_parameter_cannot_have_a_question_mark,
    );
  if (parameter.initializer !== undefined)
    return grammarErrorOnNode(g, parameter.name, Diagnostics.An_index_signature_parameter_cannot_have_an_initializer);
  if (parameter.type === undefined)
    return grammarErrorOnNode(g, parameter.name, Diagnostics.An_index_signature_parameter_must_have_a_type_annotation);
  const t = getTypeFromTypeNode(g.c, parameter.type);
  if (someTypeHasFlags(t, TypeFlags.StringOrNumberLiteralOrUnique) || isGenericType(g.c, t))
    return grammarErrorOnNode(
      g,
      parameter.name,
      Diagnostics.An_index_signature_parameter_type_cannot_be_a_literal_type_or_generic_type_Consider_using_a_mapped_object_type_instead,
    );
  if (!everyTypeIsValidIndexKey(g.c, t))
    return grammarErrorOnNode(
      g,
      parameter.name,
      Diagnostics.An_index_signature_parameter_type_must_be_string_number_symbol_or_a_template_literal_type,
    );
  if (node.type === undefined)
    return grammarErrorOnNode(g, node, Diagnostics.An_index_signature_must_have_a_type_annotation);
  return false;
}

function someTypeHasFlags(t: Type, flags: TypeFlags): boolean {
  if ((t.flags & TypeFlags.Union) === 0) return (t.flags & flags) !== 0;
  for (const member of (t as UnionType).types) if ((member.flags & flags) !== 0) return true;
  return false;
}

function everyTypeIsValidIndexKey(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Union) === 0) return isValidIndexKeyType(c, t);
  for (const member of (t as UnionType).types) if (!isValidIndexKeyType(c, member)) return false;
  return true;
}

function checkGrammarTypeArguments(g: GrammarChecker, typeArguments: NodeList | undefined): boolean {
  if (checkGrammarForDisallowedTrailingComma(g, typeArguments, Diagnostics.Trailing_comma_not_allowed)) return true;
  if (typeArguments === undefined || typeArguments.nodes.length !== 0) return false;
  const start = typeArguments.pos - 1;
  const end = skipTrivia(g.file.text, typeArguments.end) + 1;
  return grammarErrorAtPos(g, start, end - start, Diagnostics.Type_argument_list_cannot_be_empty);
}

function checkGrammarExpressionWithTypeArguments(g: GrammarChecker, node: Node): boolean {
  const typeArguments = getTypeArguments(node);
  if (
    node.kind === SyntaxKind.ExpressionWithTypeArguments &&
    (node as ExpressionWithTypeArguments).expression.kind === SyntaxKind.ImportKeyword &&
    typeArguments !== undefined
  )
    return grammarErrorOnNode(
      g,
      node,
      Diagnostics.This_use_of_import_is_invalid_import_calls_can_be_written_but_they_must_have_parentheses_and_cannot_have_type_arguments,
    );
  return checkGrammarTypeArguments(g, typeArguments);
}

function checkGrammarHeritageClause(g: GrammarChecker, clause: HeritageClause): boolean {
  const types = clause.types;
  if (checkGrammarForDisallowedTrailingComma(g, types, Diagnostics.Trailing_comma_not_allowed)) return true;
  if (types.nodes.length === 0)
    return grammarErrorAtPos(g, types.pos, 0, Diagnostics.X_0_list_cannot_be_empty, tokenToString(clause.token));
  for (const type of types.nodes) if (checkGrammarExpressionWithTypeArguments(g, type)) return true;
  return false;
}

function checkGrammarClassDeclaration(g: GrammarChecker, node: Node): void {
  const modifiers = getModifiers(node);
  if (g.legacyDecorators && modifiers !== undefined) {
    let firstDecorator: Node | undefined;
    for (const modifier of modifiers.nodes)
      if (modifier.kind === SyntaxKind.Decorator) {
        firstDecorator = modifier;
        break;
      }
    if (firstDecorator !== undefined)
      for (const member of getMembers(node)!.nodes)
        if (hasSyntacticModifier(member, ModifierFlags.Static) && isPrivateIdentifierClassElementDeclaration(member)) {
          grammarErrorOnNode(
            g,
            firstDecorator,
            Diagnostics.Class_decorators_can_t_be_used_with_static_private_identifier_Consider_removing_the_experimental_decorator,
          );
          break;
        }
  }
  if (getName(node) === undefined && !hasSyntacticModifier(node, ModifierFlags.Default))
    grammarErrorOnFirstToken(g, node, Diagnostics.A_class_declaration_without_the_default_modifier_must_have_a_name);
  checkGrammarClassLikeDeclaration(g, node);
}

function checkGrammarClassLikeDeclaration(g: GrammarChecker, node: Node): void {
  if (!checkGrammarClassDeclarationHeritageClauses(g, node)) checkGrammarTypeParameterList(g, getTypeParameters(node));
  checkGrammarDecorators(g, node);
  // `implements` clause elements are checked again as type references.
  const clauses = getHeritageClauses(node);
  if (clauses !== undefined)
    for (const clause of clauses.nodes)
      if ((clause as HeritageClause).token === SyntaxKind.ImplementsKeyword)
        for (const type of (clause as HeritageClause).types.nodes) checkGrammarTypeArguments(g, getTypeArguments(type));
}

function checkGrammarClassDeclarationHeritageClauses(g: GrammarChecker, node: Node): boolean {
  let seenExtendsClause = false;
  let seenImplementsClause = false;
  const clauses = getHeritageClauses(node);
  if (checkGrammarModifiers(g, node) || clauses === undefined) return false;
  for (const clauseNode of clauses.nodes) {
    const clause = clauseNode as HeritageClause;
    if (clause.token === SyntaxKind.ExtendsKeyword) {
      if (seenExtendsClause) return grammarErrorOnFirstToken(g, clause, Diagnostics.X_extends_clause_already_seen);
      if (seenImplementsClause)
        return grammarErrorOnFirstToken(g, clause, Diagnostics.X_extends_clause_must_precede_implements_clause);
      if (clause.types.nodes.length > 1)
        return grammarErrorOnFirstToken(g, clause.types.nodes[1]!, Diagnostics.Classes_can_only_extend_a_single_class);
      seenExtendsClause = true;
    } else {
      if (seenImplementsClause)
        return grammarErrorOnFirstToken(g, clause, Diagnostics.X_implements_clause_already_seen);
      seenImplementsClause = true;
    }
    checkGrammarHeritageClause(g, clause);
  }
  return false;
}

function checkGrammarInterfaceDeclaration(g: GrammarChecker, node: Node): void {
  const clauses = getHeritageClauses(node);
  if (!checkGrammarModifiers(g, node) && clauses !== undefined) {
    let seenExtendsClause = false;
    for (const clauseNode of clauses.nodes) {
      const clause = clauseNode as HeritageClause;
      if (clause.token === SyntaxKind.ExtendsKeyword) {
        if (seenExtendsClause) {
          grammarErrorOnFirstToken(g, clause, Diagnostics.X_extends_clause_already_seen);
          break;
        }
        seenExtendsClause = true;
      } else {
        grammarErrorOnFirstToken(g, clause, Diagnostics.Interface_declaration_cannot_have_implements_clause);
        break;
      }
      checkGrammarHeritageClause(g, clause);
    }
  }
  if (!containerAllowsBlockScopedVariable(node.parent!))
    grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_can_only_be_declared_inside_a_block, 'interface');
  // `extends` clause elements are checked again as type references.
  if (clauses !== undefined)
    for (const clause of clauses.nodes)
      if ((clause as HeritageClause).token === SyntaxKind.ExtendsKeyword)
        for (const type of (clause as HeritageClause).types.nodes) checkGrammarTypeArguments(g, getTypeArguments(type));
}

function checkGrammarComputedPropertyName(g: GrammarChecker, node: Node): boolean {
  if (node.kind !== SyntaxKind.ComputedPropertyName) return false;
  const expression = (node as ComputedPropertyName).expression;
  return (
    expression.kind === SyntaxKind.BinaryExpression &&
    (expression as BinaryExpression).operatorToken.kind === SyntaxKind.CommaToken &&
    grammarErrorOnNode(g, expression, Diagnostics.A_comma_expression_is_not_allowed_in_a_computed_property_name)
  );
}

function checkGrammarForInvalidQuestionMark(
  g: GrammarChecker,
  postfixToken: Node | undefined,
  message: DiagnosticMessage,
): boolean {
  return (
    postfixToken !== undefined &&
    postfixToken.kind === SyntaxKind.QuestionToken &&
    grammarErrorOnNode(g, postfixToken, message)
  );
}

function checkGrammarForInvalidExclamationToken(
  g: GrammarChecker,
  postfixToken: Node | undefined,
  message: DiagnosticMessage,
): boolean {
  return (
    postfixToken !== undefined &&
    postfixToken.kind === SyntaxKind.ExclamationToken &&
    grammarErrorOnNode(g, postfixToken, message)
  );
}

/** Whether a name is dynamic and can't be late bound: its type isn't a literal or unique symbol. */
function isNonBindableDynamicName(c: Checker, node: Node): boolean {
  if (!isDynamicName(node)) return false;
  let expression: Node | undefined;
  if (node.kind === SyntaxKind.ComputedPropertyName) expression = getExpression(node);
  else if (node instanceof ElementAccessExpression) expression = node.argumentExpression;
  if (expression === undefined || !isEntityNameExpression(expression, false)) return true;
  const t =
    node.kind === SyntaxKind.ComputedPropertyName
      ? checkComputedPropertyName(c, node)
      : checkExpressionCached(c, expression);
  return !isTypeUsableAsPropertyName(t);
}

function checkGrammarForInvalidDynamicName(g: GrammarChecker, node: Node, message: DiagnosticMessage): boolean {
  if (!isNonBindableDynamicName(g.c, node)) return false;
  const expression =
    node instanceof ElementAccessExpression ? skipParentheses(node.argumentExpression) : getExpression(node)!;
  return !isEntityNameExpression(expression, false) && grammarErrorOnNode(g, node, message);
}

function checkGrammarMethodDeclaration(g: GrammarChecker, node: Node): void {
  if (node.parent!.kind === SyntaxKind.ObjectLiteralExpression) {
    // `checkObjectLiteralMethod` checks the method, then checks it again as a function expression.
    checkGrammarMethod(g, node);
    checkGrammarFunctionLikeDeclaration(g, node);
    return;
  }
  const name = getName(node)!;
  if (!checkGrammarMethod(g, node)) {
    checkGrammarComputedPropertyName(g, name);
    if (getAsteriskToken(node) !== undefined && name instanceof Identifier && name.text === 'constructor')
      g.c.error(name, Diagnostics.Class_constructor_may_not_be_a_generator);
  }
  checkGrammarDecorators(g, node);
  if (name.kind === SyntaxKind.PrivateIdentifier && getContainingClass(node) === undefined)
    g.c.error(node, Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies);
}

function checkGrammarMethod(g: GrammarChecker, node: Node): boolean {
  if (checkGrammarFunctionLikeDeclaration(g, node)) return true;
  const parent = node.parent!;
  if (node.kind === SyntaxKind.MethodDeclaration) {
    if (parent.kind === SyntaxKind.ObjectLiteralExpression) {
      // Only `async` is allowed on object literal methods.
      const modifiers = getModifiers(node);
      if (
        modifiers !== undefined &&
        !(modifiers.nodes.length === 1 && modifiers.nodes[0]!.kind === SyntaxKind.AsyncKeyword)
      )
        return grammarErrorOnFirstToken(g, node, Diagnostics.Modifiers_cannot_appear_here);
      const postfixToken = getPostfixToken(node);
      if (checkGrammarForInvalidQuestionMark(g, postfixToken, Diagnostics.An_object_member_cannot_be_declared_optional))
        return true;
      if (
        checkGrammarForInvalidExclamationToken(
          g,
          postfixToken,
          Diagnostics.A_definite_assignment_assertion_is_not_permitted_in_this_context,
        )
      )
        return true;
      if (getBody(node) === undefined) return grammarErrorAtPos(g, node.end - 1, 1, Diagnostics.X_0_expected, '{');
    }
    if (checkGrammarForGenerator(g, node)) return true;
  }
  const name = getName(node)!;
  if (isClassLike(parent)) {
    // Computed names are disallowed in ambient contexts for properties and accessors too, but
    // those report other errors first.
    if ((node.flags & NodeFlags.Ambient) !== 0)
      return checkGrammarForInvalidDynamicName(
        g,
        name,
        Diagnostics.A_computed_property_name_in_an_ambient_context_must_refer_to_an_expression_whose_type_is_a_literal_type_or_a_unique_symbol_type,
      );
    if (node.kind === SyntaxKind.MethodDeclaration && getBody(node) === undefined)
      return checkGrammarForInvalidDynamicName(
        g,
        name,
        Diagnostics.A_computed_property_name_in_a_method_overload_must_refer_to_an_expression_whose_type_is_a_literal_type_or_a_unique_symbol_type,
      );
  } else if (parent.kind === SyntaxKind.InterfaceDeclaration) {
    return checkGrammarForInvalidDynamicName(
      g,
      name,
      Diagnostics.A_computed_property_name_in_an_interface_must_refer_to_an_expression_whose_type_is_a_literal_type_or_a_unique_symbol_type,
    );
  } else if (parent.kind === SyntaxKind.TypeLiteral) {
    return checkGrammarForInvalidDynamicName(
      g,
      name,
      Diagnostics.A_computed_property_name_in_a_type_literal_must_refer_to_an_expression_whose_type_is_a_literal_type_or_a_unique_symbol_type,
    );
  }
  return false;
}

function checkGrammarConstructorTypeParameters(g: GrammarChecker, node: ConstructorDeclaration): boolean {
  const range = node.typeParameters;
  if (range === undefined) return false;
  const pos = range.pos === range.end ? range.pos : skipTrivia(g.file.text, range.pos);
  return grammarErrorAtPos(
    g,
    pos,
    range.end - pos,
    Diagnostics.Type_parameters_cannot_appear_on_a_constructor_declaration,
  );
}

function checkGrammarAccessorDeclaration(g: GrammarChecker, node: Node): void {
  const name = getName(node)!;
  if (!checkGrammarFunctionLikeDeclaration(g, node) && !checkGrammarAccessor(g, node))
    checkGrammarComputedPropertyName(g, name);
  checkGrammarDecorators(g, node);
}

function checkGrammarAccessor(g: GrammarChecker, accessor: Node): boolean {
  const body = getBody(accessor);
  const parent = accessor.parent!;
  const inTypeMember = parent.kind === SyntaxKind.TypeLiteral || parent.kind === SyntaxKind.InterfaceDeclaration;
  const isAbstract = hasSyntacticModifier(accessor, ModifierFlags.Abstract);
  if ((accessor.flags & NodeFlags.Ambient) === 0 && !inTypeMember && body === undefined && !isAbstract)
    return grammarErrorAtPos(g, accessor.end - 1, 1, Diagnostics.X_0_expected, '{');
  if (body !== undefined) {
    if (isAbstract)
      return grammarErrorOnNode(g, accessor, Diagnostics.An_abstract_accessor_cannot_have_an_implementation);
    if (inTypeMember)
      return grammarErrorOnNode(g, body, Diagnostics.An_implementation_cannot_be_declared_in_ambient_contexts);
  }
  const name = getName(accessor)!;
  if (getTypeParameters(accessor) !== undefined)
    return grammarErrorOnNode(g, name, Diagnostics.An_accessor_cannot_have_type_parameters);
  const parameters = getParameters(accessor)!.nodes;
  const isGetter = accessor.kind === SyntaxKind.GetAccessor;
  // A `this` parameter only counts with the right number of other parameters.
  const hasThisParameter = parameters.length === (isGetter ? 1 : 2) && isThisParameter(parameters[0]!);
  if (!hasThisParameter && parameters.length !== (isGetter ? 0 : 1))
    return grammarErrorOnNode(
      g,
      name,
      isGetter
        ? Diagnostics.A_get_accessor_cannot_have_parameters
        : Diagnostics.A_set_accessor_must_have_exactly_one_parameter,
    );
  if (!isGetter) {
    if (getType(accessor) !== undefined)
      return grammarErrorOnNode(g, name, Diagnostics.A_set_accessor_cannot_have_a_return_type_annotation);
    const parameter = parameters[hasThisParameter ? 1 : 0]! as ParameterDeclaration;
    if (parameter.dotDotDotToken !== undefined)
      return grammarErrorOnNode(g, parameter.dotDotDotToken, Diagnostics.A_set_accessor_cannot_have_rest_parameter);
    if (parameter.questionToken !== undefined)
      return grammarErrorOnNode(
        g,
        parameter.questionToken,
        Diagnostics.A_set_accessor_cannot_have_an_optional_parameter,
      );
    if (parameter.initializer !== undefined)
      return grammarErrorOnNode(g, name, Diagnostics.A_set_accessor_parameter_cannot_have_an_initializer);
  }
  return false;
}

function checkGrammarPropertyDeclaration(g: GrammarChecker, node: Node): void {
  if (!checkGrammarModifiers(g, node) && !checkGrammarProperty(g, node))
    checkGrammarComputedPropertyName(g, getName(node)!);
}

function checkGrammarProperty(g: GrammarChecker, node: Node): boolean {
  const name = getName(node)!;
  const parent = node.parent!;
  if (name.kind === SyntaxKind.ComputedPropertyName) {
    const expression = (name as ComputedPropertyName).expression;
    if (
      expression.kind === SyntaxKind.BinaryExpression &&
      (expression as BinaryExpression).operatorToken.kind === SyntaxKind.InKeyword
    )
      return grammarErrorOnNode(
        g,
        getMembers(parent)!.nodes[0]!,
        Diagnostics.A_mapped_type_may_not_declare_properties_or_methods,
      );
  }
  if (isClassLike(parent)) {
    if (name instanceof StringLiteral && name.text === 'constructor')
      return grammarErrorOnNode(g, name, Diagnostics.Classes_may_not_have_a_field_named_constructor);
    if (
      checkGrammarForInvalidDynamicName(
        g,
        name,
        Diagnostics.A_computed_property_name_in_a_class_property_declaration_must_have_a_simple_literal_type_or_a_unique_symbol_type,
      )
    )
      return true;
    if (
      isAutoAccessorPropertyDeclaration(node) &&
      checkGrammarForInvalidQuestionMark(
        g,
        getPostfixToken(node),
        Diagnostics.An_accessor_property_cannot_be_declared_optional,
      )
    )
      return true;
  } else if (parent.kind === SyntaxKind.InterfaceDeclaration) {
    if (
      checkGrammarForInvalidDynamicName(
        g,
        name,
        Diagnostics.A_computed_property_name_in_an_interface_must_refer_to_an_expression_whose_type_is_a_literal_type_or_a_unique_symbol_type,
      )
    )
      return true;
    const initializer = getInitializer(node);
    if (initializer !== undefined)
      return grammarErrorOnNode(g, initializer, Diagnostics.An_interface_property_cannot_have_an_initializer);
  } else if (parent.kind === SyntaxKind.TypeLiteral) {
    if (
      checkGrammarForInvalidDynamicName(
        g,
        name,
        Diagnostics.A_computed_property_name_in_a_type_literal_must_refer_to_an_expression_whose_type_is_a_literal_type_or_a_unique_symbol_type,
      )
    )
      return true;
    const initializer = getInitializer(node);
    if (initializer !== undefined)
      return grammarErrorOnNode(g, initializer, Diagnostics.A_type_literal_property_cannot_have_an_initializer);
  }
  if ((node.flags & NodeFlags.Ambient) !== 0) checkAmbientInitializer(g, node);
  if (node.kind === SyntaxKind.PropertyDeclaration) {
    const property = node as PropertyDeclaration;
    const postfixToken = property.postfixToken;
    if (postfixToken !== undefined && postfixToken.kind === SyntaxKind.ExclamationToken) {
      if (property.initializer !== undefined)
        return grammarErrorOnNode(
          g,
          postfixToken,
          Diagnostics.Declarations_with_initializers_cannot_also_have_definite_assignment_assertions,
        );
      if (property.type === undefined)
        return grammarErrorOnNode(
          g,
          postfixToken,
          Diagnostics.Declarations_with_definite_assignment_assertions_must_also_have_type_annotations,
        );
      if (
        !isClassLike(parent) ||
        (node.flags & NodeFlags.Ambient) !== 0 ||
        isStatic(node) ||
        hasSyntacticModifier(node, ModifierFlags.Abstract)
      )
        return grammarErrorOnNode(
          g,
          postfixToken,
          Diagnostics.A_definite_assignment_assertion_is_not_permitted_in_this_context,
        );
    }
  }
  return false;
}

function checkAmbientInitializer(g: GrammarChecker, node: Node): boolean {
  const initializer = getInitializer(node);
  if (initializer === undefined) return false;
  const isInvalidInitializer = !(
    isInitializerStringOrNumberLiteralExpression(initializer) ||
    isInitializerSimpleLiteralEnumReference(g.c, initializer) ||
    initializer.kind === SyntaxKind.TrueKeyword ||
    initializer.kind === SyntaxKind.FalseKeyword ||
    isInitializerBigIntLiteralExpression(initializer)
  );
  const isConstOrReadonly =
    isDeclarationReadonly(node) || (node.kind === SyntaxKind.VariableDeclaration && isVarConstLike(node));
  if (!isConstOrReadonly || getType(node) !== undefined)
    return grammarErrorOnNode(g, initializer, Diagnostics.Initializers_are_not_allowed_in_ambient_contexts);
  if (isInvalidInitializer)
    return grammarErrorOnNode(
      g,
      initializer,
      Diagnostics.A_const_initializer_in_an_ambient_context_must_be_a_string_or_numeric_literal_or_literal_enum_reference,
    );
  return false;
}

function isDeclarationReadonly(node: Node): boolean {
  return (
    (getCombinedModifierFlags(node) & ModifierFlags.Readonly) !== 0 &&
    !(node.kind === SyntaxKind.Parameter && node.parent!.kind === SyntaxKind.Constructor)
  );
}

function isVarConstLike(node: Node): boolean {
  const blockScopeKind = getCombinedNodeFlags(node) & NodeFlags.BlockScoped;
  return (
    blockScopeKind === NodeFlags.Const || blockScopeKind === NodeFlags.Using || blockScopeKind === NodeFlags.AwaitUsing
  );
}

function isInitializerStringOrNumberLiteralExpression(expression: Node): boolean {
  switch (expression.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
      return true;
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = expression as PrefixUnaryExpression;
      return unary.operator === SyntaxKind.MinusToken && unary.operand.kind === SyntaxKind.NumericLiteral;
    }
  }
  return false;
}

function isInitializerBigIntLiteralExpression(expression: Node): boolean {
  if (expression.kind === SyntaxKind.BigIntLiteral) return true;
  if (expression.kind !== SyntaxKind.PrefixUnaryExpression) return false;
  const unary = expression as PrefixUnaryExpression;
  return unary.operator === SyntaxKind.MinusToken && unary.operand.kind === SyntaxKind.BigIntLiteral;
}

function isInitializerSimpleLiteralEnumReference(c: Checker, expression: Node): boolean {
  if (expression.kind === SyntaxKind.PropertyAccessExpression)
    return (checkExpressionCached(c, expression).flags & TypeFlags.EnumLike) !== 0;
  if (expression instanceof ElementAccessExpression)
    return (
      isInitializerStringOrNumberLiteralExpression(expression.argumentExpression) &&
      isEntityNameExpression(expression.expression, false) &&
      (checkExpressionCached(c, expression).flags & TypeFlags.EnumLike) !== 0
    );
  return false;
}

// ---- Statements

function checkGrammarStatementInAmbientContext(g: GrammarChecker, node: Node): boolean {
  if ((node.flags & NodeFlags.Ambient) === 0) return false;
  const parent = node.parent!;
  const id = getNodeId(node);
  if (!g.reportedAmbientStatements.has(id) && (isFunctionLike(parent) || isAccessor(parent))) {
    const reported = grammarErrorOnFirstToken(
      g,
      node,
      Diagnostics.An_implementation_cannot_be_declared_in_ambient_contexts,
    );
    if (reported) g.reportedAmbientStatements.add(id);
    return reported;
  }
  // Report once per block; statements nested in other statements are covered by their parent.
  if (
    parent.kind === SyntaxKind.Block ||
    parent.kind === SyntaxKind.ModuleBlock ||
    parent.kind === SyntaxKind.SourceFile
  ) {
    const parentId = getNodeId(parent);
    if (!g.reportedAmbientStatements.has(parentId)) {
      const reported = grammarErrorOnFirstToken(g, node, Diagnostics.Statements_are_not_allowed_in_ambient_contexts);
      if (reported) g.reportedAmbientStatements.add(parentId);
      return reported;
    }
  }
  return false;
}

function isAccessor(node: Node): boolean {
  return node.kind === SyntaxKind.GetAccessor || node.kind === SyntaxKind.SetAccessor;
}

function checkGrammarVariableStatement(g: GrammarChecker, node: VariableStatement): void {
  if (!checkGrammarModifiers(g, node) && !checkGrammarVariableDeclarationList(g, node.declarationList))
    checkGrammarForDisallowedBlockScopedVariableStatement(g, node);
}

function checkGrammarForDisallowedBlockScopedVariableStatement(g: GrammarChecker, node: VariableStatement): void {
  if (containerAllowsBlockScopedVariable(node.parent!)) return;
  const blockScopeKind = getCombinedNodeFlags(node.declarationList) & NodeFlags.BlockScoped;
  if (blockScopeKind === 0) return;
  let keyword: string;
  if (blockScopeKind === NodeFlags.Let) keyword = 'let';
  else if (blockScopeKind === NodeFlags.Const) keyword = 'const';
  else if (blockScopeKind === NodeFlags.Using) keyword = 'using';
  else keyword = 'await using';
  g.c.error(node, Diagnostics.X_0_declarations_can_only_be_declared_inside_a_block, keyword);
}

function containerAllowsBlockScopedVariable(parent: Node): boolean {
  switch (parent.kind) {
    case SyntaxKind.IfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return false;
    case SyntaxKind.LabeledStatement:
      return containerAllowsBlockScopedVariable(parent.parent!);
  }
  return true;
}

function checkGrammarVariableDeclarationList(g: GrammarChecker, list: VariableDeclarationList): boolean {
  const declarations = list.declarations;
  if (checkGrammarForDisallowedTrailingComma(g, declarations, Diagnostics.Trailing_comma_not_allowed)) return true;
  if (declarations.nodes.length === 0)
    return grammarErrorAtPos(
      g,
      declarations.pos,
      declarations.end - declarations.pos,
      Diagnostics.Variable_declaration_list_cannot_be_empty,
    );
  const blockScopeFlags = list.flags & NodeFlags.BlockScoped;
  const parent = list.parent!;
  if (blockScopeFlags === NodeFlags.Using || blockScopeFlags === NodeFlags.AwaitUsing) {
    const isUsing = blockScopeFlags === NodeFlags.Using;
    if (parent.kind === SyntaxKind.ForInStatement)
      return grammarErrorOnNode(
        g,
        list,
        isUsing
          ? Diagnostics.The_left_hand_side_of_a_for_in_statement_cannot_be_a_using_declaration
          : Diagnostics.The_left_hand_side_of_a_for_in_statement_cannot_be_an_await_using_declaration,
      );
    if ((list.flags & NodeFlags.Ambient) !== 0)
      return grammarErrorOnNode(
        g,
        list,
        isUsing
          ? Diagnostics.X_using_declarations_are_not_allowed_in_ambient_contexts
          : Diagnostics.X_await_using_declarations_are_not_allowed_in_ambient_contexts,
      );
    if (
      parent.kind === SyntaxKind.VariableStatement &&
      (parent.parent!.kind === SyntaxKind.CaseClause || parent.parent!.kind === SyntaxKind.DefaultClause)
    )
      return grammarErrorOnNode(
        g,
        list,
        isUsing
          ? Diagnostics.X_using_declarations_are_not_allowed_in_case_or_default_clauses_unless_contained_within_a_block
          : Diagnostics.X_await_using_declarations_are_not_allowed_in_case_or_default_clauses_unless_contained_within_a_block,
      );
  }
  if (blockScopeFlags === NodeFlags.AwaitUsing) return checkGrammarAwaitOrAwaitUsing(g, list);
  return false;
}

function checkGrammarVariableDeclaration(g: GrammarChecker, node: VariableDeclaration): boolean {
  const nodeFlags = getCombinedNodeFlags(node);
  const blockScopeKind = nodeFlags & NodeFlags.BlockScoped;
  const name = node.name;
  if (isBindingPattern(name)) {
    if (blockScopeKind === NodeFlags.AwaitUsing)
      return grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_may_not_have_binding_patterns, 'await using');
    if (blockScopeKind === NodeFlags.Using)
      return grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_may_not_have_binding_patterns, 'using');
  }
  const statement = node.parent!.parent!;
  if (statement.kind !== SyntaxKind.ForInStatement && statement.kind !== SyntaxKind.ForOfStatement) {
    if ((nodeFlags & NodeFlags.Ambient) !== 0) checkAmbientInitializer(g, node);
    else if (node.initializer === undefined) {
      if (isBindingPattern(name) && !isBindingPattern(node.parent))
        return grammarErrorOnNode(g, node, Diagnostics.A_destructuring_declaration_must_have_an_initializer);
      if (blockScopeKind === NodeFlags.AwaitUsing)
        return grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_must_be_initialized, 'await using');
      if (blockScopeKind === NodeFlags.Using)
        return grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_must_be_initialized, 'using');
      if (blockScopeKind === NodeFlags.Const)
        return grammarErrorOnNode(g, node, Diagnostics.X_0_declarations_must_be_initialized, 'const');
    }
  }
  const exclamationToken = node.exclamationToken;
  if (
    exclamationToken !== undefined &&
    (statement.kind !== SyntaxKind.VariableStatement ||
      node.type === undefined ||
      node.initializer !== undefined ||
      (nodeFlags & NodeFlags.Ambient) !== 0)
  ) {
    const message =
      node.initializer !== undefined
        ? Diagnostics.Declarations_with_initializers_cannot_also_have_definite_assignment_assertions
        : node.type === undefined
          ? Diagnostics.Declarations_with_definite_assignment_assertions_must_also_have_type_annotations
          : Diagnostics.A_definite_assignment_assertion_is_not_permitted_in_this_context;
    return grammarErrorOnNode(g, exclamationToken, message);
  }
  if (
    getEmitModuleFormat(g) < ModuleKind.System &&
    (statement.flags & NodeFlags.Ambient) === 0 &&
    hasSyntacticModifier(statement, ModifierFlags.Export)
  )
    checkGrammarForEsModuleMarkerInBindingName(g, name);
  // `let` can't be a name in `let` or `const` declarations.
  return blockScopeKind !== 0 && checkGrammarNameInLetOrConstDeclarations(g, name);
}

function checkGrammarForEsModuleMarkerInBindingName(g: GrammarChecker, name: Node): boolean {
  if (name instanceof Identifier)
    return (
      name.text === '__esModule' &&
      grammarErrorOnNode(
        g,
        name,
        Diagnostics.Identifier_expected_esModule_is_reserved_as_an_exported_marker_when_transforming_ECMAScript_modules,
      )
    );
  for (const element of getElements(name)!.nodes) {
    const elementName = getName(element);
    if (elementName !== undefined) return checkGrammarForEsModuleMarkerInBindingName(g, elementName);
  }
  return false;
}

function checkGrammarNameInLetOrConstDeclarations(g: GrammarChecker, name: Node): boolean {
  if (name instanceof Identifier) {
    const identifier: Identifier = name;
    if (identifier.text === 'let')
      return grammarErrorOnNode(
        g,
        name,
        Diagnostics.X_let_is_not_allowed_to_be_used_as_a_name_in_let_or_const_declarations,
      );
    return false;
  }
  for (const element of getElements(name)!.nodes) {
    const elementName = getName(element);
    if (elementName !== undefined) checkGrammarNameInLetOrConstDeclarations(g, elementName);
  }
  return false;
}

function checkGrammarBindingElement(g: GrammarChecker, node: BindingElement): boolean {
  if (node.dotDotDotToken !== undefined) {
    const elements = getElements(node.parent!)!;
    if (node !== elements.nodes[elements.nodes.length - 1]!)
      return grammarErrorOnNode(g, node, Diagnostics.A_rest_element_must_be_last_in_a_destructuring_pattern);
    checkGrammarForDisallowedTrailingComma(
      g,
      elements,
      Diagnostics.A_rest_parameter_or_binding_pattern_may_not_have_a_trailing_comma,
    );
    if (node.propertyName !== undefined)
      return grammarErrorOnNode(g, node.name!, Diagnostics.A_rest_element_cannot_have_a_property_name);
    // Report on the `=` before the initializer.
    if (node.initializer !== undefined)
      return grammarErrorAtPos(g, node.initializer.pos - 1, 1, Diagnostics.A_rest_element_cannot_have_an_initializer);
  }
  return false;
}

function checkGrammarForInOrForOfStatement(g: GrammarChecker, node: ForInOrOfStatement): boolean {
  checkGrammarForInOrForOfStatementWorker(g, node);
  // `checkForOfStatement` reports `for await` in static blocks after the statement's grammar.
  const awaitModifier = node.awaitModifier;
  if (node.kind === SyntaxKind.ForOfStatement && awaitModifier !== undefined) {
    const container = getContainingFunctionOrClassStaticBlock(node);
    if (container !== undefined && container.kind === SyntaxKind.ClassStaticBlockDeclaration)
      grammarErrorOnNode(g, awaitModifier, Diagnostics.X_for_await_loops_cannot_be_used_inside_a_class_static_block);
  }
  return false;
}

function checkGrammarForInOrForOfStatementWorker(g: GrammarChecker, node: ForInOrOfStatement): boolean {
  if (checkGrammarStatementInAmbientContext(g, node)) return true;
  const awaitModifier = node.awaitModifier;
  if (
    node.kind === SyntaxKind.ForOfStatement &&
    awaitModifier !== undefined &&
    (node.flags & NodeFlags.AwaitContext) === 0
  ) {
    if (isInTopLevelContext(node)) {
      if (!g.hasParseErrors) {
        if (!isEffectiveExternalModule(g))
          g.c.addDiagnostic(
            createDiagnosticForNode(
              awaitModifier,
              Diagnostics.X_for_await_loops_are_only_allowed_at_the_top_level_of_a_file_when_that_file_is_a_module_but_this_file_has_no_imports_or_exports_Consider_adding_an_empty_export_to_make_this_file_a_module,
              [],
            ),
          );
        const kind = checkTopLevelAwaitModule(g);
        if (kind === TopLevelAwaitSupport.CommonJS)
          g.c.addDiagnostic(
            createDiagnosticForNode(
              awaitModifier,
              Diagnostics.The_current_file_is_a_CommonJS_module_and_cannot_use_await_at_the_top_level,
              [],
            ),
          );
        else if (kind === TopLevelAwaitSupport.Unsupported)
          g.c.addDiagnostic(
            createDiagnosticForNode(
              awaitModifier,
              Diagnostics.Top_level_for_await_loops_are_only_allowed_when_the_module_option_is_set_to_es2022_esnext_system_node16_node18_node20_nodenext_or_preserve_and_the_target_option_is_set_to_es2017_or_higher,
              [],
            ),
          );
      }
    } else if (!g.hasParseErrors) {
      // `for await` in a function that isn't async.
      const diagnostic = createDiagnosticForNode(
        awaitModifier,
        Diagnostics.X_for_await_loops_are_only_allowed_within_async_functions_and_at_the_top_levels_of_modules,
        [],
      );
      const containingFunction = getContainingFunction(node);
      if (containingFunction !== undefined && containingFunction.kind !== SyntaxKind.Constructor)
        addRelated(diagnostic, containingFunction, Diagnostics.Did_you_mean_to_mark_this_function_as_async);
      g.c.addDiagnostic(diagnostic);
      return true;
    }
  }
  const initializer = node.initializer;
  if (
    node.kind === SyntaxKind.ForOfStatement &&
    (node.flags & NodeFlags.AwaitContext) === 0 &&
    initializer instanceof Identifier &&
    initializer.text === 'async'
  ) {
    grammarErrorOnNode(g, initializer, Diagnostics.The_left_hand_side_of_a_for_of_statement_may_not_be_async);
    return false;
  }
  if (initializer.kind !== SyntaxKind.VariableDeclarationList) return false;
  const list = initializer as VariableDeclarationList;
  if (checkGrammarVariableDeclarationList(g, list)) return false;
  // Declarations can be empty after a parse error, as in `for (let of x)`.
  const declarations = list.declarations.nodes;
  if (declarations.length === 0) return false;
  const isForIn = node.kind === SyntaxKind.ForInStatement;
  if (declarations.length > 1)
    return grammarErrorOnFirstToken(
      g,
      declarations[1]!,
      isForIn
        ? Diagnostics.Only_a_single_variable_declaration_is_allowed_in_a_for_in_statement
        : Diagnostics.Only_a_single_variable_declaration_is_allowed_in_a_for_of_statement,
    );
  const first = declarations[0]! as VariableDeclaration;
  if (first.initializer !== undefined)
    return grammarErrorOnNode(
      g,
      first.name,
      isForIn
        ? Diagnostics.The_variable_declaration_of_a_for_in_statement_cannot_have_an_initializer
        : Diagnostics.The_variable_declaration_of_a_for_of_statement_cannot_have_an_initializer,
    );
  if (first.type !== undefined)
    return grammarErrorOnNode(
      g,
      first,
      isForIn
        ? Diagnostics.The_left_hand_side_of_a_for_in_statement_cannot_use_a_type_annotation
        : Diagnostics.The_left_hand_side_of_a_for_of_statement_cannot_use_a_type_annotation,
    );
  return false;
}

const enum TopLevelAwaitSupport {
  Supported,
  CommonJS,
  Unsupported,
}

/** Whether the module and target options allow top-level `await`. */
function checkTopLevelAwaitModule(g: GrammarChecker): TopLevelAwaitSupport {
  const moduleKind = g.moduleKind;
  if (moduleKind >= ModuleKind.Node16 && moduleKind <= ModuleKind.NodeNext) {
    if (g.metadata.impliedNodeFormat === ModuleKind.CommonJS) return TopLevelAwaitSupport.CommonJS;
  } else if (
    moduleKind !== ModuleKind.ES2022 &&
    moduleKind !== ModuleKind.ESNext &&
    moduleKind !== ModuleKind.Preserve &&
    moduleKind !== ModuleKind.System
  )
    return TopLevelAwaitSupport.Unsupported;
  return g.c.languageVersion >= ScriptTarget.ES2017 ? TopLevelAwaitSupport.Supported : TopLevelAwaitSupport.Unsupported;
}

function checkGrammarBreakOrContinueStatement(g: GrammarChecker, node: Node): boolean {
  const targetLabel = getLabel(node);
  const isBreak = node.kind === SyntaxKind.BreakStatement;
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    if (isFunctionLike(current) || current.kind === SyntaxKind.ClassStaticBlockDeclaration)
      return grammarErrorOnNode(g, node, Diagnostics.Jump_target_cannot_cross_function_boundary);
    if (current.kind === SyntaxKind.LabeledStatement) {
      const labeled = current as LabeledStatement;
      if (targetLabel !== undefined && labeled.label.text === getText(targetLabel)) {
        // `continue` can only target labels of iteration statements.
        if (!isBreak && !isIterationStatement(labeled.statement, true))
          return grammarErrorOnNode(
            g,
            node,
            Diagnostics.A_continue_statement_can_only_jump_to_a_label_of_an_enclosing_iteration_statement,
          );
        return false;
      }
    } else if (current.kind === SyntaxKind.SwitchStatement) {
      if (isBreak && targetLabel === undefined) return false;
    } else if (isIterationStatement(current, false) && targetLabel === undefined) {
      return false;
    }
  }
  if (targetLabel !== undefined)
    return grammarErrorOnNode(
      g,
      node,
      isBreak
        ? Diagnostics.A_break_statement_can_only_jump_to_a_label_of_an_enclosing_statement
        : Diagnostics.A_continue_statement_can_only_jump_to_a_label_of_an_enclosing_iteration_statement,
    );
  return grammarErrorOnNode(
    g,
    node,
    isBreak
      ? Diagnostics.A_break_statement_can_only_be_used_within_an_enclosing_iteration_or_switch_statement
      : Diagnostics.A_continue_statement_can_only_be_used_within_an_enclosing_iteration_statement,
  );
}

function isIterationStatement(node: Node, lookInLabeledStatements: boolean): boolean {
  switch (node.kind) {
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
      return true;
    case SyntaxKind.LabeledStatement:
      return lookInLabeledStatements && isIterationStatement((node as LabeledStatement).statement, true);
  }
  return false;
}

/** Returns whether the statement's expression is checked. */
function checkGrammarReturnStatement(g: GrammarChecker, node: Node): boolean {
  if (checkGrammarStatementInAmbientContext(g, node)) return false;
  const container = getContainingFunctionOrClassStaticBlock(node);
  if (container !== undefined && container.kind === SyntaxKind.ClassStaticBlockDeclaration) {
    grammarErrorOnFirstToken(g, node, Diagnostics.A_return_statement_cannot_be_used_inside_a_class_static_block);
    return false;
  }
  if (container === undefined) {
    grammarErrorOnFirstToken(g, node, Diagnostics.A_return_statement_can_only_be_used_within_a_function_body);
    return false;
  }
  return true;
}

function checkGrammarWithStatement(g: GrammarChecker, node: WithStatement): void {
  if (!checkGrammarStatementInAmbientContext(g, node) && (node.flags & NodeFlags.AwaitContext) !== 0)
    grammarErrorOnFirstToken(g, node, Diagnostics.X_with_statements_are_not_allowed_in_an_async_function_block);
  // The body of a `with` statement isn't checked.
  g.visitNode(node.expression);
  const start = skipTrivia(g.file.text, node.pos);
  grammarErrorAtPos(
    g,
    start,
    node.statement.pos - start,
    Diagnostics.The_with_statement_is_not_supported_All_symbols_in_a_with_block_will_have_type_any,
  );
}

function checkGrammarSwitchStatement(g: GrammarChecker, node: SwitchStatement): void {
  checkGrammarStatementInAmbientContext(g, node);
  let seenDefaultClause = false;
  for (const clause of node.caseBlock.clauses.nodes) {
    if (clause.kind !== SyntaxKind.DefaultClause) continue;
    if (!seenDefaultClause) seenDefaultClause = true;
    else {
      grammarErrorOnNode(g, clause, Diagnostics.A_default_clause_cannot_appear_more_than_once_in_a_switch_statement);
      return;
    }
  }
}

function checkGrammarLabeledStatement(g: GrammarChecker, node: LabeledStatement): void {
  if (checkGrammarStatementInAmbientContext(g, node)) return;
  const label = node.label;
  for (let current = node.parent; current !== undefined && !isFunctionLike(current); current = current.parent)
    if (current.kind === SyntaxKind.LabeledStatement && (current as LabeledStatement).label.text === label.text) {
      grammarErrorOnNode(g, label, Diagnostics.Duplicate_label_0, label.text);
      return;
    }
}

function checkGrammarCatchClause(g: GrammarChecker, node: CatchClause): void {
  const declaration = node.variableDeclaration;
  if (declaration === undefined) return;
  const typeNode = declaration.type;
  if (typeNode !== undefined) {
    const t = getTypeFromTypeNode(g.c, typeNode);
    if ((t.flags & TypeFlags.AnyOrUnknown) === 0)
      grammarErrorOnFirstToken(
        g,
        typeNode,
        Diagnostics.Catch_clause_variable_type_annotation_must_be_any_or_unknown_if_specified,
      );
  } else if (declaration.initializer !== undefined) {
    grammarErrorOnFirstToken(g, declaration.initializer, Diagnostics.Catch_clause_variable_cannot_have_an_initializer);
  } else {
    const blockLocals = getLocals(node.block);
    const locals = getLocals(node);
    if (blockLocals === undefined || locals === undefined) return;
    for (const caughtName of locals.keys()) {
      const blockLocal = blockLocals.get(caughtName);
      if (
        blockLocal !== undefined &&
        blockLocal.valueDeclaration !== undefined &&
        (blockLocal.flags & SymbolFlags.BlockScopedVariable) !== 0
      )
        grammarErrorOnNode(
          g,
          blockLocal.valueDeclaration,
          Diagnostics.Cannot_redeclare_identifier_0_in_catch_clause,
          caughtName,
        );
    }
  }
}

function getContainingFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined && !isFunctionLike(current)) current = current.parent;
  return current;
}

export function getContainingFunctionOrClassStaticBlock(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined && !isFunctionLike(current) && current.kind !== SyntaxKind.ClassStaticBlockDeclaration)
    current = current.parent;
  return current;
}

// ---- Modules, imports and exports

function checkGrammarTopLevelElementsForRequiredDeclareModifier(g: GrammarChecker, file: SourceFile): boolean {
  for (const statement of file.statements.nodes) {
    if (!isDeclarationNode(statement) && statement.kind !== SyntaxKind.VariableStatement) continue;
    // Everything but interfaces, type aliases, imports and exports needs `declare` or `export`.
    switch (statement.kind) {
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ExportAssignment:
      case SyntaxKind.NamespaceExportDeclaration:
        continue;
    }
    if (hasSyntacticModifier(statement, ModifierFlags.Ambient | ModifierFlags.Export | ModifierFlags.Default)) continue;
    if (
      grammarErrorOnFirstToken(
        g,
        statement,
        Diagnostics.Top_level_declarations_in_d_ts_files_must_start_with_either_a_declare_or_export_modifier,
      )
    )
      return true;
  }
  return false;
}

function checkGrammarModuleElementContext(g: GrammarChecker, node: Node, message: DiagnosticMessage): boolean {
  const parent = node.parent!;
  const isInAppropriateContext =
    parent.kind === SyntaxKind.SourceFile ||
    parent.kind === SyntaxKind.ModuleBlock ||
    parent.kind === SyntaxKind.ModuleDeclaration;
  if (!isInAppropriateContext) grammarErrorOnFirstToken(g, node, message);
  return !isInAppropriateContext;
}

/** An ambient module's import attributes type: property signatures with string literal types, each required,
 * not readonly, named by an identifier or a string other than `resolution-mode`. */
function checkGrammarImportAttributesType(g: GrammarChecker, attributes: TypeLiteralNode): boolean {
  for (const member of attributes.members.nodes) {
    if (member.kind !== SyntaxKind.PropertySignature)
      return grammarErrorOnNode(g, member, Diagnostics.An_import_attributes_type_may_only_contain_property_signatures);
    const property = member as PropertySignatureDeclaration;
    for (const modifier of property.modifiers?.nodes ?? [])
      if (modifier.kind === SyntaxKind.ReadonlyKeyword)
        return grammarErrorOnNode(
          g,
          modifier,
          Diagnostics.An_import_attributes_property_cannot_have_a_readonly_modifier,
        );
    if (property.type === undefined)
      return grammarErrorOnNode(g, member, Diagnostics.An_import_attributes_property_must_have_a_type_annotation);
    if (property.postfixToken?.kind === SyntaxKind.QuestionToken)
      return grammarErrorOnNode(g, member, Diagnostics.An_import_attributes_property_cannot_be_optional);
    const name = property.name;
    if (!isStringLiteralLike(name) && name.kind !== SyntaxKind.Identifier)
      return grammarErrorOnNode(
        g,
        name,
        Diagnostics.An_import_attributes_property_must_have_a_string_literal_or_identifier_name,
      );
    if (getText(name) === 'resolution-mode')
      return grammarErrorOnNode(
        g,
        name,
        Diagnostics.X_0_is_not_a_valid_key_for_an_import_attributes_type,
        getText(name),
      );
    const type = property.type;
    if (type.kind !== SyntaxKind.LiteralType || (type as LiteralTypeNode).literal.kind !== SyntaxKind.StringLiteral)
      return grammarErrorOnNode(
        g,
        type,
        Diagnostics.An_import_attributes_property_must_have_a_string_literal_type_annotation,
      );
  }
  return false;
}

function checkGrammarModuleDeclaration(g: GrammarChecker, node: ModuleDeclaration): boolean {
  if (node.attributes !== undefined) checkGrammarImportAttributesType(g, node.attributes);
  // The declaration check reports an illegal context and skips the rest.
  const parent = node.parent!.kind;
  if (parent !== SyntaxKind.SourceFile && parent !== SyntaxKind.ModuleBlock && parent !== SyntaxKind.ModuleDeclaration)
    return true;
  if (
    !checkGrammarModifiers(g, node) &&
    (node.flags & NodeFlags.Ambient) === 0 &&
    node.name.kind === SyntaxKind.StringLiteral
  )
    grammarErrorOnNode(g, node.name, Diagnostics.Only_ambient_modules_can_use_quoted_names);
  return true;
}

/** Checks an import or export with a module specifier; reports and returns `false` if it is invalid. */
function checkExternalImportOrExportDeclaration(g: GrammarChecker, node: Node): boolean {
  const moduleName = getExternalModuleName(node);
  // A missing name is a parse error.
  if (moduleName === undefined || moduleName.pos === moduleName.end) return false;
  if (moduleName.kind !== SyntaxKind.StringLiteral) {
    g.c.error(moduleName, Diagnostics.String_literal_expected);
    return false;
  }
  const parent = node.parent!;
  const inAmbientExternalModule = parent.kind === SyntaxKind.ModuleBlock && isAmbientModule(parent.parent!);
  if (parent.kind !== SyntaxKind.SourceFile && !inAmbientExternalModule) {
    g.c.error(
      moduleName,
      node.kind === SyntaxKind.ExportDeclaration
        ? Diagnostics.Export_declarations_are_not_permitted_in_a_namespace
        : Diagnostics.Import_declarations_in_a_namespace_cannot_reference_a_module,
    );
    return false;
  }
  if (
    inAmbientExternalModule &&
    isExternalModuleNameRelative((moduleName as StringLiteral).text) &&
    !isModuleAugmentationExternal(parent.parent!)
  ) {
    // Module augmentations report relative names when checking the augmentation.
    g.c.error(
      node,
      Diagnostics.Import_or_export_declaration_in_an_ambient_module_declaration_cannot_reference_module_through_relative_module_name,
    );
    return false;
  }
  if (node.kind === SyntaxKind.ImportEqualsDeclaration) return true;
  const attributes = getImportAttributes(node);
  if (attributes === undefined) return true;
  let hasError = false;
  for (const attribute of attributes.attributes.nodes) {
    const value = (attribute as ImportAttribute).value;
    if (value.kind !== SyntaxKind.StringLiteral) {
      hasError = true;
      g.c.error(value, Diagnostics.Import_attribute_values_must_be_string_literal_expressions);
    }
  }
  return !hasError;
}

function getImportAttributes(node: Node): ImportAttributes | undefined {
  if (node.kind === SyntaxKind.ImportDeclaration || node.kind === SyntaxKind.JSImportDeclaration)
    return (node as ImportDeclaration).attributes;
  if (node.kind === SyntaxKind.ExportDeclaration) return (node as ExportDeclaration).attributes;
  if (node.kind === SyntaxKind.ImportType) return (node as ImportTypeNode).attributes;
  return undefined;
}

function checkGrammarImportDeclaration(g: GrammarChecker, node: ImportDeclaration): void {
  if (
    checkGrammarModuleElementContext(
      g,
      node,
      isInJSFile(node)
        ? Diagnostics.An_import_declaration_can_only_be_used_at_the_top_level_of_a_module
        : Diagnostics.An_import_declaration_can_only_be_used_at_the_top_level_of_a_namespace_or_module,
    )
  )
    return;
  if (!checkGrammarModifiers(g, node) && node.modifiers !== undefined)
    grammarErrorOnFirstToken(g, node, Diagnostics.An_import_declaration_cannot_have_modifiers);
  const clause = node.importClause;
  if (checkExternalImportOrExportDeclaration(g, node) && clause !== undefined) checkGrammarImportClause(g, clause);
  checkGrammarImportAttributes(g, node);
}

function checkGrammarImportClause(g: GrammarChecker, node: ImportClause): boolean {
  const namedBindings = node.namedBindings;
  if (node.phaseModifier === SyntaxKind.TypeKeyword) {
    if ((node.flags & NodeFlags.JSDoc) === 0 && node.name !== undefined && namedBindings !== undefined)
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.A_type_only_import_can_specify_a_default_import_or_named_bindings_but_not_both,
      );
    if (namedBindings !== undefined && namedBindings.kind === SyntaxKind.NamedImports)
      return checkGrammarTypeOnlyNamedImportsOrExports(g, namedBindings);
  } else if (node.phaseModifier === SyntaxKind.DeferKeyword) {
    if (node.name !== undefined)
      return grammarErrorOnNode(g, node, Diagnostics.Default_imports_are_not_allowed_in_a_deferred_import);
    if (namedBindings === undefined)
      return grammarErrorOnNode(g, node, Diagnostics.A_deferred_import_must_specify_a_namespace_binding);
    if (namedBindings.kind === SyntaxKind.NamedImports)
      return grammarErrorOnNode(g, node, Diagnostics.Named_imports_are_not_allowed_in_a_deferred_import);
    if (!supportsDeferredImports(g.moduleKind))
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.Deferred_imports_are_only_supported_when_the_module_flag_is_set_to_esnext_or_preserve,
      );
  } else if (node.phaseModifier === SyntaxKind.SourceKeyword) {
    if (namedBindings !== undefined)
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.Named_and_namespace_imports_are_not_allowed_in_a_source_phase_import,
      );
    if (node.name === undefined)
      return grammarErrorOnNode(g, node, Diagnostics.A_source_phase_import_must_specify_a_local_binding);
    if (!supportsSourcePhaseImports(g.moduleKind))
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.Source_phase_imports_are_only_supported_when_the_module_option_is_set_to_esnext_nodenext_or_preserve,
      );
    const moduleSpecifier = (node.parent as ImportDeclaration).moduleSpecifier;
    if (getEmitSyntaxForModuleSpecifierExpression(g.c, moduleSpecifier) === ModuleKind.CommonJS)
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.Source_phase_imports_are_not_allowed_on_statements_that_compile_to_CommonJS_require_calls,
      );
  }
  return false;
}

function checkGrammarTypeOnlyNamedImportsOrExports(g: GrammarChecker, namedBindings: Node): boolean {
  const isImport = namedBindings.kind === SyntaxKind.NamedImports;
  for (const specifier of getElements(namedBindings)!.nodes)
    if (getIsTypeOnly(specifier))
      return grammarErrorOnFirstToken(
        g,
        specifier,
        isImport
          ? Diagnostics.The_type_modifier_cannot_be_used_on_a_named_import_when_import_type_is_used_on_its_import_statement
          : Diagnostics.The_type_modifier_cannot_be_used_on_a_named_export_when_export_type_is_used_on_its_export_statement,
      );
  return false;
}

function checkGrammarImportEqualsDeclaration(g: GrammarChecker, node: ImportEqualsDeclaration): void {
  if (
    checkGrammarModuleElementContext(
      g,
      node,
      isInJSFile(node)
        ? Diagnostics.An_import_declaration_can_only_be_used_at_the_top_level_of_a_module
        : Diagnostics.An_import_declaration_can_only_be_used_at_the_top_level_of_a_namespace_or_module,
    )
  )
    return;
  checkGrammarModifiers(g, node);
  const isExternal = node.moduleReference.kind === SyntaxKind.ExternalModuleReference;
  if (!isExternal) {
    if (node.isTypeOnly) {
      const symbol = getSymbolOfDeclaration(g.c, node);
      if (symbol !== undefined && resolveAlias(g.c, symbol) !== g.c.unknownSymbol)
        grammarErrorOnNode(g, node, Diagnostics.An_import_alias_cannot_use_import_type);
    }
    return;
  }
  if (
    checkExternalImportOrExportDeclaration(g, node) &&
    g.moduleKind >= ModuleKind.ES2015 &&
    g.moduleKind <= ModuleKind.ESNext &&
    !node.isTypeOnly &&
    (node.flags & NodeFlags.Ambient) === 0
  )
    // Import assignments can't be emitted as ECMAScript modules.
    grammarErrorOnNode(
      g,
      node,
      Diagnostics.Import_assignment_cannot_be_used_when_targeting_ECMAScript_modules_Consider_using_import_Asterisk_as_ns_from_mod_import_a_from_mod_import_d_from_mod_or_another_module_format_instead,
    );
}

function checkGrammarExportDeclaration(g: GrammarChecker, node: ExportDeclaration): void {
  if (
    checkGrammarModuleElementContext(
      g,
      node,
      Diagnostics.An_export_declaration_can_only_be_used_at_the_top_level_of_a_namespace_or_module,
    )
  )
    return;
  if (!checkGrammarModifiers(g, node) && node.modifiers !== undefined)
    grammarErrorOnFirstToken(g, node, Diagnostics.An_export_declaration_cannot_have_modifiers);
  const clause = node.exportClause;
  if (node.isTypeOnly && clause !== undefined && clause.kind === SyntaxKind.NamedExports)
    checkGrammarTypeOnlyNamedImportsOrExports(g, clause);
  const hasModuleSpecifier = node.moduleSpecifier !== undefined;
  if (
    (!hasModuleSpecifier || checkExternalImportOrExportDeclaration(g, node)) &&
    clause !== undefined &&
    clause.kind === SyntaxKind.NamedExports
  ) {
    for (const specifier of getElements(clause)!.nodes) {
      checkGrammarModuleExportName(g, (specifier as ExportSpecifier).propertyName, hasModuleSpecifier);
      checkGrammarModuleExportName(g, (specifier as ExportSpecifier).name, true);
    }
    const parent = node.parent!;
    const inAmbientExternalModule = parent.kind === SyntaxKind.ModuleBlock && isAmbientModule(parent.parent!);
    const inAmbientNamespaceDeclaration =
      !inAmbientExternalModule &&
      parent.kind === SyntaxKind.ModuleBlock &&
      !hasModuleSpecifier &&
      (node.flags & NodeFlags.Ambient) !== 0;
    if (parent.kind !== SyntaxKind.SourceFile && !inAmbientExternalModule && !inAmbientNamespaceDeclaration)
      g.c.error(node, Diagnostics.Export_declarations_are_not_permitted_in_a_namespace);
  }
  checkGrammarImportAttributes(g, node);
}

function checkGrammarModuleExportName(g: GrammarChecker, name: Node | undefined, allowStringLiteral: boolean): void {
  if (name === undefined || name.kind !== SyntaxKind.StringLiteral) return;
  if (!allowStringLiteral) grammarErrorOnNode(g, name, Diagnostics.Identifier_expected);
  else if ((g.moduleKind === ModuleKind.ES2015 || g.moduleKind === ModuleKind.ES2020) && !g.file.isDeclarationFile)
    grammarErrorOnNode(
      g,
      name,
      Diagnostics.String_literal_import_and_export_names_are_not_supported_when_the_module_flag_is_set_to_es2015_or_es2020,
    );
}

/** Returns whether the export's expression is checked. */
function checkGrammarExportAssignment(g: GrammarChecker, node: ExportAssignment): boolean {
  const isExportEquals = node.isExportEquals;
  if (
    checkGrammarModuleElementContext(
      g,
      node,
      isExportEquals
        ? Diagnostics.An_export_assignment_must_be_at_the_top_level_of_a_file_or_module_declaration
        : Diagnostics.A_default_export_must_be_at_the_top_level_of_a_file_or_module_declaration,
    )
  )
    return false;
  const parent = node.parent!;
  const container = parent.kind === SyntaxKind.SourceFile ? parent : parent.parent!;
  if (container.kind === SyntaxKind.ModuleDeclaration && !isAmbientModule(container)) {
    g.c.error(
      node,
      isExportEquals
        ? Diagnostics.An_export_assignment_cannot_be_used_in_a_namespace
        : Diagnostics.A_default_export_can_only_be_used_in_an_ECMAScript_style_module,
    );
    return false;
  }
  if (!checkGrammarModifiers(g, node) && node.modifiers !== undefined)
    grammarErrorOnFirstToken(g, node, Diagnostics.An_export_assignment_cannot_have_modifiers);
  const isAmbient = (node.flags & NodeFlags.Ambient) !== 0;
  if (isAmbient && !isEntityNameExpression(node.expression, false))
    grammarErrorOnNode(
      g,
      node.expression,
      Diagnostics.The_expression_of_an_export_assignment_must_be_an_identifier_or_qualified_name_in_an_ambient_context,
    );
  if (isExportEquals) {
    const impliedFormat = getImpliedNodeFormatForEmit(g.file.fileName, g.moduleKind, g.metadata);
    // Export assignments aren't supported in ECMAScript modules.
    if (
      g.moduleKind >= ModuleKind.ES2015 &&
      g.moduleKind !== ModuleKind.Preserve &&
      (isAmbient ? impliedFormat === ModuleKind.ESNext : impliedFormat !== ModuleKind.CommonJS)
    )
      grammarErrorOnNode(
        g,
        node,
        Diagnostics.Export_assignment_cannot_be_used_when_targeting_ECMAScript_modules_Consider_using_export_default_or_another_module_format_instead,
      );
    else if (g.moduleKind === ModuleKind.System && !isAmbient)
      grammarErrorOnNode(g, node, Diagnostics.Export_assignment_is_not_supported_when_module_flag_is_system);
  }
  return true;
}

function getEmitModuleFormat(g: GrammarChecker): ModuleKind {
  return getEmitModuleFormatOfFile(g.file.fileName, g.c.compilerOptions, g.metadata);
}

function isEffectiveExternalModule(g: GrammarChecker): boolean {
  if (isExternalModule(g.file)) return true;
  const moduleKind = g.moduleKind;
  const commonJSContaining =
    moduleKind === ModuleKind.CommonJS || (moduleKind >= ModuleKind.Node16 && moduleKind <= ModuleKind.NodeNext);
  return commonJSContaining && g.file.commonJSModuleIndicator !== undefined;
}

// ---- Type nodes

function checkGrammarTypeReference(g: GrammarChecker, node: TypeReferenceNode): void {
  checkGrammarTypeArguments(g, node.typeArguments);
  const typeArguments = node.typeArguments;
  if ((node.flags & NodeFlags.JSDoc) !== 0 || typeArguments === undefined || node.typeName.end === typeArguments.pos)
    return;
  // `Foo.<T>` is JSDoc syntax. A token starting with `<`, as in `Foo<T>`, is not a dot, which
  // saves creating a scanner over the file.
  if (g.file.text.charCodeAt(node.typeName.end) === CharacterCodes.lessThan) return;
  const scanner = g.getScanner();
  scanner.resetTokenState(node.typeName.end);
  if (scanner.scan() === SyntaxKind.DotToken)
    grammarErrorAtPos(
      g,
      skipTrivia(g.file.text, node.typeName.end),
      1,
      Diagnostics.JSDoc_types_can_only_be_used_inside_documentation_comments,
    );
}

function checkGrammarTypeOperatorNode(g: GrammarChecker, node: TypeOperatorNode): boolean {
  const innerType = node.type;
  if (node.operator === SyntaxKind.UniqueKeyword) {
    if (innerType.kind !== SyntaxKind.SymbolKeyword)
      return grammarErrorOnNode(g, innerType, Diagnostics.X_0_expected, tokenToString(SyntaxKind.SymbolKeyword));
    let parent = node.parent!;
    while (parent.kind === SyntaxKind.ParenthesizedType) parent = parent.parent!;
    switch (parent.kind) {
      case SyntaxKind.VariableDeclaration: {
        const declaration = parent as VariableDeclaration;
        if (declaration.name.kind !== SyntaxKind.Identifier)
          return grammarErrorOnNode(
            g,
            node,
            Diagnostics.X_unique_symbol_types_may_not_be_used_on_a_variable_declaration_with_a_binding_name,
          );
        if (
          !(
            declaration.parent!.kind === SyntaxKind.VariableDeclarationList &&
            declaration.parent!.parent!.kind === SyntaxKind.VariableStatement
          )
        )
          return grammarErrorOnNode(
            g,
            node,
            Diagnostics.X_unique_symbol_types_are_only_allowed_on_variables_in_a_variable_statement,
          );
        if ((declaration.parent!.flags & NodeFlags.Const) === 0)
          return grammarErrorOnNode(
            g,
            declaration.name,
            Diagnostics.A_variable_whose_type_is_a_unique_symbol_type_must_be_const,
          );
        return false;
      }
      case SyntaxKind.PropertyDeclaration:
        if (!isStatic(parent) || !hasSyntacticModifier(parent, ModifierFlags.Readonly))
          return grammarErrorOnNode(
            g,
            getName(parent)!,
            Diagnostics.A_property_of_a_class_whose_type_is_a_unique_symbol_type_must_be_both_static_and_readonly,
          );
        return false;
      case SyntaxKind.PropertySignature:
        if (!hasSyntacticModifier(parent, ModifierFlags.Readonly))
          return grammarErrorOnNode(
            g,
            getName(parent)!,
            Diagnostics.A_property_of_an_interface_or_type_literal_whose_type_is_a_unique_symbol_type_must_be_readonly,
          );
        return false;
    }
    return grammarErrorOnNode(g, node, Diagnostics.X_unique_symbol_types_are_not_allowed_here);
  }
  if (
    node.operator === SyntaxKind.ReadonlyKeyword &&
    innerType.kind !== SyntaxKind.ArrayType &&
    innerType.kind !== SyntaxKind.TupleType
  )
    return grammarErrorOnFirstToken(
      g,
      node,
      Diagnostics.X_readonly_type_modifier_is_only_permitted_on_array_and_tuple_literal_types,
      tokenToString(SyntaxKind.SymbolKeyword),
    );
  return false;
}

function checkGrammarInferType(g: GrammarChecker, node: Node): void {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    const parent: Node | undefined = current.parent;
    if (
      parent !== undefined &&
      parent.kind === SyntaxKind.ConditionalType &&
      (parent as ConditionalTypeNode).extendsType === current
    )
      return;
  }
  grammarErrorOnNode(
    g,
    node,
    Diagnostics.X_infer_declarations_are_only_permitted_in_the_extends_clause_of_a_conditional_type,
  );
}

function checkGrammarTupleType(g: GrammarChecker, node: TupleTypeNode): void {
  let seenOptionalElement = false;
  let seenRestElement = false;
  for (const element of node.elements.nodes) {
    let flags = getTupleElementFlags(g.c, element);
    if ((flags & ElementFlags.Variadic) !== 0) {
      const t = getTypeFromTypeNode(g.c, getType(element)!);
      // `checkTupleType` reports non-array rest types and stops.
      if (!isArrayLikeType(g.c, t)) break;
      if (isArrayType(g.c, t) || (isTupleType(t) && (tupleTargetOf(t).combinedFlags & ElementFlags.Rest) !== 0))
        flags |= ElementFlags.Rest;
    }
    if ((flags & ElementFlags.Rest) !== 0) {
      if (seenRestElement) {
        grammarErrorOnNode(g, element, Diagnostics.A_rest_element_cannot_follow_another_rest_element);
        break;
      }
      seenRestElement = true;
    } else if ((flags & ElementFlags.Optional) !== 0) {
      if (seenRestElement) {
        grammarErrorOnNode(g, element, Diagnostics.An_optional_element_cannot_follow_a_rest_element);
        break;
      }
      seenOptionalElement = true;
    } else if ((flags & ElementFlags.Required) !== 0 && seenOptionalElement) {
      grammarErrorOnNode(g, element, Diagnostics.A_required_element_cannot_follow_an_optional_element);
      break;
    }
  }
}

function checkGrammarNamedTupleMember(g: GrammarChecker, node: NamedTupleMember): void {
  if (node.dotDotDotToken !== undefined && node.questionToken !== undefined)
    grammarErrorOnNode(g, node, Diagnostics.A_tuple_member_cannot_be_both_optional_and_rest);
  if (node.type.kind === SyntaxKind.OptionalType)
    grammarErrorOnNode(
      g,
      node.type,
      Diagnostics.A_labeled_tuple_element_is_declared_as_optional_with_a_question_mark_after_the_name_and_before_the_colon_rather_than_after_the_type,
    );
  if (node.type.kind === SyntaxKind.RestType)
    grammarErrorOnNode(
      g,
      node.type,
      Diagnostics.A_labeled_tuple_element_is_declared_as_rest_with_a_before_the_name_rather_than_before_the_type,
    );
}

/** JSDoc-only type syntax in TypeScript code. */
function checkGrammarJSDocTypeInTypeScript(g: GrammarChecker, node: Node): void {
  if ((node.flags & NodeFlags.JavaScriptFile) !== 0) return;
  if (node.kind !== SyntaxKind.JSDocNonNullableType && node.kind !== SyntaxKind.JSDocNullableType) {
    grammarErrorOnNode(g, node, Diagnostics.JSDoc_types_can_only_be_used_inside_documentation_comments);
    return;
  }
  const isNullable = node.kind === SyntaxKind.JSDocNullableType;
  const typeNode = getType(node)!;
  const postfix = node.pos === typeNode.pos;
  let t = getTypeFromTypeNode(g.c, typeNode);
  if (isNullable && t !== g.c.neverType && t !== g.c.voidType)
    t = getNullableType(g.c, t, postfix ? TypeFlags.Undefined : TypeFlags.Nullable);
  grammarErrorOnNode(
    g,
    node,
    postfix
      ? Diagnostics.X_0_at_the_end_of_a_type_is_not_valid_TypeScript_syntax_Did_you_mean_to_write_1
      : Diagnostics.X_0_at_the_start_of_a_type_is_not_valid_TypeScript_syntax_Did_you_mean_to_write_1,
    isNullable ? '?' : '!',
    typeToString(g.c, t),
  );
}

/** The `resolution-mode` of import type attributes, as tsgo's `GetResolutionModeOverride`. */
function getResolutionModeOverride(g: GrammarChecker, node: ImportAttributes, reportErrors: boolean): ModuleKind {
  const attribute = resolutionModeAttribute(node);
  if (attribute === undefined) return ModuleKind.None;
  const value = attribute.value;
  if (!isStringLiteralLike(value)) return ModuleKind.None;
  const text = getText(value);
  if (text === 'import') return ModuleKind.ESNext;
  if (text === 'require') return ModuleKind.CommonJS;
  if (reportErrors) grammarErrorOnNode(g, value, Diagnostics.X_resolution_mode_should_be_either_require_or_import);
  return ModuleKind.None;
}

/** The grammar of `checkImportAttributes` for import and export declarations. */
function checkGrammarImportAttributes(g: GrammarChecker, declaration: Node): void {
  const node = getImportAttributes(declaration);
  if (node === undefined) return;
  const isTypeOnly = isExclusivelyTypeOnlyImportOrExport(declaration) || declaration.kind === SyntaxKind.ImportType;
  const override = getResolutionModeOverride(g, node, isTypeOnly);
  // Other checks don't apply to type-only imports and import types.
  if (isTypeOnly) return;
  const moduleKind = g.moduleKind;
  if (
    !(
      (moduleKind >= ModuleKind.Node18 && moduleKind <= ModuleKind.NodeNext) ||
      moduleKind === ModuleKind.Preserve ||
      moduleKind === ModuleKind.ESNext
    )
  ) {
    grammarErrorOnNode(
      g,
      node,
      Diagnostics.Import_attributes_are_only_supported_when_the_module_option_is_set_to_esnext_node18_node20_nodenext_or_preserve,
    );
    return;
  }
  const moduleSpecifier = getExternalModuleName(declaration);
  if (
    moduleSpecifier !== undefined &&
    isStringLiteralLike(moduleSpecifier) &&
    getEmitSyntaxOfImportOrExport(g) === ModuleKind.CommonJS
  ) {
    grammarErrorOnNode(
      g,
      node,
      Diagnostics.Import_attributes_are_not_allowed_on_statements_that_compile_to_CommonJS_require_calls,
    );
    return;
  }
  if (override !== ModuleKind.None)
    grammarErrorOnNode(g, node, Diagnostics.X_resolution_mode_can_only_be_set_for_type_only_imports);
}

function isExclusivelyTypeOnlyImportOrExport(node: Node): boolean {
  if (node.kind === SyntaxKind.ExportDeclaration) return (node as ExportDeclaration).isTypeOnly;
  if (node.kind !== SyntaxKind.ImportDeclaration && node.kind !== SyntaxKind.JSImportDeclaration) return false;
  const clause = (node as ImportDeclaration).importClause;
  return clause !== undefined && clause.phaseModifier === SyntaxKind.TypeKeyword;
}

/** The module syntax an import or export declaration is emitted as. */
function getEmitSyntaxOfImportOrExport(g: GrammarChecker): ModuleKind {
  const format = getEmitModuleFormat(g);
  if (format === ModuleKind.CommonJS) return ModuleKind.CommonJS;
  if ((format >= ModuleKind.ES2015 && format <= ModuleKind.ESNext) || format === ModuleKind.Preserve)
    return ModuleKind.ESNext;
  return ModuleKind.None;
}

// ---- Expressions

const enum DeclarationMeaning {
  GetAccessor = 1 << 0,
  SetAccessor = 1 << 1,
  PropertyAssignment = 1 << 2,
  Method = 1 << 3,
  GetOrSetAccessor = GetAccessor | SetAccessor,
}

function checkGrammarObjectLiteralExpression(
  g: GrammarChecker,
  node: ObjectLiteralExpression,
  inDestructuring: boolean,
): boolean {
  // An object literal with one property can't repeat a name, so it needs no table of names.
  const seen = node.properties.nodes.length > 1 ? new Map<string, DeclarationMeaning>() : undefined;
  for (const property of node.properties.nodes) {
    if (property.kind === SyntaxKind.SpreadAssignment) {
      if (inDestructuring) {
        // A rest property can't be destructured further.
        const expression = skipParentheses(getExpression(property)!);
        if (
          expression.kind === SyntaxKind.ArrayLiteralExpression ||
          expression.kind === SyntaxKind.ObjectLiteralExpression
        )
          return grammarErrorOnNode(
            g,
            getExpression(property)!,
            Diagnostics.A_rest_element_cannot_contain_a_binding_pattern,
          );
      }
      continue;
    }
    const name = getName(property)!;
    if (name.kind === SyntaxKind.ComputedPropertyName) checkGrammarComputedPropertyName(g, name);
    if (property.kind === SyntaxKind.ShorthandPropertyAssignment && !inDestructuring) {
      // An initializer is only valid in a destructuring pattern; report on the `=`.
      const shorthand = property as ShorthandPropertyAssignment;
      const equalsToken: Node | undefined = shorthand.equalsToken;
      if (shorthand.objectAssignmentInitializer !== undefined)
        grammarErrorOnFirstToken(
          g,
          equalsToken !== undefined ? equalsToken : shorthand.name,
          Diagnostics.Did_you_mean_to_use_a_Colon_An_can_only_follow_a_property_name_when_the_containing_object_literal_is_part_of_a_destructuring_pattern,
        );
    }
    if (name.kind === SyntaxKind.PrivateIdentifier)
      grammarErrorOnNode(g, name, Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies);
    // Only `async` is allowed, and only on methods.
    const modifiers = getModifiers(property);
    if (modifiers !== undefined)
      for (const modifier of modifiers.nodes)
        if (
          isModifierKind(modifier.kind) &&
          (modifier.kind !== SyntaxKind.AsyncKeyword || property.kind !== SyntaxKind.MethodDeclaration)
        )
          grammarErrorOnNode(
            g,
            modifier,
            Diagnostics.X_0_modifier_cannot_be_used_here,
            getTextOfNodeFromSourceText(g.file.text, modifier),
          );
    // Duplicate data properties are errors in strict mode only, but accessors and data
    // properties never mix, and get/set accessors can't repeat (ECMA-262 11.1.5).
    let currentKind: DeclarationMeaning;
    switch (property.kind) {
      case SyntaxKind.ShorthandPropertyAssignment:
      case SyntaxKind.PropertyAssignment: {
        const postfixToken = getPostfixToken(property);
        checkGrammarForInvalidExclamationToken(
          g,
          postfixToken,
          Diagnostics.A_definite_assignment_assertion_is_not_permitted_in_this_context,
        );
        checkGrammarForInvalidQuestionMark(g, postfixToken, Diagnostics.An_object_member_cannot_be_declared_optional);
        if (name.kind === SyntaxKind.BigIntLiteral)
          g.c.addDiagnostic(
            createDiagnosticForNode(name, Diagnostics.A_bigint_literal_cannot_be_used_as_a_property_name, []),
          );
        currentKind = DeclarationMeaning.PropertyAssignment;
        break;
      }
      case SyntaxKind.MethodDeclaration:
        currentKind = DeclarationMeaning.Method;
        break;
      case SyntaxKind.GetAccessor:
        currentKind = DeclarationMeaning.GetAccessor;
        break;
      default:
        currentKind = DeclarationMeaning.SetAccessor;
        break;
    }
    if (inDestructuring) continue;
    const effectiveName = getEffectivePropertyNameForPropertyNameNode(g.c, name);
    if (effectiveName === undefined || seen === undefined) continue;
    const existingKind = seen.get(effectiveName);
    if (existingKind === undefined) {
      seen.set(effectiveName, currentKind);
      continue;
    }
    if ((currentKind & DeclarationMeaning.Method) !== 0 && (existingKind & DeclarationMeaning.Method) !== 0)
      grammarErrorOnNode(g, name, Diagnostics.Duplicate_identifier_0, getTextOfNodeFromSourceText(g.file.text, name));
    else if (
      (currentKind & DeclarationMeaning.PropertyAssignment) !== 0 &&
      (existingKind & DeclarationMeaning.PropertyAssignment) !== 0
    )
      grammarErrorOnNode(
        g,
        name,
        Diagnostics.An_object_literal_cannot_have_multiple_properties_with_the_same_name,
        getTextOfNodeFromSourceText(g.file.text, name),
      );
    else if (
      (currentKind & DeclarationMeaning.GetOrSetAccessor) !== 0 &&
      (existingKind & DeclarationMeaning.GetOrSetAccessor) !== 0
    ) {
      if (existingKind !== DeclarationMeaning.GetOrSetAccessor && currentKind !== existingKind)
        seen.set(effectiveName, currentKind | existingKind);
      else
        return grammarErrorOnNode(
          g,
          name,
          Diagnostics.An_object_literal_cannot_have_multiple_get_Slashset_accessors_with_the_same_name,
        );
    } else {
      return grammarErrorOnNode(
        g,
        name,
        Diagnostics.An_object_literal_cannot_have_property_and_accessor_with_the_same_name,
      );
    }
  }
  return false;
}

/** The property name a literal or computed name denotes, if known. */
function getEffectivePropertyNameForPropertyNameNode(c: Checker, name: Node): string | undefined {
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
      return getText(name);
    case SyntaxKind.ComputedPropertyName: {
      const expression = (name as ComputedPropertyName).expression;
      switch (expression.kind) {
        case SyntaxKind.StringLiteral:
        case SyntaxKind.NoSubstitutionTemplateLiteral:
        case SyntaxKind.NumericLiteral:
          return getText(expression);
        case SyntaxKind.PrefixUnaryExpression: {
          const unary = expression as PrefixUnaryExpression;
          if (
            unary.operand.kind === SyntaxKind.NumericLiteral &&
            (unary.operator === SyntaxKind.MinusToken || unary.operator === SyntaxKind.PlusToken)
          )
            return unary.operator === SyntaxKind.MinusToken ? '-' + getText(unary.operand) : getText(unary.operand);
          break;
        }
      }
      const t = getTypeOfExpression(c, expression);
      return (t.flags & (TypeFlags.UniqueESSymbol | TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) !== 0
        ? getPropertyNameFromType(t)
        : undefined;
    }
  }
  return undefined;
}

function checkGrammarCallExpression(g: GrammarChecker, node: CallExpression): void {
  const callee = node.expression;
  if (callee.kind === SyntaxKind.ImportKeyword || isImportPhaseMetaProperty(callee))
    checkGrammarImportCallExpression(g, node);
  else checkGrammarTypeArguments(g, callTypeArguments(node));
}

function checkGrammarImportCallExpression(g: GrammarChecker, node: CallExpression): boolean {
  const moduleKind = g.moduleKind;
  if (g.c.compilerOptions.verbatimModuleSyntax === true && moduleKind === ModuleKind.CommonJS)
    return grammarErrorOnNode(
      g,
      node,
      fileExtensionIsOneOf(g.file.fileName, ['.cts', '.cjs'])
        ? Diagnostics.ECMAScript_imports_and_exports_cannot_be_written_in_a_CommonJS_file_under_verbatimModuleSyntax
        : Diagnostics.ECMAScript_imports_and_exports_cannot_be_written_in_a_CommonJS_file_under_verbatimModuleSyntax_Adjust_the_type_field_in_the_nearest_package_json_to_make_this_file_an_ECMAScript_module_or_adjust_your_verbatimModuleSyntax_module_and_moduleResolution_settings_in_TypeScript,
    );
  if (isImportSourceMetaProperty(node.expression)) {
    if (!supportsSourcePhaseImports(moduleKind))
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.Source_phase_imports_are_only_supported_when_the_module_option_is_set_to_esnext_nodenext_or_preserve,
      );
  } else if (isImportDeferMetaProperty(node.expression)) {
    if (!supportsDeferredImports(moduleKind))
      return grammarErrorOnNode(
        g,
        node,
        Diagnostics.Deferred_imports_are_only_supported_when_the_module_flag_is_set_to_esnext_or_preserve,
      );
  } else if (moduleKind === ModuleKind.ES2015)
    return grammarErrorOnNode(
      g,
      node,
      Diagnostics.Dynamic_imports_are_only_supported_when_the_module_flag_is_set_to_es2020_es2022_esnext_commonjs_amd_system_umd_node16_node18_node20_or_nodenext,
    );
  const questionDotToken = callQuestionDotToken(node);
  if (questionDotToken !== undefined && isSourcePhaseImportCall(node))
    return grammarErrorOnNode(g, questionDotToken, Diagnostics.Optional_chaining_cannot_be_used_with_import_source);
  if (callTypeArguments(node) !== undefined)
    return grammarErrorOnNode(
      g,
      node,
      Diagnostics.This_use_of_import_is_invalid_import_calls_can_be_written_but_they_must_have_parentheses_and_cannot_have_type_arguments,
    );
  const args = node.arguments;
  const argumentNodes = args.nodes;
  if (
    !(moduleKind >= ModuleKind.Node16 && moduleKind <= ModuleKind.NodeNext) &&
    moduleKind !== ModuleKind.ESNext &&
    moduleKind !== ModuleKind.Preserve
  ) {
    // Import attributes allow a trailing comma.
    checkGrammarForDisallowedTrailingComma(g, args, Diagnostics.Trailing_comma_not_allowed);
    if (argumentNodes.length > 1)
      return grammarErrorOnNode(
        g,
        argumentNodes[1]!,
        Diagnostics.Dynamic_imports_only_support_a_second_argument_when_the_module_option_is_set_to_esnext_node16_node18_node20_nodenext_or_preserve,
      );
  }
  if (argumentNodes.length === 0 || argumentNodes.length > 2)
    return grammarErrorOnNode(
      g,
      node,
      Diagnostics.Dynamic_imports_can_only_accept_a_module_specifier_and_an_optional_set_of_attributes_as_arguments,
    );
  // Arguments are parsed like array elements, which allows spreads.
  for (const argument of argumentNodes)
    if (argument.kind === SyntaxKind.SpreadElement)
      return grammarErrorOnNode(g, argument, Diagnostics.Argument_of_dynamic_import_cannot_be_spread_element);
  return false;
}

function checkGrammarTaggedTemplateChain(g: GrammarChecker, node: TaggedTemplateExpression): boolean {
  if (node.questionDotToken === undefined && (node.flags & NodeFlags.OptionalChain) === 0) return false;
  return grammarErrorOnNode(
    g,
    node.template,
    Diagnostics.Tagged_template_expressions_are_not_permitted_in_an_optional_chain,
  );
}

function checkGrammarMetaProperty(g: GrammarChecker, node: MetaProperty): boolean {
  const name = node.name;
  const nameText = name.text;
  if (node.keywordToken === SyntaxKind.NewKeyword) {
    if (nameText !== 'target')
      return grammarErrorOnNode(
        g,
        name,
        Diagnostics.X_0_is_not_a_valid_meta_property_for_keyword_1_Did_you_mean_2,
        nameText,
        tokenToString(node.keywordToken),
        'target',
      );
  } else if (node.keywordToken === SyntaxKind.ImportKeyword && nameText !== 'meta') {
    const parent = node.parent!;
    const isCallee = parent.kind === SyntaxKind.CallExpression && (parent as CallExpression).expression === node;
    if (isImportPhaseMetaProperty(node)) {
      if (!isCallee) return grammarErrorAtPos(g, node.end, 0, Diagnostics.X_0_expected, '(');
    } else {
      if (isCallee)
        return grammarErrorOnNode(
          g,
          name,
          Diagnostics.X_0_is_not_a_valid_meta_property_for_keyword_import_Did_you_mean_meta_defer_or_source,
          nameText,
        );
      return grammarErrorOnNode(
        g,
        name,
        Diagnostics.X_0_is_not_a_valid_meta_property_for_keyword_1_Did_you_mean_2,
        nameText,
        tokenToString(node.keywordToken),
        'meta',
      );
    }
  }
  return false;
}

function checkGrammarAwaitOrAwaitUsing(g: GrammarChecker, node: Node): boolean {
  const isAwaitExpression = node.kind === SyntaxKind.AwaitExpression;
  let hasError = false;
  const container = getContainingFunctionOrClassStaticBlock(node);
  if (container !== undefined && container.kind === SyntaxKind.ClassStaticBlockDeclaration) {
    // Reported even with parse errors.
    g.c.error(
      node,
      isAwaitExpression
        ? Diagnostics.X_await_expression_cannot_be_used_inside_a_class_static_block
        : Diagnostics.X_await_using_statements_cannot_be_used_inside_a_class_static_block,
    );
    hasError = true;
  } else if ((node.flags & NodeFlags.AwaitContext) === 0) {
    if (isInTopLevelContext(node)) {
      if (!g.hasParseErrors) {
        if (!isEffectiveExternalModule(g)) {
          g.c.addDiagnostic(
            diagnosticAtFirstToken(
              g,
              node,
              isAwaitExpression
                ? Diagnostics.X_await_expressions_are_only_allowed_at_the_top_level_of_a_file_when_that_file_is_a_module_but_this_file_has_no_imports_or_exports_Consider_adding_an_empty_export_to_make_this_file_a_module
                : Diagnostics.X_await_using_statements_are_only_allowed_at_the_top_level_of_a_file_when_that_file_is_a_module_but_this_file_has_no_imports_or_exports_Consider_adding_an_empty_export_to_make_this_file_a_module,
            ),
          );
          hasError = true;
        }
        const support = checkTopLevelAwaitModule(g);
        if (support === TopLevelAwaitSupport.CommonJS) {
          g.c.addDiagnostic(
            diagnosticAtFirstToken(
              g,
              node,
              Diagnostics.The_current_file_is_a_CommonJS_module_and_cannot_use_await_at_the_top_level,
            ),
          );
          hasError = true;
        } else if (support === TopLevelAwaitSupport.Unsupported) {
          g.c.addDiagnostic(
            diagnosticAtFirstToken(
              g,
              node,
              isAwaitExpression
                ? Diagnostics.Top_level_await_expressions_are_only_allowed_when_the_module_option_is_set_to_es2022_esnext_system_node16_node18_node20_nodenext_or_preserve_and_the_target_option_is_set_to_es2017_or_higher
                : Diagnostics.Top_level_await_using_statements_are_only_allowed_when_the_module_option_is_set_to_es2022_esnext_system_node16_node18_node20_nodenext_or_preserve_and_the_target_option_is_set_to_es2017_or_higher,
            ),
          );
          hasError = true;
        }
      }
    } else if (!g.hasParseErrors) {
      // `await` in a function that isn't async.
      const diagnostic = diagnosticAtFirstToken(
        g,
        node,
        isAwaitExpression
          ? Diagnostics.X_await_expressions_are_only_allowed_within_async_functions_and_at_the_top_levels_of_modules
          : Diagnostics.X_await_using_statements_are_only_allowed_within_async_functions_and_at_the_top_levels_of_modules,
      );
      if (
        container !== undefined &&
        container.kind !== SyntaxKind.Constructor &&
        !hasSyntacticModifier(container, ModifierFlags.Async)
      )
        addRelated(diagnostic, container, Diagnostics.Did_you_mean_to_mark_this_function_as_async);
      g.c.addDiagnostic(diagnostic);
      hasError = true;
    }
  }
  if (isAwaitExpression && isInParameterInitializerBeforeContainingFunction(node)) {
    // Reported even with parse errors.
    g.c.error(node, Diagnostics.X_await_expressions_cannot_be_used_in_a_parameter_initializer);
    hasError = true;
  }
  return hasError;
}

function checkGrammarYieldExpression(g: GrammarChecker, node: Node): boolean {
  let hasError = false;
  if ((node.flags & NodeFlags.YieldContext) === 0) {
    grammarErrorOnFirstToken(g, node, Diagnostics.A_yield_expression_is_only_allowed_in_a_generator_body);
    hasError = true;
  }
  if (isInParameterInitializerBeforeContainingFunction(node)) {
    g.c.error(node, Diagnostics.X_yield_expressions_cannot_be_used_in_a_parameter_initializer);
    hasError = true;
  }
  return hasError;
}

export function isInParameterInitializerBeforeContainingFunction(node: Node): boolean {
  let inBindingInitializer = false;
  let current = node;
  while (current.parent !== undefined && !isFunctionLike(current.parent)) {
    const parent = current.parent;
    if (parent.kind === SyntaxKind.Parameter && (inBindingInitializer || getInitializer(parent) === current))
      return true;
    if (parent.kind === SyntaxKind.BindingElement && getInitializer(parent) === current) inBindingInitializer = true;
    current = parent;
  }
  return false;
}

/** A private name in an expression, which is only valid as `#x in obj`. */
function checkGrammarPrivateIdentifierExpression(g: GrammarChecker, node: Node): boolean {
  const parent = node.parent!;
  // Names of members, property accesses and qualified names (`typeof this.#x`) aren't expressions.
  if (
    parent.kind === SyntaxKind.PropertyAccessExpression ||
    parent.kind === SyntaxKind.QualifiedName ||
    getName(parent) === node
  )
    return false;
  const isForIn = parent.kind === SyntaxKind.ForInStatement;
  if (getContainingClass(node) === undefined)
    return grammarErrorOnNode(g, node, Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies);
  if (isForIn) return false;
  const isLeftOfIn =
    parent.kind === SyntaxKind.BinaryExpression &&
    (parent as BinaryExpression).left === node &&
    (parent as BinaryExpression).operatorToken.kind === SyntaxKind.InKeyword;
  if (!isLeftOfIn)
    return grammarErrorOnNode(
      g,
      node,
      Diagnostics.Private_identifiers_are_only_allowed_in_class_bodies_and_may_only_be_used_as_part_of_a_class_member_declaration_property_access_or_on_the_left_hand_side_of_an_in_expression,
    );
  return false;
}

function checkGrammarBigIntLiteral(g: GrammarChecker, node: Node): boolean {
  const parent = node.parent!;
  // Like tsgo, only BigInt literals checked as expressions are reported, not property or member names.
  if (getName(parent) === node) return false;
  const isLiteralType =
    parent.kind === SyntaxKind.LiteralType ||
    (parent.kind === SyntaxKind.PrefixUnaryExpression && parent.parent!.kind === SyntaxKind.LiteralType);
  // BigInt literals are fine in types and ambient contexts.
  return (
    !isLiteralType &&
    (node.flags & NodeFlags.Ambient) === 0 &&
    g.c.languageVersion < ScriptTarget.ES2020 &&
    grammarErrorOnNode(g, node, Diagnostics.BigInt_literals_are_not_available_when_targeting_lower_than_ES2020)
  );
}

/** Reports the errors of rescanning a regular expression; spelling suggestions become related information. */
class RegularExpressionErrorReporter extends ScannerErrorReporter {
  readonly g: GrammarChecker;
  lastError: Diagnostic | undefined = undefined;

  constructor(g: GrammarChecker) {
    super();
    this.g = g;
  }

  onError(message: DiagnosticMessage, start: number, length: number, args: readonly string[]): void {
    const lastError = this.lastError;
    if (
      messageCategory(message) === DiagnosticCategory.Message &&
      lastError !== undefined &&
      start === lastError.pos &&
      length === lastError.end - lastError.pos
    ) {
      lastError.relatedInformation.push(new Diagnostic(undefined, start, start + length, message, args));
    } else if (lastError === undefined || start !== lastError.pos) {
      const diagnostic = new Diagnostic(this.g.file.diagnosticFile(), start, start + length, message, args);
      this.lastError = diagnostic;
      this.g.c.addDiagnostic(diagnostic);
    }
  }
}

function checkGrammarRegularExpressionLiteral(g: GrammarChecker, node: Node): boolean {
  if (g.hasParseErrors) return false;
  const scanner = g.getScanner();
  const reporter = new RegularExpressionErrorReporter(g);
  scanner.setOnError(reporter);
  scanner.resetTokenState(node.pos);
  scanner.scan();
  scanner.reScanSlashToken(true);
  scanner.setOnError(undefined);
  return reporter.lastError !== undefined;
}
