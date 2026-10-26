// The declaration transform: turns a source file into its declaration file. Keeps exported and
// referenced declarations without their implementations, writes the types of declarations from
// their annotations or the resolver, and elides imports the output doesn't use.
import { getJSDoc } from '../parser.js';
import {
  BindingElement,
  BindingPattern,
  CallSignatureDeclaration,
  ClassDeclaration,
  ClassExpression,
  ComputedPropertyName,
  ConditionalTypeNode,
  ConstructSignatureDeclaration,
  ConstructorDeclaration,
  ConstructorTypeNode,
  EnumDeclaration,
  EnumMember,
  ExportAssignment,
  ExportDeclaration,
  ExpressionWithTypeArguments,
  ExternalModuleReference,
  FileReference,
  ArrayTypeNode,
  ArrowFunction,
  BinaryExpression,
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  JSDocParameterOrPropertyTag,
  JSDocTypeLiteral,
  JSDocVariadicType,
  TypeLiteralNode,
  UnionTypeNode,
  ElementAccessExpression,
  ExportSpecifier,
  FunctionDeclaration,
  FunctionExpression,
  FunctionTypeNode,
  ImportSpecifier,
  NodeVisitor,
  PropertyAccessExpression,
  QualifiedName,
  getArguments,
  GetAccessorDeclaration,
  HeritageClause,
  Identifier,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportTypeNode,
  IndexSignatureDeclaration,
  InterfaceDeclaration,
  JSDocTypeExpression,
  KeywordTypeNode,
  LiteralTypeNode,
  MappedTypeNode,
  MethodDeclaration,
  MethodSignatureDeclaration,
  ModifierFlags,
  ModifierList,
  ModuleBlock,
  ModuleDeclaration,
  NamedExports,
  NamedImports,
  NamespaceImport,
  type Node,
  NodeFlags,
  NodeList,
  NumericLiteral,
  ParameterDeclaration,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  JSDoc,
  JSDocText,
  ScriptKind,
  SetAccessorDeclaration,
  SourceFile,
  StringLiteral,
  SyntaxList,
  Token,
  TypeAliasDeclaration,
  TypeParameterDeclaration,
  TypeQueryNode,
  TypeReferenceNode,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  getExpression,
  getHeritageClauses,
  getMembers,
  getInitializer,
  getModifiers,
  getName,
  getParameters,
  getSymbol,
  getText,
  getType,
  getTypeParameters,
  isDeclarationNode,
} from '../ast.js';
import {
  isAmbientModule,
  isAnyImportOrReExport,
  isFunctionLike,
  isGlobalScopeAugmentation,
  isInJSFile,
  isLiteralImportTypeNode,
  modifierToFlag,
  nodeIsMissing,
  nodeIsPresent,
} from '../ast-utilities.js';
import {
  JSDeclarationKind,
  getAssignmentDeclarationKind,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getElementOrPropertyAccessName,
  getThisContainer,
  isVariableDeclarationInitializedToRequire,
  getSourceFileOfNode,
  getSourceTextOfNode,
  hasDynamicName,
  hasSyntacticModifier,
  isEntityNameExpression,
  isExternalOrCommonJSModule,
  isStatic,
} from '../binder-utilities.js';
import { type Diagnostic, Diagnostics } from '../diagnostics.js';
import type { CompilerOptions } from '../options.js';
import { type OutputPathsHost, getOutputPathsFor } from '../output-paths.js';
import { getDirectoryPath, normalizeSlashes } from '../path.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { isModifier } from '../printer/utilities.js';
import {
  getLeadingCommentRanges,
  getTrailingCommentRanges,
  identifierToKeywordKind,
  isIdentifierText,
  skipTrivia,
  stringToToken,
} from '../scanner.js';
import type { CommentRange } from '../types.js';
import { getRelativePathToDirectoryOrUrl } from '../sourcemap.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  DiagnosticContext,
  DiagnosticContextKind,
  canProduceDiagnostics,
  createDiagnosticForNode,
  declarationContext,
  declarationNameContext,
  noDiagnosticContext,
} from './declarations-diagnostics.js';
import { type DeclarationEmitResolver, NodeBuilderFlags } from './declarations-resolver.js';
import { ConstantKind } from './reference-resolver.js';
import { DeclarationTracker } from './declarations-tracker.js';
import { Transformer } from './transformer.js';
import { declarationCount, getDeclarations, SymbolFlags } from '../symbol.js';

export class DeclarationTransformer extends Transformer {
  readonly host: OutputPathsHost;
  readonly options: CompilerOptions;
  readonly resolver: DeclarationEmitResolver;
  readonly tracker: DeclarationTracker;
  private readonly declarationFilePath: string;

  private needsDeclare: boolean;
  private needsScopeFixMarker: boolean;
  private resultHasScopeMarker: boolean;
  private resultHasExternalModuleIndicator: boolean;
  private enclosingDeclaration: Node;
  /** Whether types are inside an object type, where new diagnostic contexts aren't entered. */
  private suppressNewDiagnosticContexts: boolean;
  private inClassExpressionDeclaration: boolean;
  /** Transformed top-level declarations by original node; undefined for removed ones. */
  private lateStatementReplacements: Map<Node, Node | undefined>;
  /** Functions with assigned properties (`f.x = 1`), transformed, by statement. */
  private readonly expandoHosts: Map<Node, Node | undefined>;
  /** The namespace members for the assigned properties of each function, by statement. */
  private readonly expandoMembers: Map<Node, Node[]>;
  /** Assigned properties of hosts that weren't visible when found, by host; written if the host becomes visible. */
  private readonly deferredExpandoAssignments: Map<Node, BinaryExpression[]>;
  /** The `export =` for a CommonJS `module.exports = …`. */
  private cjsExportAssignment: Node | undefined;
  /** The exports for CommonJS `exports.x = …` assignments. */
  private cjsExportMembers: Node[];
  /** The name of the `module.exports` value, which `exports.x` members are nested in. */
  private cjsExportAssignmentName: Identifier | undefined;
  private readonly witnessedCjsExports: Set<string>;
  /** `this.x` members found in a JavaScript class, and their keys. */
  private thisPropertyAssignments: Node[];
  private readonly seenProperties: Set<string>;

  constructor(
    context: EmitContext,
    host: OutputPathsHost,
    options: CompilerOptions,
    resolver: DeclarationEmitResolver,
    declarationFilePath: string,
  ) {
    super(context);
    this.host = host;
    this.options = options;
    this.resolver = resolver;
    this.tracker = new DeclarationTracker(
      resolver,
      options.isolatedDeclarations === true,
      options.stripInternal === true,
    );
    this.declarationFilePath = declarationFilePath;
    this.needsDeclare = true;
    this.needsScopeFixMarker = false;
    this.resultHasScopeMarker = false;
    this.resultHasExternalModuleIndicator = false;
    this.enclosingDeclaration = context.factory.createToken(SyntaxKind.Unknown);
    this.suppressNewDiagnosticContexts = false;
    this.inClassExpressionDeclaration = false;
    this.lateStatementReplacements = new Map<Node, Node | undefined>();
    this.expandoHosts = new Map<Node, Node | undefined>();
    this.expandoMembers = new Map<Node, Node[]>();
    this.deferredExpandoAssignments = new Map<Node, BinaryExpression[]>();
    this.cjsExportAssignment = undefined;
    this.cjsExportMembers = [];
    this.cjsExportAssignmentName = undefined;
    this.witnessedCjsExports = new Set<string>();
    this.thisPropertyAssignments = [];
    this.seenProperties = new Set<string>();
  }

  get diagnostics(): Diagnostic[] {
    return this.tracker.diagnostics;
  }

