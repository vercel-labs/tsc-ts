// CommonJS module output: imports become `require` calls, exports assignments to `exports`.
import {
  ArrowFunction,
  BinaryExpression,
  BindingPattern,
  Block,
  CallExpression,
  CaseBlock,
  CaseOrDefaultClause,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  DoStatement,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ExternalModuleReference,
  ForInOrOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  IfStatement,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  LabeledStatement,
  ModifierFlags,
  NamedExports,
  NamespaceExport,
  type Node,
  NodeFlags,
  NodeList,
  NodeVisitor,
  ObjectLiteralExpression,
  ArrayLiteralExpression,
  ParenthesizedExpression,
  PartiallyEmittedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  SwitchStatement,
  TaggedTemplateExpression,
  TemplateExpression,
  TemplateHead,
  TemplateSpan,
  TemplateTail,
  TryStatement,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  VoidExpression,
  WhileStatement,
  WithStatement,
  EmptyStatement,
  ModifierList,
  getElements,
  getName,
  callQuestionDotToken,
} from '../ast.js';
import { getExternalModuleName, isImportCall, isInJSFile, isRequireCall } from '../ast-utilities.js';
import { isAssignmentExpression, isDestructuringAssignment } from '../binder-utilities.js';
import {
  type CompilerOptions,
  JsxEmit,
  ModuleKind,
  ScriptTarget,
  getEmitModuleKind,
  getEmitScriptTarget,
} from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { NameOptions } from '../printer/factory.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { fileExtensionIsOneOf } from '../path.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  AssignmentFactory,
  convertVariableDeclarationToAssignment,
  flattenDestructuringAssignment,
  isSimpleCopiableExpression,
} from './destructuring.js';
import type { EmitResolver } from './emit-resolver.js';
import {
  type ExternalModuleInfo,
  collectExternalModuleInfo,
  createExternalHelpersImportDeclarationIfNeeded,
  getImportNeedsImportDefaultHelper,
  getImportNeedsImportStarHelper,
  getNamespaceDeclarationNode,
  isDefaultImport,
  isEffectiveExternalModule,
  moduleExportNameText,
} from './external-module-info.js';
import type { ModuleFormatHost } from './module.js';
import { Transformer } from './transformer.js';
import { hasSyntacticModifier, isExternalModule, isIdentifierReference, singleOrMany } from './utilities.js';
import { VisitorBase } from './visitor-base.js';
import { createRequireCallArguments, rewriteModuleSpecifier } from './module-utilities.js';

const exportDefault = ModifierFlags.Export | ModifierFlags.Default;
const supportedJSExtensions = ['.js', '.jsx', '.mjs', '.cjs'];

const enum VisitMode {
  /** Statements at the top level of the module. */
  TopLevel,
  /** Statements nested in top-level statements, whose `var`s are module scoped. */
  TopLevelNested,
  /** Expressions whose value is unused. */
  DiscardedValue,
}

/** Visits children in one of the transform's modes. */
class ModeVisitor extends VisitorBase {
  readonly owner: CommonJSModuleTransformer;
  readonly mode: VisitMode;

  constructor(owner: CommonJSModuleTransformer, mode: VisitMode) {
    super(owner.context);
    this.owner = owner;
    this.mode = mode;
  }

  visit(node: Node): Node | undefined {
    return this.owner.visitInMode(this.mode, node);
  }
}

/** Assigns flattened destructuring targets that are exported to `exports.x` as well. */
class ExportAssignments extends AssignmentFactory {
  readonly owner: CommonJSModuleTransformer;

  constructor(owner: CommonJSModuleTransformer) {
    super();
    this.owner = owner;
  }

  createAssignment(name: Identifier, value: Node, pos: number, end: number): Node {
    return this.owner.createAllExportExpressions(name, value, pos, end);
  }
}