  visit(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) {
          const narrowed: SourceFile = node;
          return this.visitSourceFile(narrowed);
        }
        break;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.VariableStatement:
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
      case SyntaxKind.ExportDeclaration:
      case SyntaxKind.ExportAssignment:
        return this.visitDeclarationStatement(node);
      case SyntaxKind.BreakStatement:
      case SyntaxKind.ContinueStatement:
      case SyntaxKind.DebuggerStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.EmptyStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.IfStatement:
      case SyntaxKind.LabeledStatement:
      case SyntaxKind.ReturnStatement:
      case SyntaxKind.SwitchStatement:
      case SyntaxKind.ThrowStatement:
      case SyntaxKind.TryStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.WithStatement:
      case SyntaxKind.NotEmittedStatement:
      case SyntaxKind.Block:
      case SyntaxKind.MissingDeclaration:
      case SyntaxKind.ExpressionStatement:
        return undefined;
    }
    return this.visitDeclarationSubtree(node);
  }

  // Source files

  private visitSourceFile(file: SourceFile): Node {
    if (file.isDeclarationFile) return file;
    this.needsDeclare = true;
    this.needsScopeFixMarker = false;
    this.resultHasScopeMarker = false;
    this.resultHasExternalModuleIndicator = false;
    this.enclosingDeclaration = file;
    this.suppressNewDiagnosticContexts = false;
    this.lateStatementReplacements = new Map<Node, Node | undefined>();
    this.expandoHosts.clear();
    this.expandoMembers.clear();
    this.deferredExpandoAssignments.clear();
    this.witnessedCjsExports.clear();
    this.cjsExportAssignment = undefined;
    this.cjsExportAssignmentName = undefined;
    this.cjsExportMembers = [];
    const tracker = this.tracker;
    tracker.diagnosticContext = noDiagnosticContext;
    tracker.lateMarkedStatements = [];
    tracker.currentSourceFile = file;
    this.resolver.precalculateDeclarationEmitVisibility(this.originalSourceFile(file));
    // `module.exports =` first: `exports.x` members are nested under its name.
    if (file.commonJSModuleIndicator !== undefined)
      file.forEachChild(new ExpressionWalker(this, ExpressionWalkerKind.ModuleExports));
    file.forEachChild(new ExpressionWalker(this, ExpressionWalkerKind.Members));
    const statements = this.visitNodes(file.statements)!;
    let combined = this.appendCjsExports(this.transformAndReplaceLatePaintedStatements(statements));
    combined.pos = statements.pos;
    combined.end = statements.end;
    if (isExternalOrCommonJSModule(file) && file.isJS()) this.reportMultipleModuleExports(file);
    if (
      isExternalOrCommonJSModule(file) &&
      (!this.resultHasExternalModuleIndicator || (this.needsScopeFixMarker && !this.resultHasScopeMarker))
    ) {
      const nodes = combined.nodes.slice();
      nodes.push(this.createEmptyExports());
      const withMarker = new NodeList(combined.pos, combined.end, nodes);
      combined = withMarker;
    }
    const result = this.factory.updateSourceFile(file, combined, file.endOfFileToken);
    // Always a new node: references and the declaration flag differ from the input.
    const updated =
      result === file
        ? this.factory.updateSourceFile(
            file,
            new NodeList(combined.pos, combined.end, combined.nodes),
            file.endOfFileToken,
          )
        : result;
    updated.isDeclarationFile = true;
    updated.libReferenceDirectives = preservedReferences(file.libReferenceDirectives);
    updated.typeReferenceDirectives = preservedReferences(file.typeReferenceDirectives);
    updated.referencedFiles = this.getReferencedFiles(
      file,
      getDirectoryPath(normalizeSlashes(this.declarationFilePath)),
    );
    tracker.currentSourceFile = undefined;
    this.cjsExportAssignment = undefined;
    this.cjsExportAssignmentName = undefined;
    this.cjsExportMembers = [];
    return updated;
  }

  private originalSourceFile(file: SourceFile): SourceFile {
    const original = this.context.mostOriginal(file);
    if (original === undefined || original.kind !== SyntaxKind.SourceFile) return file;
    return original as SourceFile;
  }

  private appendCjsExports(statements: NodeList): NodeList {
    if (this.cjsExportAssignment === undefined && this.cjsExportMembers.length === 0) return statements;
    const result: Node[] = [];
    if (this.cjsExportAssignment !== undefined) appendFlattened(result, this.cjsExportAssignment);
    for (const member of this.cjsExportMembers) appendFlattened(result, member);
    for (const statement of statements.nodes) result.push(statement);
    return this.factory.createNodeList(result);
  }

  private reportMultipleModuleExports(file: SourceFile): boolean {
    const symbol = file.symbol;
    const exportEquals =
      symbol === undefined || symbol.exports === undefined ? undefined : symbol.exports.get('export=');
    if (exportEquals === undefined || declarationCount(exportEquals) <= 1) return false;
    for (const declaration of getDeclarations(exportEquals))
      this.tracker.addDiagnostic(
        createDiagnosticForNode(
          declaration,
          Diagnostics.Multiple_module_exports_assignments_cannot_be_serialized_for_declaration_emit,
          [],
        ),
      );
    return true;
  }

  private createEmptyExports(): Node {
    return this.factory.created(
      new ExportDeclaration(
        undefined,
        false,
        this.factory.created(new NamedExports(this.factory.createNodeList([]))),
        undefined,
        undefined,
      ),
    );
  }

  /** `/// <reference path>` directives with `preserve="true"`, relative to the output. */
  private getReferencedFiles(file: SourceFile, outputDirectory: string): FileReference[] {
    const result: FileReference[] = [];
    for (const reference of file.referencedFiles) {
      if (!reference.preserve) continue;
      const target = this.resolver.getSourceFileFromReference(file, reference);
      if (target === undefined) continue;
      let fileName = target.fileName;
      if (!target.isDeclarationFile) {
        // The referenced file's declaration output, else its JavaScript output.
        const paths = getOutputPathsFor(
          target.fileName,
          target.scriptKind === ScriptKind.JSON,
          this.options,
          this.host,
          true,
        );
        fileName = paths.declarationFilePath !== '' ? paths.declarationFilePath : paths.jsFilePath;
        if (fileName === '') fileName = target.fileName;
      }
      if (fileName === '') continue;
      const relative = getRelativePathToDirectoryOrUrl(
        outputDirectory,
        fileName,
        this.host.useCaseSensitiveFileNames,
        this.host.currentDirectory,
      );
      result.push(new FileReference(-1, -1, relative, reference.resolutionMode, reference.preserve));
    }
    return result;
  }

  /**
   * Replaces top-level declarations with their transformed forms. Transforming a declaration can
   * mark more unexported declarations as referenced, so this runs until none are left.
   */
  private transformAndReplaceLatePaintedStatements(statements: NodeList): NodeList {
    const tracker = this.tracker;
    while (tracker.lateMarkedStatements.length > 0) {
      const next = tracker.lateMarkedStatements.shift()!;
      const saveNeedsDeclare = this.needsDeclare;
      this.needsDeclare = next.parent !== undefined && next.parent.kind === SyntaxKind.SourceFile;
      const result = this.transformTopLevelDeclaration(next);
      this.needsDeclare = saveNeedsDeclare;
      this.lateStatementReplacements.set(this.context.mostOriginal(next), result);
    }
    const results: Node[] = [];
    for (const statement of statements.nodes) {
      if (!isLateVisibilityPaintedStatement(statement)) {
        results.push(statement);
        continue;
      }
      const original = this.context.mostOriginal(statement);
      if (!this.lateStatementReplacements.has(original)) {
        results.push(statement);
        continue;
      }
      const replacement = this.lateStatementReplacements.get(original);
      if (replacement === undefined) continue;
      const atTopLevel = statement.parent !== undefined && statement.parent.kind === SyntaxKind.SourceFile;
      if (replacement instanceof SyntaxList) {
        if (!this.needsScopeFixMarker || !this.resultHasExternalModuleIndicator)
          for (const child of replacement.children) {
            if (needsScopeMarker(child)) this.needsScopeFixMarker = true;
            if (atTopLevel && isExternalModuleIndicator(child)) this.resultHasExternalModuleIndicator = true;
          }
        for (const child of replacement.children) results.push(child);
      } else {
        if (needsScopeMarker(replacement)) this.needsScopeFixMarker = true;
        if (atTopLevel && isExternalModuleIndicator(replacement)) this.resultHasExternalModuleIndicator = true;
        results.push(replacement);
      }
    }
    return this.factory.createNodeList(results);
  }

  // Diagnostic contexts

  private enterDiagnosticContext(input: Node): DiagnosticScope {
    const tracker = this.tracker;
    const scope = new DiagnosticScope(
      tracker.diagnosticContext,
      tracker.errorNameNode,
      this.suppressNewDiagnosticContexts,
    );
    if (canProduceDiagnostics(input) && !this.suppressNewDiagnosticContexts)
      tracker.diagnosticContext = declarationContext(input);
    if (
      (input.kind === SyntaxKind.TypeLiteral || input.kind === SyntaxKind.MappedType) &&
      input.parent !== undefined &&
      input.parent.kind !== SyntaxKind.TypeAliasDeclaration &&
      input.parent.kind !== SyntaxKind.JSTypeAliasDeclaration
    )
      this.suppressNewDiagnosticContexts = true;
    return scope;
  }

  private exitDiagnosticContext(scope: DiagnosticScope): boolean {
    this.tracker.diagnosticContext = scope.context;
    this.tracker.errorNameNode = scope.errorNameNode;
    this.suppressNewDiagnosticContexts = scope.suppressNewDiagnosticContexts;
    return true;
  }

  // Declarations below the top level

  private visitDeclarationSubtree(input: Node): Node | undefined {
    if (input === undefined) return undefined;
    if (this.shouldStripInternal(input)) return undefined;
    if (isDeclaration(input)) {
      if (this.isDeclarationAndNotVisible(input)) return undefined;
      if (hasDynamicName(input)) {
        const expression = getExpression(getName(input)!)!;
        if (this.tracker.isolatedDeclarations) {
          // Computed names that aren't literal types can't be checked without types.
          if (!this.resolver.isDefinitelyReferenceToGlobalSymbolObject(expression)) {
            const parentKind = input.parent!.kind;
            if (parentKind === SyntaxKind.ClassDeclaration || parentKind === SyntaxKind.ObjectLiteralExpression) {
              this.tracker.addDiagnostic(
                createDiagnosticForNode(
                  input,
                  Diagnostics.Computed_property_names_on_class_or_object_literals_cannot_be_inferred_with_isolatedDeclarations,
                  [],
                ),
              );
              return undefined;
            }
            if (
              (parentKind === SyntaxKind.InterfaceDeclaration || parentKind === SyntaxKind.TypeLiteral) &&
              !isEntityNameExpression(expression, false)
            ) {
              this.tracker.addDiagnostic(
                createDiagnosticForNode(
                  input,
                  Diagnostics.Computed_properties_must_be_number_or_string_literals_variables_or_dotted_expressions_with_isolatedDeclarations,
                  [],
                ),
              );
              return undefined;
            }
          }
        } else if (!this.resolver.isLateBound(this.parseNode(input)) || !isEntityNameExpression(expression, false))
          return undefined;
      }
    }
    // Implementations of overloads are elided.
    if (isFunctionLike(input) && this.resolver.isImplementationOfOverload(input)) return undefined;
    if (input.kind === SyntaxKind.SemicolonClassElement) return undefined;
    if (input instanceof HeritageClause) {
      const types = input.types.nodes;
      if (types.length === 0 || (types.length === 1 && nodeIsMissing(types[0]))) return undefined;
    }
    const previousEnclosingDeclaration = this.enclosingDeclaration;
    if (isEnclosingDeclaration(input)) this.enclosingDeclaration = input;
    const canProduceDiagnostic = canProduceDiagnostics(input);
    const scope = this.enterDiagnosticContext(input);
    const result = this.transformDeclarationSubtree(input);
    if (result !== undefined && canProduceDiagnostic && hasDynamicName(input)) this.checkName(input);
    this.exitDiagnosticContext(scope);
    this.enclosingDeclaration = previousEnclosingDeclaration;
    return result;
  }

  private transformDeclarationSubtree(input: Node): Node | undefined {
    switch (input.kind) {
      case SyntaxKind.MappedType:
        if (input instanceof MappedTypeNode) {
          const narrowed: MappedTypeNode = input;
          return this.transformMappedType(narrowed);
        }
        break;
      case SyntaxKind.HeritageClause:
        if (input instanceof HeritageClause) {
          const narrowed: HeritageClause = input;
          return this.transformHeritageClause(narrowed);
        }
        break;
      case SyntaxKind.MethodSignature:
        if (input instanceof MethodSignatureDeclaration) {
          const narrowed: MethodSignatureDeclaration = input;
          return this.transformMethodSignature(narrowed);
        }
        break;
      case SyntaxKind.MethodDeclaration:
        if (input instanceof MethodDeclaration) {
          const narrowed: MethodDeclaration = input;
          return this.transformMethodDeclaration(narrowed);
        }
        break;
      case SyntaxKind.ConstructSignature:
        if (input instanceof ConstructSignatureDeclaration) {
          const narrowed: ConstructSignatureDeclaration = input;
          return this.transformConstructSignature(narrowed);
        }
        break;
      case SyntaxKind.Constructor:
        if (input instanceof ConstructorDeclaration) {
          const narrowed: ConstructorDeclaration = input;
          return this.transformConstructor(narrowed);
        }
        break;
      case SyntaxKind.GetAccessor:
        if (input instanceof GetAccessorDeclaration) {
          const narrowed: GetAccessorDeclaration = input;
          return this.transformGetAccessor(narrowed);
        }
        break;
      case SyntaxKind.SetAccessor:
        if (input instanceof SetAccessorDeclaration) {
          const narrowed: SetAccessorDeclaration = input;
          return this.transformSetAccessor(narrowed);
        }
        break;
      case SyntaxKind.PropertyDeclaration:
        if (input instanceof PropertyDeclaration) {
          const narrowed: PropertyDeclaration = input;
          return this.transformPropertyDeclaration(narrowed);
        }
        break;
      case SyntaxKind.PropertySignature:
        if (input instanceof PropertySignatureDeclaration) {
          const narrowed: PropertySignatureDeclaration = input;
          return this.transformPropertySignature(narrowed);
        }
        break;
      case SyntaxKind.CallSignature:
        if (input instanceof CallSignatureDeclaration) {
          const narrowed: CallSignatureDeclaration = input;
          return this.transformCallSignature(narrowed);
        }
        break;
      case SyntaxKind.IndexSignature:
        if (input instanceof IndexSignatureDeclaration) {
          const narrowed: IndexSignatureDeclaration = input;
          return this.transformIndexSignature(narrowed);
        }
        break;
      case SyntaxKind.VariableDeclaration:
        if (input instanceof VariableDeclaration) {
          const narrowed: VariableDeclaration = input;
          return this.transformVariableDeclaration(narrowed);
        }
        break;
      case SyntaxKind.TypeParameter:
        if (input instanceof TypeParameterDeclaration) {
          const narrowed: TypeParameterDeclaration = input;
          return this.transformTypeParameter(narrowed);
        }
        break;
      case SyntaxKind.ExpressionWithTypeArguments: {
        const expression = (input as ExpressionWithTypeArguments).expression;
        if (isEntityName(expression) || isEntityNameExpression(expression, false))
          this.checkEntityNameVisibility(expression, this.enclosingDeclaration);
        return this.visitEachChild(input);
      }
      case SyntaxKind.TypeReference:
        this.checkEntityNameVisibility((input as TypeReferenceNode).typeName, this.enclosingDeclaration);
        return this.visitEachChild(input);
      case SyntaxKind.ConditionalType:
        if (input instanceof ConditionalTypeNode) {
          const narrowed: ConditionalTypeNode = input;
          return this.transformConditionalType(narrowed);
        }
        break;
      case SyntaxKind.FunctionType:
        if (input instanceof FunctionTypeNode) {
          const narrowed: FunctionTypeNode = input;
          return this.transformFunctionType(narrowed);
        }
        break;
      case SyntaxKind.ConstructorType:
        if (input instanceof ConstructorTypeNode) {
          const narrowed: ConstructorTypeNode = input;
          return this.transformConstructorType(narrowed);
        }
        break;
      case SyntaxKind.ImportType:
        if (input instanceof ImportTypeNode) {
          const narrowed: ImportTypeNode = input;
          return this.transformImportType(narrowed);
        }
        break;
      case SyntaxKind.TypeQuery:
        this.checkEntityNameVisibility((input as TypeQueryNode).exprName, this.enclosingDeclaration);
        return this.visitEachChild(input);
      case SyntaxKind.TupleType: {
        const result = this.visitEachChild(input);
        if (isOriginalNodeSingleLine(this.context, input)) this.context.addEmitFlags(result, EmitFlags.SingleLine);
        return result;
      }
      case SyntaxKind.JSDocTypeExpression:
        return this.visitNode((input as JSDocTypeExpression).type);
      case SyntaxKind.JSDocAllType:
        return this.replaceWith(input, this.keyword(SyntaxKind.AnyKeyword));
      case SyntaxKind.JSDocNullableType:
        // `?T` is `T | null`.
        return this.replaceWith(
          input,
          this.createUnion(
            this.visitNode((input as JSDocNullableType).type)!,
            this.factory.created(new LiteralTypeNode(this.factory.createKeywordExpression(SyntaxKind.NullKeyword))),
          ),
        );
      case SyntaxKind.JSDocNonNullableType:
        return this.visitNode((input as JSDocNonNullableType).type);
      case SyntaxKind.JSDocOptionalType:
        // `T=` is `T | undefined`.
        return this.replaceWith(
          input,
          this.createUnion(
            this.visitNode((input as JSDocOptionalType).type)!,
            this.keyword(SyntaxKind.UndefinedKeyword),
          ),
        );
      case SyntaxKind.JSDocVariadicType:
        // `...T` is `T[]`.
        return this.replaceWith(
          input,
          this.factory.created(new ArrayTypeNode(this.visitNode((input as JSDocVariadicType).type)!)),
        );
      case SyntaxKind.JSDocTypeLiteral: {
        const members = this.visitArray((input as JSDocTypeLiteral).jsdocPropertyTags ?? []);
        return this.replaceWith(input, this.factory.created(new TypeLiteralNode(this.factory.createNodeList(members))));
      }
      case SyntaxKind.JSDocPropertyTag: {
        const tag = input as JSDocParameterOrPropertyTag;
        const type = tag.typeExpression === undefined ? undefined : this.visitNode(tag.typeExpression);
        return this.replaceWith(
          input,
          this.factory.created(
            new PropertySignatureDeclaration(undefined, this.visitNode(tag.name)!, undefined, type, undefined),
          ),
        );
      }
    }
    return this.visitEachChild(input);
  }

  private createUnion(first: Node, second: Node): Node {
    return this.factory.created(new UnionTypeNode(this.factory.createNodeList([first, second])));
  }

  private replaceWith(original: Node, replacement: Node): Node {
    this.context.setOriginal(replacement, original);
    return replacement;
  }

  private keyword(kind: SyntaxKind): Node {
    return this.factory.created(new KeywordTypeNode(kind));
  }

  private checkName(node: Node): boolean {
    const tracker = this.tracker;
    const oldContext = tracker.diagnosticContext;
    if (!this.suppressNewDiagnosticContexts) tracker.diagnosticContext = declarationNameContext(node);
    const name = getName(node)!;
    tracker.errorNameNode = name;
    this.checkEntityNameVisibility(getExpression(name)!, this.enclosingDeclaration);
    if (!this.suppressNewDiagnosticContexts) tracker.diagnosticContext = oldContext;
    tracker.errorNameNode = undefined;
    return true;
  }

  private checkEntityNameVisibility(entityName: Node, enclosingDeclaration: Node): boolean {
    return this.tracker.handleSymbolAccessibilityError(
      this.resolver.isEntityNameVisible(entityName, enclosingDeclaration),
    );
  }

  private transformMappedType(input: MappedTypeNode): Node {
    // The printer needs a template type.
    const type = input.type === undefined ? this.keyword(SyntaxKind.AnyKeyword) : this.visitNode(input.type);
    return this.factory.updateMappedTypeNode(
      input,
      input.readonlyToken,
      this.visitNode(input.typeParameter) as TypeParameterDeclaration,
      this.visitNode(input.nameType),
      input.questionToken,
      type,
      undefined,
    );
  }

  private transformHeritageClause(clause: HeritageClause): Node | undefined {
    const types = clause.types.nodes;
    const retained: Node[] = [];
    for (const type of types) {
      const expression = (type as ExpressionWithTypeArguments).expression;
      if (
        isEntityNameExpression(expression, false) ||
        (clause.token === SyntaxKind.ExtendsKeyword && expression.kind === SyntaxKind.NullKeyword)
      )
        retained.push(type);
    }
    if (retained.length === 0) return undefined;
    if (retained.length === types.length) return this.visitEachChild(clause);
    return this.factory.updateHeritageClause(
      clause,
      clause.token,
      this.visitNodes(this.factory.createNodeList(retained))!,
    );
  }

  private transformImportType(input: ImportTypeNode): Node {
    if (!isLiteralImportTypeNode(input)) return input;
    const argument = input.argument as LiteralTypeNode;
    return this.factory.updateImportTypeNode(
      input,
      input.isTypeOf,
      this.factory.updateLiteralTypeNode(argument, this.rewriteModuleSpecifier(input, argument.literal)!),
      input.attributes,
      input.qualifier,
      this.visitNodes(input.typeArguments),
    );
  }

  private transformConstructorType(input: ConstructorTypeNode): Node {
    return this.factory.updateConstructorTypeNode(
      input,
      this.ensureModifiers(input),
      this.visitNodes(input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.visitNode(input.type),
    );
  }

  private transformFunctionType(input: FunctionTypeNode): Node {
    return this.factory.updateFunctionTypeNode(
      input,
      this.visitNodes(input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.visitNode(input.type),
    );
  }

  private transformConditionalType(input: ConditionalTypeNode): Node {
    const checkType = this.visitNode(input.checkType)!;
    const extendsType = this.visitNode(input.extendsType)!;
    const previousEnclosingDeclaration = this.enclosingDeclaration;
    this.enclosingDeclaration = input.trueType;
    const trueType = this.visitNode(input.trueType)!;
    this.enclosingDeclaration = previousEnclosingDeclaration;
    const falseType = this.visitNode(input.falseType)!;
    return this.factory.updateConditionalTypeNode(input, checkType, extendsType, trueType, falseType);
  }

  private transformTypeParameter(input: TypeParameterDeclaration): Node {
    // Type parameters of private methods lose their constraints and defaults.
    const parent = input.parent;
    if (
      parent !== undefined &&
      parent.kind === SyntaxKind.MethodDeclaration &&
      this.isPrivate(parent) &&
      (input.defaultType !== undefined || input.constraint !== undefined)
    )
      return this.factory.updateTypeParameterDeclaration(
        input,
        input.modifiers,
        input.name,
        undefined,
        input.expression,
        undefined,
      );
    return this.visitEachChild(input);
  }

  private transformVariableDeclaration(input: VariableDeclaration): Node | undefined {
    const file = this.tracker.currentSourceFile;
    if (
      file !== undefined &&
      file.commonJSModuleIndicator !== undefined &&
      isVariableDeclarationInitializedToRequire(input)
    )
      return this.transformCjsRequireVariableDeclaration(input);
    // A binding pattern with initializers becomes a declaration per name; without them it stays.
    if (input.name instanceof BindingPattern && hasAnyBindingInitializers(input.name))
      return this.recreateBindingPattern(input.name);
    // Variable types don't enter new diagnostic contexts.
    this.suppressNewDiagnosticContexts = true;
    return this.factory.updateVariableDeclaration(
      input,
      this.visitBindingName(input.name),
      undefined,
      this.ensureType(input, false),
      this.ensureNoInitializer(input),
    );
  }

  private recreateBindingPattern(pattern: BindingPattern): Node | undefined {
    const results: Node[] = [];
    for (const element of pattern.elements.nodes) {
      if (element === undefined || !(element instanceof BindingElement)) continue;
      const result = this.recreateBindingElement(element);
      if (result instanceof SyntaxList) for (const child of result.children) results.push(child);
      else if (result !== undefined) results.push(result);
    }
    if (results.length === 0) return undefined;
    if (results.length === 1) return results[0];
    return this.factory.createSyntaxList(results);
  }

  private recreateBindingElement(element: BindingElement): Node | undefined {
    const name = element.name;
    if (name === undefined || !this.getBindingNameVisible(element)) return undefined;
    if (name instanceof BindingPattern) {
      const narrowed: BindingPattern = name;
      return this.recreateBindingPattern(narrowed);
    }
    return this.factory.createVariableDeclaration(name, undefined, this.ensureType(element, false), undefined);
  }

  private transformIndexSignature(input: IndexSignatureDeclaration): Node {
    const type = this.visitNode(input.type) ?? this.keyword(SyntaxKind.AnyKeyword);
    return this.factory.updateIndexSignatureDeclaration(
      input,
      this.ensureModifiers(input),
      this.updateParamList(input, input.parameters),
      type,
    );
  }

  private transformCallSignature(input: CallSignatureDeclaration): Node {
    return this.factory.updateCallSignatureDeclaration(
      input,
      this.ensureTypeParams(input, input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.ensureType(input, false),
    );
  }

  private transformPropertySignature(input: PropertySignatureDeclaration): Node | undefined {
    if (input.name instanceof PrivateIdentifier) return undefined;
    const result = this.factory.updatePropertySignatureDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      input.postfixToken,
      this.ensureType(input, false),
      this.ensureNoInitializer(input),
    );
    this.preservePartialJsDoc(result, input);
    return result;
  }

  /** Writes the description of a property from a JSDoc `@property` tag as its comment. */
  private preservePartialJsDoc(updated: Node, original: Node): boolean {
    if ((original.flags & NodeFlags.Reparsed) === 0) return false;
    const docs = getJSDoc(getSourceFileOfNode(original), original);
    if (docs.length === 0 || !(docs[0] instanceof JSDoc)) return false;
    const description = getTextOfJSDocComment(docs[0].comment);
    if (description === '') return false;
    const comment = '*\n * ' + description.split('\n').join('\n * ') + '\n ';
    this.context.addSyntheticLeadingComment(updated, SyntaxKind.MultiLineCommentTrivia, comment, true);
    return true;
  }

  private transformPropertyDeclaration(input: PropertyDeclaration): Node | undefined {
    if (input.name instanceof PrivateIdentifier) return undefined;
    // Definite assignment assertions (`!`) are dropped.
    const postfix = input.postfixToken;
    return this.factory.updatePropertyDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      postfix !== undefined && postfix.kind === SyntaxKind.ExclamationToken ? undefined : postfix,
      this.ensureType(input, false),
      this.ensureNoInitializer(input),
    );
  }

  private transformSetAccessor(input: SetAccessorDeclaration): Node | undefined {
    if (input.name instanceof PrivateIdentifier) return undefined;
    return this.factory.updateSetAccessorDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      undefined,
      this.updateAccessorParamList(input, this.isPrivate(this.parseNode(input))),
      undefined,
      undefined,
      undefined,
    );
  }

  private transformGetAccessor(input: GetAccessorDeclaration): Node | undefined {
    if (input.name instanceof PrivateIdentifier) return undefined;
    return this.factory.updateGetAccessorDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      undefined,
      this.updateAccessorParamList(input, this.isPrivate(this.parseNode(input))),
      this.ensureType(input, false),
      undefined,
      undefined,
    );
  }

  private updateAccessorParamList(input: Node, isPrivate: boolean): NodeList {
    const params: Node[] = [];
    const parameters = getParameters(input)!.nodes;
    if (!isPrivate) {
      const thisParameter = parameters.length > 0 && isThisParameterNode(parameters[0]) ? parameters[0] : undefined;
      if (thisParameter !== undefined) params.push(this.ensureParameterNode(thisParameter));
    }
    if (input.kind === SyntaxKind.SetAccessor) {
      let valueParameter: Node | undefined = undefined;
      if (!isPrivate) {
        if (params.length === 1 && parameters.length >= 2) valueParameter = this.ensureParameterNode(parameters[1]);
        else if (params.length === 0 && parameters.length >= 1)
          valueParameter = this.ensureParameterNode(parameters[0]);
      }
      // A missing value parameter is `value: any`, untyped when private.
      valueParameter ??= this.factory.created(
        new ParameterDeclaration(
          undefined,
          undefined,
          this.factory.createIdentifier('value'),
          undefined,
          isPrivate ? undefined : this.keyword(SyntaxKind.AnyKeyword),
          undefined,
        ),
      );
      params.push(valueParameter);
    }
    return this.factory.createNodeList(params);
  }

  private transformConstructor(input: ConstructorDeclaration): Node {
    return this.factory.updateConstructorDeclaration(
      input,
      this.ensureModifiers(input),
      undefined,
      this.updateParamList(input, input.parameters),
      undefined,
      undefined,
      undefined,
    );
  }

  private transformConstructSignature(input: ConstructSignatureDeclaration): Node {
    return this.factory.updateConstructSignatureDeclaration(
      input,
      this.ensureTypeParams(input, input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.ensureType(input, false),
    );
  }

  /** A private method is written as a property without a type. */
  private omitPrivateMethodType(input: Node): Node | undefined {
    const symbol = getSymbol(input);
    if (symbol !== undefined && declarationCount(symbol) > 0 && symbol.declaration !== input) return undefined;
    // A method signature becomes a property signature, a method a property declaration.
    let result: Node;
    if (input.kind === SyntaxKind.MethodSignature)
      result = this.factory.created(
        new PropertySignatureDeclaration(this.ensureModifiers(input), getName(input)!, undefined, undefined, undefined),
      );
    else
      result = this.factory.created(
        new PropertyDeclaration(this.ensureModifiers(input), getName(input)!, undefined, undefined, undefined),
      );
    this.context.assignCommentRange(result, input);
    return result;
  }

  private transformMethodSignature(input: MethodSignatureDeclaration): Node | undefined {
    if (this.isPrivate(this.parseNode(input))) return this.omitPrivateMethodType(input);
    if (input.name instanceof PrivateIdentifier) return undefined;
    return this.factory.updateMethodSignatureDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      input.postfixToken,
      this.ensureTypeParams(input, input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.ensureType(input, false),
    );
  }

  private transformMethodDeclaration(input: MethodDeclaration): Node | undefined {
    if (this.isPrivate(this.parseNode(input))) return this.omitPrivateMethodType(input);
    if (input.name instanceof PrivateIdentifier) return undefined;
    return this.factory.updateMethodDeclaration(
      input,
      this.ensureModifiers(input),
      undefined,
      input.name,
      input.postfixToken,
      this.ensureTypeParams(input, input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.ensureType(input, false),
      undefined,
      undefined,
    );
  }

  // Top-level declarations

  private visitDeclarationStatement(input: Node): Node | undefined {
    if (input === undefined) return undefined;
    if (this.shouldStripInternal(input)) return undefined;
    if (input instanceof ExportDeclaration) {
      if (input.parent !== undefined && input.parent.kind === SyntaxKind.SourceFile)
        this.resultHasExternalModuleIndicator = true;
      this.resultHasScopeMarker = true;
      return this.factory.updateExportDeclaration(
        input,
        input.modifiers,
        input.isTypeOnly,
        input.exportClause,
        this.rewriteModuleSpecifier(input, input.moduleSpecifier),
        this.tryGetResolutionModeOverride(input.attributes),
      );
    }
    if (input instanceof ExportAssignment)
      return this.transformExportAssignment(input, input, input.expression, input.isExportEquals);
    // Transformed later, when it's known which unexported declarations are referenced.
    const original = this.context.mostOriginal(input);
    if (this.lateStatementReplacements.get(original) === undefined)
      this.lateStatementReplacements.set(original, this.transformTopLevelDeclaration(input));
    return input;
  }

  /** `export =`, `export default` or `module.exports =` of `expression`. */
  transformExportAssignment(
    input: Node,
    assignment: Node,
    expression: Node,
    isExportEquals: boolean,
  ): Node | undefined {
    if (input.parent !== undefined && input.parent.kind === SyntaxKind.SourceFile)
      this.resultHasExternalModuleIndicator = true;
    this.resultHasScopeMarker = true;
    if (
      expression instanceof Identifier &&
      input.parent !== undefined &&
      (input.parent.kind === SyntaxKind.SourceFile || input.parent.kind === SyntaxKind.ModuleBlock)
    ) {
      const result = this.factory.created(new ExportAssignment(undefined, isExportEquals, undefined, expression));
      this.context.assignSourceMapRange(result, input);
      this.context.assignCommentRange(result, input);
      return result;
    }
    // Types the default export can't name are reported for it, as class and function declarations too.
    const tracker = this.tracker;
    tracker.diagnosticContext = new DiagnosticContext(DiagnosticContextKind.DefaultExport, input, undefined);
    tracker.pushErrorFallbackNode(assignment);
    const unwrapped = skipOuterExpressions(expression);
    const name = this.getNameOfExportedExpression(unwrapped, isExportEquals);
    // Class and function expressions become declarations.
    if (unwrapped instanceof ClassExpression || isFunctionLike(unwrapped)) {
      const declaration =
        unwrapped instanceof ClassExpression
          ? this.transformClassExpressionToDeclaration(unwrapped, name, this.declareModifiers())
          : this.transformFunctionLikeToDeclaration(unwrapped, name, this.declareModifiers(), getType(assignment));
      tracker.popErrorFallbackNode();
      this.context.assignCommentRange(declaration, input);
      const exportAssignment = this.factory.created(new ExportAssignment(undefined, isExportEquals, undefined, name));
      this.context.assignSourceMapRange(exportAssignment, input);
      this.context.addEmitFlags(exportAssignment, EmitFlags.NoComments);
      return this.factory.createSyntaxList([exportAssignment, declaration]);
    }
    // Other expressions are written as a `_default` variable with the expression's type.
    this.cjsExportAssignmentName = name;
    let initializer: Node | undefined = undefined;
    if (isPrimitiveLiteralValue(skipParenthesesOnly(expression), true))
      initializer = this.resolver.createLiteralConstValue(this.context, this.parseNode(assignment), tracker);
    const type = initializer === undefined ? this.ensureType(assignment, false) : undefined;
    const declaration = this.factory.createVariableDeclaration(name, undefined, type, initializer);
    tracker.popErrorFallbackNode();
    const statement = this.createConstStatement(declaration);
    const exportAssignment = this.factory.created(new ExportAssignment(undefined, isExportEquals, undefined, name));
    this.context.assignSourceMapRange(exportAssignment, input);
    this.context.assignCommentRange(statement, input);
    return this.factory.createSyntaxList([statement, exportAssignment]);
  }

  private createConstStatement(declaration: VariableDeclaration): Node {
    return this.factory.createVariableStatement(
      this.declareModifiers(),
      this.factory.createVariableDeclarationList(this.factory.createNodeList([declaration]), NodeFlags.Const),
    );
  }

  private transformFunctionLikeToDeclaration(
    fn: Node,
    name: Identifier,
    modifiers: ModifierList,
    fullSignatureType: Node | undefined,
  ): Node {
    // A JSDoc signature, of the function or of the assignment, is reused as the type of a `const`.
    const fullSignature = getFullSignature(fn) ?? fullSignatureType;
    if (fullSignature !== undefined)
      return this.factory.createVariableStatement(
        modifiers,
        this.factory.createVariableDeclarationList(
          this.factory.createNodeList([
            this.factory.createVariableDeclaration(name, undefined, this.visitNode(fullSignature), undefined),
          ]),
          NodeFlags.Const,
        ),
      );
    return this.factory.created(
      new FunctionDeclaration(
        modifiers,
        undefined,
        name,
        this.ensureTypeParams(fn, getTypeParameters(fn)),
        this.updateParamList(fn, getParameters(fn)!),
        this.ensureType(fn, false),
        undefined,
        undefined,
      ),
    );
  }

  /** A class expression as a declaration, for `export default (class {})` and CommonJS exports. */
  private transformClassExpressionToDeclaration(
    classExpression: ClassExpression,
    name: Identifier,
    modifiers: ModifierList,
  ): Node {
    const previousEnclosingDeclaration = this.enclosingDeclaration;
    this.enclosingDeclaration = classExpression;
    const previousInClassExpression = this.inClassExpressionDeclaration;
    this.inClassExpressionDeclaration = true;
    const extraMembers = isInJSFile(classExpression) ? this.collectThisPropertyAssignments(classExpression) : [];
    const members = this.buildClassMembers(classExpression, extraMembers);
    const typeParameters = this.ensureTypeParams(classExpression, classExpression.typeParameters);
    const heritageClauses = this.visitNodes(classExpression.heritageClauses);
    this.enclosingDeclaration = previousEnclosingDeclaration;
    this.inClassExpressionDeclaration = previousInClassExpression;
    return this.factory.created(new ClassDeclaration(modifiers, name, typeParameters, heritageClauses, members));
  }

  private declareModifiers(): ModifierList {
    return this.factory.createModifierList(
      this.needsDeclare ? [this.factory.createToken(SyntaxKind.DeclareKeyword)] : [],
    );
  }

  /** The name of the variable for an exported expression: its own name if it has one, else `_default`. */
  private getNameOfExportedExpression(expression: Node, isExportEquals: boolean): Identifier {
    const name = this.tryGetNameOfAssignedExpression(expression);
    if (name !== undefined) {
      this.cjsExportAssignmentName = name;
      return name;
    }
    const file = this.tracker.currentSourceFile;
    // Only JavaScript names `export =` expressions `_exports`.
    const base = isExportEquals && file !== undefined && file.isJS() ? '_exports' : '_default';
    const result = this.factory.createUniqueName(base, GeneratedIdentifierFlags.Optimistic);
    this.cjsExportAssignmentName = result;
    return result;
  }

  /** The name of a named function or class expression, unique if it would shadow something. */
  private tryGetNameOfAssignedExpression(expression: Node): Identifier | undefined {
    let text = '';
    if (expression.kind !== SyntaxKind.PropertyAccessExpression) {
      const name = getName(expression);
      if (name instanceof Identifier) text = name.text;
    }
    if (expression instanceof Identifier) text = expression.text;
    if (text === '' || text === 'default') return undefined;
    if (this.resolver.isNameResolvable(this.enclosingDeclaration, text))
      return this.factory.createUniqueName(text, GeneratedIdentifierFlags.Optimistic);
    return this.factory.createIdentifier(text);
  }

  private rewriteModuleSpecifier(parent: Node, input: Node | undefined): Node | undefined {
    if (input === undefined) return undefined;
    if (parent.kind !== SyntaxKind.ModuleDeclaration && parent.kind !== SyntaxKind.ImportType)
      this.resultHasExternalModuleIndicator = true;
    return input;
  }

  private tryGetResolutionModeOverride(node: ImportAttributes | undefined): ImportAttributes | undefined {
    if (node === undefined) return undefined;
    return this.resolver.getResolutionModeOverride(node) !== undefined ? node : undefined;
  }

  /** The replacement statements for a direct child of a source file or module block. */
  private transformTopLevelDeclaration(input: Node): Node | undefined {
    if (input === undefined) return undefined;
    const tracker = this.tracker;
    const marked = tracker.lateMarkedStatements;
    if (marked.length > 0) {
      const remaining: Node[] = [];
      for (const node of marked) if (node !== input) remaining.push(node);
      tracker.lateMarkedStatements = remaining;
    }
    if (this.shouldStripInternal(input)) return undefined;
    if (input instanceof ImportEqualsDeclaration) {
      const narrowed: ImportEqualsDeclaration = input;
      return this.transformImportEquals(narrowed);
    }
    if (input instanceof ImportDeclaration) {
      const result = this.transformImportDeclaration(input);
      // `import x = require()` in JavaScript is written as an import declaration.
      if (result !== undefined && result.kind !== SyntaxKind.ImportDeclaration) {
        // A copy of the declaration, as tsgo's clone: with its position and emit node.
        const clone = this.factory.created(
          new ImportDeclaration(
            SyntaxKind.ImportDeclaration,
            result.modifiers,
            result.importClause,
            result.moduleSpecifier,
            result.attributes,
          ),
        );
        clone.pos = result.pos;
        clone.end = result.end;
        this.context.setOriginal(clone, result);
        return clone;
      }
      return result;
    }
    if (isDeclaration(input) && this.isDeclarationAndNotVisible(input)) return undefined;
    if (isFunctionLike(input) && this.resolver.isImplementationOfOverload(input)) return undefined;
    const original = this.context.mostOriginal(input);
    if (this.expandoHosts.has(original) || this.deferredExpandoAssignments.has(original))
      return this.createFullExpandoBlock(original);
    const previousEnclosingDeclaration = this.enclosingDeclaration;
    if (isEnclosingDeclaration(input)) this.enclosingDeclaration = input;
    const oldContext = tracker.diagnosticContext;
    const oldName = tracker.errorNameNode;
    if (canProduceDiagnostics(input)) tracker.diagnosticContext = declarationContext(input);
    const saveNeedsDeclare = this.needsDeclare;
    let result: Node | undefined = undefined;
    switch (input.kind) {
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
        if (input instanceof TypeAliasDeclaration) {
          const narrowed: TypeAliasDeclaration = input;
          result = this.transformTypeAlias(narrowed);
        }
        break;
      case SyntaxKind.InterfaceDeclaration:
        if (input instanceof InterfaceDeclaration) {
          const narrowed: InterfaceDeclaration = input;
          result = this.transformInterface(narrowed);
        }
        break;
      case SyntaxKind.FunctionDeclaration:
        if (input instanceof FunctionDeclaration) {
          const narrowed: FunctionDeclaration = input;
          result = this.transformFunctionDeclaration(narrowed);
        }
        break;
      case SyntaxKind.ModuleDeclaration:
        if (input instanceof ModuleDeclaration) {
          const narrowed: ModuleDeclaration = input;
          result = this.transformModuleDeclaration(narrowed);
        }
        break;
      case SyntaxKind.ClassDeclaration:
        if (input instanceof ClassDeclaration) {
          const narrowed: ClassDeclaration = input;
          result = this.transformClassDeclaration(narrowed);
        }
        break;
      case SyntaxKind.VariableStatement:
        if (input instanceof VariableStatement) {
          const narrowed: VariableStatement = input;
          result = this.transformVariableStatement(narrowed);
        }
        break;
      case SyntaxKind.EnumDeclaration:
        if (input instanceof EnumDeclaration) {
          const narrowed: EnumDeclaration = input;
          result = this.transformEnumDeclaration(narrowed);
        }
        break;
      default:
        throw new Error('Unhandled top-level node in declaration emit');
    }
    this.enclosingDeclaration = previousEnclosingDeclaration;
    tracker.diagnosticContext = oldContext;
    this.needsDeclare = saveNeedsDeclare;
    tracker.errorNameNode = oldName;
    return result;
  }

  private transformTypeAlias(input: TypeAliasDeclaration): Node {
    this.needsDeclare = false;
    return this.factory.updateTypeAliasDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      this.visitNodes(input.typeParameters),
      // stripInternal can elide an `@internal` type on the right; it falls back to `any`, as index signatures do.
      this.visitNode(input.type) ?? this.keyword(SyntaxKind.AnyKeyword),
    );
  }

  private transformInterface(input: InterfaceDeclaration): Node {
    return this.factory.updateInterfaceDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      this.visitNodes(input.typeParameters),
      this.visitNodes(input.heritageClauses),
      this.visitNodes(input.members)!,
    );
  }

  private transformFunctionDeclaration(input: FunctionDeclaration): Node {
    if (this.resolver.isExpandoFunctionDeclaration(input)) this.tracker.reportExpandoFunctionErrors(input);
    return this.factory.updateFunctionDeclaration(
      input,
      this.ensureModifiers(input),
      undefined,
      input.name,
      this.ensureTypeParams(input, input.typeParameters),
      this.updateParamList(input, input.parameters),
      this.ensureType(input, false),
      undefined,
      undefined,
    );
  }

  private transformModuleDeclaration(input: ModuleDeclaration): Node {
    const modifiers = this.ensureModifiers(input);
    const saveNeedsDeclare = this.needsDeclare;
    this.needsDeclare = false;
    const body = input.body;
    let keyword = input.keyword;
    if (keyword !== SyntaxKind.GlobalKeyword && !(input.name instanceof StringLiteral))
      keyword = SyntaxKind.NamespaceKeyword;
    if (body !== undefined && body instanceof ModuleBlock) {
      const oldNeedsScopeFix = this.needsScopeFixMarker;
      const oldHasScopeFix = this.resultHasScopeMarker;
      this.resultHasScopeMarker = false;
      this.needsScopeFixMarker = false;
      const statements = this.visitNodes(body.statements)!;
      let lateStatements = this.transformAndReplaceLatePaintedStatements(statements);
      // In a `declare`d namespace everything is exported already; unexported "privates" don't matter.
      if ((input.flags & NodeFlags.Ambient) !== 0) this.needsScopeFixMarker = false;
      // With an `export {}` or `export =` there's nothing to do. Otherwise, if some statements
      // are unexported, add `export {}`; if all are exported, drop the redundant `export`s.
      if (!isGlobalScopeAugmentation(input) && !this.resultHasScopeMarker && !hasScopeMarker(lateStatements)) {
        if (this.needsScopeFixMarker) {
          const nodes = lateStatements.nodes.slice();
          nodes.push(this.createEmptyExports());
          lateStatements = this.factory.createNodeList(nodes);
        } else lateStatements = this.stripExportModifiersOfList(lateStatements);
      }
      const updatedBody = this.factory.updateModuleBlock(body, lateStatements);
      this.needsDeclare = saveNeedsDeclare;
      this.needsScopeFixMarker = oldNeedsScopeFix;
      this.resultHasScopeMarker = oldHasScopeFix;
      return this.factory.updateModuleDeclaration(input, modifiers, keyword, input.name, updatedBody);
    }
    if (body !== undefined) {
      // A nested `namespace a.b` is transformed now: it needs no visibility painting.
      this.visitNode(body);
      const original = this.context.mostOriginal(body);
      const inner = this.lateStatementReplacements.get(original);
      this.lateStatementReplacements.delete(original);
      this.needsDeclare = saveNeedsDeclare;
      return this.factory.updateModuleDeclaration(input, modifiers, keyword, input.name, inner);
    }
    this.needsDeclare = saveNeedsDeclare;
    return this.factory.updateModuleDeclaration(input, modifiers, keyword, input.name, undefined);
  }

  private stripExportModifiersOfList(list: NodeList): NodeList {
    const nodes: Node[] = [];
    let changed = false;
    for (const statement of list.nodes) {
      const stripped = this.stripExportModifiers(statement);
      if (stripped !== statement) changed = true;
      nodes.push(stripped);
    }
    return changed ? new NodeList(list.pos, list.end, nodes) : list;
  }

  private stripExportModifiers(statement: Node): Node {
    const parseNode = this.context.parseNode(statement);
    // `export import` stays: imports aren't implicitly exported. So does `export default`.
    if (
      statement.kind === SyntaxKind.ImportEqualsDeclaration ||
      (parseNode !== undefined && this.resolver.getEffectiveDeclarationFlags(parseNode, ModifierFlags.Default) !== 0) ||
      !canHaveModifiers(statement)
    )
      return statement;
    const flags = getCombinedModifierFlags(statement);
    if ((flags & ModifierFlags.Export) === 0) return statement;
    return this.replaceModifiers(statement, this.createModifiers(flags & (ModifierFlags.All ^ ModifierFlags.Export)));
  }

  /** `node` with other modifiers; for statements that can be exported. */
  private replaceModifiers(node: Node, modifiers: ModifierList | undefined): Node {
    if (node === undefined) return node;
    const factory = this.factory;
    if (node instanceof VariableStatement)
      return factory.updateVariableStatement(node, modifiers, node.declarationList);
    if (node instanceof FunctionDeclaration)
      return factory.updateFunctionDeclaration(
        node,
        modifiers,
        node.asteriskToken,
        node.name,
        node.typeParameters,
        node.parameters,
        node.type,
        node.fullSignature,
        node.body,
      );
    if (node instanceof ClassDeclaration)
      return factory.updateClassDeclaration(
        node,
        modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members,
      );
    if (node instanceof InterfaceDeclaration)
      return factory.updateInterfaceDeclaration(
        node,
        modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members,
      );
    if (node instanceof TypeAliasDeclaration)
      return factory.updateTypeAliasDeclaration(node, modifiers, node.name, node.typeParameters, node.type);
    if (node instanceof EnumDeclaration) return factory.updateEnumDeclaration(node, modifiers, node.name, node.members);
    if (node instanceof ModuleDeclaration)
      return factory.updateModuleDeclaration(node, modifiers, node.keyword, node.name, node.body);
    if (node instanceof ImportDeclaration)
      return factory.updateImportDeclaration(node, modifiers, node.importClause, node.moduleSpecifier, node.attributes);
    if (node instanceof ExportDeclaration)
      return factory.updateExportDeclaration(
        node,
        modifiers,
        node.isTypeOnly,
        node.exportClause,
        node.moduleSpecifier,
        node.attributes,
      );
    if (node instanceof ExportAssignment)
      return factory.updateExportAssignment(node, modifiers, node.isExportEquals, node.type, node.expression);
    return node;
  }

  /** Class members: parameter properties, a `#private` marker and the visited members. */
  /** The members of a class declaration or expression. */
  private buildClassMembers(classNode: Node, extraMembers: Node[]): NodeList {
    const classMembers = getMembers(classNode)!;
    const tracker = this.tracker;
    const parameterProperties: Node[] = [];
    const constructor = getFirstConstructorWithBody(classMembers);
    if (constructor !== undefined) {
      const oldContext = tracker.diagnosticContext;
      for (const parameter of constructor.parameters.nodes) {
        if (!(parameter instanceof ParameterDeclaration)) continue;
        if (
          !hasSyntacticModifier(parameter, ModifierFlags.ParameterPropertyModifier) ||
          this.shouldStripInternal(parameter)
        )
          continue;
        tracker.diagnosticContext = declarationContext(parameter);
        if (parameter.name instanceof Identifier) {
          const property = this.factory.created(
            new PropertyDeclaration(
              this.ensureModifiers(parameter),
              parameter.name,
              parameter.questionToken,
              this.ensureType(parameter, false),
              this.ensureNoInitializer(parameter),
            ),
          );
          this.context.assignCommentRange(property, parameter);
          parameterProperties.push(property);
        } else if (parameter.name instanceof BindingPattern)
          // A binding pattern is an error, but written as properties anyway.
          this.walkBindingPattern(parameter.name, parameter, parameterProperties);
      }
      tracker.diagnosticContext = oldContext;
    }
    const members: Node[] = [];
    // A class with private names gets a `#private` member to keep it nominal.
    for (const member of classMembers.nodes) {
      const name = getName(member);
      if (name instanceof PrivateIdentifier) {
        members.push(
          this.factory.created(
            new PropertyDeclaration(
              undefined,
              this.factory.created(new PrivateIdentifier('#private')),
              undefined,
              undefined,
              undefined,
            ),
          ),
        );
        break;
      }
    }
    const lateIndexes = this.resolver.createLateBoundIndexSignatures(
      this.context,
      classNode,
      this.enclosingDeclaration,
      NodeBuilderFlags.DeclarationEmit,
      tracker,
    );
    for (const index of lateIndexes) members.push(index);
    for (const property of parameterProperties) members.push(property);
    for (const member of extraMembers) members.push(member);
    const visited = this.visitNodes(classMembers);
    if (visited !== undefined) for (const member of visited.nodes) members.push(member);
    return this.factory.createNodeList(members);
  }

  private walkBindingPattern(pattern: BindingPattern, parameter: ParameterDeclaration, result: Node[]): boolean {
    for (const element of pattern.elements.nodes) {
      if (!(element instanceof BindingElement) || element.name === undefined) continue;
      if (element.name instanceof BindingPattern) {
        this.walkBindingPattern(element.name, parameter, result);
        continue;
      }
      result.push(
        this.factory.created(
          new PropertyDeclaration(
            this.ensureModifiers(parameter),
            element.name,
            undefined,
            this.ensureType(element, false),
            undefined,
          ),
        ),
      );
    }
    return true;
  }

  private transformClassDeclaration(input: ClassDeclaration): Node {
    const previousEnclosingDeclaration = this.enclosingDeclaration;
    this.enclosingDeclaration = defined(input);
    const tracker = this.tracker;
    tracker.errorNameNode = input.name;
    tracker.pushErrorFallbackNode(input);
    const modifiers = this.ensureModifiers(input);
    const typeParameters = this.ensureTypeParams(input, input.typeParameters);
    const extraMembers = isInJSFile(input) ? this.collectThisPropertyAssignments(input) : [];
    const members = this.buildClassMembers(input, extraMembers);
    const extendsClause = getClassExtendsHeritageElement(input);
    let result: Node;
    if (
      extendsClause !== undefined &&
      !isEntityNameExpression(extendsClause.expression, false) &&
      extendsClause.expression.kind !== SyntaxKind.NullKeyword
    ) {
      // `class C extends f() {}` becomes `declare const C_base: T; class C extends C_base {}`.
      tracker.reportInferenceFallback(extendsClause.expression);
      const oldId =
        input.name !== undefined && nodeIsPresent(input.name) && input.name.text.length > 0
          ? input.name.text
          : 'default';
      const newId = this.factory.createUniqueName(oldId + '_base', GeneratedIdentifierFlags.Optimistic);
      tracker.diagnosticContext = new DiagnosticContext(
        DiagnosticContextKind.ExtendsExpression,
        extendsClause,
        input.name,
      );
      const declaration = this.factory.createVariableDeclaration(
        newId,
        undefined,
        this.resolver.createTypeOfExpression(
          this.context,
          extendsClause.expression,
          input,
          NodeBuilderFlags.DeclarationEmit,
          tracker,
        ) ?? this.keyword(SyntaxKind.AnyKeyword),
        undefined,
      );
      const statement = this.factory.createVariableStatement(
        this.needsDeclare
          ? this.factory.createModifierList([this.factory.createToken(SyntaxKind.DeclareKeyword)])
          : undefined,
        this.factory.createVariableDeclarationList(this.factory.createNodeList([declaration]), NodeFlags.Const),
      );
      const clause = extendsClause.parent as HeritageClause;
      const heritageClause = this.factory.updateHeritageClause(
        clause,
        clause.token,
        this.factory.createNodeList([
          defined(
            this.factory.updateExpressionWithTypeArguments(
              extendsClause,
              newId,
              this.visitNodes(extendsClause.typeArguments),
            ),
          ),
        ]),
      );
      const heritageClauses: Node[] = [defined(heritageClause)];
      // The rest are `implements` clauses.
      const retained = this.visitNodes(input.heritageClauses);
      if (retained !== undefined) for (const other of retained.nodes) heritageClauses.push(other);
      result = this.factory.createSyntaxList([
        statement,
        defined(
          this.factory.updateClassDeclaration(
            input,
            modifiers,
            input.name,
            typeParameters,
            this.factory.createNodeList(heritageClauses),
            members,
          ),
        ),
      ]);
    } else
      result = defined(
        this.factory.updateClassDeclaration(
          input,
          modifiers,
          input.name,
          typeParameters,
          this.visitNodes(input.heritageClauses),
          members,
        ),
      );
    tracker.popErrorFallbackNode();
    this.enclosingDeclaration = previousEnclosingDeclaration;
    return result;
  }

  private transformVariableStatement(input: VariableStatement): Node | undefined {
    const declarations = input.declarationList.declarations.nodes;
    let visible = false;
    for (const declaration of declarations)
      if (this.getBindingNameVisible(declaration)) {
        visible = true;
        break;
      }
    if (!visible) return undefined;
    let normal = declarations;
    const imports: Node[] = [];
    const file = this.tracker.currentSourceFile;
    if (file !== undefined && file.commonJSModuleIndicator !== undefined) {
      // `const x = require("m")` declarations become imports.
      normal = [];
      for (const declaration of declarations) {
        if (isVariableDeclarationInitializedToRequire(declaration)) {
          const visited = this.visit(declaration);
          if (visited !== undefined) imports.push(visited);
        } else normal.push(declaration);
      }
    }
    const nodes = this.visitArray(normal);
    if (nodes.length === 0) return imports.length > 0 ? this.factory.createSyntaxList(imports) : undefined;
    const list = this.factory.createNodeList(nodes);
    const modifiers = this.ensureModifiers(input);
    const declarationList = input.declarationList;
    let updatedList: VariableDeclarationList;
    const blockScope = getCombinedNodeFlags(declarationList) & NodeFlags.BlockScoped;
    if (blockScope === NodeFlags.Using || blockScope === NodeFlags.AwaitUsing) {
      // `using` declarations are written as `const`.
      updatedList = this.factory.createVariableDeclarationList(list, NodeFlags.Const);
      this.context.setOriginal(updatedList, declarationList);
      this.context.setCommentRange(updatedList, declarationList.pos, declarationList.end);
      updatedList.pos = declarationList.pos;
      updatedList.end = declarationList.end;
    } else updatedList = this.factory.updateVariableDeclarationList(declarationList, list, declarationList.flags);
    const result = this.factory.updateVariableStatement(input, modifiers, updatedList);
    if (imports.length === 0) return result;
    imports.push(defined(result));
    return this.factory.createSyntaxList(imports);
  }

  private transformEnumDeclaration(input: EnumDeclaration): Node {
    const members: Node[] = [];
    for (const member of input.members.nodes) {
      if (member === undefined || !(member instanceof EnumMember) || this.shouldStripInternal(member)) continue;
      // Initializers are rewritten to their constant values.
      const value = this.resolver.getEnumMemberValue(member);
      if (
        this.tracker.isolatedDeclarations &&
        member.initializer !== undefined &&
        value.hasExternalReferences &&
        member.name.kind !== SyntaxKind.ComputedPropertyName
      )
        this.tracker.addDiagnostic(
          createDiagnosticForNode(
            member,
            Diagnostics.Enum_member_initializers_must_be_computable_without_references_to_external_symbols_with_isolatedDeclarations,
            [],
          ),
        );
      let initializer: Node | undefined = undefined;
      if (value.kind === ConstantKind.Number) initializer = this.createNumber(value.number);
      else if (value.kind === ConstantKind.String)
        initializer = this.factory.createStringLiteral(value.string, TokenFlags.None);
      const result = defined(this.factory.updateEnumMember(member, member.name, initializer));
      this.context.assignCommentRange(result, member);
      members.push(result);
    }
    return this.factory.updateEnumDeclaration(
      input,
      this.ensureModifiers(input),
      input.name,
      this.factory.createNodeList(members),
    );
  }

  /** A number as an expression: a literal, `-literal`, `Infinity`, `-Infinity` or `NaN`. */
  createNumber(value: number): Node {
    const factory = this.factory;
    if (value !== value) return factory.createIdentifier('NaN');
    if (value === Infinity) return factory.createIdentifier('Infinity');
    if (value === -Infinity)
      return factory.created(new PrefixUnaryExpression(SyntaxKind.MinusToken, factory.createIdentifier('Infinity')));
    if (value < 0 || (value === 0 && 1 / value < 0))
      return factory.created(
        new PrefixUnaryExpression(SyntaxKind.MinusToken, factory.createNumericLiteral(String(-value))),
      );
    return factory.createNumericLiteral(String(value));
  }

  // JavaScript and assigned properties

  /** `const x = require("m")` as `import x = require("m")`, `const { a } = require("m")` as `import { a } from "m"`. */
  private transformCjsRequireVariableDeclaration(input: VariableDeclaration): Node | undefined {
    const call = skipParenthesesOnly(input.initializer!);
    const specifier = this.rewriteModuleSpecifier(input, getArguments(call)!.nodes[0])!;
    const name = input.name;
    if (name instanceof Identifier)
      return this.factory.created(
        new ImportEqualsDeclaration(
          undefined,
          false,
          name,
          this.factory.created(new ExternalModuleReference(specifier)),
        ),
      );
    if (!(name instanceof BindingPattern) || name.kind === SyntaxKind.ArrayBindingPattern) return undefined;
    const specifiers: Node[] = [];
    for (const element of name.elements.nodes) {
      // Nested destructuring is skipped.
      if (!(element instanceof BindingElement) || !(element.name instanceof Identifier)) continue;
      specifiers.push(this.factory.created(new ImportSpecifier(false, element.propertyName, element.name)));
    }
    const clause = this.factory.created(
      new ImportClause(
        undefined,
        undefined,
        this.factory.created(new NamedImports(this.factory.createNodeList(specifiers))),
      ),
    );
    return this.factory.created(
      new ImportDeclaration(SyntaxKind.ImportDeclaration, undefined, clause, specifier, undefined),
    );
  }

  /** Finds `module.exports =` assignments anywhere in the file. */
  visitModuleExportsAssignment(node: Node): boolean {
    const file = this.tracker.currentSourceFile!;
    if (
      file.commonJSModuleIndicator === undefined ||
      getAssignmentDeclarationKind(node) !== JSDeclarationKind.ModuleExports
    )
      return false;
    const scope = this.enterDiagnosticContext(node);
    const result = this.transformExportAssignment(node.parent!, node, (node as BinaryExpression).right, true);
    this.exitDiagnosticContext(scope);
    if (result === undefined) return false;
    this.cjsExportAssignment = result;
    this.resultHasScopeMarker = true;
    this.resultHasExternalModuleIndicator = true;
    return true;
  }

  /** Finds assigned properties (`f.x = 1`) and CommonJS exports (`exports.x = 1`) anywhere in the file. */
  visitNestedExpression(node: Node): boolean {
    if (node === undefined) return false;
    const kind = getAssignmentDeclarationKind(node);
    if (kind === JSDeclarationKind.None) return false;
    const scope = this.enterDiagnosticContext(node);
    const file = this.tracker.currentSourceFile!;
    switch (kind) {
      case JSDeclarationKind.Property:
        if (node instanceof BinaryExpression) this.transformExpandoAssignment(node);
        break;
      case JSDeclarationKind.ExportsProperty:
        if (file.commonJSModuleIndicator !== undefined) {
          const name = getElementOrPropertyAccessName((node as BinaryExpression).left);
          if (name !== undefined) {
            const result = this.transformCommonJSExport(node, this.getNameExpressionPreferringIdentifier(name));
            if (result !== undefined) this.cjsExportMembers.push(result);
          }
        }
        break;
      case JSDeclarationKind.ObjectDefinePropertyExports:
        if (file.commonJSModuleIndicator !== undefined) {
          const result = this.transformCommonJSExport(
            node,
            this.getNameExpressionPreferringIdentifier(getArguments(node)!.nodes[1]),
          );
          if (result !== undefined) this.cjsExportMembers.push(result);
        }
        break;
    }
    this.exitDiagnosticContext(scope);
    return true;
  }

  /** A property name as an identifier when it can be one; keywords other than `default` stay strings. */
  private getNameExpressionPreferringIdentifier(name: Node): Node {
    let result = name;
    if (name instanceof NumericLiteral) result = this.factory.createStringLiteral(name.text, TokenFlags.None);
    if (
      (result.kind === SyntaxKind.StringLiteral || result.kind === SyntaxKind.NoSubstitutionTemplateLiteral) &&
      isIdentifierText(getText(result))
    ) {
      const text = getText(result);
      const keyword = identifierToKeywordKind(text);
      if (
        keyword === SyntaxKind.Unknown ||
        keyword === SyntaxKind.Identifier ||
        keyword === SyntaxKind.DefaultKeyword
      ) {
        // A parse tree node, so names it uses are resolved where it's written.
        const identifier = new Identifier(text);
        identifier.parent = name.parent;
        return identifier;
      }
    }
    return result;
  }

  private transformCommonJSExport(input: Node, name: Node): Node | undefined {
    const result = this.transformCommonJSExportWorker(input, name);
    return result === undefined ? undefined : this.wrapInCJSExportNamespace(result);
  }

  private transformCommonJSExportWorker(input: Node, name: Node): Node | undefined {
    if (input === undefined) return undefined;
    const nameText = name.kind === SyntaxKind.Identifier || name.kind === SyntaxKind.StringLiteral ? getText(name) : '';
    if (nameText !== '' && this.witnessedCjsExports.has(nameText)) return undefined;
    this.witnessedCjsExports.add(nameText);
    this.resultHasExternalModuleIndicator = true;
    this.resultHasScopeMarker = true;
    const tracker = this.tracker;
    // At the top level, `exports.x = y` is written as `export { y as x }`.
    const statement = input.parent;
    if (
      isCommonJSAliasExport(input) &&
      statement !== undefined &&
      statement.kind === SyntaxKind.ExpressionStatement &&
      statement.parent !== undefined &&
      statement.parent.kind === SyntaxKind.SourceFile
    )
      return this.transformBinaryExpressionToExportDeclaration(input as BinaryExpression, name);
    if (input instanceof BinaryExpression) {
      const right = skipParenthesesOnly(input.right);
      if (right instanceof ClassExpression) return this.transformCommonJSClassExport(input, right, name);
    }
    if (name instanceof Identifier) {
      if (name.text === 'default') {
        // `declare const _default: T; export default _default;`
        const newId = this.factory.createUniqueName('_default', GeneratedIdentifierFlags.Optimistic);
        tracker.diagnosticContext = new DiagnosticContext(DiagnosticContextKind.DefaultExport, input, undefined);
        tracker.pushErrorFallbackNode(input);
        const declaration = this.factory.createVariableDeclaration(
          newId,
          undefined,
          this.ensureType(input, false),
          undefined,
        );
        tracker.popErrorFallbackNode();
        const variable = this.createConstStatement(declaration);
        const assignment = this.factory.created(new ExportAssignment(getModifiers(input), false, undefined, newId));
        this.context.assignCommentRange(variable, input);
        this.context.addEmitFlags(assignment, EmitFlags.NoComments);
        return this.factory.createSyntaxList([variable, assignment]);
      }
      const referenced = this.resolver.getReferencedValueDeclaration(name);
      // Inlined as `export var x: T` unless the name refers to something else.
      if (referenced === input || referenced === undefined) {
        tracker.pushErrorFallbackNode(input);
        const declaration = this.factory.createVariableDeclaration(
          name,
          undefined,
          this.ensureType(input, false),
          undefined,
        );
        tracker.popErrorFallbackNode();
        const modifiers: Node[] = [this.factory.createToken(SyntaxKind.ExportKeyword)];
        if (this.needsDeclare) modifiers.push(this.factory.createToken(SyntaxKind.DeclareKeyword));
        return this.factory.createVariableStatement(
          this.factory.createModifierList(modifiers),
          this.factory.createVariableDeclarationList(this.factory.createNodeList([declaration]), NodeFlags.None),
        );
      }
    }
    // `declare const _exported: T; export { _exported as "name" };`
    const newId = this.factory.createUniqueName('_exported', GeneratedIdentifierFlags.Optimistic);
    tracker.diagnosticContext = new DiagnosticContext(DiagnosticContextKind.DefaultExport, input, undefined);
    tracker.pushErrorFallbackNode(input);
    const declaration = this.factory.createVariableDeclaration(
      newId,
      undefined,
      this.ensureType(input, false),
      undefined,
    );
    tracker.popErrorFallbackNode();
    const variable = this.createConstStatement(declaration);
    const exportDeclaration = this.createExportDeclaration(newId, name);
    this.context.assignCommentRange(variable, input);
    this.context.addEmitFlags(exportDeclaration, EmitFlags.NoComments);
    return this.factory.createSyntaxList([variable, exportDeclaration]);
  }

  /** `exports.K = class K {}` as a class declaration, in a namespace if its name differs or is used inside. */
  private transformCommonJSClassExport(input: BinaryExpression, right: ClassExpression, name: Node): Node {
    const factory = this.factory;
    const tracker = this.tracker;
    const classExpressionName = right.name;
    if (classExpressionName !== undefined && classExpressionName.text.length > 0) {
      // Watch for the class naming itself in its members' types.
      tracker.watchedClassSymbol = right.symbol;
      tracker.classSymbolTracked = false;
      const className = factory.createIdentifier(classExpressionName.text);
      const classDeclaration = this.transformClassExpressionToDeclaration(
        right,
        className,
        factory.createModifierList([factory.createToken(SyntaxKind.ExportKeyword)]),
      );
      this.context.assignCommentRange(classDeclaration, input);
      const namesDiffer = !(name instanceof Identifier) || classExpressionName.text !== name.text;
      const needsIsolation = namesDiffer || tracker.classSymbolTracked;
      tracker.watchedClassSymbol = undefined;
      tracker.classSymbolTracked = false;
      if (needsIsolation) {
        const namespaceName = factory.createUniqueName('_ns', GeneratedIdentifierFlags.Optimistic);
        const namespace = factory.created(
          new ModuleDeclaration(
            this.declareModifiers(),
            SyntaxKind.NamespaceKeyword,
            namespaceName,
            undefined,
            factory.created(new ModuleBlock(factory.createNodeList([classDeclaration]))),
          ),
        );
        const aliasBase =
          name instanceof Identifier && isIdentifierText('_' + name.text) ? '_' + name.text : '_exported';
        const alias = factory.createUniqueName(aliasBase, GeneratedIdentifierFlags.Optimistic);
        const importEquals = factory.created(
          new ImportEqualsDeclaration(
            undefined,
            false,
            alias,
            factory.created(new QualifiedName(namespaceName, className)),
          ),
        );
        const exportDeclaration = this.createExportDeclaration(alias, name);
        this.context.addEmitFlags(exportDeclaration, EmitFlags.NoComments);
        return factory.createSyntaxList([namespace, importEquals, exportDeclaration]);
      }
      const modifiers: Node[] = [factory.createToken(SyntaxKind.ExportKeyword)];
      if (this.needsDeclare) modifiers.push(factory.createToken(SyntaxKind.DeclareKeyword));
      return this.replaceModifiers(classDeclaration, factory.createModifierList(modifiers));
    }
    const modifiers: Node[] = [factory.createToken(SyntaxKind.ExportKeyword)];
    if (this.needsDeclare) modifiers.push(factory.createToken(SyntaxKind.DeclareKeyword));
    const className =
      name !== undefined && name instanceof Identifier
        ? name
        : factory.createUniqueName('_class', GeneratedIdentifierFlags.Optimistic);
    const classDeclaration = this.transformClassExpressionToDeclaration(
      right,
      className,
      factory.createModifierList(modifiers),
    );
    this.context.assignCommentRange(classDeclaration, input);
    if (name instanceof Identifier) return classDeclaration;
    // A name that isn't an identifier is exported by a specifier.
    const exportDeclaration = this.createExportDeclaration(className, name);
    this.context.addEmitFlags(exportDeclaration, EmitFlags.NoComments);
    return factory.createSyntaxList([classDeclaration, exportDeclaration]);
  }

  private createExportDeclaration(local: Node | undefined, name: Node): ExportDeclaration {
    const factory = this.factory;
    return factory.created(
      new ExportDeclaration(
        undefined,
        false,
        factory.created(
          new NamedExports(factory.createNodeList([factory.created(new ExportSpecifier(false, local, name))])),
        ),
        undefined,
        undefined,
      ),
    );
  }

  /** `exports.x = y` and `f.x = y` as `export { y as x }`. */
  private transformBinaryExpressionToExportDeclaration(input: BinaryExpression, name: Node): Node {
    let propertyName: Node | undefined = input.right;
    // Keeps the declaration the name refers to.
    this.tracker.handleSymbolAccessibilityError(
      this.resolver.isEntityNameVisible(propertyName, this.enclosingDeclaration),
    );
    if (name instanceof Identifier && propertyName instanceof Identifier && propertyName.text === name.text)
      propertyName = undefined;
    return this.createExportDeclaration(propertyName, name);
  }

  /** CommonJS exports of a file with `module.exports =` are members of a namespace of its name. */
  private wrapInCJSExportNamespace(content: Node): Node {
    const name = this.cjsExportAssignmentName;
    if (name === undefined) return content;
    const members = content instanceof SyntaxList ? content.children : [content];
    const stripped: Node[] = [];
    for (const member of members) stripped.push(this.stripDeclareModifier(member));
    return this.factory.created(
      new ModuleDeclaration(
        this.declareModifiers(),
        SyntaxKind.NamespaceKeyword,
        name,
        undefined,
        this.factory.created(new ModuleBlock(this.factory.createNodeList(stripped))),
      ),
    );
  }

  private stripDeclareModifier(node: Node): Node {
    const modifiers = getModifiers(node);
    if (modifiers === undefined || (modifiers.modifierFlags & ModifierFlags.Ambient) === 0) return node;
    const kept: Node[] = [];
    for (const modifier of modifiers.nodes) if (modifier.kind !== SyntaxKind.DeclareKeyword) kept.push(modifier);
    return this.replaceModifiers(node, this.factory.createModifierList(kept));
  }

  /** Writes `f.x = 1` as a namespace member of `f`, kept with `f` if it's emitted. */
  private transformExpandoAssignment(node: BinaryExpression): boolean {
    const symbol = node.symbol;
    if (symbol === undefined || (symbol.flags & SymbolFlags.Assignment) === 0) return false;
    const left = node.left;
    const namespace = getLeftmostAccessExpression(left);
    if (!(namespace instanceof Identifier)) return false;
    const declaration = this.resolver.getReferencedValueDeclaration(namespace);
    if (declaration === undefined || this.shouldStripInternal(declaration)) return false;
    if (declaration instanceof VariableDeclaration && declaration.type !== undefined) return false;
    if (declaration instanceof FunctionDeclaration && declaration.fullSignature !== undefined) return false;
    // A variable gets a type instead, unless it's a function.
    if (
      declaration instanceof VariableDeclaration &&
      (declaration.initializer === undefined || !isFunctionLike(declaration.initializer))
    )
      return false;
    const host = getSymbol(declaration);
    if (host === undefined) return false;
    const name = this.factory.createIdentifier(namespace.text);
    const property = this.tryGetPropertyName(left);
    if (property === '' || !isIdentifierText(property)) return false;
    const hostId = this.getExpandoHostId(declaration);
    if (isDeclaration(declaration) && this.isDeclarationAndNotVisible(declaration)) {
      // Writing the type of a visible declaration, such as `typeof f`, can make the host visible later.
      let deferred = this.deferredExpandoAssignments.get(hostId);
      if (deferred === undefined) {
        deferred = [];
        this.deferredExpandoAssignments.set(hostId, deferred);
      }
      deferred.push(node);
      return false;
    }
    if (declaration instanceof FunctionDeclaration && !shouldEmitFunctionProperties(declaration)) return false;
    this.transformExpandoHost(name, declaration);
    const exportName = this.factory.createIdentifier(property);
    let localName = this.tryGetNameOfAssignedExpression(node);
    // The property's name works as the local name if it neither conflicts nor is a keyword.
    if (
      localName === undefined &&
      !this.resolver.isNameResolvable(this.enclosingDeclaration, property) &&
      !isNonContextualKeyword(stringToToken(property))
    )
      localName = exportName;
    if (localName === undefined || isNonContextualKeyword(stringToToken(localName.text)))
      localName = this.factory.createGeneratedNameForNode(node, GeneratedIdentifierFlags.None, '', '');
    const scope = this.enterDiagnosticContext(node);
    let members = this.expandoMembers.get(hostId);
    if (members === undefined) {
      members = [];
      this.expandoMembers.set(hostId, members);
    }
    let hasExport = false;
    for (const member of members) if (member.kind === SyntaxKind.ExportDeclaration) hasExport = true;
    if (node.right instanceof Identifier) {
      // Alias-like: `export { name }` or `export { name as alias }`; the other members stay exported.
      if (!hasExport) this.addExportModifierToExpandoMembers(members);
      members.push(this.transformBinaryExpressionToExportDeclaration(node, exportName));
      this.exitDiagnosticContext(scope);
      return true;
    }
    const variable = this.factory.createVariableStatement(
      hasExport ? this.factory.createModifierList([this.factory.createToken(SyntaxKind.ExportKeyword)]) : undefined,
      this.factory.createVariableDeclarationList(
        this.factory.createNodeList([
          this.factory.createVariableDeclaration(localName, undefined, this.ensureType(node, false), undefined),
        ]),
        NodeFlags.None,
      ),
    );
    const statements: Node[] = [variable];
    const local = defined(localName) as Identifier;
    if (local.text !== exportName.text || this.context.hasAutoGenerateInfo(local))
      statements.push(this.createExportDeclaration(local, exportName));
    // Members stay exported after an `export {}` is added.
    if (statements.length > 1 && !hasExport) this.addExportModifierToExpandoMembers(members);
    for (const statement of statements) members.push(statement);
    this.exitDiagnosticContext(scope);
    return true;
  }

  /** Adds `export` to a host's members, before the first `export {}` is added to them. */
  private addExportModifierToExpandoMembers(members: Node[]): void {
    for (let i = 0; i < members.length; i++)
      members[i] = this.replaceModifiers(
        members[i],
        this.createModifiers(ModifierFlags.Export | getCombinedModifierFlags(members[i])),
      );
  }

  private tryGetPropertyName(node: Node): string {
    if (node instanceof ElementAccessExpression) return this.resolver.getElementAccessExpressionName(node);
    if (node instanceof PropertyAccessExpression && node.name instanceof Identifier) return node.name.text;
    return '';
  }

  private getExpandoHostId(declaration: Node): Node {
    const root = declaration instanceof VariableDeclaration ? declaration.parent!.parent! : declaration;
    return this.context.mostOriginal(root);
  }

  /** The function a property is assigned to, written as a declaration once. */
  private transformExpandoHost(name: Identifier, declaration: Node): boolean {
    if (name === undefined) return false;
    const root = declaration instanceof VariableDeclaration ? declaration.parent!.parent! : declaration;
    const id = this.getExpandoHostId(declaration);
    if (this.expandoHosts.has(id)) return false;
    const saveNeedsDeclare = this.needsDeclare;
    this.needsDeclare = true;
    let flags = this.ensureModifierFlags(root);
    this.needsDeclare = saveNeedsDeclare;
    const defaultExport = (flags & ModifierFlags.Export) !== 0 && (flags & ModifierFlags.Default) !== 0;
    if (defaultExport) flags = (flags | ModifierFlags.Ambient) & ~(ModifierFlags.Default | ModifierFlags.Export);
    const scope = this.enterDiagnosticContext(declaration);
    const modifiers = this.createModifiers(flags);
    const replacement: Node[] = [];
    if (declaration instanceof FunctionDeclaration)
      replacement.push(
        defined(
          this.factory.updateFunctionDeclaration(
            declaration,
            modifiers,
            declaration.asteriskToken,
            declaration.name,
            this.ensureTypeParams(declaration, declaration.typeParameters),
            this.updateParamList(declaration, declaration.parameters),
            this.ensureType(declaration, false),
            undefined,
            undefined,
          ),
        ),
      );
    else if (isFunctionValuedVariable(declaration)) {
      const fn = getInitializer(declaration)!;
      replacement.push(
        this.factory.created(
          new FunctionDeclaration(
            modifiers,
            asteriskOf(fn),
            this.factory.createIdentifier(name.text),
            this.ensureTypeParams(fn, getTypeParameters(fn)),
            this.updateParamList(fn, getParameters(fn)!),
            this.ensureType(fn, false),
            undefined,
            undefined,
          ),
        ),
      );
    } else {
      this.expandoHosts.set(id, this.transformTopLevelDeclaration(declaration));
      this.exitDiagnosticContext(scope);
      return true;
    }
    this.tracker.reportExpandoFunctionErrors(declaration);
    if (defaultExport) {
      if (declaration.parent !== undefined && declaration.parent.kind === SyntaxKind.SourceFile)
        this.resultHasExternalModuleIndicator = true;
      this.resultHasScopeMarker = true;
      replacement.push(this.factory.created(new ExportAssignment(undefined, false, undefined, name)));
    }
    this.expandoHosts.set(id, this.factory.createSyntaxList(replacement));
    if (this.lateStatementReplacements.has(id)) this.lateStatementReplacements.set(id, this.createFullExpandoBlock(id));
    this.exitDiagnosticContext(scope);
    return true;
  }

  /** A function with its assigned properties as a namespace of the same name. */
  private createFullExpandoBlock(id: Node): Node | undefined {
    // Assignments deferred while the host wasn't visible; they are deferred again if it still isn't.
    const deferred = this.deferredExpandoAssignments.get(id);
    if (deferred !== undefined) {
      this.deferredExpandoAssignments.delete(id);
      for (const assignment of deferred) this.transformExpandoAssignment(assignment);
    }
    const host = this.expandoHosts.get(id);
    const addOns = this.expandoMembers.get(id);
    if (addOns === undefined || host === undefined) return host;
    let name: Node | undefined = undefined;
    let modifiers: ModifierList | undefined = undefined;
    const statements = host instanceof SyntaxList ? host.children : [host];
    for (const statement of statements) {
      const statementName = getName(statement);
      if (statementName === undefined) continue;
      name = this.factory.cloneNode(statementName, statementName.deepClone());
      const statementModifiers = getModifiers(statement);
      if (statementModifiers !== undefined)
        modifiers = this.factory.createModifierList(statementModifiers.nodes.slice());
      break;
    }
    if (name === undefined) return host;
    const result = statements.slice();
    result.push(
      this.factory.created(
        new ModuleDeclaration(
          modifiers,
          SyntaxKind.NamespaceKeyword,
          name,
          undefined,
          this.factory.created(new ModuleBlock(this.factory.createNodeList(addOns))),
        ),
      ),
    );
    return this.factory.createSyntaxList(result);
  }

  /** The `this.x = …` members of a JavaScript class, as property declarations. */
  private collectThisPropertyAssignments(classNode: Node): Node[] {
    const members = getMembers(classNode)!.nodes;
    this.seenProperties.clear();
    for (const member of members) {
      const name = getName(member);
      if (name !== undefined) this.seenProperties.add(thisPropertyKey(name, member, isStatic(member)));
    }
    this.thisPropertyAssignments = [];
    const walker = new ThisPropertyWalker(this, classNode);
    for (const member of members) member.forEachChild(walker);
    const result = this.thisPropertyAssignments;
    this.thisPropertyAssignments = [];
    this.seenProperties.clear();
    return result;
  }

  /** Collects a `this.x = …` assignment of a member of `classNode`. */
  visitThisPropertyAssignment(node: Node, classNode: Node): boolean {
    if (getAssignmentDeclarationKind(node) !== JSDeclarationKind.ThisProperty) return false;
    const container = getThisContainer(node, false, false);
    if (container.parent !== classNode) return false;
    const isStaticMember =
      hasSyntacticModifier(container, ModifierFlags.Static) ||
      container.kind === SyntaxKind.ClassStaticBlockDeclaration;
    const assignment = node as BinaryExpression;
    let name: Node | undefined = getElementOrPropertyAccessName(assignment.left);
    if (name === undefined) return false;
    const key = thisPropertyKey(name, node, isStaticMember);
    if (this.resolver.getReferencedMemberValueDeclaration(node) === undefined || this.seenProperties.has(key))
      return false;
    this.seenProperties.add(key);
    const heritage = getHeritageClauses(classNode);
    if (heritage !== undefined && heritage.nodes.length > 0 && !isClassExtendingNull(heritage)) {
      // A base class may provide the member; that needs types.
      this.tracker.reportInferenceFallback(classNode);
      if (this.resolver.isThisPropertyAssignmentDeclarationRedundant(node)) return false;
    }
    if (hasDynamicName(node)) return false;
    if (getTextOfPropertyName(name) === 'constructor') return false;
    if (name instanceof Identifier && !isIdentifierText(name.text))
      name = this.factory.createStringLiteralFromNode(name);
    // JSDoc modifiers such as `@readonly` and `@private` apply to the property.
    let modifierFlags = this.ensureModifierFlags(node);
    if (isStaticMember) modifierFlags |= ModifierFlags.Static;
    const property = this.factory.created(
      new PropertyDeclaration(
        this.createModifiers(modifierFlags),
        name,
        undefined,
        this.ensureType(node, false),
        undefined,
      ),
    );
    if (node.parent !== undefined && node.parent.kind === SyntaxKind.ExpressionStatement)
      this.context.assignCommentRange(property, node.parent);
    this.thisPropertyAssignments.push(property);
    return true;
  }

  // Modifiers, types and parameters

  private createModifiers(flags: ModifierFlags): ModifierList | undefined {
    const nodes: Node[] = [];
    for (const kind of modifierKindsInOrder)
      if ((flags & modifierToFlag(kind)) !== 0) nodes.push(this.factory.createToken((kind | 0) as SyntaxKind));
    return nodes.length === 0 ? undefined : this.factory.createModifierList(nodes);
  }

  private ensureModifiers(node: Node): ModifierList | undefined {
    const parseNode = this.parseNode(node);
    const currentFlags = getCombinedModifierFlags(parseNode) & ModifierFlags.All;
    const newFlags = this.ensureModifierFlags(node);
    if (currentFlags === newFlags) {
      // Decorators are dropped.
      const modifiers = getModifiers(node);
      if (modifiers === undefined) return undefined;
      let reusable = true;
      for (const modifier of modifiers.nodes)
        if (isModifier(modifier) && (modifier.flags & NodeFlags.Reparsed) !== 0) {
          reusable = false;
          break;
        }
      if (reusable) {
        const kept: Node[] = [];
        for (const modifier of modifiers.nodes) if (isModifier(modifier)) kept.push(modifier);
        return this.factory.createModifierList(kept);
      }
    }
    return this.createModifiers(newFlags);
  }

  private ensureModifierFlags(node: Node): ModifierFlags {
    // No `async` or `override` in declaration files, and `public` is implied.
    let mask = ModifierFlags.All ^ (ModifierFlags.Public | ModifierFlags.Async | ModifierFlags.Override);
    let additions =
      this.needsDeclare && node.kind !== SyntaxKind.InterfaceDeclaration ? ModifierFlags.Ambient : ModifierFlags.None;
    if (node.parent === undefined || node.parent.kind !== SyntaxKind.SourceFile) {
      mask ^= ModifierFlags.Ambient;
      additions = ModifierFlags.None;
    }
    if (isImplicitlyExportedJSDocDeclaration(node)) additions |= ModifierFlags.Export;
    return maskModifierFlags(node, mask, additions);
  }

  private ensureTypeParams(node: Node, params: NodeList | undefined): NodeList | undefined {
    if (this.isPrivate(this.parseNode(node))) return undefined;
    const typeParameters = this.visitNodes(params);
    if (typeParameters !== undefined || getFullSignature(node) === undefined) return typeParameters;
    // A JSDoc `@type` signature declares the type parameters.
    const tracker = this.tracker;
    const oldErrorNameNode = tracker.errorNameNode;
    tracker.errorNameNode = getName(node);
    const oldContext = tracker.diagnosticContext;
    if (!this.suppressNewDiagnosticContexts && canProduceDiagnostics(node))
      tracker.diagnosticContext = declarationContext(node);
    const nodes = this.resolver.createTypeParametersOfSignatureDeclaration(
      this.context,
      node,
      this.enclosingDeclaration,
      NodeBuilderFlags.DeclarationEmit,
      tracker,
    );
    tracker.errorNameNode = oldErrorNameNode;
    if (!this.suppressNewDiagnosticContexts) tracker.diagnosticContext = oldContext;
    return nodes === undefined ? undefined : this.factory.createNodeList(nodes);
  }

  private updateParamList(node: Node, params: NodeList): NodeList {
    if (this.isPrivate(this.parseNode(node)) || params.nodes.length === 0) return this.factory.createNodeList([]);
    const results: Node[] = [];
    for (const parameter of params.nodes) results.push(this.ensureParameterNode(parameter));
    return this.factory.createNodeList(results);
  }

  private ensureParameterNode(node: Node): Node {
    if (node === undefined) return node;
    return node instanceof ParameterDeclaration ? this.ensureParameter(node) : node;
  }

  private ensureParameter(p: ParameterDeclaration): Node {
    const tracker = this.tracker;
    const oldContext = tracker.diagnosticContext;
    if (!this.suppressNewDiagnosticContexts) tracker.diagnosticContext = declarationContext(p);
    let questionToken: Token | undefined = undefined;
    if (this.resolver.isOptionalParameter(p))
      questionToken = p.questionToken ?? this.factory.createToken(SyntaxKind.QuestionToken);
    const result = this.factory.updateParameterDeclaration(
      p,
      undefined,
      p.dotDotDotToken,
      this.visitBindingName(p.name),
      questionToken,
      this.ensureType(p, true),
      this.ensureNoInitializer(p),
    );
    tracker.diagnosticContext = oldContext;
    return result;
  }

  private visitBindingName(node: Node): Node {
    if (node instanceof BindingPattern) {
      const elements: Node[] = [];
      let changed = false;
      for (const element of node.elements.nodes) {
        const visited = this.visitBindingName(element);
        if (visited !== element) changed = true;
        elements.push(visited);
      }
      return changed
        ? this.factory.updateBindingPattern(node, new NodeList(node.elements.pos, node.elements.end, elements))
        : node;
    }
    if (node instanceof BindingElement) {
      const propertyName = node.propertyName;
      if (propertyName instanceof ComputedPropertyName && isEntityNameExpression(propertyName.expression, false))
        this.checkEntityNameVisibility(propertyName.expression, this.enclosingDeclaration);
      return this.factory.updateBindingElement(
        node,
        node.dotDotDotToken,
        propertyName,
        node.name === undefined ? undefined : this.visitBindingName(node.name),
        undefined,
      );
    }
    return node;
  }

  /** The type of a declaration: its annotation, or the resolver's type; `any` if neither. */
  private ensureType(node: Node, ignorePrivate: boolean): Node | undefined {
    // Private declarations have no types, except private parameter properties' parameters.
    if (!ignorePrivate && this.isPrivate(this.parseNode(node))) return undefined;
    // Literal constants are written with their initializer instead.
    if (this.shouldPrintWithInitializer(node)) return undefined;
    const type = getType(node);
    if (
      node.kind !== SyntaxKind.ExportAssignment &&
      node.kind !== SyntaxKind.BindingElement &&
      type !== undefined &&
      (node.kind !== SyntaxKind.Parameter ||
        !this.resolver.requiresAddingImplicitUndefined(node, this.enclosingDeclaration))
    ) {
      const file = this.tracker.currentSourceFile;
      if (file === undefined || !file.isJS()) return this.visitNode(type);
      // JSDoc types can need rewriting, which the resolver does.
      const rewritten = this.resolver.tryJSTypeNodeToTypeNode(
        this.context,
        type,
        this.enclosingDeclaration,
        this.nodeBuilderFlags(),
        this.tracker,
      );
      if (rewritten !== undefined) return rewritten;
    }
    const tracker = this.tracker;
    const oldErrorNameNode = tracker.errorNameNode;
    tracker.errorNameNode = getName(node);
    const oldContext = tracker.diagnosticContext;
    if (!this.suppressNewDiagnosticContexts && canProduceDiagnostics(node))
      tracker.diagnosticContext = declarationContext(node);
    let typeNode: Node | undefined = undefined;
    if (hasInferredType(node))
      typeNode = this.resolver.createTypeOfDeclaration(
        this.context,
        node,
        this.enclosingDeclaration,
        this.nodeBuilderFlags(),
        tracker,
      );
    else if (isFunctionLike(node))
      typeNode = this.resolver.createReturnTypeOfSignatureDeclaration(
        this.context,
        node,
        this.enclosingDeclaration,
        this.nodeBuilderFlags(),
        tracker,
      );
    tracker.errorNameNode = oldErrorNameNode;
    if (!this.suppressNewDiagnosticContexts) tracker.diagnosticContext = oldContext;
    return typeNode ?? this.keyword(SyntaxKind.AnyKeyword);
  }

  private nodeBuilderFlags(): NodeBuilderFlags {
    return this.inClassExpressionDeclaration
      ? NodeBuilderFlags.DeclarationEmit & ~NodeBuilderFlags.WriteClassExpressionAsTypeLiteral
      : NodeBuilderFlags.DeclarationEmit;
  }

  private shouldPrintWithInitializer(node: Node): boolean {
    return (
      this.canHaveLiteralInitializer(node) &&
      getInitializer(node) !== undefined &&
      this.resolver.isLiteralConstDeclaration(this.context.mostOriginal(node))
    );
  }

  private canHaveLiteralInitializer(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertySignature:
        return !this.isPrivate(node);
      case SyntaxKind.Parameter:
      case SyntaxKind.VariableDeclaration:
        return true;
    }
    return false;
  }

  private ensureNoInitializer(node: Node): Node | undefined {
    if (!this.shouldPrintWithInitializer(node)) return undefined;
    if (!isPrimitiveLiteralValue(skipParenthesesOnly(getInitializer(node)!), true))
      this.tracker.reportInferenceFallback(node);
    return this.resolver.createLiteralConstValue(this.context, this.parseNode(node), this.tracker);
  }

  private transformImportEquals(declaration: ImportEqualsDeclaration): Node | undefined {
    if (!this.resolver.isDeclarationVisible(declaration)) return undefined;
    const reference = declaration.moduleReference;
    if (reference instanceof ExternalModuleReference)
      return this.factory.updateImportEqualsDeclaration(
        declaration,
        declaration.modifiers,
        declaration.isTypeOnly,
        declaration.name,
        this.factory.updateExternalModuleReference(
          reference,
          this.rewriteModuleSpecifier(declaration, reference.expression)!,
        ),
      );
    const tracker = this.tracker;
    const oldContext = tracker.diagnosticContext;
    tracker.diagnosticContext = declarationContext(declaration);
    this.checkEntityNameVisibility(reference, this.enclosingDeclaration);
    tracker.diagnosticContext = oldContext;
    return declaration;
  }

  private transformImportDeclaration(declaration: ImportDeclaration): ImportDeclaration | undefined {
    const clause = declaration.importClause;
    // `import "mod"` may be needed for its side effects, like global augmentations.
    if (clause === undefined) return this.updateImport(declaration, undefined);
    const phaseModifier = clause.phaseModifier === SyntaxKind.DeferKeyword ? undefined : clause.phaseModifier;
    // The import clause's visibility is the default binding's.
    const defaultBinding =
      clause.name !== undefined && this.resolver.isDeclarationVisible(clause) ? clause.name : undefined;
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      if (defaultBinding === undefined) return undefined;
      return this.updateImport(
        declaration,
        this.factory.updateImportClause(clause, phaseModifier, defaultBinding, undefined),
      );
    }
    if (bindings instanceof NamespaceImport) {
      const namespace = this.resolver.isDeclarationVisible(bindings) ? bindings : undefined;
      if (defaultBinding === undefined && namespace === undefined) return undefined;
      return this.updateImport(
        declaration,
        this.factory.updateImportClause(clause, phaseModifier, defaultBinding, namespace),
      );
    }
    const visibleBindings: Node[] = [];
    if (bindings instanceof NamedImports)
      for (const element of bindings.elements.nodes)
        if (this.resolver.isDeclarationVisible(element)) visibleBindings.push(element);
    if (visibleBindings.length > 0 || defaultBinding !== undefined) {
      const namedImports =
        visibleBindings.length > 0 && bindings instanceof NamedImports
          ? this.factory.updateNamedImports(bindings, this.factory.createNodeList(visibleBindings))
          : undefined;
      return this.updateImport(
        declaration,
        this.factory.updateImportClause(clause, phaseModifier, defaultBinding, namedImports),
      );
    }
    // A module augmentation of an export may depend on the import.
    if (this.resolver.isImportRequiredByAugmentation(declaration)) {
      if (this.tracker.isolatedDeclarations)
        this.tracker.addDiagnostic(
          createDiagnosticForNode(
            declaration,
            Diagnostics.Declaration_emit_for_this_file_requires_preserving_this_import_for_augmentations_This_is_not_supported_with_isolatedDeclarations,
            [],
          ),
        );
      return this.updateImport(declaration, undefined);
    }
    return undefined;
  }

  private updateImport(declaration: ImportDeclaration, clause: ImportClause | undefined): ImportDeclaration {
    return this.factory.updateImportDeclaration(
      declaration,
      declaration.modifiers,
      clause,
      this.rewriteModuleSpecifier(declaration, declaration.moduleSpecifier)!,
      this.tryGetResolutionModeOverride(declaration.attributes),
    );
  }

  // Visibility helpers

  private parseNode(node: Node): Node {
    return this.context.parseNode(node) ?? node;
  }

  private isPrivate(node: Node): boolean {
    return this.resolver.getEffectiveDeclarationFlags(node, ModifierFlags.Private) !== 0;
  }

  private isDeclarationAndNotVisible(node: Node): boolean {
    const parseNode = this.parseNode(node);
    switch (parseNode.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.EnumDeclaration:
        return !this.resolver.isDeclarationVisible(parseNode);
      // These filter their members' visibility themselves.
      case SyntaxKind.VariableDeclaration:
        return !this.getBindingNameVisible(parseNode);
      case SyntaxKind.ClassStaticBlockDeclaration:
        return true;
    }
    return false;
  }

  private getBindingNameVisible(element: Node): boolean {
    if (element.kind === SyntaxKind.OmittedExpression) return false;
    const name = getName(element);
    if (name === undefined) return false;
    if (name instanceof BindingPattern) {
      // Visible if any element was marked visible, as by referenced aliases.
      for (const child of name.elements.nodes) if (this.getBindingNameVisible(child)) return true;
      return false;
    }
    return this.resolver.isDeclarationVisible(element);
  }

  private shouldStripInternal(node: Node): boolean {
    const file = this.tracker.currentSourceFile;
    return this.tracker.stripInternal && file !== undefined && this.isInternalDeclaration(node, file);
  }

  /** Whether a declaration has an `@internal` comment. */
  private isInternalDeclaration(node: Node, file: SourceFile): boolean {
    const parseTreeNode = this.context.mostOriginal(node);
    if ((parseTreeNode.flags & NodeFlags.Synthesized) !== 0) return false;
    const text = file.text;
    if (parseTreeNode instanceof ParameterDeclaration) {
      // The comment can precede the parameter or follow the previous one's comma:
      // `a, /** @internal */ public b: string`.
      const parameters = getParameters(parseTreeNode.parent!)!.nodes;
      const index = parameters.indexOf(parseTreeNode);
      let ranges: CommentRange[];
      if (index > 0) {
        const trailingPos = skipTrivia(text, parameters[index - 1].end + 1, false, true);
        ranges = commentRanges(getTrailingCommentRanges(text, trailingPos)).concat(
          commentRanges(getLeadingCommentRanges(text, node.pos)),
        );
      } else ranges = commentRanges(getTrailingCommentRanges(text, skipTrivia(text, node.pos, false, true)));
      return ranges.length > 0 && hasInternalAnnotation(text, ranges[ranges.length - 1]);
    }
    if (parseTreeNode.kind === SyntaxKind.JsxText) return false;
    for (const range of commentRanges(getLeadingCommentRanges(text, parseTreeNode.pos)))
      if (hasInternalAnnotation(text, range)) return true;
    return false;
  }
}

function commentRanges(ranges: CommentRange[] | undefined): CommentRange[] {
  return ranges ?? [];
}

function hasInternalAnnotation(text: string, range: CommentRange): boolean {
  return text.substring(range.pos, range.end).indexOf('@internal') >= 0;
}

class DiagnosticScope {
  readonly context: DiagnosticContext;
  readonly errorNameNode: Node | undefined;
  readonly suppressNewDiagnosticContexts: boolean;

  constructor(context: DiagnosticContext, errorNameNode: Node | undefined, suppressNewDiagnosticContexts: boolean) {
    this.context = context;
    this.errorNameNode = errorNameNode;
    this.suppressNewDiagnosticContexts = suppressNewDiagnosticContexts;
  }
}

const modifierKindsInOrder: SyntaxKind[] = [
  SyntaxKind.ExportKeyword,
  SyntaxKind.DeclareKeyword,
  SyntaxKind.DefaultKeyword,
  SyntaxKind.ConstKeyword,
  SyntaxKind.PublicKeyword,
  SyntaxKind.PrivateKeyword,
  SyntaxKind.ProtectedKeyword,
  SyntaxKind.AbstractKeyword,
  SyntaxKind.StaticKeyword,
  SyntaxKind.OverrideKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.AccessorKeyword,
  SyntaxKind.AsyncKeyword,
  SyntaxKind.InKeyword,
  SyntaxKind.OutKeyword,
];