export class CommonJSModuleTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly resolver: EmitResolver;
  readonly formats: ModuleFormatHost;
  readonly moduleKind: ModuleKind;
  readonly languageVersion: ScriptTarget;
  private readonly topLevel: ModeVisitor;
  private readonly topLevelNested: ModeVisitor;
  private readonly discarded: ModeVisitor;
  private readonly exportAssignments: ExportAssignments;
  private currentSourceFile: SourceFile | undefined;
  private info: ExternalModuleInfo | undefined;
  private parentNode: Node | undefined;
  private currentNode: Node | undefined;

  constructor(context: EmitContext, options: CompilerOptions, resolver: EmitResolver, formats: ModuleFormatHost) {
    super(context);
    this.options = options;
    this.resolver = resolver;
    this.formats = formats;
    this.moduleKind = getEmitModuleKind(options);
    this.languageVersion = getEmitScriptTarget(options);
    this.topLevel = new ModeVisitor(this, VisitMode.TopLevel);
    this.topLevelNested = new ModeVisitor(this, VisitMode.TopLevelNested);
    this.discarded = new ModeVisitor(this, VisitMode.DiscardedValue);
    this.exportAssignments = new ExportAssignments(this);
    this.currentSourceFile = undefined;
    this.info = undefined;
    this.parentNode = undefined;
    this.currentNode = undefined;
  }

  private moduleInfo(): ExternalModuleInfo {
    return this.info!;
  }

  // Visitors

  visit(node: Node): Node | undefined {
    const grandparent = this.pushNode(node);
    const result = this.visitNoStack(node, false);
    this.popNode(grandparent);
    return result;
  }

  visitInMode(mode: VisitMode, node: Node): Node | undefined {
    if (mode === VisitMode.TopLevel) return this.visitTopLevel(node);
    const grandparent = this.pushNode(node);
    const result =
      mode === VisitMode.TopLevelNested ? this.visitTopLevelNestedNoStack(node) : this.visitNoStack(node, true);
    this.popNode(grandparent);
    return result;
  }

  private pushNode(node: Node): Node | undefined {
    const grandparent = this.parentNode;
    this.parentNode = this.currentNode;
    this.currentNode = node;
    return grandparent;
  }

  private popNode(grandparent: Node | undefined): boolean {
    this.currentNode = this.parentNode;
    this.parentNode = grandparent;
    return true;
  }

  private visitTopLevel(node: Node): Node | undefined {
    const grandparent = this.pushNode(node);
    let result: Node | undefined;
    if (node instanceof ImportDeclaration) result = this.visitTopLevelImportDeclaration(node as ImportDeclaration);
    else if (node instanceof ImportEqualsDeclaration)
      result = this.visitTopLevelImportEqualsDeclaration(node as ImportEqualsDeclaration);
    else if (node instanceof ExportDeclaration) result = this.visitTopLevelExportDeclaration(node as ExportDeclaration);
    else if (node instanceof ExportAssignment) result = this.visitTopLevelExportAssignment(node as ExportAssignment);
    else if (node instanceof FunctionDeclaration)
      result = this.visitTopLevelFunctionDeclaration(node as FunctionDeclaration);
    else if (node instanceof ClassDeclaration) result = this.visitTopLevelClassDeclaration(node as ClassDeclaration);
    else if (node instanceof VariableStatement) result = this.visitTopLevelVariableStatement(node as VariableStatement);
    else result = this.visitTopLevelNestedNoStack(node);
    this.popNode(grandparent);
    return result;
  }

  private visitTopLevelNestedNoStack(node: Node): Node | undefined {
    const factory = this.factory;
    const nested = this.topLevelNested;
    if (node instanceof VariableStatement) return this.visitTopLevelVariableStatement(node as VariableStatement);
    if (node instanceof ForStatement) return this.visitTopLevelNestedForStatement(node as ForStatement);
    if (node instanceof ForInOrOfStatement)
      return this.visitTopLevelNestedForInOrOfStatement(node as ForInOrOfStatement);
    if (node instanceof DoStatement)
      return factory.updateDoStatement(
        node as DoStatement,
        nested.visitIterationBody(node.statement)!,
        this.visitNode(node.expression)!,
      );
    if (node instanceof WhileStatement)
      return factory.updateWhileStatement(
        node as WhileStatement,
        this.visitNode(node.expression)!,
        nested.visitIterationBody(node.statement)!,
      );
    if (node instanceof LabeledStatement) {
      const statement = nested.visitStatement(node.statement);
      return factory.updateLabeledStatement(
        node as LabeledStatement,
        node.label,
        statement !== undefined ? statement : factory.created(new EmptyStatement()),
      );
    }
    if (node instanceof WithStatement) {
      const statement = nested.visitStatement(node.statement);
      return factory.updateWithStatement(
        node as WithStatement,
        this.visitNode(node.expression)!,
        statement !== undefined ? statement : factory.created(new EmptyStatement()),
      );
    }
    if (node instanceof IfStatement) {
      const thenStatement = nested.visitStatement(node.thenStatement);
      return factory.updateIfStatement(
        node as IfStatement,
        this.visitNode(node.expression)!,
        thenStatement !== undefined ? thenStatement : factory.createBlock([], false),
        nested.visitStatement(node.elseStatement),
      );
    }
    if (node instanceof SwitchStatement) {
      const caseBlock = nested.visitNode(node.caseBlock);
      return factory.updateSwitchStatement(
        node as SwitchStatement,
        this.visitNode(node.expression)!,
        caseBlock instanceof CaseBlock ? (caseBlock as CaseBlock) : node.caseBlock,
      );
    }
    if (node instanceof CaseBlock || node instanceof TryStatement || node instanceof Block)
      return nested.visitEachChild(node);
    if (node instanceof CaseOrDefaultClause)
      return factory.updateCaseOrDefaultClause(
        node as CaseOrDefaultClause,
        this.visitNode(node.expression),
        nested.visitNodes(node.statements)!,
      );
    if (node instanceof CatchClause) {
      const block = nested.visitNode(node.block);
      return factory.updateCatchClause(
        node as CatchClause,
        node.variableDeclaration,
        block instanceof Block ? (block as Block) : node.block,
      );
    }
    return this.visitNoStack(node, false);
  }

  /** Visits a node other than a top-level statement; `discarded` if its value is unused. */
  private visitNoStack(node: Node, discarded: boolean): Node | undefined {
    if (node instanceof SourceFile) return this.visitSourceFile(node as SourceFile);
    if (node instanceof ForStatement)
      return this.factory.updateForStatement(
        node as ForStatement,
        this.discarded.visitNode(node.initializer),
        this.visitNode(node.condition),
        this.discarded.visitNode(node.incrementor),
        this.visitIterationBody(node.statement)!,
      );
    if (node instanceof ForInOrOfStatement)
      return this.factory.updateForInOrOfStatement(
        node as ForInOrOfStatement,
        node.awaitModifier,
        this.discarded.visitNode(node.initializer)!,
        this.visitNode(node.expression)!,
        this.visitIterationBody(node.statement)!,
      );
    if (node instanceof ExpressionStatement || node instanceof VoidExpression)
      return this.discarded.visitEachChild(node);
    if (node instanceof ParenthesizedExpression)
      return this.factory.updateParenthesizedExpression(
        node as ParenthesizedExpression,
        (discarded ? this.discarded.visitNode(node.expression) : this.visitNode(node.expression))!,
      );
    if (node instanceof PartiallyEmittedExpression)
      return this.factory.updatePartiallyEmittedExpression(
        node as PartiallyEmittedExpression,
        (discarded ? this.discarded.visitNode(node.expression) : this.visitNode(node.expression))!,
      );
    if (node instanceof CallExpression) return this.visitCallExpression(node as CallExpression);
    if (node instanceof TaggedTemplateExpression)
      return this.visitTaggedTemplateExpression(node as TaggedTemplateExpression);
    if (node instanceof BinaryExpression) return this.visitBinaryExpression(node as BinaryExpression, discarded);
    if (node instanceof PrefixUnaryExpression) return this.visitPrefixUnaryExpression(node as PrefixUnaryExpression);
    if (node instanceof PostfixUnaryExpression)
      return this.visitPostfixUnaryExpression(node as PostfixUnaryExpression, discarded);
    if (node instanceof ShorthandPropertyAssignment)
      return this.visitShorthandPropertyAssignment(node as ShorthandPropertyAssignment);
    if (node instanceof Identifier)
      return isIdentifierReference(node, this.parentNode) ? this.visitExpressionIdentifier(node as Identifier) : node;
    return this.visitEachChild(node);
  }

  // Source files

  private visitSourceFile(node: SourceFile): Node {
    if (node.isDeclarationFile || !(isEffectiveExternalModule(node, this.options) || containsDynamicImport(node)))
      return node;
    this.currentSourceFile = node;
    this.info = collectExternalModuleInfo(node, this.context, this.resolver);
    const updated = this.transformCommonJSModule(node);
    this.currentSourceFile = undefined;
    this.info = undefined;
    return updated;
  }

  private shouldEmitUnderscoreUnderscoreESModule(file: SourceFile): boolean {
    if (
      fileExtensionIsOneOf(file.fileName, supportedJSExtensions) &&
      file.commonJSModuleIndicator !== undefined &&
      (file.externalModuleIndicator === undefined || file.externalModuleIndicator.kind === SyntaxKind.SourceFile)
    )
      return false;
    return this.moduleInfo().exportEquals === undefined && isExternalModule(file);
  }

  /** `Object.defineProperty(exports, "__esModule", { value: true });` */
  private createUnderscoreUnderscoreESModule(): Node {
    const factory = this.factory;
    const statement = factory.createExpressionStatement(
      factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('Object'),
          factory.createIdentifier('defineProperty'),
        ),
        [
          factory.createIdentifier('exports'),
          factory.createStringLiteral('__esModule', TokenFlags.None),
          factory.createObjectLiteral(
            [factory.createPropertyAssignment(factory.createIdentifier('value'), factory.createTrue())],
            false,
          ),
        ],
      ),
    );
    this.context.setEmitFlags(statement, EmitFlags.CustomPrologue);
    return statement;
  }

  private transformCommonJSModule(node: SourceFile): Node {
    const factory = this.factory;
    const context = this.context;
    const info = this.moduleInfo();
    context.startVariableEnvironment();
    const source = node.statements.nodes;
    const prologueEnd = standardPrologueEnd(source);
    const statements: Node[] = source.slice(0, prologueEnd);
    const customEnd = this.customPrologueEnd(source, prologueEnd);
    appendAll(statements, this.topLevel.visitArray(source.slice(prologueEnd, customEnd)));
    if (this.shouldEmitUnderscoreUnderscoreESModule(node)) statements.push(this.createUnderscoreUnderscoreESModule());
    // exports.a = exports.b = void 0;
    const names = info.exportedNames;
    for (let start = 0; start < names.length; start += 50) {
      let right: Node = factory.createVoidZero();
      const end = Math.min(start + 50, names.length);
      for (let i = start; i < end; i++) right = factory.createAssignment(this.createExportsReference(names[i]), right);
      const statement = factory.createExpressionStatement(right);
      context.addEmitFlags(statement, EmitFlags.CustomPrologue);
      statements.push(statement);
    }
    // exports.f = f; ahead of the helpers import, as TypeScript orders them.
    const functionsStart = statements.length;
    for (let i = 0; i < info.exportedFunctions.length; i++)
      this.appendExportsOfClassOrFunctionDeclaration(statements, info.exportedFunctions[i]);
    for (let i = functionsStart; i < statements.length; i++)
      context.addEmitFlags(statements[i], EmitFlags.CustomPrologue);
    appendAll(statements, this.topLevel.visitArray(source.slice(customEnd)));
    this.appendExportEqualsIfNeeded(statements);
    const merged = context.mergeEnvironment(statements, context.endVariableEnvironment());
    let result = factory.updateSourceFile(
      node,
      new NodeList(node.statements.pos, node.statements.end, merged),
      node.endOfFileToken,
    );
    const helpers = context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) context.addEmitHelper(result, helpers[i]);
    const helpersImport = createExternalHelpersImportDeclarationIfNeeded(
      context,
      result,
      this.options,
      this.formats.getEmitModuleFormat(node.fileName),
    );
    if (helpersImport !== undefined) {
      const current = result.statements.nodes;
      const standardEnd = standardPrologueEnd(current);
      const end = this.customPrologueEnd(current, standardEnd);
      const withImport = current.slice(0, end);
      const visited = this.topLevel.visitNode(helpersImport);
      if (visited !== undefined) withImport.push(visited);
      appendAll(withImport, current.slice(end));
      result = factory.updateSourceFile(
        result,
        new NodeList(result.statements.pos, result.statements.end, withImport),
        node.endOfFileToken,
      );
    }
    return result;
  }

  private customPrologueEnd(statements: readonly Node[], start: number): number {
    let i = start;
    while (
      i < statements.length &&
      !isPrologueDirective(statements[i]) &&
      (this.context.getEmitFlags(statements[i]) & EmitFlags.CustomPrologue) !== 0
    )
      i++;
    return i;
  }

  /** `exports.x` or `exports["x"]` for an export name. */
  private createExportsReference(name: Node): Node {
    const factory = this.factory;
    if (name instanceof StringLiteral)
      return factory.createElementAccessExpression(
        factory.createIdentifier('exports'),
        factory.createStringLiteralFromNode(name),
      );
    const clone = this.cloneName(name);
    this.context.setEmitFlags(clone, EmitFlags.NoSourceMap | EmitFlags.NoComments);
    return factory.createPropertyAccessExpression(factory.createIdentifier('exports'), clone);
  }

  private cloneName(name: Node): Node {
    return name instanceof Identifier ? this.factory.cloneIdentifier(name as Identifier) : name;
  }

  /** `module.exports = x;` for `export = x`. */
  private appendExportEqualsIfNeeded(statements: Node[]): boolean {
    const exportEquals = this.moduleInfo().exportEquals;
    if (exportEquals === undefined) return false;
    const grandparent = this.pushNode(exportEquals);
    const expression = this.visitNode(exportEquals.expression);
    this.popNode(grandparent);
    if (expression === undefined) return false;
    const factory = this.factory;
    const statement = factory.createExpressionStatement(
      factory.createAssignment(
        factory.createPropertyAccessExpression(factory.createIdentifier('module'), factory.createIdentifier('exports')),
        expression,
      ),
    );
    this.context.assignCommentAndSourceMapRanges(statement, exportEquals);
    this.context.addEmitFlags(statement, EmitFlags.NoComments);
    statements.push(statement);
    return true;
  }

  // Exports of declarations

  private appendExportsOfImportDeclaration(statements: Node[], declaration: ImportDeclaration): boolean {
    if (this.moduleInfo().exportEquals !== undefined) return false;
    const clause = declaration.importClause;
    if (clause === undefined) return false;
    const seen = new Set<string>();
    if (clause.name !== undefined) this.appendExportsOfDeclaration(statements, clause, seen, false);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && bindings.kind === SyntaxKind.NamespaceImport)
      this.appendExportsOfDeclaration(statements, bindings, seen, false);
    else if (bindings !== undefined && bindings.kind === SyntaxKind.NamedImports) {
      const elements = bindingElementsOf(bindings);
      for (let i = 0; i < elements.length; i++) this.appendExportsOfDeclaration(statements, elements[i], seen, true);
    }
    return true;
  }

  private appendExportsOfVariableDeclarationList(
    statements: Node[],
    list: VariableDeclarationList,
    isForInOrOfInitializer: boolean,
  ): boolean {
    if (this.moduleInfo().exportEquals !== undefined) return false;
    const declarations = list.declarations.nodes;
    for (let i = 0; i < declarations.length; i++)
      this.appendExportsOfBindingElement(statements, declarations[i], isForInOrOfInitializer);
    return true;
  }

  private appendExportsOfBindingElement(statements: Node[], declaration: Node, isForInOrOfInitializer: boolean) {
    if (this.moduleInfo().exportEquals !== undefined) return false;
    const name = bindingNameOf(declaration);
    if (name === undefined) return false;
    if (name instanceof BindingPattern) {
      const elements = name.elements.nodes;
      for (let i = 0; i < elements.length; i++)
        if (elements[i].kind !== SyntaxKind.OmittedExpression)
          this.appendExportsOfBindingElement(statements, elements[i], isForInOrOfInitializer);
      return true;
    }
    if (
      !this.context.hasAutoGenerateInfo(name) &&
      (!(declaration instanceof VariableDeclaration) || declaration.initializer !== undefined || isForInOrOfInitializer)
    )
      this.appendExportsOfDeclaration(statements, declaration, undefined, false);
    return true;
  }

  private appendExportsOfClassOrFunctionDeclaration(statements: Node[], declaration: Node): boolean {
    if (this.moduleInfo().exportEquals !== undefined) return false;
    const seen = new Set<string>();
    if (hasSyntacticModifier(declaration, ModifierFlags.Export)) {
      const exportName: Node = hasSyntacticModifier(declaration, ModifierFlags.Default)
        ? this.factory.createIdentifier('default')
        : this.factory.getDeclarationName(declaration, NameOptions.None);
      this.appendExportStatement(
        statements,
        seen,
        exportName,
        this.factory.getLocalName(declaration, NameOptions.None),
        declaration,
        false,
        false,
      );
    }
    if (declarationNameOf(declaration) !== undefined)
      this.appendExportsOfDeclaration(statements, declaration, seen, false);
    return true;
  }

  private appendExportsOfDeclaration(
    statements: Node[],
    declaration: Node,
    seenNames: Set<string> | undefined,
    liveBinding: boolean,
  ): boolean {
    const info = this.moduleInfo();
    if (info.exportEquals !== undefined) return false;
    const seen = seenNames !== undefined ? seenNames : new Set<string>();
    if (info.exportSpecifiers.size === 0 || !(declarationNameOf(declaration) instanceof Identifier)) return false;
    const name = this.factory.getDeclarationName(declaration, NameOptions.None);
    const specifiers = info.exportSpecifiers.get(name.text);
    if (specifiers === undefined || specifiers.length === 0) return false;
    const value = this.visitExpressionIdentifier(name);
    for (let i = 0; i < specifiers.length; i++)
      this.appendExportStatement(statements, seen, specifiers[i].name, value, specifiers[i].name, false, liveBinding);
    return true;
  }

  private appendExportStatement(
    statements: Node[],
    seen: Set<string>,
    exportName: Node,
    value: Node,
    location: Node | undefined,
    allowComments: boolean,
    liveBinding: boolean,
  ): boolean {
    if (!(exportName instanceof StringLiteral)) {
      const text = moduleExportNameText(exportName);
      if (seen.has(text)) return false;
      seen.add(text);
    }
    statements.push(this.createExportStatement(exportName, value, location, allowComments, liveBinding));
    return true;
  }

  private createExportStatement(
    name: Node,
    value: Node,
    location: Node | undefined,
    allowComments: boolean,
    liveBinding: boolean,
  ): Node {
    const statement = this.factory.createExpressionStatement(
      this.createExportExpression(name, value, undefined, liveBinding),
    );
    if (location !== undefined) this.context.setCommentRange(statement, location.pos, location.end);
    this.context.addEmitFlags(statement, EmitFlags.StartOnNewLine);
    if (!allowComments) this.context.addEmitFlags(statement, EmitFlags.NoComments);
    return statement;
  }

  /** `exports.x = value`, or a getter on `exports` for a live binding. */
  private createExportExpression(name: Node, value: Node, location: Node | undefined, liveBinding: boolean): Node {
    const factory = this.factory;
    let expression: Node;
    if (liveBinding) {
      // Object.defineProperty(exports, "x", { enumerable: true, get: function () { return value; } })
      const getter = factory.createFunctionExpression(
        [],
        factory.createBlock([factory.createReturnStatement(value)], false),
      );
      expression = factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('Object'),
          factory.createIdentifier('defineProperty'),
        ),
        [
          factory.createIdentifier('exports'),
          factory.createStringLiteralFromNode(name),
          factory.createObjectLiteral(
            [
              factory.createPropertyAssignment(factory.createIdentifier('enumerable'), factory.createTrue()),
              factory.createPropertyAssignment(factory.createIdentifier('get'), getter),
            ],
            false,
          ),
        ],
      );
    } else {
      const target =
        name instanceof StringLiteral
          ? factory.createElementAccessExpression(
              factory.createIdentifier('exports'),
              factory.createStringLiteralFromNode(name),
            )
          : factory.createPropertyAccessExpression(factory.createIdentifier('exports'), this.cloneName(name));
      expression = factory.createAssignment(target, value);
    }
    if (location !== undefined) this.context.setCommentRange(expression, location.pos, location.end);
    return expression;
  }

  /** `require("mod")` */
  private createRequireCall(node: Node): Node {
    const factory = this.factory;
    return factory.createCallExpression(
      factory.createIdentifier('require'),
      createRequireCallArguments(this.context, node, this.options),
    );
  }

  private getHelperExpressionForImport(node: ImportDeclaration, inner: Node): Node {
    if (getImportNeedsImportStarHelper(node)) return this.visitNode(this.factory.createImportStarHelper(inner))!;
    if (getImportNeedsImportDefaultHelper(node)) return this.visitNode(this.factory.createImportDefaultHelper(inner))!;
    return inner;
  }

  // Top-level statements

  private visitTopLevelImportDeclaration(node: ImportDeclaration): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    if (node.importClause === undefined) {
      // import "mod";
      const statement = factory.createExpressionStatement(this.createRequireCall(node));
      context.setOriginal(statement, node);
      context.assignCommentAndSourceMapRanges(statement, node);
      return statement;
    }
    const variables: Node[] = [];
    const namespaceDeclaration = getNamespaceDeclarationNode(node);
    if (namespaceDeclaration !== undefined && !isDefaultImport(node)) {
      // import * as n from "mod";
      variables.push(
        factory.createVariableDeclaration(
          this.cloneName(namespaceNameOf(namespaceDeclaration)),
          undefined,
          undefined,
          this.getHelperExpressionForImport(node, this.createRequireCall(node)),
        ),
      );
    } else {
      // import d, { x } from "mod";
      variables.push(
        factory.createVariableDeclaration(
          factory.createGeneratedNameForNode(node, 0, '', ''),
          undefined,
          undefined,
          this.getHelperExpressionForImport(node, this.createRequireCall(node)),
        ),
      );
      if (namespaceDeclaration !== undefined)
        variables.push(
          factory.createVariableDeclaration(
            this.cloneName(namespaceNameOf(namespaceDeclaration)),
            undefined,
            undefined,
            factory.createGeneratedNameForNode(node, 0, '', ''),
          ),
        );
    }
    const statement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(factory.createNodeList(variables), NodeFlags.Const),
    );
    context.setOriginal(statement, node);
    context.assignCommentAndSourceMapRanges(statement, node);
    const statements: Node[] = [statement];
    this.appendExportsOfImportDeclaration(statements, node);
    return singleOrMany(statements, factory);
  }

  private visitTopLevelImportEqualsDeclaration(node: ImportEqualsDeclaration): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    if (!(node.moduleReference instanceof ExternalModuleReference)) return this.visitEachChild(node);
    let statement: Node;
    if (hasSyntacticModifier(node, ModifierFlags.Export)) {
      // export import m = require("mod");
      statement = factory.createExpressionStatement(
        this.createExportExpression(node.name, this.createRequireCall(node), node, false),
      );
    } else {
      // import m = require("mod");
      statement = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          factory.createNodeList([
            factory.createVariableDeclaration(
              factory.cloneIdentifier(node.name),
              undefined,
              undefined,
              this.createRequireCall(node),
            ),
          ]),
          NodeFlags.Const,
        ),
      );
    }
    context.setOriginal(statement, node);
    context.assignCommentAndSourceMapRanges(statement, node);
    const statements: Node[] = [statement];
    this.appendExportsOfDeclaration(statements, node, undefined, false);
    return singleOrMany(statements, factory);
  }

  private visitTopLevelExportDeclaration(node: ExportDeclaration): Node | undefined {
    const factory = this.factory;
    const context = this.context;
    // Local `export { x }` is handled with the declarations it exports.
    if (node.moduleSpecifier === undefined) return undefined;
    const generatedName = factory.createGeneratedNameForNode(node, 0, '', '');
    const clause = node.exportClause;
    if (clause instanceof NamedExports) {
      // export { x, y } from "mod";
      const statement = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          factory.createNodeList([
            factory.createVariableDeclaration(generatedName, undefined, undefined, this.createRequireCall(node)),
          ]),
          NodeFlags.None,
        ),
      );
      context.setOriginal(statement, node);
      context.assignCommentAndSourceMapRanges(statement, node);
      const statements: Node[] = [statement];
      const specifiers = clause.elements.nodes;
      for (let i = 0; i < specifiers.length; i++) {
        const specifier = specifiers[i];
        if (!(specifier instanceof ExportSpecifier)) continue;
        const imported = specifier.propertyName !== undefined ? specifier.propertyName : specifier.name;
        const target: Node =
          moduleExportNameText(imported) === 'default'
            ? factory.createImportDefaultHelper(generatedName)
            : generatedName;
        const exportName: Node =
          specifier.name instanceof StringLiteral
            ? factory.createStringLiteralFromNode(specifier.name)
            : factory.getExportName(specifier, NameOptions.None);
        const value =
          imported instanceof StringLiteral
            ? factory.createElementAccessExpression(target, imported)
            : factory.createPropertyAccessExpression(target, imported);
        const exportStatement = factory.createExpressionStatement(
          this.createExportExpression(exportName, value, undefined, true),
        );
        context.setOriginal(exportStatement, specifier);
        context.assignCommentAndSourceMapRanges(exportStatement, specifier);
        statements.push(exportStatement);
      }
      return singleOrMany(statements, factory);
    }
    if (clause instanceof NamespaceExport) {
      // export * as ns from "mod";
      const name = clause.name;
      const exportName: Node =
        name instanceof StringLiteral ? factory.createStringLiteralFromNode(name) : this.cloneName(name);
      const statement = factory.createExpressionStatement(
        this.createExportExpression(
          exportName,
          this.visitNode(factory.createImportStarHelper(this.createRequireCall(node)))!,
          undefined,
          false,
        ),
      );
      context.setOriginal(statement, node);
      context.assignCommentAndSourceMapRanges(statement, node);
      return statement;
    }
    // export * from "mod";
    const statement = factory.createExpressionStatement(
      this.visitNode(
        factory.createExportStarHelper(this.createRequireCall(node), factory.createIdentifier('exports')),
      )!,
    );
    context.setOriginal(statement, node);
    context.assignCommentAndSourceMapRanges(statement, node);
    return statement;
  }

  private visitTopLevelExportAssignment(node: ExportAssignment): Node | undefined {
    if (node.isExportEquals) return undefined;
    return this.createExportStatement(
      this.factory.createIdentifier('default'),
      this.visitNode(node.expression)!,
      node,
      true,
      false,
    );
  }

  private visitTopLevelFunctionDeclaration(node: FunctionDeclaration): Node | undefined {
    if (!hasSyntacticModifier(node, ModifierFlags.Export)) return this.visitEachChild(node);
    return this.factory.updateFunctionDeclaration(
      node,
      this.extractModifiers(node.modifiers, ~exportDefault),
      node.asteriskToken,
      this.factory.getDeclarationName(node, NameOptions.None),
      undefined,
      this.visitNodes(node.parameters)!,
      undefined,
      undefined,
      this.visitNode(node.body),
    );
  }

  private visitTopLevelClassDeclaration(node: ClassDeclaration): Node | undefined {
    const statements: Node[] = [];
    if (hasSyntacticModifier(node, ModifierFlags.Export)) {
      const updated: Node | undefined = this.factory.updateClassDeclaration(
        node,
        this.visitModifiers(this.extractModifiers(node.modifiers, ~exportDefault)),
        this.factory.getDeclarationName(node, NameOptions.None),
        undefined,
        this.visitNodes(node.heritageClauses),
        this.visitNodes(node.members)!,
      );
      if (updated !== undefined) statements.push(updated);
    } else statements.push(this.visitEachChild(node));
    this.appendExportsOfClassOrFunctionDeclaration(statements, node);
    return singleOrMany(statements, this.factory);
  }

  private visitTopLevelVariableStatement(node: VariableStatement): Node | undefined {
    if (!hasSyntacticModifier(node, ModifierFlags.Export)) {
      // Nested `var`s may still be exported with `export { x }`.
      const statements: Node[] = [this.visitEachChild(node)];
      this.appendExportsOfVariableDeclarationList(statements, node.declarationList, false);
      return singleOrMany(statements, this.factory);
    }
    // export var a = b;  becomes  exports.a = b;
    const factory = this.factory;
    const context = this.context;
    const splitter = new ExportedVariableSplitter(this, node);
    const declarations = node.declarationList.declarations.nodes;
    for (let i = 0; i < declarations.length; i++) {
      const variable = declarations[i];
      if (!(variable instanceof VariableDeclaration)) continue;
      const name = variable.name;
      const initializer = variable.initializer;
      if (name instanceof Identifier && (context.getEmitFlags(name) & EmitFlags.LocalName) !== 0) {
        // A class or function converted to a variable: references stay local, an `export { x }` follows.
        splitter.ensureModifiers();
        splitter.pushVariable(
          initializer === undefined
            ? variable
            : factory.updateVariableDeclaration(
                variable as VariableDeclaration,
                name,
                undefined,
                undefined,
                this.createExportExpression(name, this.visitNode(initializer)!, undefined, false),
              ),
        );
      } else if (
        initializer !== undefined &&
        !(name instanceof BindingPattern) &&
        (initializer instanceof ArrowFunction ||
          initializer instanceof FunctionExpression ||
          initializer instanceof ClassExpression)
      ) {
        // Variables keep functions and classes named.
        splitter.pushVariable(
          factory.createVariableDeclaration(
            name,
            variable.exclamationToken,
            variable.type,
            this.visitNode(initializer),
          ),
        );
        const access = factory.createPropertyAccessExpression(factory.createIdentifier('exports'), name);
        context.assignCommentAndSourceMapRanges(access, name);
        splitter.pushExpression(factory.createAssignment(access, this.cloneName(name)));
      } else if (name instanceof Identifier) {
        const expression = this.transformInitializedVariable(variable as VariableDeclaration);
        if (expression !== undefined) splitter.pushExpression(this.visitNode(expression)!);
      } else if (name instanceof BindingPattern) {
        const expression = this.transformInitializedVariable(variable as VariableDeclaration);
        if (expression !== undefined) splitter.pushExpression(expression);
      } else {
        const expression = convertVariableDeclarationToAssignment(this, variable as VariableDeclaration);
        if (expression !== undefined) splitter.pushExpression(this.visitNode(expression)!);
      }
    }
    splitter.commitVariables();
    splitter.commitExpressions();
    const statements = splitter.statements;
    this.appendExportsOfVariableDeclarationList(statements, node.declarationList, false);
    return singleOrMany(statements, factory);
  }

  private transformInitializedVariable(node: VariableDeclaration): Node | undefined {
    const initializer = node.initializer;
    if (initializer === undefined) return undefined;
    const name = node.name;
    if (name instanceof BindingPattern) {
      // Kept as native destructuring unless a target can't be rewritten to `exports.x`.
      const assignment = convertVariableDeclarationToAssignment(this, node)!;
      const grandparent = this.pushNode(assignment);
      const result =
        assignment instanceof BinaryExpression ? this.visitDestructuringAssignment(assignment, true) : assignment;
      this.popNode(grandparent);
      return result;
    }
    const access = this.factory.createPropertyAccessExpression(this.factory.createIdentifier('exports'), name);
    this.context.assignCommentAndSourceMapRanges(access, name);
    return this.factory.createAssignment(access, initializer);
  }

  private visitTopLevelNestedForStatement(node: ForStatement): Node | undefined {
    const factory = this.factory;
    const initializer = node.initializer;
    if (initializer instanceof VariableDeclarationList && (initializer.flags & NodeFlags.BlockScoped) === 0) {
      const exports: Node[] = [];
      this.appendExportsOfVariableDeclarationList(exports, initializer as VariableDeclarationList, false);
      if (exports.length > 0) {
        // var x = 0; exports.x = x; for (; ;) { }
        const list = this.discarded.visitNode(initializer);
        const statements: Node[] = [
          factory.createVariableStatement(
            undefined,
            list instanceof VariableDeclarationList
              ? (list as VariableDeclarationList)
              : (initializer as VariableDeclarationList),
          ),
        ];
        appendAll(statements, exports);
        const updated: Node | undefined = factory.updateForStatement(
          node,
          undefined,
          this.visitNode(node.condition),
          this.discarded.visitNode(node.incrementor),
          this.topLevelNested.visitIterationBody(node.statement)!,
        );
        if (updated !== undefined) statements.push(updated);
        return singleOrMany(statements, factory);
      }
    }
    return factory.updateForStatement(
      node,
      this.discarded.visitNode(initializer),
      this.visitNode(node.condition),
      this.discarded.visitNode(node.incrementor),
      this.topLevelNested.visitIterationBody(node.statement)!,
    );
  }

  private visitTopLevelNestedForInOrOfStatement(node: ForInOrOfStatement): Node | undefined {
    const factory = this.factory;
    const initializer = node.initializer;
    if (initializer instanceof VariableDeclarationList && (initializer.flags & NodeFlags.BlockScoped) === 0) {
      const exports: Node[] = [];
      this.appendExportsOfVariableDeclarationList(exports, initializer, true);
      if (exports.length > 0) {
        // for (var x in y) { exports.x = x; ... }
        const visitedInitializer = this.discarded.visitNode(initializer)!;
        const expression = this.visitNode(node.expression)!;
        const body = this.topLevelNested.visitIterationBody(node.statement)!;
        let updatedBody: Node;
        if (body instanceof Block) {
          const block: Node | undefined = factory.updateBlock(
            body,
            new NodeList(body.statements.pos, body.statements.end, exports.concat(body.statements.nodes)),
            body.multiLine,
          );
          updatedBody = block !== undefined ? block : body;
        } else {
          exports.push(body);
          updatedBody = factory.createBlock(exports, true);
        }
        return factory.updateForInOrOfStatement(node, node.awaitModifier, visitedInitializer, expression, updatedBody);
      }
    }
    return factory.updateForInOrOfStatement(
      node,
      node.awaitModifier,
      this.discarded.visitNode(initializer)!,
      this.visitNode(node.expression)!,
      this.topLevelNested.visitIterationBody(node.statement)!,
    );
  }

  // Expressions

  private visitBinaryExpression(node: BinaryExpression, discarded: boolean): Node {
    if (isDestructuringAssignment(node)) return this.visitDestructuringAssignment(node, discarded);
    if (isAssignmentExpression(node, false)) return this.visitAssignmentExpression(node);
    if (node.operatorToken.kind === SyntaxKind.CommaToken)
      return this.factory.updateBinaryExpression(
        node,
        undefined,
        this.discarded.visitNode(node.left)!,
        undefined,
        node.operatorToken,
        (discarded ? this.discarded.visitNode(node.right) : this.visitNode(node.right))!,
      );
    return this.visitEachChild(node);
  }

  /** Assigning an exported name also assigns each of its exports. */
  private visitAssignmentExpression(node: BinaryExpression): Node {
    const left = node.left;
    if (left instanceof Identifier && this.isSubstitutableName(left)) {
      const exportedNames = this.getExports(left);
      if (exportedNames !== undefined && exportedNames.length > 0) {
        let expression = this.visitEachChild(node);
        for (let i = 0; i < exportedNames.length; i++)
          expression = this.createExportExpression(exportedNames[i], expression, node, false);
        return expression;
      }
    }
    return this.visitEachChild(node);
  }

  /** Not generated (except file-level reserved names) and not a local name. */
  private isSubstitutableName(name: Identifier): boolean {
    const context = this.context;
    return (
      (!context.hasAutoGenerateInfo(name) || this.isFileLevelReservedGeneratedIdentifier(name)) &&
      (context.getEmitFlags(name) & EmitFlags.LocalName) === 0
    );
  }

  private visitDestructuringAssignment(node: BinaryExpression, discarded: boolean): Node {
    if (this.destructuringNeedsFlattening(node.left))
      return flattenDestructuringAssignment(this, node, !discarded, this.exportAssignments);
    return this.visitEachChild(node);
  }

  /** Whether a destructuring target assigns an exported name that native destructuring can't update. */
  private destructuringNeedsFlattening(node: Node): boolean {
    if (node instanceof ObjectLiteralExpression) {
      const properties = node.properties.nodes;
      for (let i = 0; i < properties.length; i++) {
        const element = properties[i];
        if (element instanceof PropertyAssignment) {
          if (this.destructuringNeedsFlattening(element.initializer)) return true;
        } else if (element instanceof ShorthandPropertyAssignment) {
          if (this.destructuringNeedsFlattening(element.name)) return true;
        } else if (element instanceof SpreadAssignment) {
          if (this.destructuringNeedsFlattening(element.expression)) return true;
        } else if (
          element.kind === SyntaxKind.MethodDeclaration ||
          element.kind === SyntaxKind.GetAccessor ||
          element.kind === SyntaxKind.SetAccessor
        )
          return false;
      }
      return false;
    }
    if (node instanceof ArrayLiteralExpression) {
      const elements = node.elements.nodes;
      for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        const target = element instanceof SpreadElement ? element.expression : element;
        if (this.destructuringNeedsFlattening(target)) return true;
      }
      return false;
    }
    if (node instanceof Identifier) {
      const exportedNames = this.getExports(node as Identifier);
      const count = exportedNames === undefined ? 0 : exportedNames.length;
      if ((this.context.getEmitFlags(node) & EmitFlags.ExportName) !== 0) return count > 1;
      if (count === 0) return false;
      // A single direct export of the same name becomes `exports.x` natively.
      if (
        count === 1 &&
        this.isDirectExport(node as Identifier) &&
        moduleExportNameText(exportedNames![0]) === node.text
      )
        return false;
      return true;
    }
    return false;
  }

  /** The assignment of a flattened destructuring target, assigning its exports too. */
  createAllExportExpressions(name: Identifier, value: Node, pos: number, end: number): Node {
    const factory = this.factory;
    const exportedNames = this.getExports(name);
    if (exportedNames !== undefined && exportedNames.length > 0) {
      let expression = this.isDirectExport(name)
        ? this.createDirectExportAssignment(name, value)
        : factory.createAssignment(name, value);
      for (let i = 0; i < exportedNames.length; i++) {
        expression = this.createExportExpression(exportedNames[i], expression, undefined, false);
        this.context.setCommentRange(expression, pos, end);
      }
      return expression;
    }
    if (this.isDirectExport(name)) return this.createDirectExportAssignment(name, value);
    return factory.createAssignment(name, value);
  }

  /** `exports.x = value` for a directly exported `x`. */
  private createDirectExportAssignment(name: Identifier, value: Node): Node {
    const factory = this.factory;
    const context = this.context;
    const exportName = factory.cloneIdentifier(name);
    context.addEmitFlags(exportName, EmitFlags.NoComments | EmitFlags.NoSourceMap);
    const access = factory.createPropertyAccessExpression(factory.createIdentifier('exports'), exportName);
    context.addEmitFlags(access, EmitFlags.NoComments);
    const assignment = factory.createAssignment(access, value);
    context.assignCommentAndSourceMapRanges(assignment, name);
    return assignment;
  }

  /** Whether `name` refers to a declaration exported by the module itself, like `export let x`. */
  private isDirectExport(name: Identifier): boolean {
    const location = this.context.mostOriginal(name);
    if (!(location instanceof Identifier) || (location.flags & NodeFlags.Synthesized) !== 0) return false;
    return this.resolver.getReferencedExportContainer(location as Identifier, false) instanceof SourceFile;
  }

  private visitPrefixUnaryExpression(node: PrefixUnaryExpression): Node {
    const operand = node.operand;
    if (
      (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken) &&
      operand instanceof Identifier &&
      (this.context.getEmitFlags(operand) & EmitFlags.LocalName) === 0
    ) {
      const exportedNames = this.getExports(operand);
      if (exportedNames !== undefined && exportedNames.length > 0) {
        // exports.x = ++x;
        let expression: Node = this.factory.updatePrefixUnaryExpression(node, node.operator, this.visitNode(operand)!);
        for (let i = 0; i < exportedNames.length; i++) {
          expression = this.createExportExpression(exportedNames[i], expression, undefined, false);
          this.context.assignCommentAndSourceMapRanges(expression, node);
        }
        return expression;
      }
    }
    return this.visitEachChild(node);
  }

  private visitPostfixUnaryExpression(node: PostfixUnaryExpression, discarded: boolean): Node {
    const operand = node.operand;
    if (
      (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken) &&
      operand instanceof Identifier &&
      (this.context.getEmitFlags(operand) & EmitFlags.LocalName) === 0
    ) {
      const exportedNames = this.getExports(operand);
      if (exportedNames !== undefined && exportedNames.length > 0) {
        // exports.x = (x++, x);  or, when the value is used:  (exports.x = (_a = x++, x), _a)
        const factory = this.factory;
        const context = this.context;
        let temp: Identifier | undefined = undefined;
        let expression: Node = factory.updatePostfixUnaryExpression(node, this.visitNode(operand)!, node.operator);
        if (!discarded) {
          temp = factory.createTempVariable(0);
          context.addVariableDeclaration(temp);
          expression = factory.createAssignment(temp, expression);
          context.assignCommentAndSourceMapRanges(expression, node);
        }
        expression = factory.createCommaExpression(expression, factory.cloneIdentifier(operand));
        context.assignCommentAndSourceMapRanges(expression, node);
        for (let i = 0; i < exportedNames.length; i++) {
          expression = this.createExportExpression(exportedNames[i], expression, undefined, false);
          context.assignCommentAndSourceMapRanges(expression, node);
        }
        if (temp !== undefined) {
          expression = factory.createCommaExpression(expression, temp);
          context.assignCommentAndSourceMapRanges(expression, node);
        }
        return expression;
      }
    }
    return this.visitEachChild(node);
  }

  /** `(0, mod_1.f)()` for a call of an import; `import()` becomes a `require` call. */
  private visitCallExpression(node: CallExpression): Node {
    const rewrite =
      this.options.rewriteRelativeImportExtensions === true &&
      ((isImportCall(node) && node.arguments.nodes.length > 0) || (isInJSFile(node) && isRequireCall(node, false)));
    // `import.source()` and the other phase imports stay as written.
    if (node.expression.kind === SyntaxKind.ImportKeyword && this.shouldTransformImportCall())
      return this.visitImportCallExpression(node, rewrite);
    if (rewrite) return this.rewriteImportOrRequireCall(node);
    const callee = node.expression;
    if (callee instanceof Identifier) {
      const expression = this.visitExpressionIdentifier(callee);
      const updated = this.factory.updateCallExpression(
        node,
        expression,
        callQuestionDotToken(node),
        undefined,
        this.visitNodes(node.arguments)!,
        node.flags,
      );
      if (!(expression instanceof Identifier) && (this.context.getEmitFlags(callee) & EmitFlags.HelperName) === 0)
        this.context.addEmitFlags(updated, EmitFlags.IndirectCall);
      return updated;
    }
    return this.visitEachChild(node);
  }

  private shouldTransformImportCall(): boolean {
    const kind = this.moduleKind;
    if ((kind >= ModuleKind.Node16 && kind <= ModuleKind.NodeNext) || kind === ModuleKind.Preserve) return false;
    return this.formats.getEmitModuleFormat(this.currentSourceFile!.fileName) < ModuleKind.ES2015;
  }

  private visitImportCallExpression(node: CallExpression, rewrite: boolean): Node {
    if (this.moduleKind === ModuleKind.None && this.languageVersion >= ScriptTarget.ES2020)
      return this.visitEachChild(node);
    const factory = this.factory;
    const specifier = getExternalModuleName(node);
    const moduleName =
      specifier instanceof StringLiteral ? factory.createStringLiteral(specifier.text, TokenFlags.None) : undefined;
    const args = node.arguments.nodes;
    const first = args.length > 0 ? this.visitNode(args[0]) : undefined;
    // The module name only where it differs from the argument, which keeps the argument's quotes.
    let argument: Node | undefined;
    if (moduleName !== undefined && (!(first instanceof StringLiteral) || first.text !== moduleName.text))
      argument = moduleName;
    else if (first !== undefined && rewrite)
      argument =
        first instanceof StringLiteral
          ? rewriteModuleSpecifier(this.context, first, this.options)
          : factory.createRewriteRelativeImportExtensionsHelper(first, this.options.jsx === JsxEmit.Preserve);
    else argument = first;
    return this.createImportCallExpressionCommonJS(argument);
  }

  /** `Promise.resolve().then(() => __importStar(require(x)))` */
  private createImportCallExpressionCommonJS(argument: Node | undefined): Node {
    const factory = this.factory;
    // A non-literal argument is converted to a string synchronously, as `import()` does.
    const needSyncEval = argument !== undefined && !isSimpleInlineableExpression(argument);
    const resolveArguments: Node[] = [];
    if (needSyncEval)
      resolveArguments.push(
        factory.created(
          new TemplateExpression(
            factory.created(new TemplateHead('', '', TokenFlags.None)),
            factory.createNodeList([
              factory.created(new TemplateSpan(argument!, factory.created(new TemplateTail('', '', TokenFlags.None)))),
            ]),
          ),
        ),
      );
    const promiseResolve = factory.createCallExpression(
      factory.createPropertyAccessExpression(factory.createIdentifier('Promise'), factory.createIdentifier('resolve')),
      resolveArguments,
    );
    const requireArguments: Node[] = needSyncEval
      ? [factory.createIdentifier('s')]
      : argument !== undefined
        ? [argument]
        : [];
    const requireCall = factory.createImportStarHelper(
      factory.createCallExpression(factory.createIdentifier('require'), requireArguments),
    );
    const parameters: Node[] = needSyncEval ? [factory.createParameter(factory.createIdentifier('s'))] : [];
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(promiseResolve, factory.createIdentifier('then')),
      [factory.createArrowFunction(parameters, requireCall)],
    );
  }

  private rewriteImportOrRequireCall(node: CallExpression): Node {
    const factory = this.factory;
    const expression = this.visitNode(node.expression)!;
    let args = node.arguments;
    const nodes = args.nodes;
    if (nodes.length > 0) {
      const first = this.visitNode(nodes[0])!;
      const rewritten =
        first instanceof StringLiteral || first.kind === SyntaxKind.NoSubstitutionTemplateLiteral
          ? rewriteModuleSpecifier(this.context, first, this.options)
          : factory.createRewriteRelativeImportExtensionsHelper(first, this.options.jsx === JsxEmit.Preserve);
      const rest = nodes.slice(1);
      const visitedRest = this.visitArray(rest);
      if (rewritten !== nodes[0] || visitedRest !== rest)
        args = new NodeList(args.pos, args.end, [rewritten].concat(visitedRest));
    }
    return factory.updateCallExpression(node, expression, callQuestionDotToken(node), undefined, args, node.flags);
  }

  private visitTaggedTemplateExpression(node: TaggedTemplateExpression): Node {
    const tag = node.tag;
    if (!(tag instanceof Identifier)) return this.visitEachChild(node);
    const expression = this.visitExpressionIdentifier(tag);
    const updated = this.factory.updateTaggedTemplateExpression(
      node,
      expression,
      undefined,
      undefined,
      this.visitNode(node.template)!,
      node.flags,
    );
    if (!(expression instanceof Identifier) && (this.context.getEmitFlags(tag) & EmitFlags.HelperName) === 0)
      this.context.addEmitFlags(updated, EmitFlags.IndirectCall);
    return updated;
  }

  private visitShorthandPropertyAssignment(node: ShorthandPropertyAssignment): Node {
    const factory = this.factory;
    const name = node.name;
    const reference = name instanceof Identifier ? this.visitExpressionIdentifier(name) : name;
    if (reference !== name) {
      // `{ x }` becomes `{ x: exports.x }`; with an initializer, it's part of a destructuring assignment.
      let expression = reference;
      if (node.objectAssignmentInitializer !== undefined)
        expression = factory.createAssignment(expression, this.visitNode(node.objectAssignmentInitializer)!);
      const assignment = factory.createPropertyAssignment(name, expression);
      assignment.pos = node.pos;
      assignment.end = node.end;
      this.context.assignCommentAndSourceMapRanges(assignment, node);
      return assignment;
    }
    return factory.updateShorthandPropertyAssignment(
      node,
      undefined,
      reference,
      undefined,
      undefined,
      node.equalsToken,
      this.visitNode(node.objectAssignmentInitializer),
    );
  }

  /** `exports.x` for an exported name, `mod_1.x` or `mod_1.default` for an import. */
  private visitExpressionIdentifier(node: Identifier): Node {
    const context = this.context;
    const factory = this.factory;
    const info = context.getAutoGenerateInfo(node);
    if (
      (info !== undefined && (info.flags & GeneratedIdentifierFlags.AllowNameSubstitution) === 0) ||
      (context.getEmitFlags(node) & (EmitFlags.HelperName | EmitFlags.LocalName)) !== 0 ||
      isDeclarationNameOfEnumOrNamespace(context.mostOriginal(node))
    )
      return node;
    const location = context.mostOriginal(node);
    if (!(location instanceof Identifier)) return node;
    // Generated names, such as the JSX transform's `_jsx`, may still refer to an import.
    const synthesized = (location.flags & NodeFlags.Synthesized) !== 0;
    const container = synthesized
      ? undefined
      : this.resolver.getReferencedExportContainer(
          location as Identifier,
          (context.getEmitFlags(node) & EmitFlags.ExportName) !== 0,
        );
    if (container instanceof SourceFile) {
      const reference = factory.createPropertyAccessExpression(
        factory.createIdentifier('exports'),
        factory.cloneIdentifier(node),
      );
      context.assignCommentAndSourceMapRanges(reference, node);
      reference.pos = node.pos;
      reference.end = node.end;
      return reference;
    }
    const declaration = this.resolver.getReferencedImportDeclaration(location as Identifier);
    if (declaration instanceof ImportClause && declaration.parent !== undefined) {
      const reference = factory.createPropertyAccessExpression(
        factory.createGeneratedNameForNode(declaration.parent, 0, '', ''),
        factory.createIdentifier('default'),
      );
      context.assignCommentAndSourceMapRanges(reference, node);
      reference.pos = node.pos;
      reference.end = node.end;
      return reference;
    }
    if (declaration instanceof ImportSpecifier) {
      const imported = declaration.propertyName !== undefined ? declaration.propertyName : declaration.name;
      const importDeclaration = findImportDeclaration(declaration);
      const target = factory.createGeneratedNameForNode(
        importDeclaration !== undefined ? importDeclaration : declaration,
        0,
        '',
        '',
      );
      let reference: Node;
      if (imported instanceof StringLiteral)
        reference = factory.createElementAccessExpression(target, factory.createStringLiteralFromNode(imported));
      else {
        const name = imported instanceof Identifier ? factory.cloneIdentifier(imported) : imported;
        context.addEmitFlags(name, EmitFlags.NoSourceMap | EmitFlags.NoComments);
        reference = factory.createPropertyAccessExpression(target, name);
      }
      context.assignCommentAndSourceMapRanges(reference, node);
      reference.pos = node.pos;
      reference.end = node.end;
      return reference;
    }
    return node;
  }

  /** The export names of what `name` refers to. */
  private getExports(name: Identifier): Node[] | undefined {
    const context = this.context;
    const info = this.moduleInfo();
    if (!context.hasAutoGenerateInfo(name)) {
      const location = context.mostOriginal(name);
      if (!(location instanceof Identifier) || (location.flags & NodeFlags.Synthesized) !== 0) return undefined;
      const importDeclaration = this.resolver.getReferencedImportDeclaration(location as Identifier);
      if (importDeclaration !== undefined) return info.getExportedBindings(importDeclaration);
      // An exported namespace or enum may merge with ambient declarations, so all value declarations count.
      const declarations = this.resolver.getReferencedValueDeclarations(location as Identifier);
      if (declarations === undefined) return undefined;
      const bindings: Node[] = [];
      for (let i = 0; i < declarations.length; i++) {
        const exported = info.getExportedBindings(declarations[i]);
        if (exported === undefined) continue;
        for (let j = 0; j < exported.length; j++) if (bindings.indexOf(exported[j]) < 0) bindings.push(exported[j]);
      }
      return bindings;
    }
    if (this.isFileLevelReservedGeneratedIdentifier(name)) {
      const specifiers = info.exportSpecifiers.get(name.text);
      if (specifiers === undefined) return undefined;
      const names: Node[] = [];
      for (let i = 0; i < specifiers.length; i++) names.push(specifiers[i].name);
      return names;
    }
    return undefined;
  }

  private isFileLevelReservedGeneratedIdentifier(name: Identifier): boolean {
    const info = this.context.getAutoGenerateInfo(name);
    const flags =
      GeneratedIdentifierFlags.FileLevel |
      GeneratedIdentifierFlags.Optimistic |
      GeneratedIdentifierFlags.ReservedInNestedScopes;
    return info !== undefined && (info.flags & flags) === flags;
  }
}