function preservedReferences(references: readonly FileReference[]): FileReference[] {
  const result: FileReference[] = [];
  for (const reference of references)
    if (reference.preserve)
      result.push(new FileReference(-1, -1, reference.fileName, reference.resolutionMode, reference.preserve));
  return result;
}

/** Whether a node is a declaration (type parameters only when attached). */
function isDeclaration(node: Node): boolean {
  if (node.kind === SyntaxKind.TypeParameter) return node.parent !== undefined;
  return isDeclarationNode(node);
}

function isEntityName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName;
}

function isThisParameterNode(node: Node): boolean {
  return node instanceof ParameterDeclaration && node.name instanceof Identifier && node.name.text === 'this';
}

/** Declarations whose scope names in their types are resolved from. */
function isEnclosingDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.SourceFile:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.MappedType:
    case SyntaxKind.VariableDeclaration:
      return true;
  }
  return isFunctionLike(node);
}

function isLateVisibilityPaintedStatement(node: Node): boolean {
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

function isExternalModuleIndicator(node: Node): boolean {
  return (
    isAnyImportOrReExport(node) ||
    node.kind === SyntaxKind.ExportAssignment ||
    hasSyntacticModifier(node, ModifierFlags.Export)
  );
}

/** Whether a statement in a namespace without `export {}` would stop being exported implicitly. */
function needsScopeMarker(node: Node): boolean {
  return (
    !isAnyImportOrReExport(node) &&
    node.kind !== SyntaxKind.ExportAssignment &&
    !hasSyntacticModifier(node, ModifierFlags.Export) &&
    !isAmbientModule(node)
  );
}

function hasScopeMarker(statements: NodeList): boolean {
  for (const statement of statements.nodes)
    if (statement.kind === SyntaxKind.ExportAssignment || statement.kind === SyntaxKind.ExportDeclaration) return true;
  return false;
}

function maskModifierFlags(node: Node, mask: ModifierFlags, additions: ModifierFlags): ModifierFlags {
  let flags = (getCombinedModifierFlags(node) & mask) | additions;
  // A default export keeps `export` even where exports are stripped, and never has `declare`.
  if ((flags & ModifierFlags.Default) !== 0 && (flags & ModifierFlags.Export) === 0) flags ^= ModifierFlags.Export;
  if ((flags & ModifierFlags.Default) !== 0 && (flags & ModifierFlags.Ambient) !== 0) flags ^= ModifierFlags.Ambient;
  return flags;
}

function isImplicitlyExportedJSDocDeclaration(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined || parent.kind !== SyntaxKind.SourceFile) return false;
  if (!isExternalOrCommonJSModule(parent as SourceFile)) return false;
  if (node.kind === SyntaxKind.JSTypeAliasDeclaration) return true;
  return node.kind === SyntaxKind.ModuleDeclaration && (node.flags & NodeFlags.Reparsed) !== 0;
}

function canHaveModifiers(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.VariableStatement:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportDeclaration:
      return true;
  }
  return false;
}

/** Kinds whose type the resolver writes from the declaration rather than a signature. */
function hasInferredType(node: Node): boolean {
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

/** A literal that can be an initializer in a declaration file: a string, number, bigint or boolean. */
function isPrimitiveLiteralValue(node: Node, includeBigInt: boolean): boolean {
  switch (node.kind) {
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return true;
    case SyntaxKind.BigIntLiteral:
      return includeBigInt;
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = node as PrefixUnaryExpression;
      const operand = unary.operand;
      if (unary.operator === SyntaxKind.MinusToken)
        return operand instanceof NumericLiteral || (includeBigInt && operand.kind === SyntaxKind.BigIntLiteral);
      if (unary.operator === SyntaxKind.PlusToken) return operand instanceof NumericLiteral;
      return false;
    }
  }
  return false;
}

function skipParenthesesOnly(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.ParenthesizedExpression) current = getExpression(current)!;
  return current;
}

/** Skips what passes an expression's type through: parentheses, assignments and commas. */
function skipOuterExpressions(node: Node): Node {
  let current = node;
  for (;;) {
    if (current.kind === SyntaxKind.ParenthesizedExpression) current = getExpression(current)!;
    else if (
      current instanceof BinaryExpression &&
      (current.operatorToken.kind === SyntaxKind.EqualsToken || current.operatorToken.kind === SyntaxKind.CommaToken)
    )
      current = current.right;
    else return current;
  }
}