/** Builds the statements of an exported variable statement, grouping declarations and assignments. */
class ExportedVariableSplitter {
  readonly owner: CommonJSModuleTransformer;
  readonly node: VariableStatement;
  readonly statements: Node[];
  private variables: Node[];
  private expressions: Node[];
  private modifiers: ModifierList | undefined;
  private hasModifiers: boolean;

  constructor(owner: CommonJSModuleTransformer, node: VariableStatement) {
    this.owner = owner;
    this.node = node;
    this.statements = [];
    this.variables = [];
    this.expressions = [];
    this.modifiers = undefined;
    this.hasModifiers = false;
  }

  ensureModifiers(): boolean {
    if (!this.hasModifiers) {
      this.modifiers = this.owner.extractModifiers(this.node.modifiers, ~exportDefault);
      this.hasModifiers = true;
    }
    return true;
  }

  pushVariable(variable: Node): boolean {
    this.commitExpressions();
    this.variables.push(variable);
    return true;
  }

  pushExpression(expression: Node): boolean {
    this.commitVariables();
    this.expressions.push(expression);
    return true;
  }

  commitVariables(): boolean {
    if (this.variables.length === 0) return false;
    const factory = this.owner.factory;
    const list = this.node.declarationList;
    const statement = factory.updateVariableStatement(
      this.node,
      this.modifiers,
      factory.updateVariableDeclarationList(list, factory.createNodeList(this.variables), list.flags),
    );
    if (this.statements.length > 0) this.owner.context.addEmitFlags(statement, EmitFlags.NoComments);
    this.statements.push(statement as Node);
    this.variables = [];
    return true;
  }