function getFirstConstructorWithBody(members: NodeList): ConstructorDeclaration | undefined {
  for (const member of members.nodes)
    if (member !== undefined && member instanceof ConstructorDeclaration && nodeIsPresent(member.body)) return member;
  return undefined;
}

function getClassExtendsHeritageElement(node: Node): ExpressionWithTypeArguments | undefined {
  const clauses = getHeritageClauses(node);
  if (clauses === undefined) return undefined;
  for (const clause of clauses.nodes)
    if (clause instanceof HeritageClause && clause.token === SyntaxKind.ExtendsKeyword) {
      const first = clause.types.nodes.length > 0 ? clause.types.nodes[0] : undefined;
      return first !== undefined && first instanceof ExpressionWithTypeArguments ? first : undefined;
    }
  return undefined;
}

/** Whether the original of `node` is on one line of its source file. */
function isOriginalNodeSingleLine(context: EmitContext, node: Node): boolean {
  const original = context.mostOriginal(node);
  if ((original.flags & NodeFlags.Synthesized) !== 0 || original.pos < 0) return false;
  const text = getSourceFileOfNode(original).text;
  for (let i = original.pos; i < original.end; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 || ch === 13) return false;
  }
  return true;
}

/** A node known to be present, checked where its type allows `undefined` at runtime. */
function defined(node: Node | undefined): Node {
  if (node === undefined) throw new Error('Expected a node');
  return node;
}

function asteriskOf(fn: Node): Token | undefined {
  if (fn !== undefined && fn instanceof FunctionExpression) return fn.asteriskToken;
  return undefined;
}

/** `const f = function () {}` or `const f = () => {}`. */
function isFunctionValuedVariable(node: Node): boolean {
  if (node.kind !== SyntaxKind.VariableDeclaration) return false;
  const initializer = getInitializer(node);
  return (
    initializer !== undefined &&
    (initializer.kind === SyntaxKind.FunctionExpression || initializer.kind === SyntaxKind.ArrowFunction)
  );
}

function appendFlattened(result: Node[], node: Node): boolean {
  if (node instanceof SyntaxList) for (const child of node.children) result.push(child);
  else result.push(node);
  return true;
}

/** The JSDoc `@type` signature of a function-like declaration. */
function getFullSignature(node: Node): Node | undefined {
  if (node instanceof FunctionExpression) return node.fullSignature;
  if (node instanceof ArrowFunction) return node.fullSignature;
  if (node instanceof FunctionDeclaration) return node.fullSignature;
  if (node instanceof MethodDeclaration) return node.fullSignature;
  if (node instanceof ConstructorDeclaration) return node.fullSignature;
  if (node instanceof GetAccessorDeclaration) return node.fullSignature;
  if (node instanceof SetAccessorDeclaration) return node.fullSignature;
  return undefined;
}