  commitExpressions(): boolean {
    if (this.expressions.length === 0) return false;
    const factory = this.owner.factory;
    const statement = factory.createExpressionStatement(factory.inlineExpressions(this.expressions)!);
    this.owner.context.assignCommentAndSourceMapRanges(statement, this.node);
    if (this.statements.length > 0) this.owner.context.addEmitFlags(statement, EmitFlags.NoComments);
    this.statements.push(statement);
    this.expressions = [];
    return true;
  }
}

function appendAll(target: Node[], source: readonly Node[]): Node[] {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
  return target;
}

function standardPrologueEnd(statements: readonly Node[]): number {
  let i = 0;
  while (i < statements.length && isPrologueDirective(statements[i])) i++;
  return i;
}

function bindingElementsOf(node: Node): Node[] {
  const elements = getElements(node);
  return elements === undefined ? [] : elements.nodes;
}

function bindingNameOf(node: Node): Node | undefined {
  return getName(node);
}

function declarationNameOf(node: Node): Node | undefined {
  return getName(node);
}

function namespaceNameOf(node: Node): Node {
  return getName(node)!;
}

function findImportDeclaration(node: Node): ImportDeclaration | undefined {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current instanceof ImportDeclaration) return current as ImportDeclaration;
  return undefined;
}

function isDeclarationNameOfEnumOrNamespace(original: Node): boolean {
  const parent = original.parent;
  if (parent === undefined) return false;
  if (parent.kind !== SyntaxKind.EnumDeclaration && parent.kind !== SyntaxKind.ModuleDeclaration) return false;
  return getName(parent) === original;
}

/** A literal or keyword: copied into several places without side effects. */
function isSimpleInlineableExpression(node: Node): boolean {
  return !(node instanceof Identifier) && isSimpleCopiableExpression(node);
}

/** Whether a file has `import()` calls. */
function containsDynamicImport(file: SourceFile): boolean {
  const finder = new DynamicImportFinder();
  return file.forEachChild(finder);
}

class DynamicImportFinder extends NodeVisitor {
  visitNode(node: Node): boolean {
    // `import()`, not `import.defer()`.
    if (node instanceof CallExpression && node.expression.kind === SyntaxKind.ImportKeyword) return true;
    return node.forEachChild(this);
  }
}