function isCommonJSAliasExport(node: Node): boolean {
  if (!(node instanceof BinaryExpression) || !(node.right instanceof Identifier)) return false;
  const symbol = node.symbol;
  return symbol !== undefined && declarationCount(symbol) === 1;
}

function getLeftmostAccessExpression(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.PropertyAccessExpression || current.kind === SyntaxKind.ElementAccessExpression)
    current = getExpression(current)!;
  return current;
}

/** Whether properties assigned to a function are emitted: one of its declarations has a body. */
function shouldEmitFunctionProperties(fn: FunctionDeclaration): boolean {
  if (fn.body !== undefined) return true;
  const symbol = fn.symbol;
  if (symbol === undefined) return false;
  for (const declaration of getDeclarations(symbol))
    if (declaration instanceof FunctionDeclaration && declaration.body !== undefined) return true;
  return false;
}

function isNonContextualKeyword(kind: SyntaxKind): boolean {
  return (
    kind >= SyntaxKind.FirstKeyword &&
    kind <= SyntaxKind.LastKeyword &&
    !(kind >= SyntaxKind.FirstContextualKeyword && kind <= SyntaxKind.LastContextualKeyword)
  );
}

function isClassExtendingNull(heritage: NodeList): boolean {
  if (heritage.nodes.length !== 1) return false;
  for (const type of (heritage.nodes[0] as HeritageClause).types.nodes)
    if (getExpression(type)!.kind === SyntaxKind.NullKeyword) return true;
  return false;
}

function getTextOfPropertyName(name: Node): string {
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getText(name);
  }
  return '';
}

/** The key of a class member for deduplicating `this.x` members: name, staticness and privateness. */
function thisPropertyKey(name: Node, node: Node, isStaticMember: boolean): string {
  const prefix = (isStaticMember ? 's' : 'i') + (name instanceof PrivateIdentifier ? '#' : '.');
  if (!(name instanceof ComputedPropertyName) && name.kind !== SyntaxKind.ElementAccessExpression) {
    const text = getTextOfPropertyName(name);
    if (text !== '' || name instanceof StringLiteral) return prefix + text;
  }
  return prefix + '@' + node.pos + ':' + node.end;
}

const enum ExpressionWalkerKind {
  ModuleExports,
  Members,
}

/** Walks a whole file for `module.exports =`, assigned properties and CommonJS exports. */
class ExpressionWalker extends NodeVisitor {
  readonly transformer: DeclarationTransformer;
  readonly kind: ExpressionWalkerKind;

  constructor(transformer: DeclarationTransformer, kind: ExpressionWalkerKind) {
    super();
    this.transformer = transformer;
    this.kind = kind;
  }

  visitNode(node: Node): boolean {
    // Only assignments and `Object.defineProperty` calls declare anything.
    if (node.kind === SyntaxKind.BinaryExpression || node.kind === SyntaxKind.CallExpression) {
      if (this.kind === ExpressionWalkerKind.ModuleExports) this.transformer.visitModuleExportsAssignment(node);
      else this.transformer.visitNestedExpression(node);
    }
    return node.forEachChild(this);
  }
}

/** Walks a class member for `this.x = …` assignments. */
class ThisPropertyWalker extends NodeVisitor {
  readonly transformer: DeclarationTransformer;
  readonly classNode: Node;

  constructor(transformer: DeclarationTransformer, classNode: Node) {
    super();
    this.transformer = transformer;
    this.classNode = classNode;
  }

  visitNode(node: Node): boolean {
    this.transformer.visitThisPropertyAssignment(node, this.classNode);
    return node.forEachChild(this);
  }
}

/** The text of a JSDoc comment: its text and links, without trailing whitespace. */
function getTextOfJSDocComment(comment: NodeList | undefined): string {
  if (comment === undefined) return '';
  let text = '';
  for (const n of comment.nodes) {
    if (n instanceof JSDocText) text += n.text;
    else if (
      n.kind === SyntaxKind.JSDocLink ||
      n.kind === SyntaxKind.JSDocLinkCode ||
      n.kind === SyntaxKind.JSDocLinkPlain
    )
      text += getSourceTextOfNode(getSourceFileOfNode(n), n);
  }
  return text.trimEnd();
}

function hasAnyBindingInitializers(pattern: BindingPattern): boolean {
  for (const element of pattern.elements.nodes) {
    if (!(element instanceof BindingElement)) continue;
    if (element.initializer !== undefined) return true;
    if (element.name instanceof BindingPattern && hasAnyBindingInitializers(element.name)) return true;
  }
  return false;
}
