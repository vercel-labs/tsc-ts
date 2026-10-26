// The TypeScript/JavaScript/JSX/JSON parser, a port of TypeScript 7.1's (tsgo) parser with its
// error recovery, parse diagnostics and JavaScript-specific reparsing.
//
// ```ts
// const file = parseSourceFile('/src/main.ts', text);
// for (const statement of file.statements.nodes) console.log(statement.kind);
// ```
import {
  appendToList,
  ArrayLiteralExpression,
  ArrayTypeNode,
  ArrowFunction,
  AsExpression,
  AwaitExpression,
  BigIntLiteral,
  BinaryExpression,
  BindingElement,
  BindingPattern,
  Block,
  BreakStatement,
  CallExpression,
  CallSignatureDeclaration,
  CaseBlock,
  CaseOrDefaultClause,
  CatchClause,
  CheckJsDirective,
  ClassDeclaration,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ComputedPropertyName,
  ConditionalExpression,
  ConditionalTypeNode,
  ConstructSignatureDeclaration,
  ConstructorDeclaration,
  ConstructorTypeNode,
  ContinueStatement,
  DebuggerStatement,
  Decorator,
  DeleteExpression,
  DoStatement,
  ElementAccessExpression,
  emptyCommentDirectives,
  emptyDiagnostics,
  emptyFileReferences,
  emptyNodes,
  emptyPragmas,
  EmptyStatement,
  EnumDeclaration,
  EnumMember,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  ExternalModuleIndicatorOptions,
  ExternalModuleReference,
  FileReference,
  ForInOrOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  FunctionTypeNode,
  GetAccessorDeclaration,
  HeritageClause,
  Identifier,
  IfStatement,
  ImportAttribute,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  ImportTypeNode,
  IndexSignatureDeclaration,
  IndexedAccessTypeNode,
  InferTypeNode,
  InterfaceDeclaration,
  IntersectionTypeNode,
  JSDocAllType,
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  JSDocVariadicType,
  JsxAttribute,
  JsxAttributes,
  JsxClosingElement,
  JsxClosingFragment,
  JsxElement,
  JsxExpression,
  JsxFragment,
  JsxNamespacedName,
  JsxOpeningElement,
  JsxOpeningFragment,
  JsxSelfClosingElement,
  JsxSpreadAttribute,
  JsxText,
  KeywordExpression,
  KeywordTypeNode,
  LabeledStatement,
  LiteralTypeNode,
  MappedTypeNode,
  MetaProperty,
  MethodDeclaration,
  MethodSignatureDeclaration,
  MissingDeclaration,
  ModifierFlags,
  MissingNodeList,
  ModifierList,
  ModuleBlock,
  ModuleDeclaration,
  NamedExports,
  NamedImports,
  NamedTupleMember,
  NamespaceExport,
  NamespaceExportDeclaration,
  NamespaceImport,
  NewExpression,
  NoSubstitutionTemplateLiteral,
  Node,
  NodeFlags,
  NodeList,
  NodeVisitor,
  NonNullExpression,
  NumericLiteral,
  ObjectLiteralExpression,
  OmittedExpression,
  OptionalTypeNode,
  ParameterDeclaration,
  ParenthesizedExpression,
  ParenthesizedTypeNode,
  ParseOptions,
  PostfixUnaryExpression,
  Pragma,
  PragmaArgument,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  QualifiedName,
  ReferenceIdentifier,
  RegularExpressionLiteral,
  RestTypeNode,
  ReturnStatement,
  SatisfiesExpression,
  ScriptKind,
  SemicolonClassElement,
  SetAccessorDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  SwitchStatement,
  TaggedTemplateExpression,
  TemplateExpression,
  TemplateHead,
  TemplateLiteralTypeNode,
  TemplateLiteralTypeSpan,
  TemplateMiddle,
  TemplateSpan,
  TemplateTail,
  ThisTypeNode,
  ThrowStatement,
  Token,
  Tristate,
  TryStatement,
  TupleTypeNode,
  TypeAliasDeclaration,
  TypeAssertion,
  TypeLiteralNode,
  TypeOfExpression,
  TypeOperatorNode,
  TypeParameterDeclaration,
  TypePredicateNode,
  TypeQueryNode,
  TypeReferenceNode,
  UnionTypeNode,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  VoidExpression,
  WhileStatement,
  WithStatement,
  YieldExpression,
  getBody,
  getIsTypeOnly,
  getModifiers,
  getName,
  getPostfixToken,
  getQuestionToken,
  getStatements,
  getText,
  getType,
  getTypeArguments,
  getTypeParameters,
  type EntityName,
  type Expression,
  type Statement,
  type TypeNode,
  newCallExpression,
  newPropertyAssignment,
} from './ast.js';
import {
  OperatorPrecedence,
  canHaveDecorators,
  canHaveIllegalDecorators,
  compareNodePositions,
  getBinaryOperatorPrecedence,
  getExternalModuleName,
  getImportTypeNodeLiteral,
  getTextOfNodeFromSourceText,
  isAmbientModule,
  isAnyImportOrReExport,
  isAssignmentOperator,
  isClassMemberModifier,
  isFunctionLike,
  isImportCall,
  isImportMeta,
  isInJSFile,
  isKeyword,
  isKeywordOrPunctuation,
  isLeftHandSideExpression,
  isModifierKind,
  isRequireCall,
  isReservedWord,
  isStringLiteralLike,
  modifierToFlag,
  modifiersToFlags,
  nodeIsMissing,
  nodeIsPresent,
  tagNamesAreEquivalent,
  tokenIsIdentifierOrKeyword,
  tokenIsIdentifierOrKeywordOrGreaterThan,
} from './ast-utilities.js';
import { CharacterCodes, isLineBreak } from './character-codes.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics, messageCode } from './diagnostics.js';
import { JSDocParser } from './jsdoc.js';
import { ModuleKind } from './module-resolution-types.js';
import { isDeclarationFileName, isExternalModuleNameRelative } from './path.js';
import {
  Scanner,
  ScannerErrorReporter,
  ScannerState,
  getLeadingCommentRanges,
  getViableKeywordSuggestions,
  skipTrivia,
  tokenToString,
} from './scanner.js';
import { getSpellingSuggestion } from './spelling.js';
import { SyntaxKind } from './syntax-kind.js';
import { type CommentRange, LanguageVariant, TokenFlags } from './types.js';

const enum ParsingContext {
  SourceElements,
  BlockStatements,
  SwitchClauses,
  SwitchClauseStatements,
  TypeMembers,
  ClassMembers,
  EnumMembers,
  HeritageClauseElement,
  VariableDeclarations,
  ObjectBindingElements,
  ArrayBindingElements,
  ArgumentExpressions,
  ObjectLiteralMembers,
  JsxAttributes,
  JsxChildren,
  ArrayLiteralMembers,
  Parameters,
  JSDocParameters,
  RestProperties,
  TypeParameters,
  TypeArguments,
  TupleElementTypes,
  HeritageClauses,
  ImportOrExportSpecifiers,
  ImportAttributes,
  JSDocComment,
  Count,
}

/** Which parser `parseList` and `parseDelimitedList` call for each element. */
const enum ListElement {
  Statement,
  TopLevelStatement,
  CaseOrDefaultClause,
  VariableDeclaration,
  VariableDeclarationAllowExclamation,
  ArrayBindingElement,
  ObjectBindingElement,
  ClassElement,
  HeritageClause,
  ExpressionWithTypeArguments,
  EnumMember,
  ImportSpecifier,
  ExportSpecifier,
  Type,
  ImportAttribute,
  TypeMember,
  TypeParameter,
  Parameter,
  /** A parameter of a signature, using `signatureParameter*` state. */
  SignatureParameter,
  TupleElement,
  JsxAttribute,
  ArgumentExpression,
  ArrayLiteralElement,
  ObjectLiteralElement,
}

export const enum ParseFlags {
  None = 0,
  Yield = 1 << 0,
  Await = 1 << 1,
  Type = 1 << 2,
  IgnoreMissingOpenBrace = 1 << 4,
  JSDoc = 1 << 5,
}

/** How an identifier is used, which decides whether it holds a flow node. */
export const enum IdentifierUse {
  /** An expression or another reference: a `ReferenceIdentifier`. */
  Reference,
  /** A declaration, property, property access or type name, whose flow node nothing reads: an `Identifier`. */
  Name,
  /** An object literal element's name: a name before `:`, `(` or `<`, a reference in a shorthand property. */
  ElementName,
}

/** What the scanner saw of the JSDoc comments preceding a token. */
export const enum JSDocScannerInfo {
  None = 0,
  HasJSDoc = 1 << 0,
  HasDeprecated = 1 << 1,
  HasSeeOrLink = 1 << 2,
}

const noArgs: readonly string[] = [];

/** Parser state saved by `mark` for speculative parsing. */
export class ParserState extends ScannerState {
  contextFlags: NodeFlags;
  diagnosticsLength: number;
  jsDiagnosticsLength: number;
  jsDocInfosLength: number;
  reparsedClonesLength: number;
  statementHasAwaitIdentifier: boolean;
  hasParseError: boolean;

  constructor(
    scanner: Scanner,
    contextFlags: NodeFlags,
    diagnosticsLength: number,
    jsDiagnosticsLength: number,
    jsDocInfosLength: number,
    reparsedClonesLength: number,
    statementHasAwaitIdentifier: boolean,
    hasParseError: boolean,
  ) {
    // One object for the scanner and parser state: speculation is frequent.
    super(
      scanner.pos,
      scanner.fullStartPos,
      scanner.tokenStart,
      scanner.token,
      scanner.tokenFlags,
      scanner.tokenValue,
      scanner.valueStart,
      scanner.valueEnd,
      scanner.commentDirectives.length,
      scanner.skipJSDocLeadingAsterisks,
    );
    this.contextFlags = contextFlags;
    this.diagnosticsLength = diagnosticsLength;
    this.jsDiagnosticsLength = jsDiagnosticsLength;
    this.jsDocInfosLength = jsDocInfosLength;
    this.reparsedClonesLength = reparsedClonesLength;
    this.statementHasAwaitIdentifier = statementHasAwaitIdentifier;
    this.hasParseError = hasParseError;
  }

  /** Overwrites this state with the parser's current one, like `Parser.mark`. */
  assignParser(p: Parser): void {
    this.assign(p.scanner);
    this.contextFlags = p.contextFlags;
    this.diagnosticsLength = p.diagnostics.length;
    this.jsDiagnosticsLength = p.jsDiagnostics.length;
    this.jsDocInfosLength = p.jsDocInfos.length;
    this.reparsedClonesLength = p.reparsedClones.length;
    this.statementHasAwaitIdentifier = p.statementHasAwaitIdentifier;
    this.hasParseError = p.hasParseError;
  }
}

function appendRange(to: Node[], from: readonly Node[], start: number, end: number): void {
  // `i += 1`: scriptc rejects `i++` here (the bounds come from array elements).
  for (let i = start; i < end; i += 1) to.push(from[i]!);
}

// The nodes of every empty parsed list. A list's nodes are pushed into a new `[]`, which natively
// reserves room for its first elements (112 bytes); a parsed list never changes, so an empty one
// keeps this shared array instead and its builder is freed.
const emptyListNodes: Node[] = [];

/** Parses `text` as the file `fileName`. The script kind defaults to the one implied by the extension. */
export function parseSourceFile(fileName: string, text: string, options?: ParseOptions): SourceFile {
  const path = options === undefined ? fileName : options.path;
  let scriptKind = options === undefined ? ScriptKind.Unknown : options.scriptKind;
  if (scriptKind === ScriptKind.Unknown) scriptKind = getScriptKindFromFileName(fileName);
  const moduleOptions =
    options === undefined ? new ExternalModuleIndicatorOptions(false, false) : options.externalModuleIndicatorOptions;
  const p = new Parser(fileName, path, text, scriptKind, moduleOptions);
  p.nextToken();
  if (scriptKind === ScriptKind.JSON) {
    // Like other files (parseSourceFileWorker): reading the caches later never writes to the file.
    const json = p.parseJSONText();
    json.computeCaches();
    p.release();
    return json;
  }
  const file = p.parseSourceFileWorker();
  p.release();
  return file;
}

/** Parses `text` as an entity name like `a.b.c`, or returns undefined if it isn't one. */
export function parseIsolatedEntityName(text: string): EntityName | undefined {
  const p = new Parser('/', '/', text, ScriptKind.JS, new ExternalModuleIndicatorOptions(false, false));
  p.nextToken();
  const entityName = p.parseEntityName(true, undefined);
  return p.token() === SyntaxKind.EndOfFile && p.diagnostics.length === 0 ? entityName : undefined;
}

export function getScriptKindFromFileName(fileName: string): ScriptKind {
  const dot = fileName.lastIndexOf('.');
  if (dot >= 0) {
    switch (fileName.substring(dot).toLowerCase()) {
      case '.js':
      case '.cjs':
      case '.mjs':
        return ScriptKind.JS;
      case '.jsx':
        return ScriptKind.JSX;
      case '.ts':
      case '.cts':
      case '.mts':
        return ScriptKind.TS;
      case '.tsx':
        return ScriptKind.TSX;
      case '.json':
        return ScriptKind.JSON;
    }
  }
  return ScriptKind.Unknown;
}

function getLanguageVariant(scriptKind: ScriptKind): LanguageVariant {
  switch (scriptKind) {
    case ScriptKind.TSX:
    case ScriptKind.JSX:
    case ScriptKind.JS:
    case ScriptKind.JSON:
      return LanguageVariant.JSX;
  }
  return LanguageVariant.Standard;
}

export class Parser extends ScannerErrorReporter {
  readonly scanner: Scanner;
  readonly fileName: string;
  readonly path: string;
  readonly sourceText: string;
  readonly scriptKind: ScriptKind;
  readonly languageVariant: LanguageVariant;
  readonly externalModuleIndicatorOptions: ExternalModuleIndicatorOptions;

  diagnostics: Diagnostic[];
  jsDiagnostics: Diagnostic[];
  jsDocDiagnostics: Diagnostic[];

  currentToken: SyntaxKind;
  sourceFlags: NodeFlags;
  contextFlags: NodeFlags;
  parsingContexts: number;
  statementHasAwaitIdentifier: boolean;
  hasDeprecatedTag: boolean;
  hasParseError: boolean;

  /** Identifier and interned literal texts in parse order, each identifier text once (other texts may repeat). */
  identifierTexts: string[];
  identifierCount: number;
  nodeCount: number;
  /** Start positions of parenthesized arrow function candidates that turned out not to be arrows. */
  notParenthesizedArrow: Set<number>;
  /** Pairs of [start, end) statement indexes that may need reparsing for top-level await. */
  possibleAwaitSpans: number[];
  /** Nodes produced by JSDoc reparsing to insert before the current list element. */
  reparseList: Node[];
  // One reparse list per nesting depth of `parseListIndex`, reused by sibling lists: a list rarely
  // receives reparsed nodes, and a fresh array per parsed list would be one more allocation each.
  private readonly reparseLists: Node[][];
  private reparseDepth: number;
  // One scratch array per nesting depth of the lists being parsed. A list collects its elements in
  // its depth's array and is copied out at its exact length, so the tree keeps no spare capacity.
  private readonly listScratch: Node[][];
  private listDepth: number;
  reparsedClones: Node[];
  /** Nodes with eagerly parsed JSDoc, for rewinding. */
  jsDocInfos: Node[];
  /** The eagerly parsed JSDoc of this file's nodes by node id; becomes `SourceFile.jsDocs`. */
  jsDocTable: Map<number, Node[]> | undefined;

  // State for `ListElement.SignatureParameter`.
  signatureParameterInAwaitContext: boolean;
  signatureParameterAllowAmbiguity: boolean;
  signatureParameterFlags: ParseFlags;

  /** Parses JSDoc comments and, in JavaScript files, reparses their tags. */
  jsdoc: JSDocParser;
  /**
   * Returned instead of `undefined` by hot element parsers: a `Node | undefined` result is boxed natively
   * for every node returned.
   */
  readonly noElement: Node;
  // States reused by speculation that ends before the method that started it returns, by depth.
  private readonly speculation: ParserState[];
  private speculationDepth: number;

  constructor(
    fileName: string,
    path: string,
    sourceText: string,
    scriptKind: ScriptKind,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
    /** The scanner copies the code units of only the ranges it is asked to (`Scanner.loadUnits`). */
    unitsOnDemand = false,
  ) {
    super();
    if (scriptKind === ScriptKind.Unknown) throw new Error('ScriptKind must be specified when parsing ' + fileName);
    this.fileName = fileName;
    this.path = path;
    this.sourceText = sourceText;
    this.scriptKind = scriptKind;
    this.languageVariant = getLanguageVariant(scriptKind);
    this.externalModuleIndicatorOptions = externalModuleIndicatorOptions;
    this.diagnostics = [];
    this.jsDiagnostics = [];
    this.jsDocDiagnostics = [];
    this.currentToken = SyntaxKind.Unknown;
    this.sourceFlags = NodeFlags.None;
    this.contextFlags = NodeFlags.None;
    if (scriptKind === ScriptKind.JS || scriptKind === ScriptKind.JSX) this.contextFlags = NodeFlags.JavaScriptFile;
    else if (scriptKind === ScriptKind.JSON) this.contextFlags = NodeFlags.JavaScriptFile | NodeFlags.JsonFile;
    this.parsingContexts = 0;
    this.statementHasAwaitIdentifier = false;
    this.hasDeprecatedTag = false;
    this.hasParseError = false;
    this.identifierTexts = [];
    this.identifierCount = 0;
    this.nodeCount = 0;
    this.notParenthesizedArrow = new Set<number>();
    this.possibleAwaitSpans = [];
    this.reparseList = [];
    this.reparseLists = [this.reparseList];
    this.reparseDepth = 0;
    this.listScratch = [];
    this.listDepth = -1;
    this.reparsedClones = [];
    this.jsDocInfos = [];
    this.jsDocTable = undefined;
    this.signatureParameterInAwaitContext = false;
    this.signatureParameterAllowAmbiguity = false;
    this.signatureParameterFlags = ParseFlags.None;
    this.jsdoc = new JSDocParser(this);
    this.noElement = new Token(SyntaxKind.Unknown);
    this.speculation = [];
    this.speculationDepth = 0;
    this.scanner = new Scanner(sourceText, unitsOnDemand);
    this.scanner.setOnError(this);
    this.scanner.setLanguageVariant(this.languageVariant);
  }

  /**
   * Frees the scanner's copy of the text once the parser is done, and drops the references back to
   * this parser from its scanner and JSDoc parser. Natively, the parser is then freed as soon as its
   * caller lets go of it, instead of at a cycle collection, which may come much later (on a parse
   * thread, not before the thread exits).
   */
  release(): void {
    this.scanner.setText('');
    this.scanner.setOnError(undefined);
    this.jsdoc = releasedParser().jsdoc;
  }

  token(): SyntaxKind {
    return this.currentToken;
  }

  isJavaScript(): boolean {
    return this.scriptKind === ScriptKind.JS || this.scriptKind === ScriptKind.JSX;
  }

  // Diagnostics

  onError(message: DiagnosticMessage, start: number, length: number, args: readonly string[]): void {
    this.parseErrorAt(start, start + length, message, args);
  }

  /** Reports an error unless the previous one starts at the same position. */
  parseErrorAt(
    pos: number,
    end: number,
    message: DiagnosticMessage,
    args: readonly string[] = noArgs,
  ): Diagnostic | undefined {
    const diagnostics = this.diagnostics;
    let result: Diagnostic | undefined;
    if (diagnostics.length === 0 || diagnostics[diagnostics.length - 1]!.pos !== pos) {
      result = new Diagnostic(undefined, pos, end, message, args);
      diagnostics.push(result);
    }
    this.hasParseError = true;
    return result;
  }

  parseErrorAtCurrentToken(message: DiagnosticMessage, args: readonly string[] = noArgs): Diagnostic | undefined {
    return this.parseErrorAt(this.scanner.getTokenStart(), this.scanner.getTokenEnd(), message, args);
  }

  /** A diagnostic for TypeScript-only syntax in a JavaScript file, starting after trivia. */
  jsErrorAt(pos: number, end: number, message: DiagnosticMessage, args: readonly string[] = noArgs): void {
    this.jsDiagnostics.push(new Diagnostic(undefined, skipTrivia(this.sourceText, pos), end, message, args));
  }

  // Speculative parsing

  mark(): ParserState {
    return new ParserState(
      this.scanner,
      this.contextFlags,
      this.diagnostics.length,
      this.jsDiagnostics.length,
      this.jsDocInfos.length,
      this.reparsedClones.length,
      this.statementHasAwaitIdentifier,
      this.hasParseError,
    );
  }

  /** Attaches eagerly parsed JSDoc to `node`, undone by `rewind`. */
  setJSDoc(node: Node, jsDoc: Node[]): void {
    let table = this.jsDocTable;
    if (table === undefined) {
      table = new Map<number, Node[]>();
      this.jsDocTable = table;
    }
    table.set(node.id, jsDoc);
    this.jsDocInfos.push(node);
  }

  rewind(state: ParserState): void {
    this.scanner.rewind(state);
    this.currentToken = this.scanner.getToken();
    this.contextFlags = state.contextFlags;
    // Truncate only when needed: setting an array's length is not free.
    if (this.diagnostics.length !== state.diagnosticsLength) this.diagnostics.length = state.diagnosticsLength;
    if (this.jsDiagnostics.length !== state.jsDiagnosticsLength) this.jsDiagnostics.length = state.jsDiagnosticsLength;
    const jsDocInfos = this.jsDocInfos;
    while (jsDocInfos.length > state.jsDocInfosLength) {
      const node = jsDocInfos.pop();
      if (node !== undefined && this.jsDocTable !== undefined) this.jsDocTable.delete(node.id);
    }
    if (this.reparsedClones.length !== state.reparsedClonesLength)
      this.reparsedClones.length = state.reparsedClonesLength;
    this.statementHasAwaitIdentifier = state.statementHasAwaitIdentifier;
    this.hasParseError = state.hasParseError;
  }

  /** Like `mark`, but reuses a state object; balance every call with `endSpeculation`. */
  beginSpeculation(): ParserState {
    const depth = this.speculationDepth++;
    if (depth === this.speculation.length) {
      const state = this.mark();
      this.speculation.push(state);
      return state;
    }
    const state = this.speculation[depth]!;
    state.assignParser(this);
    return state;
  }

  /** Releases the state from `beginSpeculation`, keeping the current parser state. */
  endSpeculation(_state: ParserState): void {
    this.speculationDepth--;
  }

  /** Runs `callback` and restores the parser state afterwards. */
  lookAhead(callback: (p: Parser) => boolean): boolean {
    const state = this.beginSpeculation();
    const result = callback(this);
    this.rewind(state);
    this.endSpeculation(state);
    return result;
  }

  // Tokens

  nextToken(): SyntaxKind {
    // Keywords can't contain escapes.
    if (isKeyword(this.token()) && (this.scanner.hasUnicodeEscape() || this.scanner.hasExtendedUnicodeEscape()))
      this.parseErrorAtCurrentToken(Diagnostics.Keywords_cannot_contain_escape_characters);
    this.currentToken = this.scanner.scan();
    return this.token();
  }

  nextTokenWithoutCheck(): SyntaxKind {
    this.currentToken = this.scanner.scan();
    return this.token();
  }

  nextTokenJSDoc(): SyntaxKind {
    this.currentToken = this.scanner.scanJSDocToken();
    return this.token();
  }

  nextJSDocCommentTextToken(inBackticks: boolean): SyntaxKind {
    this.currentToken = this.scanner.scanJSDocCommentTextToken(inBackticks);
    return this.token();
  }

  nodePos(): number {
    return this.scanner.getTokenFullStart();
  }

  hasPrecedingLineBreak(): boolean {
    return this.scanner.hasPrecedingLineBreak();
  }

  jsdocScannerInfo(): JSDocScannerInfo {
    const scanner = this.scanner;
    if (!scanner.hasPrecedingJSDocComment()) return JSDocScannerInfo.None;
    let info = JSDocScannerInfo.HasJSDoc;
    if (scanner.hasPrecedingJSDocWithDeprecatedTag()) info |= JSDocScannerInfo.HasDeprecated;
    if (scanner.hasPrecedingJSDocWithSeeOrLink()) info |= JSDocScannerInfo.HasSeeOrLink;
    return info;
  }

  // Context flags

  setContextFlags(flags: NodeFlags, value: boolean): void {
    if (value) this.contextFlags |= flags;
    else this.contextFlags &= ~flags;
  }

  inYieldContext(): boolean {
    return (this.contextFlags & NodeFlags.YieldContext) !== 0;
  }

  inDisallowInContext(): boolean {
    return (this.contextFlags & NodeFlags.DisallowInContext) !== 0;
  }

  inDisallowConditionalTypesContext(): boolean {
    return (this.contextFlags & NodeFlags.DisallowConditionalTypesContext) !== 0;
  }

  inDecoratorContext(): boolean {
    return (this.contextFlags & NodeFlags.DecoratorContext) !== 0;
  }

  inAwaitContext(): boolean {
    return (this.contextFlags & NodeFlags.AwaitContext) !== 0;
  }

  // Nodes

  newNodeList(pos: number, end: number, nodes: Node[]): NodeList {
    return new NodeList(pos, end, nodes.length === 0 ? emptyListNodes : nodes);
  }

  newModifierList(pos: number, end: number, nodes: Node[]): ModifierList {
    return new ModifierList(pos, end, nodes.length === 0 ? emptyListNodes : nodes, modifiersToFlags(nodes));
  }

  finishNode(node: Node, pos: number): Node {
    return this.finishNodeWithEnd(node, pos, this.nodePos());
  }

  finishNodeWithEnd(node: Node, pos: number, end: number): Node {
    node.pos = pos | 0;
    node.end = end | 0;
    node.flags |= this.contextFlags;
    if (this.hasParseError) {
      node.flags |= NodeFlags.ThisNodeHasError;
      this.hasParseError = false;
    }
    this.nodeCount++;
    this.overrideParentInImmediateChildren(node);
    return node;
  }

  overrideParentInImmediateChildren(node: Node): void {
    node.setParentOfChildren();
  }

  // Source files

  parseSourceFileWorker(): SourceFile {
    const isDeclarationFile = isDeclarationFileName(this.fileName);
    if (isDeclarationFile) this.contextFlags |= NodeFlags.Ambient;
    const pos = this.nodePos();
    let statements = this.parseListIndex(ParsingContext.SourceElements, ListElement.TopLevelStatement);
    const end = this.nodePos();
    const endJSDoc = this.jsdocScannerInfo();
    const eof = this.parseTokenNode();
    this.withJSDoc(eof, endJSDoc);
    if (eof.kind !== SyntaxKind.EndOfFile) throw new Error('Expected end of file token from scanner.');
    if (this.reparseList.length !== 0) {
      statements = statements.concat(this.reparseList);
      this.reparseList = [];
    }
    let result = this.newSourceFile(this.newNodeList(pos, end, statements), eof);
    this.finishNode(result, pos);
    this.finishSourceFile(result, isDeclarationFile);
    if (
      !result.isDeclarationFile &&
      result.externalModuleIndicator !== undefined &&
      this.possibleAwaitSpans.length > 0
    ) {
      const reparse = this.reparseTopLevelAwait(result);
      this.finishNode(reparse, pos);
      if (reparse !== result) {
        result = reparse;
        this.finishSourceFile(result, isDeclarationFile);
      }
    }
    collectExternalModuleReferences(result);
    if (result.isJS()) result.jsDiagnostics = attachFileToDiagnostics(this.jsDiagnostics, result);
    // Files get their line starts on first use (in a thread's copy once they may be shared,
    // `useThreadTextCaches`): most files are never pointed into by a diagnostic. The file's
    // DiagnosticFile exists from here on, so reading it never writes to the file.
    result.diagnosticFile();
    return result;
  }

  newSourceFile(statements: NodeList, eof: Token): SourceFile {
    return new SourceFile(
      this.fileName,
      this.path,
      this.sourceText,
      this.externalModuleIndicatorOptions,
      statements,
      eof,
    );
  }

  finishSourceFile(result: SourceFile, isDeclarationFile: boolean): void {
    const commentDirectives = this.scanner.getCommentDirectives();
    result.commentDirectives = commentDirectives.length === 0 ? emptyCommentDirectives : commentDirectives;
    result.pragmas = getCommentPragmas(this.sourceText);
    this.processPragmasIntoFields(result);
    result.diagnostics = attachFileToDiagnostics(this.diagnostics, result);
    result.jsDocDiagnostics = attachFileToDiagnostics(this.jsDocDiagnostics, result);
    result.isDeclarationFile = isDeclarationFile;
    result.languageVariant = this.languageVariant;
    result.scriptKind = this.scriptKind;
    result.flags |= this.sourceFlags;
    result.identifierTexts = this.identifierTexts;
    result.nodeCount = this.nodeCount;
    result.textCount = this.identifierCount;
    result.identifierCount = this.identifierCount;
    // JSDoc of TypeScript files is parsed on first use.
    result.hasLazyJSDoc = !this.isJavaScript();
    // The table stays with the parser: when top-level await reparsing produces a second source
    // file, it finishes with the same table, which still holds the JSDoc of retained statements.
    result.jsDocs = this.jsDocTable;
    if (this.reparsedClones.length === 0) result.reparsedClones = emptyNodes;
    else {
      const clones = this.reparsedClones.slice();
      clones.sort(compareNodePositions);
      result.reparsedClones = clones;
    }
    setExternalModuleIndicator(result);
  }

  parseToplevelStatement(index: number): Statement {
    this.statementHasAwaitIdentifier = false;
    const statement = this.parseStatement();
    // JSDoc reparses produced while parsing this statement are inserted before it.
    const i = index + this.reparseList.length;
    if (this.statementHasAwaitIdentifier && (statement.flags & NodeFlags.AwaitContext) === 0) {
      const spans = this.possibleAwaitSpans;
      if (spans.length === 0 || spans[spans.length - 1]! !== i) spans.push(i, i + 1);
      else spans[spans.length - 1] = i + 1;
    }
    return statement;
  }

  reparseTopLevelAwait(sourceFile: SourceFile): SourceFile {
    const spans = this.possibleAwaitSpans;
    if (spans.length % 2 === 1)
      throw new Error('possibleAwaitSpans malformed: odd number of indices, not paired into spans.');
    const original = sourceFile.statements.nodes;
    const statements: Node[] = [];
    const savedParseDiagnostics = this.diagnostics;
    this.diagnostics = [];
    let afterAwaitStatement: number = 0;
    for (let i = 0; i < spans.length; i += 2) {
      const nextAwaitStatement: number = spans[i]!;
      // Copy the statements up to the next span with their diagnostics.
      const prevStatement = original[afterAwaitStatement]!;
      const nextStatement = original[nextAwaitStatement]!;
      appendRange(statements, original, afterAwaitStatement, nextAwaitStatement);
      const diagnosticStart = findDiagnosticAtOrAfter(savedParseDiagnostics, 0, prevStatement.pos);
      if (diagnosticStart >= 0) {
        const diagnosticEnd = findDiagnosticAtOrAfter(savedParseDiagnostics, diagnosticStart, nextStatement.pos);
        const stop = diagnosticEnd >= 0 ? diagnosticEnd : savedParseDiagnostics.length;
        for (let j = diagnosticStart; j < stop; j++) this.diagnostics.push(savedParseDiagnostics[j]!);
      }
      // Reparse the span's statements in an await context, keeping only the new diagnostics.
      const state = this.mark();
      this.contextFlags |= NodeFlags.AwaitContext;
      this.scanner.resetPos(nextStatement.pos);
      this.nextToken();
      afterAwaitStatement = spans[i + 1]!;
      while (this.token() !== SyntaxKind.EndOfFile) {
        const startPos = this.scanner.getTokenFullStart();
        const statement = this.parseStatement();
        statements.push(statement);
        if (startPos === this.scanner.getTokenFullStart()) this.nextToken();
        if (afterAwaitStatement < original.length) {
          const lastAwaitStatement = original[afterAwaitStatement - 1]!;
          if (statement.end === lastAwaitStatement.end) break;
          if (statement.end > lastAwaitStatement.end) {
            // We ate into the next statement, so continue with the next span.
            i += 2;
            afterAwaitStatement = i < spans.length ? spans[i + 1]! : original.length;
          }
        }
      }
      state.diagnosticsLength = this.diagnostics.length;
      this.rewind(state);
    }
    // Copy the remaining statements with their diagnostics.
    if (afterAwaitStatement < original.length) {
      const prevStatement = original[afterAwaitStatement]!;
      appendRange(statements, original, afterAwaitStatement, original.length);
      const diagnosticStart = findDiagnosticAtOrAfter(savedParseDiagnostics, 0, prevStatement.pos);
      if (diagnosticStart >= 0)
        for (let j = diagnosticStart; j < savedParseDiagnostics.length; j++)
          this.diagnostics.push(savedParseDiagnostics[j]!);
    }
    const list = sourceFile.statements;
    const result = this.newSourceFile(this.newNodeList(list.pos, list.end, statements), sourceFile.endOfFileToken);
    for (const statement of statements) statement.parent = result;
    return result;
  }

  // Lists

  /** The element, or `noElement` if a signature parameter can't start here. */
  parseListElement(element: ListElement, index: number): Node {
    switch (element) {
      case ListElement.Statement:
        return this.parseStatement();
      case ListElement.TopLevelStatement:
        return this.parseToplevelStatement(index);
      case ListElement.CaseOrDefaultClause:
        return this.parseCaseOrDefaultClause();
      case ListElement.VariableDeclaration:
        return this.parseVariableDeclaration();
      case ListElement.VariableDeclarationAllowExclamation:
        return this.parseVariableDeclarationAllowExclamation();
      case ListElement.ArrayBindingElement:
        return this.parseArrayBindingElement();
      case ListElement.ObjectBindingElement:
        return this.parseObjectBindingElement();
      case ListElement.ClassElement:
        return this.parseClassElement();
      case ListElement.HeritageClause:
        return this.parseHeritageClause();
      case ListElement.ExpressionWithTypeArguments:
        return this.parseExpressionWithTypeArguments();
      case ListElement.EnumMember:
        return this.parseEnumMember();
      case ListElement.ImportSpecifier:
        return this.parseImportSpecifier();
      case ListElement.ExportSpecifier:
        return this.parseExportSpecifier();
      case ListElement.Type:
        return this.parseType();
      case ListElement.ImportAttribute:
        return this.parseImportAttribute();
      case ListElement.TypeMember:
        return this.parseTypeMember();
      case ListElement.TypeParameter:
        return this.parseTypeParameter();
      case ListElement.Parameter:
        return this.parseParameter();
      case ListElement.SignatureParameter: {
        const parameter = this.parseParameterEx(
          this.signatureParameterInAwaitContext,
          this.signatureParameterAllowAmbiguity,
        );
        if (parameter !== this.noElement && (this.signatureParameterFlags & ParseFlags.Type) === 0)
          this.checkJSSyntax(parameter);
        return parameter;
      }
      case ListElement.TupleElement:
        return this.parseTupleElementNameOrTupleElementType();
      case ListElement.JsxAttribute:
        return this.parseJsxAttribute();
      case ListElement.ArgumentExpression:
        return this.parseArgumentExpression();
      case ListElement.ArrayLiteralElement:
        return this.parseArgumentOrArrayLiteralElement();
      case ListElement.ObjectLiteralElement:
        return this.parseObjectLiteralElement();
    }
  }

  parseListIndex(kind: ParsingContext, element: ListElement): Node[] {
    const saveParsingContexts = this.parsingContexts;
    this.parsingContexts |= 1 << kind;
    const outerReparseList = this.reparseList;
    const depth = ++this.reparseDepth;
    if (depth === this.reparseLists.length) this.reparseLists.push([]);
    const reparseList = this.reparseLists[depth]!;
    this.reparseList = reparseList;
    const list = this.openList();
    while (!this.isListTerminator(kind)) {
      if (this.isListElement(kind, false)) {
        const elt = this.parseListElement(element, list.length);
        if (reparseList.length !== 0) {
          for (const e of reparseList) {
            // Propagate @typedef aliases and @import declarations to a context that permits them.
            if (
              (e.kind === SyntaxKind.JSTypeAliasDeclaration || e.kind === SyntaxKind.JSImportDeclaration) &&
              kind !== ParsingContext.SourceElements &&
              kind !== ParsingContext.BlockStatements
            )
              outerReparseList.push(e);
            else list.push(e);
          }
          reparseList.length = 0;
        }
        if (elt !== this.noElement) list.push(elt);
        continue;
      }
      if (this.abortParsingListOrMoveToNextToken(kind)) break;
    }
    this.reparseDepth = depth - 1;
    this.reparseList = outerReparseList;
    this.parsingContexts = saveParsingContexts;
    return this.closeList(list);
  }

  parseList(kind: ParsingContext, element: ListElement): NodeList {
    const pos = this.nodePos();
    const nodes = this.parseListIndex(kind, element);
    return this.newNodeList(pos, this.nodePos(), nodes);
  }

  /** The list, or undefined if an element parser returned undefined. */
  parseDelimitedList(kind: ParsingContext, element: ListElement): NodeList | undefined {
    const pos = this.nodePos();
    const saveParsingContexts = this.parsingContexts;
    this.parsingContexts |= 1 << kind;
    const list = this.openList();
    for (;;) {
      if (this.isListElement(kind, false)) {
        const startPos = this.nodePos();
        const result = this.parseListElement(element, list.length);
        if (result === this.noElement) {
          this.closeList(list);
          this.parsingContexts = saveParsingContexts;
          return undefined;
        }
        list.push(result);
        if (this.parseOptional(SyntaxKind.CommaToken)) continue;
        if (this.isListTerminator(kind)) break;
        // No comma and no terminator: parse a comma for a good error message.
        if (this.token() !== SyntaxKind.CommaToken && kind === ParsingContext.EnumMembers)
          this.parseErrorAtCurrentToken(Diagnostics.An_enum_member_name_must_be_followed_by_a_or);
        else this.parseExpected(SyntaxKind.CommaToken);
        // Skip semicolons used as delimiters, e.g. in object literals; the error is already reported.
        if (
          (kind === ParsingContext.ObjectLiteralMembers || kind === ParsingContext.ImportAttributes) &&
          this.token() === SyntaxKind.SemicolonToken &&
          !this.hasPrecedingLineBreak()
        )
          this.nextToken();
        // Nothing consumed: advance to avoid an infinite loop.
        if (startPos === this.nodePos()) this.nextToken();
        continue;
      }
      if (this.isListTerminator(kind)) break;
      if (this.abortParsingListOrMoveToNextToken(kind)) break;
    }
    this.parsingContexts = saveParsingContexts;
    return this.newNodeList(pos, this.nodePos(), this.closeList(list));
  }

  /** The scratch array for a list at the next nesting depth, empty. */
  private openList(): Node[] {
    const depth = ++this.listDepth;
    if (depth === this.listScratch.length) this.listScratch.push([]);
    return this.listScratch[depth]!;
  }

  /** The elements collected in `list` (the scratch array from `openList`) as an array of their exact
   * length, or the shared empty array; empties the scratch array for the next list at its depth. */
  private closeList(list: Node[]): Node[] {
    this.listDepth--;
    if (list.length === 0) return emptyListNodes;
    const nodes = list.slice();
    list.length = 0;
    return nodes;
  }

  /** The list; a missing list if `opening` is absent; undefined if an element parser returned undefined. */
  parseBracketedList(
    kind: ParsingContext,
    element: ListElement,
    opening: SyntaxKind,
    closing: SyntaxKind,
  ): NodeList | undefined {
    if (this.parseExpected(opening)) {
      const result = this.parseDelimitedList(kind, element);
      this.parseExpected(closing);
      return result;
    }
    return this.createMissingList();
  }

  parseEmptyNodeList(): NodeList {
    return this.newNodeList(this.nodePos(), this.nodePos(), []);
  }

  createMissingList(): NodeList {
    return new MissingNodeList(this.nodePos(), this.nodePos(), []);
  }

  /** Reports an error for the current token; returns true if parsing the list should stop. */
  abortParsingListOrMoveToNextToken(kind: ParsingContext): boolean {
    this.parsingContextErrors(kind);
    if (this.isInSomeParsingContext()) return true;
    this.nextToken();
    return false;
  }

  /** Whether the current token is an element or terminator of the current list or an enclosing one. */
  isInSomeParsingContext(): boolean {
    for (let kind = 0; kind < ParsingContext.Count; kind++) {
      if ((this.parsingContexts & (1 << kind)) !== 0) {
        const context = kind as ParsingContext;
        if (this.isListElement(context, true) || this.isListTerminator(context)) return true;
      }
    }
    return false;
  }

  parsingContextErrors(context: ParsingContext): void {
    switch (context) {
      case ParsingContext.SourceElements:
        if (this.token() === SyntaxKind.DefaultKeyword)
          this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, ['export']);
        else this.parseErrorAtCurrentToken(Diagnostics.Declaration_or_statement_expected);
        break;
      case ParsingContext.BlockStatements:
        this.parseErrorAtCurrentToken(Diagnostics.Declaration_or_statement_expected);
        break;
      case ParsingContext.SwitchClauses:
        this.parseErrorAtCurrentToken(Diagnostics.X_case_or_default_expected);
        break;
      case ParsingContext.SwitchClauseStatements:
        this.parseErrorAtCurrentToken(Diagnostics.Statement_expected);
        break;
      case ParsingContext.RestProperties:
      case ParsingContext.TypeMembers:
        this.parseErrorAtCurrentToken(Diagnostics.Property_or_signature_expected);
        break;
      case ParsingContext.ClassMembers:
        this.parseErrorAtCurrentToken(
          Diagnostics.Unexpected_token_A_constructor_method_accessor_or_property_was_expected,
        );
        break;
      case ParsingContext.EnumMembers:
        this.parseErrorAtCurrentToken(Diagnostics.Enum_member_expected);
        break;
      case ParsingContext.HeritageClauseElement:
        this.parseErrorAtCurrentToken(Diagnostics.Expression_expected);
        break;
      case ParsingContext.VariableDeclarations:
        if (isKeyword(this.token()))
          this.parseErrorAtCurrentToken(Diagnostics.X_0_is_not_allowed_as_a_variable_declaration_name, [
            tokenToString(this.token()),
          ]);
        else this.parseErrorAtCurrentToken(Diagnostics.Variable_declaration_expected);
        break;
      case ParsingContext.ObjectBindingElements:
        this.parseErrorAtCurrentToken(Diagnostics.Property_destructuring_pattern_expected);
        break;
      case ParsingContext.ArrayBindingElements:
        this.parseErrorAtCurrentToken(Diagnostics.Array_element_destructuring_pattern_expected);
        break;
      case ParsingContext.ArgumentExpressions:
        this.parseErrorAtCurrentToken(Diagnostics.Argument_expression_expected);
        break;
      case ParsingContext.ObjectLiteralMembers:
        this.parseErrorAtCurrentToken(Diagnostics.Property_assignment_expected);
        break;
      case ParsingContext.ArrayLiteralMembers:
        this.parseErrorAtCurrentToken(Diagnostics.Expression_or_comma_expected);
        break;
      case ParsingContext.JSDocParameters:
        this.parseErrorAtCurrentToken(Diagnostics.Parameter_declaration_expected);
        break;
      case ParsingContext.Parameters:
        if (isKeyword(this.token()))
          this.parseErrorAtCurrentToken(Diagnostics.X_0_is_not_allowed_as_a_parameter_name, [
            tokenToString(this.token()),
          ]);
        else this.parseErrorAtCurrentToken(Diagnostics.Parameter_declaration_expected);
        break;
      case ParsingContext.TypeParameters:
        this.parseErrorAtCurrentToken(Diagnostics.Type_parameter_declaration_expected);
        break;
      case ParsingContext.TypeArguments:
        this.parseErrorAtCurrentToken(Diagnostics.Type_argument_expected);
        break;
      case ParsingContext.TupleElementTypes:
        this.parseErrorAtCurrentToken(Diagnostics.Type_expected);
        break;
      case ParsingContext.HeritageClauses:
        this.parseErrorAtCurrentToken(Diagnostics.Unexpected_token_expected);
        break;
      case ParsingContext.ImportOrExportSpecifiers:
        if (this.token() === SyntaxKind.FromKeyword) this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, ['}']);
        else this.parseErrorAtCurrentToken(Diagnostics.Identifier_expected);
        break;
      case ParsingContext.JsxAttributes:
      case ParsingContext.JsxChildren:
      case ParsingContext.JSDocComment:
        this.parseErrorAtCurrentToken(Diagnostics.Identifier_expected);
        break;
      case ParsingContext.ImportAttributes:
        this.parseErrorAtCurrentToken(Diagnostics.Identifier_or_string_literal_expected);
        break;
      default:
        throw new Error('Unhandled case in parsingContextErrors');
    }
  }

  isListElement(parsingContext: ParsingContext, inErrorRecovery: boolean): boolean {
    switch (parsingContext) {
      case ParsingContext.SourceElements:
      case ParsingContext.BlockStatements:
      case ParsingContext.SwitchClauseStatements:
        // In error recovery, ';' isn't an empty statement: it shows up in too many contexts.
        return !(this.token() === SyntaxKind.SemicolonToken && inErrorRecovery) && this.isStartOfStatement();
      case ParsingContext.SwitchClauses:
        return this.token() === SyntaxKind.CaseKeyword || this.token() === SyntaxKind.DefaultKeyword;
      case ParsingContext.TypeMembers:
        return this.lookAhead(scanTypeMemberStart);
      case ParsingContext.ClassMembers:
        // Semicolons are class elements, except in error recovery.
        return this.lookAhead(scanClassMemberStart) || (this.token() === SyntaxKind.SemicolonToken && !inErrorRecovery);
      case ParsingContext.EnumMembers:
        // Include computed properties (and, as a result, indexers).
        return this.token() === SyntaxKind.OpenBracketToken || this.isLiteralPropertyName();
      case ParsingContext.ObjectLiteralMembers:
        switch (this.token()) {
          case SyntaxKind.OpenBracketToken:
          case SyntaxKind.AsteriskToken:
          case SyntaxKind.DotDotDotToken:
          case SyntaxKind.DotToken:
            return true;
          default:
            return this.isLiteralPropertyName();
        }
      case ParsingContext.RestProperties:
        return this.isLiteralPropertyName();
      case ParsingContext.ObjectBindingElements:
        return (
          this.token() === SyntaxKind.OpenBracketToken ||
          this.token() === SyntaxKind.DotDotDotToken ||
          this.isLiteralPropertyName()
        );
      case ParsingContext.ImportAttributes:
        return this.isImportAttributeName();
      case ParsingContext.HeritageClauseElement:
        // Only consume `{ ... }` as an expression if followed by `,` or `{`, not the class body.
        if (this.token() === SyntaxKind.OpenBraceToken) return this.isValidHeritageClauseObjectLiteral();
        if (!inErrorRecovery)
          return this.isStartOfLeftHandSideExpression() && !this.isHeritageClauseExtendsOrImplementsKeyword();
        // In error recovery, tighten up: don't treat `this` as a heritage clause element.
        return this.isIdentifier() && !this.isHeritageClauseExtendsOrImplementsKeyword();
      case ParsingContext.VariableDeclarations:
        return this.isBindingIdentifierOrPrivateIdentifierOrPattern();
      case ParsingContext.ArrayBindingElements:
        return (
          this.token() === SyntaxKind.CommaToken ||
          this.token() === SyntaxKind.DotDotDotToken ||
          this.isBindingIdentifierOrPrivateIdentifierOrPattern()
        );
      case ParsingContext.TypeParameters:
        return this.token() === SyntaxKind.InKeyword || this.token() === SyntaxKind.ConstKeyword || this.isIdentifier();
      case ParsingContext.ArrayLiteralMembers:
        // `.` isn't an element but shouldn't close the array.
        if (this.token() === SyntaxKind.CommaToken || this.token() === SyntaxKind.DotToken) return true;
        return this.token() === SyntaxKind.DotDotDotToken || this.isStartOfExpression();
      case ParsingContext.ArgumentExpressions:
        return this.token() === SyntaxKind.DotDotDotToken || this.isStartOfExpression();
      case ParsingContext.Parameters:
        return this.isStartOfParameter(false);
      case ParsingContext.JSDocParameters:
        return this.isStartOfParameter(true);
      case ParsingContext.TypeArguments:
      case ParsingContext.TupleElementTypes:
        return this.token() === SyntaxKind.CommaToken || this.isStartOfType(false);
      case ParsingContext.HeritageClauses:
        return this.isHeritageClause();
      case ParsingContext.ImportOrExportSpecifiers:
        // Stop at `from "mod"`, as in `import { from "mod"`, for a better error.
        if (this.token() === SyntaxKind.FromKeyword && this.lookAhead(nextTokenIsTokenStringLiteral)) return false;
        // Arbitrary module namespace identifiers.
        if (this.token() === SyntaxKind.StringLiteral) return true;
        return tokenIsIdentifierOrKeyword(this.token());
      case ParsingContext.JsxAttributes:
        return tokenIsIdentifierOrKeyword(this.token()) || this.token() === SyntaxKind.OpenBraceToken;
      case ParsingContext.JsxChildren:
      case ParsingContext.JSDocComment:
        return true;
    }
    throw new Error('Unhandled case in isListElement');
  }

  isListTerminator(kind: ParsingContext): boolean {
    const token = this.token();
    if (token === SyntaxKind.EndOfFile) return true;
    switch (kind) {
      case ParsingContext.BlockStatements:
      case ParsingContext.SwitchClauses:
      case ParsingContext.TypeMembers:
      case ParsingContext.ClassMembers:
      case ParsingContext.EnumMembers:
      case ParsingContext.ObjectLiteralMembers:
      case ParsingContext.ObjectBindingElements:
      case ParsingContext.ImportOrExportSpecifiers:
      case ParsingContext.ImportAttributes:
        return token === SyntaxKind.CloseBraceToken;
      case ParsingContext.SwitchClauseStatements:
        return (
          token === SyntaxKind.CloseBraceToken ||
          token === SyntaxKind.CaseKeyword ||
          token === SyntaxKind.DefaultKeyword
        );
      case ParsingContext.HeritageClauseElement:
        return (
          token === SyntaxKind.OpenBraceToken ||
          token === SyntaxKind.ExtendsKeyword ||
          token === SyntaxKind.ImplementsKeyword
        );
      case ParsingContext.VariableDeclarations:
        // Done at a semicolon (or ASI), at `in`/`of` in for statements, and at `=>` for error recovery.
        return (
          this.canParseSemicolon() ||
          token === SyntaxKind.InKeyword ||
          token === SyntaxKind.OfKeyword ||
          token === SyntaxKind.EqualsGreaterThanToken
        );
      case ParsingContext.TypeParameters:
        // Tokens other than '>' are here for better error recovery.
        return (
          token === SyntaxKind.GreaterThanToken ||
          token === SyntaxKind.OpenParenToken ||
          token === SyntaxKind.OpenBraceToken ||
          token === SyntaxKind.ExtendsKeyword ||
          token === SyntaxKind.ImplementsKeyword
        );
      case ParsingContext.ArgumentExpressions:
        // Tokens other than ')' are here for better error recovery.
        return token === SyntaxKind.CloseParenToken || token === SyntaxKind.SemicolonToken;
      case ParsingContext.ArrayLiteralMembers:
      case ParsingContext.TupleElementTypes:
      case ParsingContext.ArrayBindingElements:
        return token === SyntaxKind.CloseBracketToken;
      case ParsingContext.JSDocParameters:
      case ParsingContext.Parameters:
      case ParsingContext.RestProperties:
        // ']' is for index signatures.
        return token === SyntaxKind.CloseParenToken || token === SyntaxKind.CloseBracketToken;
      case ParsingContext.TypeArguments:
        // Any token but a comma terminates the type arguments.
        return token !== SyntaxKind.CommaToken;
      case ParsingContext.HeritageClauses:
        return token === SyntaxKind.OpenBraceToken || token === SyntaxKind.CloseBraceToken;
      case ParsingContext.JsxAttributes:
        return token === SyntaxKind.GreaterThanToken || token === SyntaxKind.SlashToken;
      case ParsingContext.JsxChildren:
        return token === SyntaxKind.LessThanToken && this.lookAhead(nextTokenIsSlash);
    }
    return false;
  }

  // Expected tokens

  parseExpectedJSDoc(kind: SyntaxKind): boolean {
    if (this.token() === kind) {
      this.nextTokenJSDoc();
      return true;
    }
    if (!isKeywordOrPunctuation(kind)) throw new Error('Invalid JSDoc kind: expected keyword or punctuation');
    this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(kind)]);
    return false;
  }

  parseExpectedMatchingBrackets(
    openKind: SyntaxKind,
    closeKind: SyntaxKind,
    openParsed: boolean,
    openPosition: number,
  ): void {
    if (this.token() === closeKind) {
      this.nextToken();
      return;
    }
    const lastError = this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(closeKind)]);
    if (!openParsed) return;
    if (lastError !== undefined)
      lastError.addRelatedInfo(
        new Diagnostic(
          undefined,
          openPosition,
          openPosition,
          Diagnostics.The_parser_expected_to_find_a_1_to_match_the_0_token_here,
          [tokenToString(openKind), tokenToString(closeKind)],
        ),
      );
  }

  parseOptional(token: SyntaxKind): boolean {
    if (this.token() === token) {
      this.nextToken();
      return true;
    }
    return false;
  }

  parseExpected(kind: SyntaxKind): boolean {
    return this.parseExpectedWithDiagnostic(kind, undefined, true);
  }

  parseExpectedWithoutAdvancing(kind: SyntaxKind): boolean {
    return this.parseExpectedWithDiagnostic(kind, undefined, false);
  }

  parseExpectedWithDiagnostic(
    kind: SyntaxKind,
    message: DiagnosticMessage | undefined,
    shouldAdvance: boolean,
  ): boolean {
    if (this.token() === kind) {
      if (shouldAdvance) this.nextToken();
      return true;
    }
    if (message !== undefined) this.parseErrorAtCurrentToken(message);
    else this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(kind)]);
    return false;
  }

  parseTokenNode(): Token {
    const pos = this.nodePos();
    const kind = this.token();
    this.nextToken();
    const result = new Token(kind);
    this.finishNode(result, pos);
    return result;
  }

  parseExpectedToken(kind: SyntaxKind): Token {
    const token = this.parseOptionalToken(kind);
    if (token !== undefined) return token;
    this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(kind)]);
    const missing = new Token(kind);
    this.finishNode(missing, this.nodePos());
    return missing;
  }

  parseOptionalToken(kind: SyntaxKind): Token | undefined {
    return this.token() === kind ? this.parseTokenNode() : undefined;
  }

  parseExpectedTokenJSDoc(kind: SyntaxKind): Token {
    const optional = this.parseOptionalTokenJSDoc(kind);
    if (optional !== undefined) return optional;
    if (!isKeywordOrPunctuation(kind)) throw new Error('expected keyword or punctuation');
    this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(kind)]);
    const missing = new Token(kind);
    this.finishNode(missing, this.nodePos());
    return missing;
  }

  parseOptionalTokenJSDoc(kind: SyntaxKind): Token | undefined {
    return this.token() === kind ? this.parseTokenNode() : undefined;
  }

  // Statements

  parseStatement(): Statement {
    switch (this.token()) {
      case SyntaxKind.SemicolonToken:
        return this.parseEmptyStatement();
      case SyntaxKind.OpenBraceToken:
        return this.parseBlock(false, undefined);
      case SyntaxKind.VarKeyword:
        return this.parseVariableStatement(this.nodePos(), this.jsdocScannerInfo(), undefined);
      case SyntaxKind.LetKeyword:
        if (this.isLetDeclaration())
          return this.parseVariableStatement(this.nodePos(), this.jsdocScannerInfo(), undefined);
        break;
      case SyntaxKind.AwaitKeyword:
        if (this.isAwaitUsingDeclaration())
          return this.parseVariableStatement(this.nodePos(), this.jsdocScannerInfo(), undefined);
        break;
      case SyntaxKind.UsingKeyword:
        if (this.isUsingDeclaration())
          return this.parseVariableStatement(this.nodePos(), this.jsdocScannerInfo(), undefined);
        break;
      case SyntaxKind.FunctionKeyword:
        return this.parseFunctionDeclaration(this.nodePos(), this.jsdocScannerInfo(), undefined);
      case SyntaxKind.ClassKeyword:
        return this.parseClassDeclaration(this.nodePos(), this.jsdocScannerInfo(), undefined);
      case SyntaxKind.IfKeyword:
        return this.parseIfStatement();
      case SyntaxKind.DoKeyword:
        return this.parseDoStatement();
      case SyntaxKind.WhileKeyword:
        return this.parseWhileStatement();
      case SyntaxKind.ForKeyword:
        return this.parseForOrForInOrForOfStatement();
      case SyntaxKind.ContinueKeyword:
        return this.parseContinueStatement();
      case SyntaxKind.BreakKeyword:
        return this.parseBreakStatement();
      case SyntaxKind.ReturnKeyword:
        return this.parseReturnStatement();
      case SyntaxKind.WithKeyword:
        return this.parseWithStatement();
      case SyntaxKind.SwitchKeyword:
        return this.parseSwitchStatement();
      case SyntaxKind.ThrowKeyword:
        return this.parseThrowStatement();
      case SyntaxKind.TryKeyword:
      case SyntaxKind.CatchKeyword:
      case SyntaxKind.FinallyKeyword:
        return this.parseTryStatement();
      case SyntaxKind.DebuggerKeyword:
        return this.parseDebuggerStatement();
      case SyntaxKind.AtToken:
        return this.parseDeclaration();
      case SyntaxKind.AsyncKeyword:
      case SyntaxKind.InterfaceKeyword:
      case SyntaxKind.TypeKeyword:
      case SyntaxKind.ModuleKeyword:
      case SyntaxKind.NamespaceKeyword:
      case SyntaxKind.DeclareKeyword:
      case SyntaxKind.ConstKeyword:
      case SyntaxKind.EnumKeyword:
      case SyntaxKind.ExportKeyword:
      case SyntaxKind.ImportKeyword:
      case SyntaxKind.PrivateKeyword:
      case SyntaxKind.ProtectedKeyword:
      case SyntaxKind.PublicKeyword:
      case SyntaxKind.AbstractKeyword:
      case SyntaxKind.AccessorKeyword:
      case SyntaxKind.StaticKeyword:
      case SyntaxKind.ReadonlyKeyword:
      case SyntaxKind.GlobalKeyword:
        if (this.isStartOfDeclaration()) return this.parseDeclaration();
        break;
    }
    return this.parseExpressionOrLabeledStatement();
  }

  parseDeclaration(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const modifiers = this.parseModifiersEx(true, false, false);
    if (modifiers !== undefined && hasModifierOfKind(modifiers, SyntaxKind.DeclareKeyword)) {
      for (const m of modifiers.nodes) m.flags |= NodeFlags.Ambient;
      const saveContextFlags = this.contextFlags;
      this.setContextFlags(NodeFlags.Ambient, true);
      const result = this.parseDeclarationWorker(pos, jsdoc, modifiers);
      this.contextFlags = saveContextFlags;
      return result;
    }
    return this.parseDeclarationWorker(pos, jsdoc, modifiers);
  }

  parseDeclarationWorker(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    switch (this.token()) {
      case SyntaxKind.VarKeyword:
      case SyntaxKind.LetKeyword:
      case SyntaxKind.ConstKeyword:
      case SyntaxKind.UsingKeyword:
        return this.parseVariableStatement(pos, jsdoc, modifiers);
      case SyntaxKind.AwaitKeyword:
        if (this.isAwaitUsingDeclaration()) return this.parseVariableStatement(pos, jsdoc, modifiers);
        break;
      case SyntaxKind.FunctionKeyword:
        return this.parseFunctionDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.ClassKeyword:
        return this.parseClassDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.InterfaceKeyword:
        return this.parseInterfaceDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.TypeKeyword:
        return this.parseTypeAliasDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.EnumKeyword:
        return this.parseEnumDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.GlobalKeyword:
      case SyntaxKind.ModuleKeyword:
      case SyntaxKind.NamespaceKeyword:
        return this.parseModuleDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.ImportKeyword:
        return this.parseImportDeclarationOrImportEqualsDeclaration(pos, jsdoc, modifiers);
      case SyntaxKind.ExportKeyword:
        this.nextToken();
        switch (this.token()) {
          case SyntaxKind.DefaultKeyword:
          case SyntaxKind.EqualsToken:
            return this.parseExportAssignment(pos, jsdoc, modifiers);
          case SyntaxKind.AsKeyword:
            return this.parseNamespaceExportDeclaration(pos, jsdoc, modifiers);
          default:
            return this.parseExportDeclaration(pos, jsdoc, modifiers);
        }
    }
    if (modifiers !== undefined) {
      // Decorators or modifiers without a declaration: return an incomplete declaration for recovery.
      this.parseErrorAt(this.nodePos(), this.nodePos(), Diagnostics.Declaration_expected);
      return this.finishNode(new MissingDeclaration(modifiers), pos);
    }
    throw new Error('Unhandled case in parseDeclarationWorker');
  }

  isLetDeclaration(): boolean {
    // `let` starts a lexical declaration if followed by an identifier, `{` or `[`.
    return this.lookAhead(nextTokenIsBindingIdentifierOrStartOfDestructuring);
  }

  parseBlock(ignoreMissingOpenBrace: boolean, diagnosticMessage: DiagnosticMessage | undefined): Block {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const openBracePosition = this.scanner.getTokenStart();
    const openBraceParsed = this.parseExpectedWithDiagnostic(SyntaxKind.OpenBraceToken, diagnosticMessage, true);
    let multiline = false;
    if (openBraceParsed || ignoreMissingOpenBrace) {
      multiline = this.hasPrecedingLineBreak();
      const statements = this.parseList(ParsingContext.BlockStatements, ListElement.Statement);
      this.parseExpectedMatchingBrackets(
        SyntaxKind.OpenBraceToken,
        SyntaxKind.CloseBraceToken,
        openBraceParsed,
        openBracePosition,
      );
      const result = new Block(statements, multiline);
      this.finishNode(result, pos);
      this.withJSDoc(result, jsdoc);
      if (this.token() === SyntaxKind.EqualsToken) {
        this.parseErrorAtCurrentToken(
          Diagnostics.Declaration_or_statement_expected_This_follows_a_block_of_statements_so_if_you_intended_to_write_a_destructuring_assignment_you_might_need_to_wrap_the_whole_assignment_in_parentheses,
        );
        this.nextToken();
      }
      return result;
    }
    const result = new Block(this.createMissingList(), multiline);
    this.finishNode(result, pos);
    this.withJSDoc(result, jsdoc);
    return result;
  }

  parseEmptyStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.SemicolonToken);
    return this.finishWithJSDoc(new EmptyStatement(), pos, jsdoc);
  }

  /** Finishes `node` and attaches its JSDoc. */
  finishWithJSDoc(node: Node, pos: number, jsdoc: JSDocScannerInfo): Node {
    this.finishNode(node, pos);
    this.withJSDoc(node, jsdoc);
    return node;
  }

  parseIfStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.IfKeyword);
    const openParenPosition = this.scanner.getTokenStart();
    const openParenParsed = this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseExpressionAllowIn();
    this.parseExpectedMatchingBrackets(
      SyntaxKind.OpenParenToken,
      SyntaxKind.CloseParenToken,
      openParenParsed,
      openParenPosition,
    );
    const thenStatement = this.parseStatement();
    const elseStatement = this.parseOptional(SyntaxKind.ElseKeyword) ? this.parseStatement() : undefined;
    return this.finishWithJSDoc(new IfStatement(expression, thenStatement, elseStatement), pos, jsdoc);
  }

  parseDoStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.DoKeyword);
    const statement = this.parseStatement();
    this.parseExpected(SyntaxKind.WhileKeyword);
    const openParenPosition = this.scanner.getTokenStart();
    const openParenParsed = this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseExpressionAllowIn();
    this.parseExpectedMatchingBrackets(
      SyntaxKind.OpenParenToken,
      SyntaxKind.CloseParenToken,
      openParenParsed,
      openParenPosition,
    );
    // `do;while(0)x` gets a semicolon inserted before `x`, as engines do.
    this.parseOptional(SyntaxKind.SemicolonToken);
    return this.finishWithJSDoc(new DoStatement(statement, expression), pos, jsdoc);
  }

  parseWhileStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.WhileKeyword);
    const openParenPosition = this.scanner.getTokenStart();
    const openParenParsed = this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseExpressionAllowIn();
    this.parseExpectedMatchingBrackets(
      SyntaxKind.OpenParenToken,
      SyntaxKind.CloseParenToken,
      openParenParsed,
      openParenPosition,
    );
    const statement = this.parseStatement();
    return this.finishWithJSDoc(new WhileStatement(expression, statement), pos, jsdoc);
  }

  parseForOrForInOrForOfStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.ForKeyword);
    const awaitToken = this.parseOptionalToken(SyntaxKind.AwaitKeyword);
    this.parseExpected(SyntaxKind.OpenParenToken);
    let initializer: Node | undefined;
    if (this.token() !== SyntaxKind.SemicolonToken) {
      if (
        this.token() === SyntaxKind.VarKeyword ||
        this.token() === SyntaxKind.LetKeyword ||
        this.token() === SyntaxKind.ConstKeyword ||
        (this.token() === SyntaxKind.UsingKeyword &&
          this.lookAhead(nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLineDisallowOf)) ||
        // `await using` allows `of`.
        (this.token() === SyntaxKind.AwaitKeyword &&
          this.lookAhead(nextIsUsingKeywordThenBindingIdentifierOrStartOfObjectDestructuringOnSameLine))
      ) {
        initializer = this.parseVariableDeclarationList(true);
      } else {
        const saveContextFlags = this.contextFlags;
        this.setContextFlags(NodeFlags.DisallowInContext, true);
        initializer = this.parseExpression();
        this.contextFlags = saveContextFlags;
      }
    }
    let result: Node;
    if (
      (awaitToken !== undefined && this.parseExpected(SyntaxKind.OfKeyword)) ||
      (awaitToken === undefined && this.parseOptional(SyntaxKind.OfKeyword))
    ) {
      const saveContextFlags = this.contextFlags;
      this.setContextFlags(NodeFlags.DisallowInContext, false);
      const expression = this.parseAssignmentExpressionOrHigher();
      this.contextFlags = saveContextFlags;
      this.parseExpected(SyntaxKind.CloseParenToken);
      result = new ForInOrOfStatement(
        SyntaxKind.ForOfStatement,
        awaitToken,
        initializer!,
        expression,
        this.parseStatement(),
      );
    } else if (this.parseOptional(SyntaxKind.InKeyword)) {
      const expression = this.parseExpressionAllowIn();
      this.parseExpected(SyntaxKind.CloseParenToken);
      result = new ForInOrOfStatement(
        SyntaxKind.ForInStatement,
        undefined,
        initializer!,
        expression,
        this.parseStatement(),
      );
    } else {
      this.parseExpected(SyntaxKind.SemicolonToken);
      const condition =
        this.token() !== SyntaxKind.SemicolonToken && this.token() !== SyntaxKind.CloseParenToken
          ? this.parseExpressionAllowIn()
          : undefined;
      this.parseExpected(SyntaxKind.SemicolonToken);
      const incrementor = this.token() !== SyntaxKind.CloseParenToken ? this.parseExpressionAllowIn() : undefined;
      this.parseExpected(SyntaxKind.CloseParenToken);
      result = new ForStatement(initializer, condition, incrementor, this.parseStatement());
    }
    return this.finishWithJSDoc(result, pos, jsdoc);
  }

  parseBreakStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.BreakKeyword);
    const label = this.parseIdentifierUnlessAtSemicolon();
    this.parseSemicolon();
    return this.finishWithJSDoc(new BreakStatement(label), pos, jsdoc);
  }

  parseContinueStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.ContinueKeyword);
    const label = this.parseIdentifierUnlessAtSemicolon();
    this.parseSemicolon();
    return this.finishWithJSDoc(new ContinueStatement(label), pos, jsdoc);
  }

  parseIdentifierUnlessAtSemicolon(): Identifier | undefined {
    return this.canParseSemicolon() ? undefined : this.parseIdentifier(IdentifierUse.Name);
  }

  parseReturnStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.ReturnKeyword);
    const expression = this.canParseSemicolon() ? undefined : this.parseExpressionAllowIn();
    this.parseSemicolon();
    return this.finishWithJSDoc(new ReturnStatement(expression), pos, jsdoc);
  }

  parseWithStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.WithKeyword);
    const openParenPosition = this.scanner.getTokenStart();
    const openParenParsed = this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseExpressionAllowIn();
    this.parseExpectedMatchingBrackets(
      SyntaxKind.OpenParenToken,
      SyntaxKind.CloseParenToken,
      openParenParsed,
      openParenPosition,
    );
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.InWithStatement, true);
    const statement = this.parseStatement();
    this.contextFlags = saveContextFlags;
    return this.finishWithJSDoc(new WithStatement(expression, statement), pos, jsdoc);
  }

  parseCaseClause(): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.CaseKeyword);
    const expression = this.parseExpressionAllowIn();
    this.parseExpected(SyntaxKind.ColonToken);
    const statements = this.parseList(ParsingContext.SwitchClauseStatements, ListElement.Statement);
    return this.finishWithJSDoc(new CaseOrDefaultClause(SyntaxKind.CaseClause, expression, statements), pos, jsdoc);
  }

  parseDefaultClause(): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.DefaultKeyword);
    this.parseExpected(SyntaxKind.ColonToken);
    const statements = this.parseList(ParsingContext.SwitchClauseStatements, ListElement.Statement);
    return this.finishWithJSDoc(new CaseOrDefaultClause(SyntaxKind.DefaultClause, undefined, statements), pos, jsdoc);
  }

  parseCaseOrDefaultClause(): Node {
    return this.token() === SyntaxKind.CaseKeyword ? this.parseCaseClause() : this.parseDefaultClause();
  }

  parseCaseBlock(): CaseBlock {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.OpenBraceToken);
    const clauses = this.parseList(ParsingContext.SwitchClauses, ListElement.CaseOrDefaultClause);
    this.parseExpected(SyntaxKind.CloseBraceToken);
    const result = new CaseBlock(clauses);
    this.finishWithJSDoc(result, pos, jsdoc);
    return result;
  }

  parseSwitchStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.SwitchKeyword);
    this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseExpressionAllowIn();
    this.parseExpected(SyntaxKind.CloseParenToken);
    const caseBlock = this.parseCaseBlock();
    return this.finishWithJSDoc(new SwitchStatement(expression, caseBlock), pos, jsdoc);
  }

  parseThrowStatement(): Statement {
    // ThrowStatement[Yield] : throw [no LineTerminator here]Expression[In, ?Yield];
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.ThrowKeyword);
    // With a line break, ASI would end the statement: use a missing identifier and let the
    // grammar checker report it, rather than consuming an expression on the next line.
    const expression = this.hasPrecedingLineBreak() ? this.createMissingIdentifier() : this.parseExpressionAllowIn();
    if (!this.tryParseSemicolon()) this.parseErrorForMissingSemicolonAfter(expression);
    return this.finishWithJSDoc(new ThrowStatement(expression), pos, jsdoc);
  }

  parseTryStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.TryKeyword);
    const tryBlock = this.parseBlock(false, undefined);
    const catchClause = this.token() === SyntaxKind.CatchKeyword ? this.parseCatchClause() : undefined;
    // Without a catch clause there must be a finally clause; parse one regardless.
    let finallyBlock: Block | undefined;
    if (catchClause === undefined || this.token() === SyntaxKind.FinallyKeyword) {
      this.parseExpectedWithDiagnostic(SyntaxKind.FinallyKeyword, Diagnostics.X_catch_or_finally_expected, true);
      finallyBlock = this.parseBlock(false, undefined);
    }
    return this.finishWithJSDoc(new TryStatement(tryBlock, catchClause, finallyBlock), pos, jsdoc);
  }

  parseCatchClause(): CatchClause {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.CatchKeyword);
    let variableDeclaration: VariableDeclaration | undefined;
    if (this.parseOptional(SyntaxKind.OpenParenToken)) {
      variableDeclaration = this.parseVariableDeclaration();
      this.parseExpected(SyntaxKind.CloseParenToken);
    }
    const block = this.parseBlock(false, undefined);
    const result = new CatchClause(variableDeclaration, block);
    this.finishNode(result, pos);
    return result;
  }

  parseDebuggerStatement(): Statement {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.DebuggerKeyword);
    this.parseSemicolon();
    return this.finishWithJSDoc(new DebuggerStatement(), pos, jsdoc);
  }

  parseExpressionOrLabeledStatement(): Statement {
    // Parse an expression, then check for an identifier followed by a colon: no lookahead needed.
    const pos = this.nodePos();
    let jsdoc = this.jsdocScannerInfo();
    const hasParen = this.token() === SyntaxKind.OpenParenToken;
    const expression = this.parseExpression();
    if (expression instanceof Identifier && this.parseOptional(SyntaxKind.ColonToken))
      return this.finishWithJSDoc(new LabeledStatement(expression, this.parseStatement()), pos, jsdoc);
    if (!this.tryParseSemicolon()) this.parseErrorForMissingSemicolonAfter(expression);
    const result = new ExpressionStatement(expression);
    this.finishNode(result, pos);
    if (hasParen) jsdoc &= ~JSDocScannerInfo.HasJSDoc;
    this.withJSDoc(result, jsdoc);
    return result;
  }

  parseVariableStatement(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    const declarationList = this.parseVariableDeclarationList(false);
    this.parseSemicolon();
    const result = this.finishWithJSDoc(new VariableStatement(modifiers, declarationList), pos, jsdoc);
    this.checkJSSyntax(result);
    return result;
  }

  parseVariableDeclarationList(inForStatementInitializer: boolean): VariableDeclarationList {
    const pos = this.nodePos();
    let flags = NodeFlags.None;
    switch (this.token()) {
      case SyntaxKind.VarKeyword:
        break;
      case SyntaxKind.LetKeyword:
        flags = NodeFlags.Let;
        break;
      case SyntaxKind.ConstKeyword:
        flags = NodeFlags.Const;
        break;
      case SyntaxKind.UsingKeyword:
        flags = NodeFlags.Using;
        break;
      case SyntaxKind.AwaitKeyword:
        if (!this.isAwaitUsingDeclaration()) break;
        flags = NodeFlags.AwaitUsing;
        this.nextToken();
        break;
      default:
        throw new Error('Unhandled case in parseVariableDeclarationList');
    }
    this.nextToken();
    // In `for (let of X) { }`, parse an empty declaration list and `of` as a keyword; the checker
    // reports the empty list.
    let declarations: NodeList;
    if (this.token() === SyntaxKind.OfKeyword && this.lookAhead(nextIsIdentifierAndCloseParen)) {
      declarations = this.createMissingList();
    } else {
      const saveContextFlags = this.contextFlags;
      this.setContextFlags(NodeFlags.DisallowInContext, inForStatementInitializer);
      declarations = this.parseDelimitedList(
        ParsingContext.VariableDeclarations,
        inForStatementInitializer ? ListElement.VariableDeclaration : ListElement.VariableDeclarationAllowExclamation,
      )!;
      this.contextFlags = saveContextFlags;
    }
    const result = new VariableDeclarationList(declarations, flags);
    this.finishNode(result, pos);
    return result;
  }

  parseVariableDeclaration(): VariableDeclaration {
    return this.parseVariableDeclarationWorker(false);
  }

  parseVariableDeclarationAllowExclamation(): VariableDeclaration {
    return this.parseVariableDeclarationWorker(true);
  }

  parseVariableDeclarationWorker(allowExclamation: boolean): VariableDeclaration {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const name = this.parseIdentifierOrPatternWithDiagnostic(
      Diagnostics.Private_identifiers_are_not_allowed_in_variable_declarations,
    );
    let exclamationToken: Token | undefined;
    if (
      allowExclamation &&
      name.kind === SyntaxKind.Identifier &&
      this.token() === SyntaxKind.ExclamationToken &&
      !this.hasPrecedingLineBreak()
    )
      exclamationToken = this.parseTokenNode();
    const type = this.parseTypeAnnotation();
    const initializer =
      this.token() !== SyntaxKind.InKeyword && this.token() !== SyntaxKind.OfKeyword
        ? this.parseInitializer()
        : undefined;
    const result = new VariableDeclaration(name, exclamationToken, type, initializer);
    this.finishWithJSDoc(result, pos, jsdoc);
    this.checkJSSyntax(result);
    return result;
  }

  parseIdentifierOrPattern(): Node {
    return this.parseIdentifierOrPatternWithDiagnostic(undefined);
  }

  parseIdentifierOrPatternWithDiagnostic(privateIdentifierDiagnosticMessage: DiagnosticMessage | undefined): Node {
    if (this.token() === SyntaxKind.OpenBracketToken) return this.parseArrayBindingPattern();
    if (this.token() === SyntaxKind.OpenBraceToken) return this.parseObjectBindingPattern();
    return this.parseBindingIdentifierWithDiagnostic(privateIdentifierDiagnosticMessage);
  }

  parseArrayBindingPattern(): Node {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.OpenBracketToken);
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext, false);
    const elements = this.parseDelimitedList(ParsingContext.ArrayBindingElements, ListElement.ArrayBindingElement)!;
    this.contextFlags = saveContextFlags;
    this.parseExpected(SyntaxKind.CloseBracketToken);
    return this.finishNode(new BindingPattern(SyntaxKind.ArrayBindingPattern, elements), pos);
  }

  parseArrayBindingElement(): Node {
    const pos = this.nodePos();
    let dotDotDotToken: Token | undefined;
    let name: Node | undefined;
    let initializer: Expression | undefined;
    // All undefined for a missing element.
    if (this.token() !== SyntaxKind.CommaToken) {
      dotDotDotToken = this.parseOptionalToken(SyntaxKind.DotDotDotToken);
      name = this.parseIdentifierOrPattern();
      initializer = this.parseInitializer();
    }
    return this.finishNode(new BindingElement(dotDotDotToken, undefined, name, initializer), pos);
  }

  parseObjectBindingPattern(): Node {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.OpenBraceToken);
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext, false);
    const elements = this.parseDelimitedList(ParsingContext.ObjectBindingElements, ListElement.ObjectBindingElement)!;
    this.contextFlags = saveContextFlags;
    this.parseExpected(SyntaxKind.CloseBraceToken);
    return this.finishNode(new BindingPattern(SyntaxKind.ObjectBindingPattern, elements), pos);
  }

  parseObjectBindingElement(): Node {
    const pos = this.nodePos();
    const dotDotDotToken = this.parseOptionalToken(SyntaxKind.DotDotDotToken);
    const tokenIsIdentifier = this.isBindingIdentifier();
    let propertyName: Node | undefined = this.parsePropertyName();
    let name: Node;
    if (tokenIsIdentifier && this.token() !== SyntaxKind.ColonToken) {
      name = propertyName;
      propertyName = undefined;
    } else {
      this.parseExpected(SyntaxKind.ColonToken);
      name = this.parseIdentifierOrPattern();
    }
    const initializer = this.parseInitializer();
    return this.finishNode(new BindingElement(dotDotDotToken, propertyName, name, initializer), pos);
  }

  parseInitializer(): Expression | undefined {
    return this.parseOptional(SyntaxKind.EqualsToken) ? this.parseAssignmentExpressionOrHigher() : undefined;
  }

  /** `parseInitializer` outside yield, await and disallow-in contexts. */
  parseInitializerInPropertyContext(): Expression | undefined {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.YieldContext | NodeFlags.AwaitContext | NodeFlags.DisallowInContext, false);
    const result = this.parseInitializer();
    this.contextFlags = saveContextFlags;
    return result;
  }

  parseTypeAnnotation(): TypeNode | undefined {
    return this.parseOptional(SyntaxKind.ColonToken) ? this.parseType() : undefined;
  }

  parseFunctionDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    this.parseExpected(SyntaxKind.FunctionKeyword);
    const asteriskToken = this.parseOptionalToken(SyntaxKind.AsteriskToken);
    // The name isn't parsed in an await context; the checker reports `await` names.
    let name: Identifier | undefined;
    if (
      modifiers === undefined ||
      (modifiers.modifierFlags & ModifierFlags.Default) === 0 ||
      this.isBindingIdentifier()
    )
      name = this.parseBindingIdentifier();
    const signatureFlags =
      (asteriskToken !== undefined ? ParseFlags.Yield : ParseFlags.None) |
      (modifiers !== undefined && (modifiers.modifierFlags & ModifierFlags.Async) !== 0
        ? ParseFlags.Await
        : ParseFlags.None);
    const typeParameters = this.parseTypeParameters();
    const saveContextFlags = this.contextFlags;
    if (modifiers !== undefined && (modifiers.modifierFlags & ModifierFlags.Export) !== 0)
      this.setContextFlags(NodeFlags.AwaitContext, true);
    const parameters = this.parseParameters(signatureFlags);
    const returnType = this.parseReturnType(SyntaxKind.ColonToken, false);
    const body = this.parseFunctionBlockOrSemicolon(signatureFlags, Diagnostics.X_or_expected);
    this.contextFlags = saveContextFlags;
    const result = this.finishWithJSDoc(
      new FunctionDeclaration(modifiers, asteriskToken, name, typeParameters, parameters, returnType, undefined, body),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseClassDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    return this.parseClassDeclarationOrExpression(pos, jsdoc, modifiers, SyntaxKind.ClassDeclaration);
  }

  parseClassExpression(): Expression {
    return this.parseClassDeclarationOrExpression(
      this.nodePos(),
      this.jsdocScannerInfo(),
      undefined,
      SyntaxKind.ClassExpression,
    );
  }

  parseClassDeclarationOrExpression(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
    kind: SyntaxKind,
  ): Node {
    const saveContextFlags = this.contextFlags;
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    this.parseExpected(SyntaxKind.ClassKeyword);
    // The name isn't parsed in an await context; the checker reports `await` names.
    const name = this.parseNameOfClassDeclarationOrExpression();
    const typeParameters = this.parseTypeParameters();
    if (modifiers !== undefined && hasModifierOfKind(modifiers, SyntaxKind.ExportKeyword))
      this.setContextFlags(NodeFlags.AwaitContext, true);
    const heritageClauses = this.parseHeritageClauses();
    let members: NodeList;
    if (this.parseExpected(SyntaxKind.OpenBraceToken)) {
      members = this.parseList(ParsingContext.ClassMembers, ListElement.ClassElement);
      this.parseExpected(SyntaxKind.CloseBraceToken);
    } else {
      members = this.createMissingList();
    }
    this.contextFlags = saveContextFlags;
    if (modifiers !== undefined && (modifiersToFlags(modifiers.nodes) & ModifierFlags.Ambient) !== 0)
      this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    const result: Node =
      kind === SyntaxKind.ClassDeclaration
        ? new ClassDeclaration(modifiers, name, typeParameters, heritageClauses, members)
        : new ClassExpression(modifiers, name, typeParameters, heritageClauses, members);
    this.finishWithJSDoc(result, pos, jsdoc);
    if ((result.flags & NodeFlags.JavaScriptFile) !== 0) {
      this.checkJSSyntax(result);
      if (heritageClauses !== undefined)
        for (const clause of heritageClauses.nodes)
          if (clause instanceof HeritageClause && (clause as HeritageClause).token === SyntaxKind.ExtendsKeyword)
            for (const expression of (clause as HeritageClause).types.nodes) this.checkJSSyntax(expression);
    }
    return result;
  }

  parseNameOfClassDeclarationOrExpression(): Identifier | undefined {
    // `class implements` may be an anonymous class with an implements clause or a class
    // named `implements`.
    if (this.isBindingIdentifier() && !this.isImplementsClause()) {
      const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
      const id = this.createIdentifier(this.isBindingIdentifier(), IdentifierUse.Name);
      this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
      return id;
    }
    return undefined;
  }

  isImplementsClause(): boolean {
    return this.token() === SyntaxKind.ImplementsKeyword && this.lookAhead(nextTokenIsIdentifierOrKeyword);
  }

  parseHeritageClauses(): NodeList | undefined {
    return this.isHeritageClause()
      ? this.parseList(ParsingContext.HeritageClauses, ListElement.HeritageClause)
      : undefined;
  }

  parseHeritageClause(): Node {
    const pos = this.nodePos();
    const kind = this.token();
    this.nextToken();
    const types = this.parseDelimitedList(
      ParsingContext.HeritageClauseElement,
      ListElement.ExpressionWithTypeArguments,
    )!;
    return this.checkJSSyntax(this.finishNode(new HeritageClause(kind, types), pos));
  }

  parseExpressionWithTypeArguments(): Node {
    const pos = this.nodePos();
    const expression = this.parseLeftHandSideExpressionOrHigher();
    if (expression instanceof ExpressionWithTypeArguments) return expression;
    const typeArguments = this.parseTypeArguments();
    return this.finishNode(new ExpressionWithTypeArguments(expression, typeArguments), pos);
  }

  parseClassElement(): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    if (this.token() === SyntaxKind.SemicolonToken) {
      this.nextToken();
      return this.finishWithJSDoc(new SemicolonClassElement(), pos, jsdoc);
    }
    const modifiers = this.parseModifiersEx(true, true, true);
    if (this.token() === SyntaxKind.StaticKeyword && this.lookAhead(nextTokenIsOpenBrace))
      return this.parseClassStaticBlockDeclaration(pos, jsdoc, modifiers);
    if (this.parseContextualModifier(SyntaxKind.GetKeyword))
      return this.parseAccessorDeclaration(pos, jsdoc, modifiers, SyntaxKind.GetAccessor, ParseFlags.None);
    if (this.parseContextualModifier(SyntaxKind.SetKeyword))
      return this.parseAccessorDeclaration(pos, jsdoc, modifiers, SyntaxKind.SetAccessor, ParseFlags.None);
    if (this.token() === SyntaxKind.ConstructorKeyword || this.token() === SyntaxKind.StringLiteral) {
      const constructorDeclaration = this.tryParseConstructorDeclaration(pos, jsdoc, modifiers);
      if (constructorDeclaration !== undefined) return constructorDeclaration;
    }
    if (this.isIndexSignature()) return this.checkJSSyntax(this.parseIndexSignatureDeclaration(pos, jsdoc, modifiers));
    // Checked after index signatures: `[` starts an index signature or a computed property name.
    if (
      tokenIsIdentifierOrKeyword(this.token()) ||
      this.token() === SyntaxKind.StringLiteral ||
      this.token() === SyntaxKind.NumericLiteral ||
      this.token() === SyntaxKind.BigIntLiteral ||
      this.token() === SyntaxKind.AsteriskToken ||
      this.token() === SyntaxKind.OpenBracketToken
    ) {
      if (modifiers !== undefined && hasModifierOfKind(modifiers, SyntaxKind.DeclareKeyword)) {
        for (const m of modifiers.nodes) m.flags |= NodeFlags.Ambient;
        const saveContextFlags = this.contextFlags;
        this.setContextFlags(NodeFlags.Ambient, true);
        const result = this.parsePropertyOrMethodDeclaration(pos, jsdoc, modifiers);
        this.contextFlags = saveContextFlags;
        return result;
      }
      return this.parsePropertyOrMethodDeclaration(pos, jsdoc, modifiers);
    }
    if (modifiers !== undefined) {
      // A property declaration with a missing name.
      this.parseErrorAt(this.nodePos(), this.nodePos(), Diagnostics.Declaration_expected);
      const name = this.createMissingIdentifier();
      return this.parsePropertyDeclaration(pos, jsdoc, modifiers, name, undefined);
    }
    throw new Error('Should not have attempted to parse class member declaration.');
  }

  parseClassStaticBlockDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Node {
    this.parseExpectedToken(SyntaxKind.StaticKeyword);
    const body = this.parseClassStaticBlockBody();
    return this.finishWithJSDoc(new ClassStaticBlockDeclaration(modifiers, body), pos, jsdoc);
  }

  parseClassStaticBlockBody(): Block {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.YieldContext, false);
    this.setContextFlags(NodeFlags.AwaitContext, true);
    const body = this.parseBlock(false, undefined);
    this.contextFlags = saveContextFlags;
    return body;
  }

  tryParseConstructorDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
  ): Node | undefined {
    const state = this.mark();
    if (
      this.token() === SyntaxKind.ConstructorKeyword ||
      (this.token() === SyntaxKind.StringLiteral &&
        this.scanner.getTokenValue() === 'constructor' &&
        this.lookAhead(nextTokenIsOpenParen))
    ) {
      this.nextToken();
      const typeParameters = this.parseTypeParameters();
      const parameters = this.parseParameters(ParseFlags.None);
      const returnType = this.parseReturnType(SyntaxKind.ColonToken, false);
      const body = this.parseFunctionBlockOrSemicolon(ParseFlags.None, Diagnostics.X_or_expected);
      const result = this.finishWithJSDoc(
        new ConstructorDeclaration(modifiers, typeParameters, parameters, returnType, undefined, body),
        pos,
        jsdoc,
      );
      this.checkJSSyntax(result);
      return result;
    }
    this.rewind(state);
    return undefined;
  }

  parsePropertyOrMethodDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Node {
    const asteriskToken = this.parseOptionalToken(SyntaxKind.AsteriskToken);
    const name = this.parsePropertyName();
    // Not legal, but parsed so the grammar checker can report it.
    const questionToken = this.parseOptionalToken(SyntaxKind.QuestionToken);
    if (
      asteriskToken !== undefined ||
      this.token() === SyntaxKind.OpenParenToken ||
      this.token() === SyntaxKind.LessThanToken
    )
      return this.parseMethodDeclaration(
        pos,
        jsdoc,
        modifiers,
        asteriskToken,
        name,
        questionToken,
        Diagnostics.X_or_expected,
      );
    return this.parsePropertyDeclaration(pos, jsdoc, modifiers, name, questionToken);
  }

  parseMethodDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
    asteriskToken: Token | undefined,
    name: Node,
    questionToken: Token | undefined,
    diagnosticMessage: DiagnosticMessage | undefined,
  ): Node {
    const signatureFlags =
      (asteriskToken !== undefined ? ParseFlags.Yield : ParseFlags.None) |
      (modifiers !== undefined && hasModifierOfKind(modifiers, SyntaxKind.AsyncKeyword)
        ? ParseFlags.Await
        : ParseFlags.None);
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters(signatureFlags);
    const type = this.parseReturnType(SyntaxKind.ColonToken, false);
    const body = this.parseFunctionBlockOrSemicolon(signatureFlags, diagnosticMessage);
    const result = this.finishWithJSDoc(
      new MethodDeclaration(
        modifiers,
        asteriskToken,
        name,
        questionToken,
        typeParameters,
        parameters,
        type,
        undefined,
        body,
      ),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parsePropertyDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
    name: Node,
    questionToken: Token | undefined,
  ): Node {
    let postfixToken = questionToken;
    if (postfixToken === undefined && !this.hasPrecedingLineBreak())
      postfixToken = this.parseOptionalToken(SyntaxKind.ExclamationToken);
    const type = this.parseTypeAnnotation();
    const initializer = this.parseInitializerInPropertyContext();
    this.parseSemicolonAfterPropertyName(name, type, initializer);
    const result = this.finishWithJSDoc(
      new PropertyDeclaration(modifiers, name, postfixToken, type, initializer),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseSemicolonAfterPropertyName(name: Node, type: TypeNode | undefined, initializer: Expression | undefined): void {
    if (this.token() === SyntaxKind.AtToken && !this.hasPrecedingLineBreak()) {
      this.parseErrorAtCurrentToken(
        Diagnostics.Decorators_must_precede_the_name_and_all_keywords_of_property_declarations,
      );
      return;
    }
    if (this.token() === SyntaxKind.OpenParenToken) {
      this.parseErrorAtCurrentToken(Diagnostics.Cannot_start_a_function_call_in_a_type_annotation);
      this.nextToken();
      return;
    }
    if (type !== undefined && !this.canParseSemicolon()) {
      if (initializer !== undefined)
        this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(SyntaxKind.SemicolonToken)]);
      else this.parseErrorAtCurrentToken(Diagnostics.Expected_for_property_initializer);
      return;
    }
    if (this.tryParseSemicolon()) return;
    if (initializer !== undefined) {
      this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(SyntaxKind.SemicolonToken)]);
      return;
    }
    this.parseErrorForMissingSemicolonAfter(name);
  }

  parseErrorForMissingSemicolonAfter(node: Node): void {
    // Tagged templates sometimes appear where only plain strings are allowed, as in
    // `module `M1` {`, which parses as the template literal module`M1`.
    if (node instanceof TaggedTemplateExpression) {
      const template = (node as TaggedTemplateExpression).template;
      this.parseErrorAt(
        skipTrivia(this.sourceText, template.pos),
        template.end,
        Diagnostics.Module_declaration_names_may_only_use_or_quoted_strings,
      );
      return;
    }
    // Unless this is a keyword-like identifier, give the generic message.
    const expressionText = node instanceof Identifier ? (node as Identifier).text : '';
    if (expressionText === '') {
      this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(SyntaxKind.SemicolonToken)]);
      return;
    }
    const pos = skipTrivia(this.sourceText, node.pos);
    // Some keywords are likely signs of syntax used improperly.
    switch (expressionText) {
      case 'const':
      case 'let':
      case 'var':
        this.parseErrorAt(pos, node.end, Diagnostics.Variable_declaration_not_allowed_at_this_location);
        return;
      case 'declare':
        // A declaration that failed to parse already reported a diagnostic.
        return;
      case 'interface':
        this.parseErrorForInvalidName(
          Diagnostics.Interface_name_cannot_be_0,
          Diagnostics.Interface_must_be_given_a_name,
          SyntaxKind.OpenBraceToken,
        );
        return;
      case 'is':
        this.parseErrorAt(
          pos,
          this.scanner.getTokenStart(),
          Diagnostics.A_type_predicate_is_only_allowed_in_return_type_position_for_functions_and_methods,
        );
        return;
      case 'module':
      case 'namespace':
        this.parseErrorForInvalidName(
          Diagnostics.Namespace_name_cannot_be_0,
          Diagnostics.Namespace_must_be_given_a_name,
          SyntaxKind.OpenBraceToken,
        );
        return;
      case 'type':
        this.parseErrorForInvalidName(
          Diagnostics.Type_alias_name_cannot_be_0,
          Diagnostics.Type_alias_must_be_given_a_name,
          SyntaxKind.EqualsToken,
        );
        return;
    }
    // A misspelled keyword, or a missing space after one.
    let suggestion = getSpellingSuggestion(expressionText, viableKeywordSuggestions);
    if (suggestion === '') suggestion = getSpaceSuggestion(expressionText);
    if (suggestion !== '') {
      this.parseErrorAt(pos, node.end, Diagnostics.Unknown_keyword_or_identifier_Did_you_mean_0, [suggestion]);
      return;
    }
    // The scanner reports unknown tokens.
    if (this.token() === SyntaxKind.Unknown) return;
    // Some unknown word, not just a missing semicolon.
    this.parseErrorAt(pos, node.end, Diagnostics.Unexpected_keyword_or_identifier);
  }

  parseErrorForInvalidName(
    nameDiagnostic: DiagnosticMessage,
    blankDiagnostic: DiagnosticMessage,
    tokenIfBlankName: SyntaxKind,
  ): void {
    if (this.token() === tokenIfBlankName) this.parseErrorAtCurrentToken(blankDiagnostic);
    else this.parseErrorAtCurrentToken(nameDiagnostic, [this.scanner.getTokenValue()]);
  }

  parseInterfaceDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    this.parseExpected(SyntaxKind.InterfaceKeyword);
    const name = this.parseIdentifier(IdentifierUse.Name);
    const typeParameters = this.parseTypeParameters();
    const heritageClauses = this.parseHeritageClauses();
    const members = this.parseObjectTypeMembers();
    const result = this.finishWithJSDoc(
      new InterfaceDeclaration(modifiers, name, typeParameters, heritageClauses, members),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseTypeAliasDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    this.parseExpected(SyntaxKind.TypeKeyword);
    if (this.hasPrecedingLineBreak()) this.parseErrorAtCurrentToken(Diagnostics.Line_break_not_permitted_here);
    const name = this.parseIdentifier(IdentifierUse.Name);
    const typeParameters = this.parseTypeParameters();
    this.parseExpected(SyntaxKind.EqualsToken);
    const type =
      this.token() === SyntaxKind.IntrinsicKeyword && this.lookAhead(nextIsNotDot)
        ? this.parseKeywordTypeNode()
        : this.parseType();
    this.parseSemicolon();
    const result = this.finishWithJSDoc(
      new TypeAliasDeclaration(SyntaxKind.TypeAliasDeclaration, modifiers, name, typeParameters, type),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  // Ambient declarations only allow integer literal initializers; non-ambient ones allow uninitialized
  // members only in a constant section (at the start, or after an integer literal initializer).
  parseEnumMember(): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const name = this.parsePropertyName();
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext, false);
    const initializer = this.parseInitializer();
    this.contextFlags = saveContextFlags;
    return this.finishWithJSDoc(new EnumMember(name, initializer), pos, jsdoc);
  }

  parseEnumDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    this.parseExpected(SyntaxKind.EnumKeyword);
    const name = this.parseIdentifier(IdentifierUse.Name);
    let members: NodeList;
    if (this.parseExpected(SyntaxKind.OpenBraceToken)) {
      const saveContextFlags = this.contextFlags;
      this.setContextFlags(NodeFlags.YieldContext | NodeFlags.AwaitContext, false);
      members = this.parseDelimitedList(ParsingContext.EnumMembers, ListElement.EnumMember)!;
      this.contextFlags = saveContextFlags;
      this.parseExpected(SyntaxKind.CloseBraceToken);
    } else {
      members = this.createMissingList();
    }
    const result = this.finishWithJSDoc(new EnumDeclaration(modifiers, name, members), pos, jsdoc);
    this.checkJSSyntax(result);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return result;
  }

  parseModuleDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    let keyword = SyntaxKind.ModuleKeyword;
    if (this.token() === SyntaxKind.GlobalKeyword) {
      // A global augmentation.
      return this.parseAmbientExternalModuleDeclaration(pos, jsdoc, modifiers);
    } else if (this.parseOptional(SyntaxKind.NamespaceKeyword)) {
      keyword = SyntaxKind.NamespaceKeyword;
    } else {
      this.parseExpected(SyntaxKind.ModuleKeyword);
      if (this.token() === SyntaxKind.StringLiteral)
        return this.parseAmbientExternalModuleDeclaration(pos, jsdoc, modifiers);
    }
    return this.parseModuleOrNamespaceDeclaration(pos, jsdoc, modifiers, false, keyword);
  }

  parseAmbientExternalModuleDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
  ): Statement {
    let name: Node;
    let keyword = SyntaxKind.ModuleKeyword;
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    if (this.token() === SyntaxKind.GlobalKeyword) {
      // `global` names the global scope augmentation.
      name = this.parseIdentifier(IdentifierUse.Name);
      keyword = SyntaxKind.GlobalKeyword;
    } else {
      name = this.parseLiteralExpression(true);
    }
    let body: Node | undefined;
    if (this.token() === SyntaxKind.OpenBraceToken) body = this.parseModuleBlock();
    else this.parseSemicolon();
    const result = this.finishWithJSDoc(new ModuleDeclaration(modifiers, keyword, name, undefined, body), pos, jsdoc);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return result;
  }

  parseModuleBlock(): Node {
    const pos = this.nodePos();
    let statements: NodeList;
    if (this.parseExpected(SyntaxKind.OpenBraceToken)) {
      statements = this.parseList(ParsingContext.BlockStatements, ListElement.Statement);
      this.parseExpected(SyntaxKind.CloseBraceToken);
    } else {
      statements = this.createMissingList();
    }
    return this.finishNode(new ModuleBlock(statements), pos);
  }

  parseModuleOrNamespaceDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
    nested: boolean,
    keyword: SyntaxKind,
  ): Node {
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    const name = nested ? this.parseIdentifierName(IdentifierUse.Name) : this.parseIdentifier(IdentifierUse.Name);
    let body: Node;
    if (this.parseOptional(SyntaxKind.DotToken)) {
      const implicitExport = new Token(SyntaxKind.ExportKeyword);
      implicitExport.pos = this.nodePos() | 0;
      implicitExport.end = this.nodePos() | 0;
      implicitExport.flags = NodeFlags.Reparsed;
      const implicitModifiers = this.newModifierList(this.nodePos(), this.nodePos(), [implicitExport]);
      body = this.parseModuleOrNamespaceDeclaration(
        this.nodePos(),
        JSDocScannerInfo.None,
        implicitModifiers,
        true,
        keyword,
      );
    } else {
      body = this.parseModuleBlock();
    }
    const result = this.finishWithJSDoc(new ModuleDeclaration(modifiers, keyword, name, undefined, body), pos, jsdoc);
    this.checkJSSyntax(result);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return result;
  }

  parseImportDeclarationOrImportEqualsDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
  ): Statement {
    this.parseExpected(SyntaxKind.ImportKeyword);
    const afterImportPos = this.nodePos();
    // The identifier isn't parsed in an await context; the checker reports `await`.
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    let identifier = this.isIdentifier() ? this.parseIdentifier(IdentifierUse.Name) : undefined;
    let phaseModifier = SyntaxKind.Unknown;
    if (
      identifier !== undefined &&
      identifier.text === 'type' &&
      (this.token() !== SyntaxKind.FromKeyword ||
        (this.isIdentifier() && this.lookAhead(nextTokenIsFromKeywordOrEqualsToken))) &&
      (this.isIdentifier() || this.tokenAfterImportDefinitelyProducesImportDeclaration())
    ) {
      phaseModifier = SyntaxKind.TypeKeyword;
      identifier = this.isIdentifier() ? this.parseIdentifier(IdentifierUse.Name) : undefined;
    } else if (identifier !== undefined && identifier.text === 'defer') {
      const shouldParseAsDeferModifier =
        this.token() === SyntaxKind.FromKeyword
          ? !this.lookAhead(nextTokenIsTokenStringLiteral)
          : this.token() !== SyntaxKind.CommaToken && this.token() !== SyntaxKind.EqualsToken;
      if (shouldParseAsDeferModifier) {
        phaseModifier = SyntaxKind.DeferKeyword;
        identifier = this.isIdentifier() ? this.parseIdentifier(IdentifierUse.Name) : undefined;
      }
    }
    if (
      identifier !== undefined &&
      !this.tokenAfterImportedIdentifierDefinitelyProducesImportDeclaration() &&
      phaseModifier !== SyntaxKind.DeferKeyword
    ) {
      const importEquals = this.checkJSSyntax(
        this.parseImportEqualsDeclaration(pos, jsdoc, modifiers, identifier, phaseModifier === SyntaxKind.TypeKeyword),
      );
      // Import= declarations are always parsed in an await context; no reparse needed.
      this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
      return importEquals;
    }
    const importClause = this.tryParseImportClause(identifier, afterImportPos, phaseModifier, false);
    // Import clauses are always parsed in an await context.
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    const moduleSpecifier = this.parseModuleSpecifier();
    const attributes = this.tryParseImportAttributes();
    this.parseSemicolon();
    const result = this.finishWithJSDoc(
      new ImportDeclaration(SyntaxKind.ImportDeclaration, modifiers, importClause, moduleSpecifier, attributes),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  tokenAfterImportDefinitelyProducesImportDeclaration(): boolean {
    return this.token() === SyntaxKind.AsteriskToken || this.token() === SyntaxKind.OpenBraceToken;
  }

  /** In `import id ___`, whether the token makes this an ImportDeclaration rather than ImportEqualsDeclaration. */
  tokenAfterImportedIdentifierDefinitelyProducesImportDeclaration(): boolean {
    return this.token() === SyntaxKind.CommaToken || this.token() === SyntaxKind.FromKeyword;
  }

  parseImportEqualsDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
    identifier: Identifier,
    isTypeOnly: boolean,
  ): Node {
    this.parseExpected(SyntaxKind.EqualsToken);
    const moduleReference = this.parseModuleReference();
    this.parseSemicolon();
    return this.finishWithJSDoc(
      new ImportEqualsDeclaration(modifiers, isTypeOnly, identifier, moduleReference),
      pos,
      jsdoc,
    );
  }

  parseModuleReference(): Node {
    if (this.token() === SyntaxKind.RequireKeyword && this.lookAhead(nextTokenIsOpenParen))
      return this.parseExternalModuleReference();
    return this.parseEntityName(false, undefined);
  }

  parseExternalModuleReference(): Node {
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.RequireKeyword);
    this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseModuleSpecifier();
    this.parseExpected(SyntaxKind.CloseParenToken);
    const result = this.finishNode(new ExternalModuleReference(expression), pos);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return result;
  }

  parseModuleSpecifier(): Expression {
    if (this.token() === SyntaxKind.StringLiteral) return this.parseLiteralExpression(true);
    // Any expression is allowed here; the grammar checker reports non-string specifiers.
    return this.parseExpression();
  }

  tryParseImportClause(
    identifier: Identifier | undefined,
    pos: number,
    phaseModifier: SyntaxKind,
    skipJSDocLeadingAsterisks: boolean,
  ): ImportClause | undefined {
    // import ImportClause from ModuleSpecifier ;
    // import ModuleSpecifier;
    if (
      identifier !== undefined ||
      this.token() === SyntaxKind.AsteriskToken ||
      this.token() === SyntaxKind.OpenBraceToken
    ) {
      const importClause = this.parseImportClause(identifier, pos, phaseModifier, skipJSDocLeadingAsterisks);
      this.parseExpected(SyntaxKind.FromKeyword);
      return importClause;
    }
    return undefined;
  }

  parseImportClause(
    identifier: Identifier | undefined,
    pos: number,
    phaseModifier: SyntaxKind,
    skipJSDocLeadingAsterisks: boolean,
  ): ImportClause {
    // Namespace or named imports follow when there is no default import or after a comma.
    let namedBindings: Node | undefined;
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    if (identifier === undefined || this.parseOptional(SyntaxKind.CommaToken)) {
      if (skipJSDocLeadingAsterisks) this.scanner.setSkipJSDocLeadingAsterisks(true);
      namedBindings =
        this.token() === SyntaxKind.AsteriskToken ? this.parseNamespaceImport() : this.parseNamedImports();
      if (skipJSDocLeadingAsterisks) this.scanner.setSkipJSDocLeadingAsterisks(false);
    }
    // A clause without a phase modifier holds undefined, as decoded and factory-made clauses do.
    const result = new ImportClause(
      phaseModifier === SyntaxKind.Unknown ? undefined : phaseModifier,
      identifier,
      namedBindings,
    );
    this.finishNode(result, pos);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return result;
  }

  parseNamespaceImport(): Node {
    // NameSpaceImport: * as ImportedBinding
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.AsteriskToken);
    this.parseExpected(SyntaxKind.AsKeyword);
    const name = this.parseIdentifier(IdentifierUse.Name);
    return this.finishNode(new NamespaceImport(name), pos);
  }

  parseNamedImports(): Node {
    const pos = this.nodePos();
    const imports = this.parseBracketedList(
      ParsingContext.ImportOrExportSpecifiers,
      ListElement.ImportSpecifier,
      SyntaxKind.OpenBraceToken,
      SyntaxKind.CloseBraceToken,
    )!;
    return this.finishNode(new NamedImports(imports), pos);
  }

  parseImportSpecifier(): Node {
    return this.parseImportOrExportSpecifier(SyntaxKind.ImportSpecifier);
  }

  parseExportSpecifier(): Node {
    return this.parseImportOrExportSpecifier(SyntaxKind.ExportSpecifier);
  }

  parseImportOrExportSpecifier(kind: SyntaxKind): Node {
    // ImportSpecifier: BindingIdentifier | ModuleExportName as BindingIdentifier
    // ExportSpecifier: ModuleExportName | ModuleExportName as ModuleExportName
    const pos = this.nodePos();
    const jsdoc = kind === SyntaxKind.ExportSpecifier ? this.jsdocScannerInfo() : JSDocScannerInfo.None;
    let canParseAsKeyword = true;
    const disallowKeywords = kind === SyntaxKind.ImportSpecifier;
    let isTypeOnly = false;
    let propertyName: Node | undefined;
    let nameOk = this.isModuleExportNameOk(disallowKeywords);
    let name = this.parseModuleExportName();
    if (name instanceof Identifier && (name as Identifier).text === 'type') {
      // With a leading `type`, especially before `as`:
      //   import { type } from "mod";          - isTypeOnly: false, name: type
      //   import { type as } from "mod";       - isTypeOnly: true,  name: as
      //   import { type as as } from "mod";    - isTypeOnly: false, name: as, propertyName: type
      //   import { type as as as } from "mod"; - isTypeOnly: true,  name: as, propertyName: as
      if (this.token() === SyntaxKind.AsKeyword) {
        const firstAs = this.parseIdentifierName(IdentifierUse.Name);
        if (this.token() === SyntaxKind.AsKeyword) {
          const secondAs = this.parseIdentifierName(IdentifierUse.Name);
          if (this.canParseModuleExportName()) {
            // { type as as something }
            isTypeOnly = true;
            propertyName = firstAs;
            nameOk = this.isModuleExportNameOk(disallowKeywords);
            name = this.parseModuleExportName();
            canParseAsKeyword = false;
          } else {
            // { type as as }
            propertyName = name;
            name = secondAs;
            canParseAsKeyword = false;
          }
        } else if (this.canParseModuleExportName()) {
          // { type as something }
          propertyName = name;
          canParseAsKeyword = false;
          nameOk = this.isModuleExportNameOk(disallowKeywords);
          name = this.parseModuleExportName();
        } else {
          // { type as }
          isTypeOnly = true;
          name = firstAs;
        }
      } else if (this.canParseModuleExportName()) {
        // { type something ...? }
        isTypeOnly = true;
        nameOk = this.isModuleExportNameOk(disallowKeywords);
        name = this.parseModuleExportName();
      }
    }
    if (canParseAsKeyword && this.token() === SyntaxKind.AsKeyword) {
      propertyName = name;
      this.parseExpected(SyntaxKind.AsKeyword);
      nameOk = this.isModuleExportNameOk(disallowKeywords);
      name = this.parseModuleExportName();
    }
    if (!nameOk) this.parseErrorAt(skipTrivia(this.sourceText, name.pos), name.end, Diagnostics.Identifier_expected);
    if (kind === SyntaxKind.ExportSpecifier) {
      const result = this.finishWithJSDoc(new ExportSpecifier(isTypeOnly, propertyName, name), pos, jsdoc);
      this.checkJSSyntax(result);
      return result;
    }
    let identifierName: Identifier;
    if (name instanceof Identifier) {
      identifierName = name;
    } else {
      this.parseErrorAt(skipTrivia(this.sourceText, name.pos), name.end, Diagnostics.Identifier_expected);
      identifierName = this.newIdentifier('');
      this.finishNode(identifierName, name.pos);
    }
    return this.checkJSSyntax(this.finishNode(new ImportSpecifier(isTypeOnly, propertyName, identifierName), pos));
  }

  canParseModuleExportName(): boolean {
    return tokenIsIdentifierOrKeyword(this.token()) || this.token() === SyntaxKind.StringLiteral;
  }

  /** Whether the module export name at the current token is acceptable. */
  isModuleExportNameOk(disallowKeywords: boolean): boolean {
    return (
      this.token() === SyntaxKind.StringLiteral ||
      !(disallowKeywords && isKeyword(this.token()) && !this.isIdentifier())
    );
  }

  parseModuleExportName(): Node {
    if (this.token() === SyntaxKind.StringLiteral) return this.parseLiteralExpression(false);
    return this.parseIdentifierName(IdentifierUse.Name);
  }

  tryParseImportAttributes(): ImportAttributes | undefined {
    if (
      this.token() === SyntaxKind.WithKeyword ||
      (this.token() === SyntaxKind.AssertKeyword && !this.hasPrecedingLineBreak())
    ) {
      if (this.token() === SyntaxKind.AssertKeyword)
        this.parseErrorAtCurrentToken(
          Diagnostics.Import_assertions_have_been_replaced_by_import_attributes_Use_with_instead_of_assert,
        );
      return this.parseImportAttributes(this.token(), false);
    }
    return undefined;
  }

  parseExportAssignment(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    const saveContextFlags = this.contextFlags;
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    this.setContextFlags(NodeFlags.AwaitContext, true);
    let isExportEquals = false;
    if (this.parseOptional(SyntaxKind.EqualsToken)) isExportEquals = true;
    else this.parseExpected(SyntaxKind.DefaultKeyword);
    const expression = this.parseAssignmentExpressionOrHigher();
    this.parseSemicolon();
    this.contextFlags = saveContextFlags;
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    const result = this.finishWithJSDoc(
      new ExportAssignment(modifiers, isExportEquals, undefined, expression),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseNamespaceExportDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
  ): Statement {
    this.parseExpected(SyntaxKind.AsKeyword);
    this.parseExpected(SyntaxKind.NamespaceKeyword);
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    const name = this.parseIdentifier(IdentifierUse.Name);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    this.parseSemicolon();
    // Modifiers are kept so the grammar checker can report them.
    return this.finishWithJSDoc(new NamespaceExportDeclaration(modifiers, name), pos, jsdoc);
  }

  parseExportDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Statement {
    const saveContextFlags = this.contextFlags;
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    this.setContextFlags(NodeFlags.AwaitContext, true);
    let exportClause: Node | undefined;
    let moduleSpecifier: Expression | undefined;
    let attributes: ImportAttributes | undefined;
    const isTypeOnly = this.parseOptional(SyntaxKind.TypeKeyword);
    const namespaceExportPos = this.nodePos();
    if (this.parseOptional(SyntaxKind.AsteriskToken)) {
      if (this.parseOptional(SyntaxKind.AsKeyword)) exportClause = this.parseNamespaceExport(namespaceExportPos);
      this.parseExpected(SyntaxKind.FromKeyword);
      moduleSpecifier = this.parseModuleSpecifier();
    } else {
      exportClause = this.parseNamedExports();
      // `from` is often omitted by accident, or parsed as a named export in `export { from "m";`.
      // Without `from`, still parse a string literal that ASI wouldn't separate.
      if (
        this.token() === SyntaxKind.FromKeyword ||
        (this.token() === SyntaxKind.StringLiteral && !this.hasPrecedingLineBreak())
      ) {
        this.parseExpected(SyntaxKind.FromKeyword);
        moduleSpecifier = this.parseModuleSpecifier();
      }
    }
    if (
      moduleSpecifier !== undefined &&
      (this.token() === SyntaxKind.WithKeyword || this.token() === SyntaxKind.AssertKeyword) &&
      !this.hasPrecedingLineBreak()
    ) {
      if (this.token() === SyntaxKind.AssertKeyword)
        this.parseErrorAtCurrentToken(
          Diagnostics.Import_assertions_have_been_replaced_by_import_attributes_Use_with_instead_of_assert,
        );
      attributes = this.parseImportAttributes(this.token(), false);
    }
    this.parseSemicolon();
    this.contextFlags = saveContextFlags;
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    const result = this.finishWithJSDoc(
      new ExportDeclaration(modifiers, isTypeOnly, exportClause, moduleSpecifier, attributes),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseNamespaceExport(pos: number): Node {
    const exportName = this.parseModuleExportName();
    return this.finishNode(new NamespaceExport(exportName), pos);
  }

  parseNamedExports(): Node {
    const pos = this.nodePos();
    const exports = this.parseBracketedList(
      ParsingContext.ImportOrExportSpecifiers,
      ListElement.ExportSpecifier,
      SyntaxKind.OpenBraceToken,
      SyntaxKind.CloseBraceToken,
    )!;
    return this.finishNode(new NamedExports(exports), pos);
  }

  // Types

  parseType(): TypeNode {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.TypeExcludesFlags, false);
    let type: TypeNode;
    if (this.isStartOfFunctionTypeOrConstructorType()) {
      type = this.parseFunctionOrConstructorType();
    } else {
      const pos = this.nodePos();
      type = this.parseUnionTypeOrHigher();
      if (
        !this.inDisallowConditionalTypesContext() &&
        !this.hasPrecedingLineBreak() &&
        this.parseOptional(SyntaxKind.ExtendsKeyword)
      ) {
        // The type after `extends` can't be another conditional type.
        const extendsType = this.parseTypeInConditionalContext(true);
        this.parseExpected(SyntaxKind.QuestionToken);
        const trueType = this.parseTypeInConditionalContext(false);
        this.parseExpected(SyntaxKind.ColonToken);
        const falseType = this.parseTypeInConditionalContext(false);
        type = this.finishNode(new ConditionalTypeNode(type, extendsType, trueType, falseType), pos);
      }
    }
    this.contextFlags = saveContextFlags;
    return type;
  }

  /** `parseType` with conditional types disallowed or allowed. */
  parseTypeInConditionalContext(disallowConditionalTypes: boolean): TypeNode {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowConditionalTypesContext, disallowConditionalTypes);
    const result = this.parseType();
    this.contextFlags = saveContextFlags;
    return result;
  }

  parseUnionTypeOrHigher(): TypeNode {
    return this.parseUnionOrIntersectionType(SyntaxKind.BarToken);
  }

  parseIntersectionTypeOrHigher(): TypeNode {
    return this.parseUnionOrIntersectionType(SyntaxKind.AmpersandToken);
  }

  /** `parseIntersectionTypeOrHigher` for unions, `parseTypeOperatorOrHigher` for intersections. */
  parseConstituentType(isUnionType: boolean): TypeNode {
    return isUnionType ? this.parseIntersectionTypeOrHigher() : this.parseTypeOperatorOrHigher();
  }

  parseUnionOrIntersectionType(operator: SyntaxKind): TypeNode {
    const pos = this.nodePos();
    const isUnionType = operator === SyntaxKind.BarToken;
    const hasLeadingOperator = this.parseOptional(operator);
    let type = hasLeadingOperator
      ? this.parseFunctionOrConstructorTypeToError(isUnionType)
      : this.parseConstituentType(isUnionType);
    if (this.token() === operator || hasLeadingOperator) {
      const types = this.openList();
      types.push(type);
      while (this.parseOptional(operator)) types.push(this.parseFunctionOrConstructorTypeToError(isUnionType));
      const list = this.newNodeList(pos, this.nodePos(), this.closeList(types));
      type = isUnionType ? new UnionTypeNode(list) : new IntersectionTypeNode(list);
      this.finishNode(type, pos);
    }
    return type;
  }

  parseTypeOperatorOrHigher(): TypeNode {
    const operator = this.token();
    switch (operator) {
      case SyntaxKind.KeyOfKeyword:
      case SyntaxKind.UniqueKeyword:
      case SyntaxKind.ReadonlyKeyword:
        return this.parseTypeOperator(operator);
      case SyntaxKind.InferKeyword:
        return this.parseInferType();
    }
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowConditionalTypesContext, false);
    const result = this.parsePostfixTypeOrHigher();
    this.contextFlags = saveContextFlags;
    return result;
  }

  parseTypeOperator(operator: SyntaxKind): TypeNode {
    const pos = this.nodePos();
    this.parseExpected(operator);
    return this.finishNode(new TypeOperatorNode(operator, this.parseTypeOperatorOrHigher()), pos);
  }

  parseInferType(): TypeNode {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.InferKeyword);
    return this.finishNode(new InferTypeNode(this.parseTypeParameterOfInferType()), pos);
  }

  parseTypeParameterOfInferType(): TypeParameterDeclaration {
    const pos = this.nodePos();
    const name = this.parseIdentifier(IdentifierUse.Name);
    const constraint = this.tryParseConstraintOfInferType();
    const result = new TypeParameterDeclaration(undefined, name, constraint, undefined, undefined);
    this.finishNode(result, pos);
    return result;
  }

  tryParseConstraintOfInferType(): TypeNode | undefined {
    const state = this.mark();
    if (this.parseOptional(SyntaxKind.ExtendsKeyword)) {
      const constraint = this.parseTypeInConditionalContext(true);
      if (this.inDisallowConditionalTypesContext() || this.token() !== SyntaxKind.QuestionToken) return constraint;
    }
    this.rewind(state);
    return undefined;
  }

  parsePostfixTypeOrHigher(): TypeNode {
    const pos = this.nodePos();
    let type = this.parseNonArrayType();
    while (!this.hasPrecedingLineBreak()) {
      switch (this.token()) {
        case SyntaxKind.ExclamationToken:
          this.nextToken();
          type = this.finishNode(new JSDocNonNullableType(type), pos);
          break;
        case SyntaxKind.QuestionToken:
          // A type after `?` makes this a conditional type.
          if (this.lookAhead(nextIsStartOfType)) return type;
          this.nextToken();
          type = this.finishNode(new JSDocNullableType(type), pos);
          break;
        case SyntaxKind.OpenBracketToken:
          this.parseExpected(SyntaxKind.OpenBracketToken);
          if (this.isStartOfType(false)) {
            const indexType = this.parseType();
            this.parseExpected(SyntaxKind.CloseBracketToken);
            type = this.finishNode(new IndexedAccessTypeNode(type, indexType), pos);
          } else {
            this.parseExpected(SyntaxKind.CloseBracketToken);
            type = this.finishNode(new ArrayTypeNode(type), pos);
          }
          break;
        default:
          return type;
      }
    }
    return type;
  }

  parseNonArrayType(): TypeNode {
    switch (this.token()) {
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.StringKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.BigIntKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.ObjectKeyword: {
        const state = this.beginSpeculation();
        const keywordTypeNode = this.parseKeywordTypeNode();
        // Followed by a dot, these are a dotted type reference.
        if (this.token() !== SyntaxKind.DotToken) {
          this.endSpeculation(state);
          return keywordTypeNode;
        }
        this.rewind(state);
        this.endSpeculation(state);
        return this.parseTypeReference();
      }
      case SyntaxKind.AsteriskEqualsToken:
        // `*=` is `*` followed by a postfix `=`.
        this.scanner.reScanAsteriskEqualsToken();
        return this.parseJSDocAllType();
      case SyntaxKind.AsteriskToken:
        return this.parseJSDocAllType();
      case SyntaxKind.QuestionQuestionToken:
        // `??` is a prefix `?` in a JSDoc type.
        this.scanner.reScanQuestionToken();
        return this.parseJSDocNullableType();
      case SyntaxKind.QuestionToken:
        return this.parseJSDocNullableType();
      case SyntaxKind.ExclamationToken:
        return this.parseJSDocNonNullableType();
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.NullKeyword:
        return this.parseLiteralTypeNode(false);
      case SyntaxKind.MinusToken:
        if (this.lookAhead(nextTokenIsNumericOrBigIntLiteral)) return this.parseLiteralTypeNode(true);
        return this.parseTypeReference();
      case SyntaxKind.VoidKeyword:
        return this.parseKeywordTypeNode();
      case SyntaxKind.ThisKeyword: {
        const thisKeyword = this.parseThisTypeNode();
        if (this.token() === SyntaxKind.IsKeyword && !this.hasPrecedingLineBreak())
          return this.parseThisTypePredicate(thisKeyword);
        return thisKeyword;
      }
      case SyntaxKind.TypeOfKeyword:
        if (this.lookAhead(nextIsStartOfTypeOfImportType)) return this.parseImportType();
        return this.parseTypeQuery();
      case SyntaxKind.OpenBraceToken:
        if (this.lookAhead(nextIsStartOfMappedType)) return this.parseMappedType();
        return this.parseTypeLiteral();
      case SyntaxKind.OpenBracketToken:
        return this.parseTupleType();
      case SyntaxKind.OpenParenToken:
        return this.parseParenthesizedType();
      case SyntaxKind.ImportKeyword:
        return this.parseImportType();
      case SyntaxKind.AssertsKeyword:
        if (this.lookAhead(nextTokenIsIdentifierOrKeywordOnSameLine)) return this.parseAssertsTypePredicate();
        return this.parseTypeReference();
      case SyntaxKind.TemplateHead:
        return this.parseTemplateType();
      default:
        return this.parseTypeReference();
    }
  }

  parseKeywordTypeNode(): TypeNode {
    const pos = this.nodePos();
    const result = new KeywordTypeNode(this.token());
    this.nextToken();
    return this.finishNode(result, pos);
  }

  parseThisTypeNode(): ThisTypeNode {
    const pos = this.nodePos();
    this.nextToken();
    const result = new ThisTypeNode();
    this.finishNode(result, pos);
    return result;
  }

  parseThisTypePredicate(lhs: Node): TypeNode {
    this.nextToken();
    return this.finishNode(new TypePredicateNode(undefined, lhs, this.parseType()), lhs.pos);
  }

  parseJSDocAllType(): TypeNode {
    const pos = this.nodePos();
    this.nextToken();
    return this.finishNode(new JSDocAllType(), pos);
  }

  parseJSDocNonNullableType(): TypeNode {
    const pos = this.nodePos();
    this.nextToken();
    return this.finishNode(new JSDocNonNullableType(this.parseTypeOperatorOrHigher()), pos);
  }

  parseJSDocNullableType(): TypeNode {
    const pos = this.nodePos();
    // Skip the `?`.
    this.nextToken();
    return this.finishNode(new JSDocNullableType(this.parseTypeOperatorOrHigher()), pos);
  }

  parseJSDocType(): TypeNode {
    this.scanner.setSkipJSDocLeadingAsterisks(true);
    const pos = this.nodePos();
    const hasDotDotDot = this.parseOptional(SyntaxKind.DotDotDotToken);
    let type = this.parseTypeOrTypePredicate();
    this.scanner.setSkipJSDocLeadingAsterisks(false);
    if (hasDotDotDot) type = this.finishNode(new JSDocVariadicType(type), pos);
    if (this.token() === SyntaxKind.EqualsToken) {
      this.nextToken();
      return this.finishNode(new JSDocOptionalType(type), pos);
    }
    return type;
  }

  parseLiteralTypeNode(negative: boolean): TypeNode {
    const pos = this.nodePos();
    if (negative) this.nextToken();
    let expression: Expression =
      this.token() === SyntaxKind.TrueKeyword ||
      this.token() === SyntaxKind.FalseKeyword ||
      this.token() === SyntaxKind.NullKeyword
        ? this.parseKeywordExpression()
        : this.parseLiteralExpression(false);
    if (negative) expression = this.finishNode(new PrefixUnaryExpression(SyntaxKind.MinusToken, expression), pos);
    return this.finishNode(new LiteralTypeNode(expression), pos);
  }

  parseTypeReference(): TypeNode {
    const pos = this.nodePos();
    return this.finishNode(
      new TypeReferenceNode(this.parseEntityNameOfTypeReference(), this.parseTypeArgumentsOfTypeReference()),
      pos,
    );
  }

  parseEntityNameOfTypeReference(): EntityName {
    return this.parseEntityName(true, Diagnostics.Type_expected);
  }

  /** An entity name; `use` is for its first identifier, the qualified names' right sides are names. */
  parseEntityName(
    allowReservedWords: boolean,
    diagnosticMessage: DiagnosticMessage | undefined,
    use: IdentifierUse = IdentifierUse.Name,
  ): EntityName {
    const pos = this.nodePos();
    let entity: Node = allowReservedWords
      ? this.parseIdentifierNameWithDiagnostic(diagnosticMessage, use)
      : this.parseIdentifierWithDiagnostic(diagnosticMessage, undefined, use);
    while (this.parseOptional(SyntaxKind.DotToken)) {
      // A JSDoc-style generic; the checker reports the gap between the name and the type arguments.
      if (this.token() === SyntaxKind.LessThanToken) break;
      entity = this.finishNode(
        new QualifiedName(entity, this.parseRightSideOfDotIdentifier(allowReservedWords, true)),
        pos,
      );
    }
    return entity;
  }

  parseRightSideOfDot(
    allowIdentifierNames: boolean,
    allowPrivateIdentifiers: boolean,
    allowUnicodeEscapeSequenceInIdentifierName: boolean,
  ): Node {
    if (allowPrivateIdentifiers && this.token() === SyntaxKind.PrivateIdentifier && !this.isKeywordStartingNextLine())
      return this.parsePrivateIdentifier();
    return this.parseRightSideOfDotIdentifier(allowIdentifierNames, allowUnicodeEscapeSequenceInIdentifierName);
  }

  /** `parseRightSideOfDot` without private identifiers. */
  parseRightSideOfDotIdentifier(
    allowIdentifierNames: boolean,
    allowUnicodeEscapeSequenceInIdentifierName: boolean,
  ): Identifier {
    // Keywords are identifier names, but in
    //
    //      name.
    //      identifierOrKeyword identifierNameOrKeyword
    //
    // the keyword more likely starts another construct (ASI doesn't apply without a line break
    // after it). Report a missing identifier right after the dot rather than on the next token.
    if (this.isKeywordStartingNextLine()) {
      this.parseErrorAt(this.nodePos(), this.nodePos(), Diagnostics.Identifier_expected);
      return this.createMissingIdentifier(IdentifierUse.Name);
    }
    if (this.token() === SyntaxKind.PrivateIdentifier) {
      this.parsePrivateIdentifier();
      this.parseErrorAt(this.nodePos(), this.nodePos(), Diagnostics.Identifier_expected);
      return this.createMissingIdentifier(IdentifierUse.Name);
    }
    if (allowIdentifierNames) {
      if (allowUnicodeEscapeSequenceInIdentifierName) return this.parseIdentifierName(IdentifierUse.Name);
      return this.parseIdentifierNameErrorOnUnicodeEscapeSequence(IdentifierUse.Name);
    }
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    const id = this.parseIdentifier(IdentifierUse.Name);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return id;
  }

  /** An identifier or keyword after a line break, followed by another on the same line. */
  isKeywordStartingNextLine(): boolean {
    return (
      this.hasPrecedingLineBreak() &&
      tokenIsIdentifierOrKeyword(this.token()) &&
      this.lookAhead(nextTokenIsIdentifierOrKeywordOnSameLine)
    );
  }

  /**
   * A new identifier of the class `use` calls for. Callers create it after the identifier's token, so
   * for an element name the current token tells a shorthand property from an assignment or a method.
   */
  newIdentifier(text: string, use: IdentifierUse = IdentifierUse.Reference): Identifier {
    this.identifierCount++;
    if (text === 'await') this.statementHasAwaitIdentifier = true;
    if (use === IdentifierUse.Name || (use === IdentifierUse.ElementName && this.isElementNameEnd()))
      return new Identifier(text);
    return new ReferenceIdentifier(text);
  }

  /** Whether the current token ends an object literal element name that is not a shorthand property. */
  isElementNameEnd(): boolean {
    const token = this.token();
    return token === SyntaxKind.ColonToken || token === SyntaxKind.OpenParenToken || token === SyntaxKind.LessThanToken;
  }

  createMissingIdentifier(use: IdentifierUse = IdentifierUse.Reference): Identifier {
    const result = this.newIdentifier('', use);
    this.finishNode(result, this.nodePos());
    return result;
  }

  parsePrivateIdentifier(): Node {
    const pos = this.nodePos();
    const text = this.scanner.getIdentifierValue();
    this.nextToken();
    return this.finishNode(new PrivateIdentifier(this.internIdentifier(text)), pos);
  }

  reScanLessThanToken(): SyntaxKind {
    this.currentToken = this.scanner.reScanLessThanToken();
    return this.currentToken;
  }

  reScanGreaterThanToken(): SyntaxKind {
    this.currentToken = this.scanner.reScanGreaterThanToken();
    return this.currentToken;
  }

  reScanSlashToken(): SyntaxKind {
    this.currentToken = this.scanner.reScanSlashToken();
    return this.currentToken;
  }

  reScanTemplateToken(isTaggedTemplate: boolean): SyntaxKind {
    this.currentToken = this.scanner.reScanTemplateToken(isTaggedTemplate);
    return this.currentToken;
  }

  parseTypeArgumentsOfTypeReference(): NodeList | undefined {
    if (!this.hasPrecedingLineBreak() && this.reScanLessThanToken() === SyntaxKind.LessThanToken)
      return this.parseTypeArguments();
    return undefined;
  }

  parseTypeArguments(): NodeList | undefined {
    if (this.token() === SyntaxKind.LessThanToken)
      return this.parseBracketedList(
        ParsingContext.TypeArguments,
        ListElement.Type,
        SyntaxKind.LessThanToken,
        SyntaxKind.GreaterThanToken,
      );
    return undefined;
  }

  parseImportType(): TypeNode {
    this.sourceFlags |= NodeFlags.PossiblyContainsDynamicImport;
    const pos = this.nodePos();
    const isTypeOf = this.parseOptional(SyntaxKind.TypeOfKeyword);
    this.parseExpected(SyntaxKind.ImportKeyword);
    this.parseExpected(SyntaxKind.OpenParenToken);
    const type = this.parseType();
    let attributes: ImportAttributes | undefined;
    if (this.parseOptional(SyntaxKind.CommaToken)) {
      const openBracePosition = this.scanner.getTokenStart();
      this.parseExpected(SyntaxKind.OpenBraceToken);
      const currentToken = this.token();
      if (currentToken === SyntaxKind.WithKeyword || currentToken === SyntaxKind.AssertKeyword) {
        if (currentToken === SyntaxKind.AssertKeyword)
          this.parseErrorAtCurrentToken(
            Diagnostics.Import_assertions_have_been_replaced_by_import_attributes_Use_with_instead_of_assert,
          );
        this.nextToken();
      } else {
        this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(SyntaxKind.WithKeyword)]);
      }
      this.parseExpected(SyntaxKind.ColonToken);
      attributes = this.parseImportAttributes(currentToken, true);
      this.parseOptional(SyntaxKind.CommaToken);
      if (!this.parseExpected(SyntaxKind.CloseBraceToken)) this.addMatchingBraceRelatedInfo(openBracePosition);
    }
    this.parseExpected(SyntaxKind.CloseParenToken);
    const qualifier = this.parseOptional(SyntaxKind.DotToken) ? this.parseEntityNameOfTypeReference() : undefined;
    const typeArguments = this.parseTypeArgumentsOfTypeReference();
    return this.finishNode(new ImportTypeNode(isTypeOf, type, attributes, qualifier, typeArguments), pos);
  }

  /** Points a trailing `'}' expected.` error at the `{` it should match. */
  addMatchingBraceRelatedInfo(openBracePosition: number): void {
    const diagnostics = this.diagnostics;
    if (diagnostics.length === 0) return;
    const lastDiagnostic = diagnostics[diagnostics.length - 1]!;
    if (lastDiagnostic.code === messageCode(Diagnostics.X_0_expected))
      lastDiagnostic.addRelatedInfo(
        new Diagnostic(
          undefined,
          openBracePosition,
          openBracePosition,
          Diagnostics.The_parser_expected_to_find_a_1_to_match_the_0_token_here,
          ['{', '}'],
        ),
      );
  }

  parseImportAttribute(): Node {
    const pos = this.nodePos();
    let name: Node | undefined;
    if (tokenIsIdentifierOrKeyword(this.token())) name = this.parseIdentifierName(IdentifierUse.Name);
    else if (this.token() === SyntaxKind.StringLiteral) name = this.parseLiteralExpression(false);
    if (name !== undefined) this.parseExpected(SyntaxKind.ColonToken);
    else this.parseErrorAtCurrentToken(Diagnostics.Identifier_or_string_literal_expected);
    const value = this.parseAssignmentExpressionOrHigher();
    return this.finishNode(new ImportAttribute(name, value), pos);
  }

  parseImportAttributes(token: SyntaxKind, skipKeyword: boolean): ImportAttributes {
    const pos = this.nodePos();
    if (!skipKeyword) this.parseExpected(token);
    let elements: NodeList;
    let multiLine = false;
    const openBracePosition = this.scanner.getTokenStart();
    if (this.parseExpected(SyntaxKind.OpenBraceToken)) {
      multiLine = this.hasPrecedingLineBreak();
      elements = this.parseDelimitedList(ParsingContext.ImportAttributes, ListElement.ImportAttribute)!;
      if (!this.parseExpected(SyntaxKind.CloseBraceToken)) this.addMatchingBraceRelatedInfo(openBracePosition);
    } else {
      elements = this.parseEmptyNodeList();
    }
    const result = new ImportAttributes(token, elements, multiLine);
    this.finishNode(result, pos);
    return result;
  }

  parseTypeQuery(): TypeNode {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.TypeOfKeyword);
    const entityName = this.parseEntityName(true, undefined, IdentifierUse.Reference);
    // ASI: don't parse the next line's type arguments as part of an instantiation expression.
    const typeArguments = this.hasPrecedingLineBreak() ? undefined : this.parseTypeArguments();
    return this.finishNode(new TypeQueryNode(entityName, typeArguments), pos);
  }

  parseMappedType(): TypeNode {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.OpenBraceToken);
    let readonlyToken: Token | undefined;
    if (
      this.token() === SyntaxKind.ReadonlyKeyword ||
      this.token() === SyntaxKind.PlusToken ||
      this.token() === SyntaxKind.MinusToken
    ) {
      readonlyToken = this.parseTokenNode();
      if (readonlyToken.kind !== SyntaxKind.ReadonlyKeyword) this.parseExpected(SyntaxKind.ReadonlyKeyword);
    }
    this.parseExpected(SyntaxKind.OpenBracketToken);
    const typeParameter = this.parseMappedTypeParameter();
    const nameType = this.parseOptional(SyntaxKind.AsKeyword) ? this.parseType() : undefined;
    this.parseExpected(SyntaxKind.CloseBracketToken);
    let questionToken: Token | undefined;
    if (
      this.token() === SyntaxKind.QuestionToken ||
      this.token() === SyntaxKind.PlusToken ||
      this.token() === SyntaxKind.MinusToken
    ) {
      questionToken = this.parseTokenNode();
      if (questionToken.kind !== SyntaxKind.QuestionToken) this.parseExpected(SyntaxKind.QuestionToken);
    }
    const type = this.parseTypeAnnotation();
    this.parseSemicolon();
    const members = this.parseList(ParsingContext.TypeMembers, ListElement.TypeMember);
    this.parseExpected(SyntaxKind.CloseBraceToken);
    return this.finishNode(
      new MappedTypeNode(readonlyToken, typeParameter, nameType, questionToken, type, members),
      pos,
    );
  }

  parseMappedTypeParameter(): TypeParameterDeclaration {
    const pos = this.nodePos();
    const name = this.parseIdentifierName(IdentifierUse.Name);
    this.parseExpected(SyntaxKind.InKeyword);
    const type = this.parseType();
    const result = new TypeParameterDeclaration(undefined, name, type, undefined, undefined);
    this.finishNode(result, pos);
    return result;
  }

  parseTypeMember(): Node {
    if (this.token() === SyntaxKind.OpenParenToken || this.token() === SyntaxKind.LessThanToken)
      return this.parseSignatureMember(SyntaxKind.CallSignature);
    if (this.token() === SyntaxKind.NewKeyword && this.lookAhead(nextTokenIsOpenParenOrLessThan))
      return this.parseSignatureMember(SyntaxKind.ConstructSignature);
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const modifiers = this.parseModifiers();
    if (this.parseContextualModifier(SyntaxKind.GetKeyword))
      return this.parseAccessorDeclaration(pos, jsdoc, modifiers, SyntaxKind.GetAccessor, ParseFlags.Type);
    if (this.parseContextualModifier(SyntaxKind.SetKeyword))
      return this.parseAccessorDeclaration(pos, jsdoc, modifiers, SyntaxKind.SetAccessor, ParseFlags.Type);
    if (this.isIndexSignature()) return this.parseIndexSignatureDeclaration(pos, jsdoc, modifiers);
    return this.parsePropertyOrMethodSignature(pos, jsdoc, modifiers);
  }

  parseSignatureMember(kind: SyntaxKind): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    if (kind === SyntaxKind.ConstructSignature) this.parseExpected(SyntaxKind.NewKeyword);
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters(ParseFlags.Type);
    const type = this.parseReturnType(SyntaxKind.ColonToken, true);
    this.parseTypeMemberSemicolon();
    const result: Node =
      kind === SyntaxKind.CallSignature
        ? new CallSignatureDeclaration(typeParameters, parameters, type)
        : new ConstructSignatureDeclaration(typeParameters, parameters, type);
    return this.finishWithJSDoc(result, pos, jsdoc);
  }

  parseTypeParameters(): NodeList | undefined {
    if (this.token() === SyntaxKind.LessThanToken)
      return this.parseBracketedList(
        ParsingContext.TypeParameters,
        ListElement.TypeParameter,
        SyntaxKind.LessThanToken,
        SyntaxKind.GreaterThanToken,
      );
    return undefined;
  }

  parseTypeParameter(): Node {
    const pos = this.nodePos();
    const modifiers = this.parseModifiersEx(false, true, false);
    const name = this.parseIdentifier(IdentifierUse.Name);
    let constraint: TypeNode | undefined;
    let expression: Expression | undefined;
    if (this.parseOptional(SyntaxKind.ExtendsKeyword)) {
      // For an expression written as a constraint, parse an expression to recover well and let the
      // checker report that a type is needed. Use a unary expression, so `<T extends "">` doesn't
      // consume the `>`.
      if (this.isStartOfType(false) || !this.isStartOfExpression()) constraint = this.parseType();
      else expression = this.parseUnaryExpressionOrHigher();
    }
    const defaultType = this.parseOptional(SyntaxKind.EqualsToken) ? this.parseType() : undefined;
    return this.finishNode(new TypeParameterDeclaration(modifiers, name, constraint, expression, defaultType), pos);
  }

  parseParameters(flags: ParseFlags): NodeList {
    if (this.parseExpected(SyntaxKind.OpenParenToken)) {
      const parameters = this.parseParametersWorker(flags, true)!;
      this.parseExpected(SyntaxKind.CloseParenToken);
      return parameters;
    }
    return this.createMissingList();
  }

  /** The parameters, or undefined if `allowAmbiguity` is false and one isn't unambiguously a parameter. */
  parseParametersWorker(flags: ParseFlags, allowAmbiguity: boolean): NodeList | undefined {
    const saveInAwaitContext = this.signatureParameterInAwaitContext;
    const saveAllowAmbiguity = this.signatureParameterAllowAmbiguity;
    const saveFlags = this.signatureParameterFlags;
    this.signatureParameterInAwaitContext = this.inAwaitContext();
    this.signatureParameterAllowAmbiguity = allowAmbiguity;
    this.signatureParameterFlags = flags;
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.YieldContext, (flags & ParseFlags.Yield) !== 0);
    this.setContextFlags(NodeFlags.AwaitContext, (flags & ParseFlags.Await) !== 0);
    const parameters = this.parseDelimitedList(ParsingContext.Parameters, ListElement.SignatureParameter);
    this.contextFlags = saveContextFlags;
    this.signatureParameterInAwaitContext = saveInAwaitContext;
    this.signatureParameterAllowAmbiguity = saveAllowAmbiguity;
    this.signatureParameterFlags = saveFlags;
    return parameters;
  }

  parseParameter(): Node {
    return this.parseParameterEx(false, true);
  }

  /** The parameter, or `noElement` if ambiguity isn't allowed and no parameter name starts here. */
  parseParameterEx(inOuterAwaitContext: boolean, allowAmbiguity: boolean): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    // Decorators are parsed in the outer [Await] context, the rest in the function's.
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.AwaitContext, inOuterAwaitContext);
    const modifiers = this.parseModifiersEx(true, false, false);
    this.contextFlags = saveContextFlags;
    if (this.token() === SyntaxKind.ThisKeyword) {
      const result = new ParameterDeclaration(
        modifiers,
        undefined,
        this.createIdentifier(true, IdentifierUse.Name),
        undefined,
        this.parseTypeAnnotation(),
        undefined,
      );
      if (modifiers !== undefined) {
        const first = modifiers.nodes[0]!;
        this.parseErrorAt(
          first.pos,
          first.end,
          Diagnostics.Neither_decorators_nor_modifiers_may_be_applied_to_this_parameters,
        );
      }
      return this.finishWithJSDoc(result, pos, jsdoc);
    }
    const dotDotDotToken = this.parseOptionalToken(SyntaxKind.DotDotDotToken);
    if (!allowAmbiguity && !this.isParameterNameStart()) return this.noElement;
    const name = this.parseNameOfParameter(modifiers);
    const questionToken = this.parseOptionalToken(SyntaxKind.QuestionToken);
    const type = this.parseTypeAnnotation();
    const initializer = this.parseInitializer();
    return this.finishWithJSDoc(
      new ParameterDeclaration(modifiers, dotDotDotToken, name, questionToken, type, initializer),
      pos,
      jsdoc,
    );
  }

  isParameterNameStart(): boolean {
    // Permissive about await and yield: rejecting them in a speculative parse causes many more
    // follow-on errors than parsing the function and complaining afterwards.
    return (
      this.isBindingIdentifier() ||
      this.token() === SyntaxKind.OpenBracketToken ||
      this.token() === SyntaxKind.OpenBraceToken
    );
  }

  parseNameOfParameter(modifiers: ModifierList | undefined): Node {
    const name = this.parseIdentifierOrPatternWithDiagnostic(
      Diagnostics.Private_identifiers_cannot_be_used_as_parameters,
    );
    if (name.end - name.pos === 0 && modifiers === undefined && isModifierKind(this.token())) {
      // In `function foo(static)`, `static` is a modifier but not a strict-mode identifier: the name
      // is missing and the token didn't change, so advance to avoid looping forever.
      this.nextToken();
    }
    return name;
  }

  parseReturnType(returnToken: SyntaxKind, isType: boolean): TypeNode | undefined {
    if (this.shouldParseReturnType(returnToken, isType)) {
      const saveContextFlags = this.contextFlags;
      this.setContextFlags(NodeFlags.DisallowConditionalTypesContext, false);
      const result = this.parseTypeOrTypePredicate();
      this.contextFlags = saveContextFlags;
      return result;
    }
    return undefined;
  }

  shouldParseReturnType(returnToken: SyntaxKind, isType: boolean): boolean {
    if (returnToken === SyntaxKind.EqualsGreaterThanToken) {
      this.parseExpected(returnToken);
      return true;
    }
    if (this.parseOptional(SyntaxKind.ColonToken)) return true;
    if (isType && this.token() === SyntaxKind.EqualsGreaterThanToken) {
      // `=>` for `:` is an easy mistake in type contexts; parse the type anyway.
      this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(SyntaxKind.ColonToken)]);
      this.nextToken();
      return true;
    }
    return false;
  }

  parseTypeOrTypePredicate(): TypeNode {
    // `x is T`: the identifier is parsed only once `is` is known to follow it.
    if (this.isIdentifier() && this.lookAhead(nextTokenIsIsKeywordOnSameLine)) {
      const pos = this.nodePos();
      const id = this.parseIdentifier(IdentifierUse.Name);
      this.nextToken();
      return this.finishNode(new TypePredicateNode(undefined, id, this.parseType()), pos);
    }
    return this.parseType();
  }

  /** Type members are separated by commas or (possibly ASI) semicolons. */
  parseTypeMemberSemicolon(): boolean {
    return this.parseOptional(SyntaxKind.CommaToken) || this.parseSemicolon();
  }

  parseAccessorDeclaration(
    pos: number,
    jsdoc: JSDocScannerInfo,
    modifiers: ModifierList | undefined,
    kind: SyntaxKind,
    flags: ParseFlags,
  ): Node {
    const name = this.parsePropertyName();
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters(ParseFlags.None);
    const returnType = this.parseReturnType(SyntaxKind.ColonToken, false);
    const body = this.parseFunctionBlockOrSemicolon(flags, undefined);
    // Type parameters (and setter return types) are kept for the grammar checker.
    const result: Node =
      kind === SyntaxKind.GetAccessor
        ? new GetAccessorDeclaration(modifiers, name, typeParameters, parameters, returnType, undefined, body)
        : new SetAccessorDeclaration(modifiers, name, typeParameters, parameters, returnType, undefined, body);
    this.finishWithJSDoc(result, pos, jsdoc);
    if ((flags & ParseFlags.Type) === 0) this.checkJSSyntax(result);
    return result;
  }

  parsePropertyName(use: IdentifierUse = IdentifierUse.Name): Node {
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    const prop = this.parsePropertyNameWorker(true, use);
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return prop;
  }

  parsePropertyNameWorker(allowComputedPropertyNames: boolean, use: IdentifierUse = IdentifierUse.Name): Node {
    const token = this.token();
    if (token === SyntaxKind.StringLiteral || token === SyntaxKind.NumericLiteral || token === SyntaxKind.BigIntLiteral)
      return this.parseLiteralExpression(true);
    if (allowComputedPropertyNames && token === SyntaxKind.OpenBracketToken) return this.parseComputedPropertyName();
    if (token === SyntaxKind.PrivateIdentifier) return this.parsePrivateIdentifier();
    return this.parseIdentifierName(use);
  }

  parseComputedPropertyName(): Node {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.OpenBracketToken);
    // Any expression is parsed, including comma expressions; the grammar checker reports them.
    const expression = this.parseExpressionAllowIn();
    this.parseExpected(SyntaxKind.CloseBracketToken);
    return this.finishNode(new ComputedPropertyName(expression), pos);
  }

  parseFunctionBlockOrSemicolon(
    flags: ParseFlags,
    diagnosticMessage: DiagnosticMessage | undefined,
  ): Block | undefined {
    if (this.token() !== SyntaxKind.OpenBraceToken) {
      if ((flags & ParseFlags.Type) !== 0) {
        this.parseTypeMemberSemicolon();
        return undefined;
      }
      if (this.canParseSemicolon()) {
        this.parseSemicolon();
        return undefined;
      }
    }
    return this.parseFunctionBlock(flags, diagnosticMessage);
  }

  parseFunctionBlock(flags: ParseFlags, diagnosticMessage: DiagnosticMessage | undefined): Block {
    const saveContextFlags = this.contextFlags;
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    this.setContextFlags(NodeFlags.YieldContext, (flags & ParseFlags.Yield) !== 0);
    this.setContextFlags(NodeFlags.AwaitContext, (flags & ParseFlags.Await) !== 0);
    // Function bodies are never in a [Decorator] context.
    this.setContextFlags(NodeFlags.DecoratorContext, false);
    const block = this.parseBlock((flags & ParseFlags.IgnoreMissingOpenBrace) !== 0, diagnosticMessage);
    this.contextFlags = saveContextFlags;
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return block;
  }

  isIndexSignature(): boolean {
    return this.token() === SyntaxKind.OpenBracketToken && this.lookAhead(nextIsUnambiguouslyIndexSignature);
  }

  parseIndexSignatureDeclaration(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Node {
    const parameters = this.parseBracketedList(
      ParsingContext.Parameters,
      ListElement.Parameter,
      SyntaxKind.OpenBracketToken,
      SyntaxKind.CloseBracketToken,
    )!;
    const type = this.parseTypeAnnotation();
    this.parseTypeMemberSemicolon();
    return this.finishWithJSDoc(new IndexSignatureDeclaration(modifiers, parameters, type), pos, jsdoc);
  }

  parsePropertyOrMethodSignature(pos: number, jsdoc: JSDocScannerInfo, modifiers: ModifierList | undefined): Node {
    const name = this.parsePropertyName();
    const questionToken = this.parseOptionalToken(SyntaxKind.QuestionToken);
    let result: Node;
    if (this.token() === SyntaxKind.OpenParenToken || this.token() === SyntaxKind.LessThanToken) {
      // Method signatures don't exist in expression contexts: neither [Yield] nor [Await].
      const typeParameters = this.parseTypeParameters();
      const parameters = this.parseParameters(ParseFlags.Type);
      const returnType = this.parseReturnType(SyntaxKind.ColonToken, true);
      result = new MethodSignatureDeclaration(modifiers, name, questionToken, typeParameters, parameters, returnType);
    } else {
      const type = this.parseTypeAnnotation();
      // Parse an initializer anyway so the checker can report it.
      const initializer = this.token() === SyntaxKind.EqualsToken ? this.parseInitializer() : undefined;
      result = new PropertySignatureDeclaration(modifiers, name, questionToken, type, initializer);
    }
    this.parseTypeMemberSemicolon();
    return this.finishWithJSDoc(result, pos, jsdoc);
  }

  parseTypeLiteral(): TypeNode {
    const pos = this.nodePos();
    return this.finishNode(new TypeLiteralNode(this.parseObjectTypeMembers()), pos);
  }

  parseObjectTypeMembers(): NodeList {
    if (this.parseExpected(SyntaxKind.OpenBraceToken)) {
      const members = this.parseList(ParsingContext.TypeMembers, ListElement.TypeMember);
      this.parseExpected(SyntaxKind.CloseBraceToken);
      return members;
    }
    return this.createMissingList();
  }

  parseTupleType(): TypeNode {
    const pos = this.nodePos();
    return this.finishNode(
      new TupleTypeNode(
        this.parseBracketedList(
          ParsingContext.TupleElementTypes,
          ListElement.TupleElement,
          SyntaxKind.OpenBracketToken,
          SyntaxKind.CloseBracketToken,
        )!,
      ),
      pos,
    );
  }

  parseTupleElementNameOrTupleElementType(): Node {
    if (this.lookAhead(scanStartOfNamedTupleElement)) {
      const pos = this.nodePos();
      const jsdoc = this.jsdocScannerInfo();
      const dotDotDotToken = this.parseOptionalToken(SyntaxKind.DotDotDotToken);
      const name = this.parseIdentifierName(IdentifierUse.Name);
      const questionToken = this.parseOptionalToken(SyntaxKind.QuestionToken);
      this.parseExpected(SyntaxKind.ColonToken);
      const type = this.parseTupleElementType();
      return this.finishWithJSDoc(new NamedTupleMember(dotDotDotToken, name, questionToken, type), pos, jsdoc);
    }
    return this.parseTupleElementType();
  }

  parseTupleElementType(): TypeNode {
    const pos = this.nodePos();
    if (this.parseOptional(SyntaxKind.DotDotDotToken)) return this.finishNode(new RestTypeNode(this.parseType()), pos);
    const type = this.parseType();
    if (type instanceof JSDocNullableType && (type as JSDocNullableType).pos === (type as JSDocNullableType).type.pos) {
      const node = new OptionalTypeNode((type as JSDocNullableType).type);
      node.flags = (type as JSDocNullableType).flags;
      node.pos = (type as JSDocNullableType).pos;
      node.end = (type as JSDocNullableType).end;
      (type as JSDocNullableType).type.parent = node;
      return node;
    }
    return type;
  }

  parseParenthesizedType(): TypeNode {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.OpenParenToken);
    const type = this.parseType();
    this.parseExpected(SyntaxKind.CloseParenToken);
    return this.finishNode(new ParenthesizedTypeNode(type), pos);
  }

  parseAssertsTypePredicate(): TypeNode {
    const pos = this.nodePos();
    const assertsModifier = this.parseExpectedToken(SyntaxKind.AssertsKeyword);
    const parameterName: Node =
      this.token() === SyntaxKind.ThisKeyword ? this.parseThisTypeNode() : this.parseIdentifier(IdentifierUse.Name);
    const type = this.parseOptional(SyntaxKind.IsKeyword) ? this.parseType() : undefined;
    return this.finishNode(new TypePredicateNode(assertsModifier, parameterName, type), pos);
  }

  parseTemplateType(): TypeNode {
    const pos = this.nodePos();
    return this.finishNode(
      new TemplateLiteralTypeNode(this.parseTemplateHead(false), this.parseTemplateTypeSpans()),
      pos,
    );
  }

  parseTemplateHead(isTaggedTemplate: boolean): TemplateHead {
    if (!isTaggedTemplate && (this.scanner.getTokenFlags() & TokenFlags.IsInvalid) !== 0)
      this.reScanTemplateToken(false);
    const pos = this.nodePos();
    const result = new TemplateHead(
      this.scanner.getTokenValue(),
      this.getTemplateLiteralRawText(2),
      this.scanner.getTokenFlags(),
    );
    this.nextToken();
    this.finishNode(result, pos);
    return result;
  }

  getTemplateLiteralRawText(endLength: number): string {
    const tokenText = this.scanner.getTokenText();
    if ((this.scanner.getTokenFlags() & TokenFlags.Unterminated) !== 0) endLength = 0;
    return tokenText.substring(1, tokenText.length - endLength);
  }

  parseTemplateTypeSpans(): NodeList {
    const pos = this.nodePos();
    const list = this.openList();
    for (;;) {
      const span = this.parseTemplateTypeSpan();
      list.push(span);
      if (span.literal.kind !== SyntaxKind.TemplateMiddle) break;
    }
    return this.newNodeList(pos, this.nodePos(), this.closeList(list));
  }

  parseTemplateTypeSpan(): TemplateLiteralTypeSpan {
    const pos = this.nodePos();
    const result = new TemplateLiteralTypeSpan(this.parseType(), this.parseLiteralOfTemplateSpan(false));
    this.finishNode(result, pos);
    return result;
  }

  parseLiteralOfTemplateSpan(isTaggedTemplate: boolean): Node {
    if (this.token() === SyntaxKind.CloseBraceToken) {
      this.reScanTemplateToken(isTaggedTemplate);
      return this.parseTemplateMiddleOrTail();
    }
    this.parseErrorAtCurrentToken(Diagnostics.X_0_expected, [tokenToString(SyntaxKind.CloseBraceToken)]);
    return this.finishNode(new TemplateTail('', '', TokenFlags.None), this.nodePos());
  }

  parseTemplateMiddleOrTail(): Node {
    const pos = this.nodePos();
    const result: Node =
      this.token() === SyntaxKind.TemplateMiddle
        ? new TemplateMiddle(
            this.scanner.getTokenValue(),
            this.getTemplateLiteralRawText(2),
            this.scanner.getTokenFlags(),
          )
        : new TemplateTail(
            this.scanner.getTokenValue(),
            this.getTemplateLiteralRawText(1),
            this.scanner.getTokenFlags(),
          );
    this.nextToken();
    return this.finishNode(result, pos);
  }

  /** Function and constructor types must be parenthesized in unions and intersections; parse them with an error. */
  parseFunctionOrConstructorTypeToError(isInUnionType: boolean): TypeNode {
    if (this.isStartOfFunctionTypeOrConstructorType()) {
      const type = this.parseFunctionOrConstructorType();
      let diagnostic: DiagnosticMessage;
      if (type.kind === SyntaxKind.FunctionType)
        diagnostic = isInUnionType
          ? Diagnostics.Function_type_notation_must_be_parenthesized_when_used_in_a_union_type
          : Diagnostics.Function_type_notation_must_be_parenthesized_when_used_in_an_intersection_type;
      else
        diagnostic = isInUnionType
          ? Diagnostics.Constructor_type_notation_must_be_parenthesized_when_used_in_a_union_type
          : Diagnostics.Constructor_type_notation_must_be_parenthesized_when_used_in_an_intersection_type;
      this.parseErrorAt(type.pos, type.end, diagnostic);
      return type;
    }
    return this.parseConstituentType(isInUnionType);
  }

  isStartOfFunctionTypeOrConstructorType(): boolean {
    const token = this.token();
    return (
      token === SyntaxKind.LessThanToken ||
      (token === SyntaxKind.OpenParenToken && this.lookAhead(nextIsUnambiguouslyStartOfFunctionType)) ||
      token === SyntaxKind.NewKeyword ||
      (token === SyntaxKind.AbstractKeyword && this.lookAhead(nextTokenIsNewKeyword))
    );
  }

  parseFunctionOrConstructorType(): TypeNode {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const modifiers = this.parseModifiersForConstructorType();
    const isConstructorType = this.parseOptional(SyntaxKind.NewKeyword);
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters(ParseFlags.Type);
    const returnType = this.parseReturnType(SyntaxKind.EqualsGreaterThanToken, false);
    const result: Node = isConstructorType
      ? new ConstructorTypeNode(modifiers, typeParameters, parameters, returnType)
      : new FunctionTypeNode(typeParameters, parameters, returnType);
    return this.finishWithJSDoc(result, pos, jsdoc);
  }

  parseModifiersForConstructorType(): ModifierList | undefined {
    if (this.token() === SyntaxKind.AbstractKeyword) {
      const pos = this.nodePos();
      const modifier = new Token(this.token());
      this.nextToken();
      this.finishNode(modifier, pos);
      return this.newModifierList(modifier.pos, modifier.end, [modifier]);
    }
    return undefined;
  }

  /** Skips modifiers and a parameter name or binding pattern; true if that succeeded without errors. */
  skipParameterStart(): boolean {
    if (isModifierKind(this.token())) this.parseModifiers();
    this.parseOptional(SyntaxKind.DotDotDotToken);
    if (this.isIdentifier() || this.token() === SyntaxKind.ThisKeyword) {
      this.nextToken();
      return true;
    }
    if (this.token() === SyntaxKind.OpenBracketToken || this.token() === SyntaxKind.OpenBraceToken) {
      const previousErrorCount = this.diagnostics.length;
      this.parseIdentifierOrPattern();
      return previousErrorCount === this.diagnostics.length;
    }
    return false;
  }

  parseModifiers(): ModifierList | undefined {
    return this.parseModifiersEx(false, false, false);
  }

  parseModifiersEx(
    allowDecorators: boolean,
    permitConstAsModifier: boolean,
    stopOnStartOfClassStaticBlock: boolean,
  ): ModifierList | undefined {
    // Decorators can appear before and after leading modifiers:
    // [...leadingDecorators, ...leadingModifiers, ...trailingDecorators, ...trailingModifiers].
    // The checker reports invalid combinations.
    let hasLeadingModifier = false;
    let hasTrailingDecorator = false;
    let hasTrailingModifier = false;
    let hasStaticModifier = false;
    const pos = this.nodePos();
    const list = this.openList();
    for (;;) {
      if (allowDecorators && this.token() === SyntaxKind.AtToken && !hasTrailingModifier) {
        const decorator = this.parseDecorator();
        list.push(decorator);
        if (hasLeadingModifier) hasTrailingDecorator = true;
      } else {
        const modifier = this.tryParseModifier(hasStaticModifier, permitConstAsModifier, stopOnStartOfClassStaticBlock);
        if (modifier === undefined) break;
        if (modifier.kind === SyntaxKind.StaticKeyword) hasStaticModifier = true;
        list.push(modifier);
        if (hasTrailingDecorator) hasTrailingModifier = true;
        else hasLeadingModifier = true;
      }
    }
    const nodes = this.closeList(list);
    return nodes.length === 0 ? undefined : this.newModifierList(pos, this.nodePos(), nodes);
  }

  parseDecorator(): Node {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.AtToken);
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DecoratorContext, true);
    const expression = this.parseDecoratorExpression();
    this.contextFlags = saveContextFlags;
    return this.finishNode(new Decorator(expression), pos);
  }

  parseDecoratorExpression(): Expression {
    if (this.inAwaitContext() && this.token() === SyntaxKind.AwaitKeyword) {
      // `@await` is disallowed in an [Await] context; parse a missing identifier and move on.
      const pos = this.nodePos();
      const awaitExpression = this.parseIdentifierWithDiagnostic(Diagnostics.Expression_expected, undefined);
      this.nextToken();
      const memberExpression = this.parseMemberExpressionRest(pos, awaitExpression, true);
      return this.parseCallExpressionRest(pos, memberExpression);
    }
    return this.parseLeftHandSideExpressionOrHigher();
  }

  tryParseModifier(
    hasSeenStaticModifier: boolean,
    permitConstAsModifier: boolean,
    stopOnStartOfClassStaticBlock: boolean,
  ): Node | undefined {
    const pos = this.nodePos();
    const kind = this.token();
    if (kind === SyntaxKind.ConstKeyword && permitConstAsModifier) {
      // Following modifiers must be on the same line, so a standalone `const` declaration isn't an error.
      if (!this.lookAhead(nextTokenIsOnSameLineAndCanFollowModifier)) return undefined;
      this.nextToken();
    } else if (
      stopOnStartOfClassStaticBlock &&
      kind === SyntaxKind.StaticKeyword &&
      this.lookAhead(nextTokenIsOpenBrace)
    ) {
      return undefined;
    } else if (hasSeenStaticModifier && kind === SyntaxKind.StaticKeyword) {
      return undefined;
    } else if (!this.parseAnyContextualModifier()) {
      return undefined;
    }
    return this.finishNode(new Token(kind), pos);
  }

  parseContextualModifier(t: SyntaxKind): boolean {
    return this.token() === t && this.tryNextTokenCanFollowModifier();
  }

  parseAnyContextualModifier(): boolean {
    return isModifierKind(this.token()) && this.tryNextTokenCanFollowModifier();
  }

  /** Advances past a modifier if the next token can follow it; otherwise leaves the state unchanged. */
  tryNextTokenCanFollowModifier(): boolean {
    const state = this.beginSpeculation();
    const result = this.nextTokenCanFollowModifier();
    if (!result) this.rewind(state);
    this.endSpeculation(state);
    return result;
  }

  nextTokenCanFollowModifier(): boolean {
    switch (this.token()) {
      case SyntaxKind.ConstKeyword:
        // `const` is only a modifier before `enum`.
        return this.nextToken() === SyntaxKind.EnumKeyword;
      case SyntaxKind.ExportKeyword: {
        const next = this.nextToken();
        if (next === SyntaxKind.DefaultKeyword) return this.lookAhead(nextTokenCanFollowDefaultKeyword);
        if (next === SyntaxKind.TypeKeyword) return this.lookAhead(nextTokenCanFollowExportModifier);
        return this.canFollowExportModifier();
      }
      case SyntaxKind.DefaultKeyword:
        return this.nextTokenCanFollowDefaultKeyword();
      case SyntaxKind.StaticKeyword:
        this.nextToken();
        return this.canFollowModifier();
      case SyntaxKind.GetKeyword:
      case SyntaxKind.SetKeyword:
        this.nextToken();
        return this.canFollowGetOrSetKeyword();
      default:
        return this.nextTokenIsOnSameLineAndCanFollowModifier();
    }
  }

  nextTokenCanFollowDefaultKeyword(): boolean {
    switch (this.nextToken()) {
      case SyntaxKind.ClassKeyword:
      case SyntaxKind.FunctionKeyword:
      case SyntaxKind.InterfaceKeyword:
      case SyntaxKind.AtToken:
        return true;
      case SyntaxKind.AbstractKeyword:
        return this.lookAhead(nextTokenIsClassKeywordOnSameLine);
      case SyntaxKind.AsyncKeyword:
        return this.lookAhead(nextTokenIsFunctionKeywordOnSameLine);
    }
    return false;
  }

  canFollowExportModifier(): boolean {
    const token = this.token();
    return (
      token === SyntaxKind.AtToken ||
      (token !== SyntaxKind.AsteriskToken &&
        token !== SyntaxKind.AsKeyword &&
        token !== SyntaxKind.OpenBraceToken &&
        this.canFollowModifier())
    );
  }

  canFollowModifier(): boolean {
    const token = this.token();
    return (
      token === SyntaxKind.OpenBracketToken ||
      token === SyntaxKind.OpenBraceToken ||
      token === SyntaxKind.AsteriskToken ||
      token === SyntaxKind.DotDotDotToken ||
      this.isLiteralPropertyName()
    );
  }

  canFollowGetOrSetKeyword(): boolean {
    return this.token() === SyntaxKind.OpenBracketToken || this.isLiteralPropertyName();
  }

  nextTokenIsOnSameLineAndCanFollowModifier(): boolean {
    this.nextToken();
    if (this.hasPrecedingLineBreak()) return false;
    return this.canFollowModifier();
  }

  // Expressions

  parseExpression(): Expression {
    // Expression[in]: AssignmentExpression[in] | Expression[in] , AssignmentExpression[in]
    // Expressions are unambiguous inside decorators: clear the decorator context.
    const saveContextFlags = this.contextFlags;
    this.contextFlags &= ~NodeFlags.DecoratorContext;
    const pos = this.nodePos();
    let expr = this.parseAssignmentExpressionOrHigher();
    for (;;) {
      const operatorToken = this.parseOptionalToken(SyntaxKind.CommaToken);
      if (operatorToken === undefined) break;
      expr = this.makeBinaryExpression(expr, operatorToken, this.parseAssignmentExpressionOrHigher(), pos);
    }
    this.contextFlags = saveContextFlags;
    return expr;
  }

  parseExpressionAllowIn(): Expression {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext, false);
    const result = this.parseExpression();
    this.contextFlags = saveContextFlags;
    return result;
  }

  parseAssignmentExpressionOrHigher(): Expression {
    return this.parseAssignmentExpressionOrHigherWorker(true);
  }

  /** `parseAssignmentExpressionOrHigher` with `in` allowed. */
  parseAssignmentExpressionOrHigherAllowIn(): Expression {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext, false);
    const result = this.parseAssignmentExpressionOrHigher();
    this.contextFlags = saveContextFlags;
    return result;
  }

  parseAssignmentExpressionOrHigherWorker(allowReturnTypeInArrowFunction: boolean): Expression {
    //  AssignmentExpression[in,yield]:
    //      1) ConditionalExpression[?in,?yield]
    //      2) LeftHandSideExpression = AssignmentExpression[?in,?yield]
    //      3) LeftHandSideExpression AssignmentOperator AssignmentExpression[?in,?yield]
    //      4) ArrowFunctionExpression[?in,?yield]
    //      5) AsyncArrowFunctionExpression[in,yield,await]
    //      6) [+Yield] YieldExpression[?In]
    // Productions 2 and 3 are both binary expressions with an assignment operator.
    if (this.isYieldExpression()) return this.parseYieldExpression();
    // An arrow function (4, 5) isn't a LeftHandSideExpression and doesn't start a conditional
    // expression, so we're done if we parse one.
    let arrowExpression = this.tryParseParenthesizedArrowFunctionExpression(allowReturnTypeInArrowFunction);
    if (arrowExpression !== undefined) return arrowExpression;
    arrowExpression = this.tryParseAsyncSimpleArrowFunctionExpression(allowReturnTypeInArrowFunction);
    if (arrowExpression !== undefined) return arrowExpression;
    // Productions 1-3: parse any binary expression, then check for an assignment or a conditional.
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const expr = this.parseBinaryExpressionOrHigher(OperatorPrecedence.Lowest);
    // An arrow function with a single unparenthesized parameter, `x => ...`.
    if (expr instanceof Identifier && this.token() === SyntaxKind.EqualsGreaterThanToken)
      return this.parseSimpleArrowFunctionExpression(pos, expr, allowReturnTypeInArrowFunction, jsdoc, undefined);
    // reScanGreaterThanToken merges `> > =` into `>>=`.
    if (isLeftHandSideExpression(expr) && isAssignmentOperator(this.reScanGreaterThanToken()))
      return this.makeBinaryExpression(
        expr,
        this.parseTokenNode(),
        this.parseAssignmentExpressionOrHigherWorker(allowReturnTypeInArrowFunction),
        pos,
      );
    return this.parseConditionalExpressionRest(expr, pos, allowReturnTypeInArrowFunction);
  }

  isYieldExpression(): boolean {
    if (this.token() === SyntaxKind.YieldKeyword) {
      // Always a yield expression in a [Yield] context.
      if (this.inYieldContext()) return true;
      // Elsewhere, `yield foo` can't be a normal expression, so parse a yield expression and report it
      // later; `yield(foo)` is a call.
      return this.lookAhead(nextTokenIsIdentifierOrKeywordOrLiteralOnSameLine);
    }
    return false;
  }

  parseYieldExpression(): Expression {
    const pos = this.nodePos();
    // YieldExpression[In] :
    //      yield
    //      yield [no LineTerminator here] [Lexical goal InputElementRegExp]AssignmentExpression[?In, Yield]
    //      yield [no LineTerminator here] * [Lexical goal InputElementRegExp]AssignmentExpression[?In, Yield]
    this.nextToken();
    let result: Node;
    if (!this.hasPrecedingLineBreak() && (this.token() === SyntaxKind.AsteriskToken || this.isStartOfExpression())) {
      const asteriskToken = this.parseOptionalToken(SyntaxKind.AsteriskToken);
      result = new YieldExpression(asteriskToken, this.parseAssignmentExpressionOrHigher());
    } else {
      // A plain `yield`.
      result = new YieldExpression(undefined, undefined);
    }
    return this.finishNode(result, pos);
  }

  isParenthesizedArrowFunctionExpression(): Tristate {
    const token = this.token();
    if (
      token === SyntaxKind.OpenParenToken ||
      token === SyntaxKind.LessThanToken ||
      token === SyntaxKind.AsyncKeyword
    ) {
      const state = this.mark();
      const result = this.nextIsParenthesizedArrowFunctionExpression();
      this.rewind(state);
      return result;
    }
    // Error recovery: a standalone `=>` is likely an arrow function.
    if (token === SyntaxKind.EqualsGreaterThanToken) return Tristate.True;
    return Tristate.False;
  }

  nextIsParenthesizedArrowFunctionExpression(): Tristate {
    if (this.token() === SyntaxKind.AsyncKeyword) {
      this.nextToken();
      if (this.hasPrecedingLineBreak()) return Tristate.False;
      if (this.token() !== SyntaxKind.OpenParenToken && this.token() !== SyntaxKind.LessThanToken)
        return Tristate.False;
    }
    const first = this.token();
    const second = this.nextToken();
    if (first === SyntaxKind.OpenParenToken) {
      if (second === SyntaxKind.CloseParenToken) {
        // `() =>`, `():` and `() {` (not an arrow function, but probably intended as one).
        switch (this.nextToken()) {
          case SyntaxKind.EqualsGreaterThanToken:
          case SyntaxKind.ColonToken:
          case SyntaxKind.OpenBraceToken:
            return Tristate.True;
        }
        return Tristate.False;
      }
      // `([` and `({` may start binding patterns.
      if (second === SyntaxKind.OpenBracketToken || second === SyntaxKind.OpenBraceToken) return Tristate.Unknown;
      // `(...` is a rest parameter.
      if (second === SyntaxKind.DotDotDotToken) return Tristate.True;
      // `(modifier identifier` isn't allowed, but treat it as an arrow for a good error.
      if (isModifierKind(second) && second !== SyntaxKind.AsyncKeyword && this.lookAhead(nextTokenIsIdentifier)) {
        // https://github.com/microsoft/TypeScript/issues/44466
        if (this.nextToken() === SyntaxKind.AsKeyword) return Tristate.False;
        return Tristate.True;
      }
      // `(` followed by a non-identifier isn't an arrow; `this` is parsed and reported later.
      if (!this.isIdentifier() && second !== SyntaxKind.ThisKeyword) return Tristate.False;
      switch (this.nextToken()) {
        case SyntaxKind.ColonToken:
          // `(a:` is a type-annotated parameter.
          return Tristate.True;
        case SyntaxKind.QuestionToken: {
          // `(a?:`, `(a?,`, `(a?=` and `(a?)` are parameters; anything else isn't.
          const next = this.nextToken();
          if (
            next === SyntaxKind.ColonToken ||
            next === SyntaxKind.CommaToken ||
            next === SyntaxKind.EqualsToken ||
            next === SyntaxKind.CloseParenToken
          )
            return Tristate.True;
          return Tristate.False;
        }
        case SyntaxKind.CommaToken:
        case SyntaxKind.EqualsToken:
        case SyntaxKind.CloseParenToken:
          // `(a,`, `(a=` and `(a)` could be arrow functions.
          return Tristate.Unknown;
      }
      return Tristate.False;
    }
    // `<` not followed by an identifier isn't an arrow function.
    if (!this.isIdentifier() && this.token() !== SyntaxKind.ConstKeyword) return Tristate.False;
    if (this.languageVariant === LanguageVariant.JSX)
      return this.lookAhead(isArrowFunctionInJsx) ? Tristate.True : Tristate.False;
    return Tristate.Unknown;
  }

  tryParseParenthesizedArrowFunctionExpression(allowReturnTypeInArrowFunction: boolean): Expression | undefined {
    const tristate = this.isParenthesizedArrowFunctionExpression();
    if (tristate === Tristate.False) return undefined;
    // A definite arrow function doesn't need a following `=>` or `{`. Otherwise parse without
    // ambiguity, returning undefined if this could be an expression.
    if (tristate === Tristate.True) return this.parseParenthesizedArrowFunctionExpression(true, true);
    const state = this.mark();
    const result = this.parsePossibleParenthesizedArrowFunctionExpression(allowReturnTypeInArrowFunction);
    if (result === undefined) this.rewind(state);
    return result;
  }

  parseParenthesizedArrowFunctionExpression(
    allowAmbiguity: boolean,
    allowReturnTypeInArrowFunction: boolean,
  ): Expression | undefined {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const modifiers = this.parseModifiersForArrowFunction();
    const isAsync = modifiers !== undefined && hasModifierOfKind(modifiers, SyntaxKind.AsyncKeyword);
    const signatureFlags = isAsync ? ParseFlags.Await : ParseFlags.None;
    // Arrow functions are never generators. A speculative parse needs a complete parameter list,
    // so `a => (b => c)` isn't read as `(b =>` with a missing close paren.
    const typeParameters = this.parseTypeParameters();
    let parameters: NodeList;
    if (!this.parseExpected(SyntaxKind.OpenParenToken)) {
      if (!allowAmbiguity) return undefined;
      parameters = this.createMissingList();
    } else {
      const maybeParameters = this.parseParametersWorker(signatureFlags, allowAmbiguity);
      if (maybeParameters === undefined) return undefined;
      parameters = maybeParameters;
      if (!this.parseExpected(SyntaxKind.CloseParenToken) && !allowAmbiguity) return undefined;
    }
    const hasReturnColon = this.token() === SyntaxKind.ColonToken;
    const returnType = this.parseReturnType(SyntaxKind.ColonToken, false);
    if (returnType !== undefined && !allowAmbiguity && typeHasArrowFunctionBlockingParseError(returnType))
      return undefined;
    // A signature alone isn't enough: `(x = 10)`, `(x,y)` and `a ? (b): c` parse as signatures.
    if (
      !allowAmbiguity &&
      this.token() !== SyntaxKind.EqualsGreaterThanToken &&
      this.token() !== SyntaxKind.OpenBraceToken
    )
      return undefined;
    // Parse the body after `=>`, or after `{` for error recovery.
    const lastToken = this.token();
    const equalsGreaterThanToken = this.parseExpectedToken(SyntaxKind.EqualsGreaterThanToken);
    const body =
      lastToken === SyntaxKind.EqualsGreaterThanToken || lastToken === SyntaxKind.OpenBraceToken
        ? this.parseArrowFunctionExpressionBody(isAsync, allowReturnTypeInArrowFunction)
        : this.parseIdentifier();
    // In the true branch of a conditional, as in `x ? y => ({ y }) : z => ({ z })`, a colon ends the
    // expression, so don't allow a return type unless the parameters were unambiguous. But accept it
    // when another colon follows, as in `a ? (x): string => x : null`.
    if (!allowReturnTypeInArrowFunction && hasReturnColon && this.token() !== SyntaxKind.ColonToken) return undefined;
    const result = this.finishWithJSDoc(
      new ArrowFunction(modifiers, typeParameters, parameters, returnType, undefined, equalsGreaterThanToken, body),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseModifiersForArrowFunction(): ModifierList | undefined {
    if (this.token() === SyntaxKind.AsyncKeyword) {
      const pos = this.nodePos();
      this.nextToken();
      const modifier = this.finishNode(new Token(SyntaxKind.AsyncKeyword), pos);
      return this.newModifierList(modifier.pos, modifier.end, [modifier]);
    }
    return undefined;
  }

  parseArrowFunctionExpressionBody(isAsync: boolean, allowReturnTypeInArrowFunction: boolean): Node {
    if (this.token() === SyntaxKind.OpenBraceToken)
      return this.parseFunctionBlock(isAsync ? ParseFlags.Await : ParseFlags.None, undefined);
    if (
      this.token() !== SyntaxKind.SemicolonToken &&
      this.token() !== SyntaxKind.FunctionKeyword &&
      this.token() !== SyntaxKind.ClassKeyword &&
      this.isStartOfStatement() &&
      !this.isStartOfExpressionStatement()
    ) {
      // A plain statement, as in `a => let v = 0; }`: the user probably forgot the open brace.
      // Recover with a block, or the next `}` would close the enclosing construct.
      return this.parseFunctionBlock(
        ParseFlags.IgnoreMissingOpenBrace | (isAsync ? ParseFlags.Await : ParseFlags.None),
        undefined,
      );
    }
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.AwaitContext, isAsync);
    this.setContextFlags(NodeFlags.YieldContext, false);
    const node = this.parseAssignmentExpressionOrHigherWorker(allowReturnTypeInArrowFunction);
    this.contextFlags = saveContextFlags;
    return node;
  }

  isStartOfExpressionStatement(): boolean {
    // `{`, `function` and `class` can't start an expression statement.
    const token = this.token();
    return (
      token !== SyntaxKind.OpenBraceToken &&
      token !== SyntaxKind.FunctionKeyword &&
      token !== SyntaxKind.ClassKeyword &&
      token !== SyntaxKind.AtToken &&
      this.isStartOfExpression()
    );
  }

  parsePossibleParenthesizedArrowFunctionExpression(allowReturnTypeInArrowFunction: boolean): Expression | undefined {
    const tokenPos = this.scanner.getTokenStart();
    if (this.notParenthesizedArrow.has(tokenPos)) return undefined;
    const result = this.parseParenthesizedArrowFunctionExpression(false, allowReturnTypeInArrowFunction);
    if (result === undefined) this.notParenthesizedArrow.add(tokenPos);
    return result;
  }

  tryParseAsyncSimpleArrowFunctionExpression(allowReturnTypeInArrowFunction: boolean): Expression | undefined {
    // Checked first to avoid an unnecessary lookahead.
    if (this.token() === SyntaxKind.AsyncKeyword && this.lookAhead(nextIsUnParenthesizedAsyncArrowFunction)) {
      const pos = this.nodePos();
      const jsdoc = this.jsdocScannerInfo();
      const asyncModifier = this.parseModifiersForArrowFunction();
      const expr = this.parseBinaryExpressionOrHigher(OperatorPrecedence.Lowest);
      return this.parseSimpleArrowFunctionExpression(pos, expr, allowReturnTypeInArrowFunction, jsdoc, asyncModifier);
    }
    return undefined;
  }

  parseSimpleArrowFunctionExpression(
    pos: number,
    identifier: Node,
    allowReturnTypeInArrowFunction: boolean,
    jsdoc: JSDocScannerInfo,
    asyncModifier: ModifierList | undefined,
  ): Expression {
    const parameter = this.finishNode(
      new ParameterDeclaration(undefined, undefined, identifier, undefined, undefined, undefined),
      identifier.pos,
    );
    const parameters = this.newNodeList(parameter.pos, parameter.end, [parameter]);
    const equalsGreaterThanToken = this.parseExpectedToken(SyntaxKind.EqualsGreaterThanToken);
    const body = this.parseArrowFunctionExpressionBody(asyncModifier !== undefined, allowReturnTypeInArrowFunction);
    return this.finishWithJSDoc(
      new ArrowFunction(asyncModifier, undefined, parameters, undefined, undefined, equalsGreaterThanToken, body),
      pos,
      jsdoc,
    );
  }

  parseConditionalExpressionRest(
    leftOperand: Expression,
    pos: number,
    allowReturnTypeInArrowFunction: boolean,
  ): Expression {
    const questionToken = this.parseOptionalToken(SyntaxKind.QuestionToken);
    if (questionToken === undefined) return leftOperand;
    // `in` is allowed in the true branch but not the false one.
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext, false);
    const trueExpression = this.parseAssignmentExpressionOrHigherWorker(false);
    this.contextFlags = saveContextFlags;
    const colonToken = this.parseExpectedToken(SyntaxKind.ColonToken);
    const falseExpression = nodeIsPresent(colonToken)
      ? this.parseAssignmentExpressionOrHigherWorker(allowReturnTypeInArrowFunction)
      : this.createMissingIdentifier();
    return this.finishNode(
      new ConditionalExpression(leftOperand, questionToken, trueExpression, colonToken, falseExpression),
      pos,
    );
  }

  parseBinaryExpressionOrHigher(precedence: OperatorPrecedence): Expression {
    const pos = this.nodePos();
    const leftOperand = this.parseUnaryExpressionOrHigher();
    return this.parseBinaryExpressionRest(precedence, leftOperand, pos);
  }

  parseBinaryExpressionRest(precedence: OperatorPrecedence, leftOperand: Expression, pos: number): Expression {
    let lastOperand = leftOperand;
    for (;;) {
      // reScanGreaterThanToken merges `>` and `=` into `>=`.
      const operator = this.reScanGreaterThanToken();
      const newPrecedence = getBinaryOperatorPrecedence(operator);
      // Take a left-associative operator when its precedence is higher than the current one (so
      // `a - b - c` returns `b` as the right operand of the first `-`), and `**` (right
      // associative) when it is at least as high.
      const consumeCurrentOperator =
        operator === SyntaxKind.AsteriskAsteriskToken ? newPrecedence >= precedence : newPrecedence > precedence;
      if (!consumeCurrentOperator) break;
      if (operator === SyntaxKind.InKeyword && this.inDisallowInContext()) break;
      if (operator === SyntaxKind.AsKeyword || operator === SyntaxKind.SatisfiesKeyword) {
        // ASI applies before `as`: `var x = foo \n as (Bar)` is a declaration and a call to `as`.
        if (this.hasPrecedingLineBreak()) break;
        this.nextToken();
        // In `a ## b as T`, stop at a following operator with a higher precedence than `##`: the
        // `as` couldn't be erased without changing the meaning (TypeScript#63527).
        const lastPrecedence =
          lastOperand instanceof BinaryExpression
            ? getBinaryOperatorPrecedence((lastOperand as BinaryExpression).operatorToken.kind)
            : OperatorPrecedence.Highest;
        leftOperand =
          operator === SyntaxKind.SatisfiesKeyword
            ? this.makeSatisfiesExpression(leftOperand, this.parseType())
            : this.makeAsExpression(leftOperand, this.parseType());
        if (getBinaryOperatorPrecedence(this.reScanGreaterThanToken()) > lastPrecedence) break;
      } else {
        leftOperand = this.makeBinaryExpression(
          leftOperand,
          this.parseTokenNode(),
          this.parseBinaryExpressionOrHigher(newPrecedence),
          pos,
        );
        lastOperand = leftOperand;
      }
    }
    return leftOperand;
  }

  makeSatisfiesExpression(expression: Expression, type: TypeNode): Expression {
    return this.checkJSSyntax(this.finishNode(new SatisfiesExpression(expression, type), expression.pos));
  }

  makeAsExpression(left: Expression, right: TypeNode): Expression {
    return this.checkJSSyntax(this.finishNode(new AsExpression(left, right), left.pos));
  }

  makeBinaryExpression(left: Expression, operatorToken: Token, right: Expression, pos: number): Expression {
    return this.finishNode(new BinaryExpression(undefined, left, undefined, operatorToken, right), pos);
  }

  parseUnaryExpressionOrHigher(): Expression {
    // ES7 UpdateExpression: LeftHandSideExpression, with postfix `++`/`--`, or prefix `++`/`--` UnaryExpression.
    if (this.isUpdateExpression()) {
      const pos = this.nodePos();
      const updateExpression = this.parseUpdateExpression();
      if (this.token() === SyntaxKind.AsteriskAsteriskToken)
        return this.parseBinaryExpressionRest(getBinaryOperatorPrecedence(this.token()), updateExpression, pos);
      return updateExpression;
    }
    // ES7 UnaryExpression: UpdateExpression, or delete/void/typeof/+/-/~/! UpdateExpression.
    const unaryOperator = this.token();
    const simpleUnaryExpression = this.parseSimpleUnaryExpression();
    if (this.token() === SyntaxKind.AsteriskAsteriskToken) {
      const pos = skipTrivia(this.sourceText, simpleUnaryExpression.pos);
      const end = simpleUnaryExpression.end;
      if (simpleUnaryExpression.kind === SyntaxKind.TypeAssertionExpression)
        this.parseErrorAt(
          pos,
          end,
          Diagnostics.A_type_assertion_expression_is_not_allowed_in_the_left_hand_side_of_an_exponentiation_expression_Consider_enclosing_the_expression_in_parentheses,
        );
      else
        this.parseErrorAt(
          pos,
          end,
          Diagnostics.An_unary_expression_with_the_0_operator_is_not_allowed_in_the_left_hand_side_of_an_exponentiation_expression_Consider_enclosing_the_expression_in_parentheses,
          [tokenToString(unaryOperator)],
        );
    }
    return simpleUnaryExpression;
  }

  isUpdateExpression(): boolean {
    switch (this.token()) {
      case SyntaxKind.PlusToken:
      case SyntaxKind.MinusToken:
      case SyntaxKind.TildeToken:
      case SyntaxKind.ExclamationToken:
      case SyntaxKind.DeleteKeyword:
      case SyntaxKind.TypeOfKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.AwaitKeyword:
        return false;
      case SyntaxKind.LessThanToken:
        return this.languageVariant === LanguageVariant.JSX;
    }
    return true;
  }

  parseUpdateExpression(): Expression {
    const pos = this.nodePos();
    if (this.token() === SyntaxKind.PlusPlusToken || this.token() === SyntaxKind.MinusMinusToken) {
      const operator = this.token();
      this.nextToken();
      return this.finishNode(new PrefixUnaryExpression(operator, this.parseLeftHandSideExpressionOrHigher()), pos);
    }
    if (
      this.languageVariant === LanguageVariant.JSX &&
      this.token() === SyntaxKind.LessThanToken &&
      this.lookAhead(nextTokenIsIdentifierOrKeywordOrGreaterThan)
    ) {
      // JSX elements are primary expressions.
      return this.parseJsxElementOrSelfClosingElementOrFragment(true, -1, undefined, false);
    }
    const expression = this.parseLeftHandSideExpressionOrHigher();
    if (
      (this.token() === SyntaxKind.PlusPlusToken || this.token() === SyntaxKind.MinusMinusToken) &&
      !this.hasPrecedingLineBreak()
    ) {
      const operator = this.token();
      this.nextToken();
      return this.finishNode(new PostfixUnaryExpression(expression, operator), pos);
    }
    return expression;
  }

  // JSX

  parseJsxElementOrSelfClosingElementOrFragment(
    inExpressionContext: boolean,
    topInvalidNodePosition: number,
    openingTag: Node | undefined,
    mustBeUnary: boolean,
  ): Expression {
    const pos = this.nodePos();
    const opening = this.parseJsxOpeningOrSelfClosingElementOrOpeningFragment(inExpressionContext);
    let result: Node;
    if (opening instanceof JsxOpeningElement) {
      let children = this.parseJsxChildren(opening);
      let closingElement: JsxClosingElement;
      const lastChild = children.nodes.length > 0 ? children.nodes[children.nodes.length - 1]! : undefined;
      if (
        lastChild instanceof JsxElement &&
        !tagNamesAreEquivalent(
          (lastChild as JsxElement).openingElement.tagName,
          (lastChild as JsxElement).closingElement.tagName,
        ) &&
        tagNamesAreEquivalent((opening as JsxOpeningElement).tagName, (lastChild as JsxElement).closingElement.tagName)
      ) {
        // An unclosed opening element took its parent's closing element: restructure
        // (<div>(...<span>...</div>)) into (<div>(...<span>...</>)</div>). The parent reports it.
        const end = (lastChild as JsxElement).children.end;
        const missingIdentifier = this.finishNodeWithEnd(this.newIdentifier(''), end, end);
        const newClosingElement = new JsxClosingElement(missingIdentifier);
        this.finishNodeWithEnd(newClosingElement, end, end);
        const newLast = new JsxElement(
          (lastChild as JsxElement).openingElement,
          (lastChild as JsxElement).children,
          newClosingElement,
        );
        this.finishNodeWithEnd(newLast, (lastChild as JsxElement).openingElement.pos, end);
        // Reset parents from the discarded parse.
        (lastChild as JsxElement).openingElement.parent = newLast;
        for (const c of (lastChild as JsxElement).children.nodes) c.parent = newLast;
        newClosingElement.parent = newLast;
        const nodes = children.nodes.slice(0, children.nodes.length - 1);
        nodes.push(newLast);
        children = this.newNodeList(children.pos, newLast.end, nodes);
        closingElement = (lastChild as JsxElement).closingElement;
      } else {
        closingElement = this.parseJsxClosingElement(opening, inExpressionContext);
        if (!tagNamesAreEquivalent((opening as JsxOpeningElement).tagName, closingElement.tagName)) {
          if (
            openingTag instanceof JsxOpeningElement &&
            tagNamesAreEquivalent(closingElement.tagName, (openingTag as JsxOpeningElement).tagName)
          ) {
            // The opening matched its parent's closing: report it on the opening.
            const tagName = (opening as JsxOpeningElement).tagName;
            this.parseErrorAt(tagName.pos, tagName.end, Diagnostics.JSX_element_0_has_no_corresponding_closing_tag, [
              getTextOfNodeFromSourceText(this.sourceText, tagName),
            ]);
          } else {
            // Other mismatches are reported on the closing.
            const tagName = closingElement.tagName;
            this.parseErrorAt(tagName.pos, tagName.end, Diagnostics.Expected_corresponding_JSX_closing_tag_for_0, [
              getTextOfNodeFromSourceText(this.sourceText, (opening as JsxOpeningElement).tagName),
            ]);
          }
        }
      }
      result = this.finishNode(new JsxElement(opening, children, closingElement), pos);
      // Reset the parent from a possibly discarded parse.
      closingElement.parent = result;
    } else if (opening instanceof JsxOpeningFragment) {
      const children = this.parseJsxChildren(opening);
      result = this.finishNode(
        new JsxFragment(opening, children, this.parseJsxClosingFragment(inExpressionContext)),
        pos,
      );
    } else if (opening.kind === SyntaxKind.JsxSelfClosingElement) {
      result = opening;
    } else {
      throw new Error('Unhandled case in parseJsxElementOrSelfClosingElementOrFragment');
    }
    // For `<div></div><div></div>` in an expression context, parse the second element speculatively
    // and wrap both in a synthetic binary expression, for a better error and less formatter damage.
    // Not in a unary context: the binary expression isn't a valid UnaryExpression.
    if (!mustBeUnary && inExpressionContext && this.token() === SyntaxKind.LessThanToken) {
      const topBadPos = topInvalidNodePosition < 0 ? result.pos : topInvalidNodePosition;
      const invalidElement = this.parseJsxElementOrSelfClosingElementOrFragment(true, topBadPos, undefined, false);
      const operatorToken = new Token(SyntaxKind.CommaToken);
      operatorToken.pos = invalidElement.pos;
      operatorToken.end = invalidElement.pos;
      this.parseErrorAt(
        skipTrivia(this.sourceText, topBadPos),
        invalidElement.end,
        Diagnostics.JSX_expressions_must_have_one_parent_element,
      );
      result = this.finishNode(new BinaryExpression(undefined, result, undefined, operatorToken, invalidElement), pos);
    }
    return result;
  }

  parseJsxChildren(openingTag: Node): NodeList {
    const pos = this.nodePos();
    const saveParsingContexts = this.parsingContexts;
    this.parsingContexts |= 1 << ParsingContext.JsxChildren;
    const list = this.openList();
    for (;;) {
      // Like tsgo, this leaves the parser's current token unchanged.
      const currentToken = this.scanner.reScanJsxToken(true);
      const child = this.parseJsxChild(openingTag, currentToken);
      if (child === undefined) break;
      list.push(child);
      // Stop after a mismatched child like <div>...(<span></div>) to reattach the </div> higher up.
      if (
        openingTag instanceof JsxOpeningElement &&
        child instanceof JsxElement &&
        !tagNamesAreEquivalent(
          (child as JsxElement).openingElement.tagName,
          (child as JsxElement).closingElement.tagName,
        ) &&
        tagNamesAreEquivalent((openingTag as JsxOpeningElement).tagName, (child as JsxElement).closingElement.tagName)
      )
        break;
    }
    this.parsingContexts = saveParsingContexts;
    return this.newNodeList(pos, this.nodePos(), this.closeList(list));
  }

  parseJsxChild(openingTag: Node, token: SyntaxKind): Expression | undefined {
    switch (token) {
      case SyntaxKind.EndOfFile:
        // Report at the tag without a closing element rather than at the end of the file.
        if (openingTag instanceof JsxOpeningFragment) {
          this.parseErrorAt(
            (openingTag as JsxOpeningFragment).pos,
            (openingTag as JsxOpeningFragment).end,
            Diagnostics.JSX_fragment_has_no_corresponding_closing_tag,
          );
        } else if (openingTag instanceof JsxOpeningElement) {
          // Only cover `Foo.Bar` in `< Foo.Bar >`.
          const tag = (openingTag as JsxOpeningElement).tagName;
          const start = Math.min(skipTrivia(this.sourceText, tag.pos), tag.end);
          this.parseErrorAt(start, tag.end, Diagnostics.JSX_element_0_has_no_corresponding_closing_tag, [
            getTextOfNodeFromSourceText(this.sourceText, tag),
          ]);
        }
        return undefined;
      case SyntaxKind.LessThanSlashToken:
      case SyntaxKind.ConflictMarkerTrivia:
        return undefined;
      case SyntaxKind.JsxText:
      case SyntaxKind.JsxTextAllWhiteSpaces:
        return this.parseJsxText();
      case SyntaxKind.OpenBraceToken:
        return this.parseJsxExpression(false);
      case SyntaxKind.LessThanToken:
        return this.parseJsxElementOrSelfClosingElementOrFragment(false, -1, openingTag, false);
    }
    throw new Error('Unhandled case in parseJsxChild');
  }

  parseJsxText(): Node {
    const pos = this.nodePos();
    const result = new JsxText(this.scanner.getTokenValue(), this.token() === SyntaxKind.JsxTextAllWhiteSpaces);
    this.scanJsxText();
    return this.finishNode(result, pos);
  }

  parseJsxExpression(inExpressionContext: boolean): Node | undefined {
    const pos = this.nodePos();
    if (!this.parseExpected(SyntaxKind.OpenBraceToken)) return undefined;
    let dotDotDotToken: Token | undefined;
    let expression: Expression | undefined;
    if (this.token() !== SyntaxKind.CloseBraceToken) {
      if (!inExpressionContext) dotDotDotToken = this.parseOptionalToken(SyntaxKind.DotDotDotToken);
      // Only an AssignmentExpression is valid, but a comma sequence parses unambiguously and gets a
      // better error from the grammar checker.
      expression = this.parseExpression();
    }
    if (inExpressionContext) this.parseExpected(SyntaxKind.CloseBraceToken);
    else if (this.parseExpectedWithoutAdvancing(SyntaxKind.CloseBraceToken)) this.scanJsxText();
    return this.finishNode(new JsxExpression(dotDotDotToken, expression), pos);
  }

  scanJsxText(): SyntaxKind {
    this.currentToken = this.scanner.scanJsxToken();
    return this.currentToken;
  }

  scanJsxIdentifier(): SyntaxKind {
    this.currentToken = this.scanner.scanJsxIdentifier();
    return this.currentToken;
  }

  scanJsxAttributeValue(): SyntaxKind {
    this.currentToken = this.scanner.scanJsxAttributeValue();
    return this.currentToken;
  }

  parseJsxClosingElement(open: JsxOpeningElement, inExpressionContext: boolean): JsxClosingElement {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.LessThanSlashToken);
    const tagName = this.parseJsxElementName();
    if (this.parseExpectedWithDiagnostic(SyntaxKind.GreaterThanToken, undefined, false)) {
      // Advance manually to scan JSX text inside JSX.
      if (inExpressionContext || !tagNamesAreEquivalent(open.tagName, tagName)) this.nextToken();
      else this.scanJsxText();
    }
    const result = new JsxClosingElement(tagName);
    this.finishNode(result, pos);
    return result;
  }

  parseJsxOpeningOrSelfClosingElementOrOpeningFragment(inExpressionContext: boolean): Node {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.LessThanToken);
    if (this.token() === SyntaxKind.GreaterThanToken) {
      // See below for why scanJsxText.
      this.scanJsxText();
      return this.finishNode(new JsxOpeningFragment(), pos);
    }
    const tagName = this.parseJsxElementName();
    const typeArguments = (this.contextFlags & NodeFlags.JavaScriptFile) === 0 ? this.parseTypeArguments() : undefined;
    const attributes = this.parseJsxAttributes();
    let result: Node;
    if (this.token() === SyntaxKind.GreaterThanToken) {
      // Scan the text after the tag as JSX text, so characters like '#' aren't scanning errors.
      this.scanJsxText();
      result = new JsxOpeningElement(tagName, typeArguments, attributes);
    } else {
      this.parseExpected(SyntaxKind.SlashToken);
      if (this.parseExpectedWithoutAdvancing(SyntaxKind.GreaterThanToken)) {
        if (inExpressionContext) this.nextToken();
        else this.scanJsxText();
      }
      result = new JsxSelfClosingElement(tagName, typeArguments, attributes);
    }
    return this.finishNode(result, pos);
  }

  parseJsxElementName(): Expression {
    const pos = this.nodePos();
    // A property access or a primary expression: an identifier or `this`. Not
    // parseLeftHandSideExpressionOrHigher, which would treat `class`, `function`, … as keywords.
    const initialExpression = this.parseJsxTagName();
    // `a:b.c` is invalid: let parseAttribute report the unexpected `:` instead.
    if (initialExpression instanceof JsxNamespacedName) return initialExpression;
    let expression = initialExpression;
    while (this.parseOptional(SyntaxKind.DotToken))
      expression = this.finishNode(
        new PropertyAccessExpression(
          expression,
          undefined,
          this.parseRightSideOfDot(true, false, false),
          NodeFlags.None,
        ),
        pos,
      );
    return expression;
  }

  parseJsxTagName(): Expression {
    const pos = this.nodePos();
    this.scanJsxIdentifier();
    const isThis = this.token() === SyntaxKind.ThisKeyword;
    const tagName = this.parseIdentifierNameErrorOnUnicodeEscapeSequence();
    if (this.parseOptional(SyntaxKind.ColonToken)) {
      this.scanJsxIdentifier();
      return this.finishNode(
        new JsxNamespacedName(tagName, this.parseIdentifierNameErrorOnUnicodeEscapeSequence()),
        pos,
      );
    }
    if (isThis) return this.finishNode(new KeywordExpression(SyntaxKind.ThisKeyword), pos);
    return tagName;
  }

  parseJsxAttributes(): JsxAttributes {
    const pos = this.nodePos();
    const result = new JsxAttributes(this.parseList(ParsingContext.JsxAttributes, ListElement.JsxAttribute));
    this.finishNode(result, pos);
    return result;
  }

  parseJsxAttribute(): Node {
    if (this.token() === SyntaxKind.OpenBraceToken) return this.parseJsxSpreadAttribute();
    const pos = this.nodePos();
    const name = this.parseJsxAttributeName();
    return this.finishNode(new JsxAttribute(name, this.parseJsxAttributeValue()), pos);
  }

  parseJsxSpreadAttribute(): Node {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.OpenBraceToken);
    this.parseExpected(SyntaxKind.DotDotDotToken);
    const expression = this.parseExpression();
    this.parseExpected(SyntaxKind.CloseBraceToken);
    return this.finishNode(new JsxSpreadAttribute(expression), pos);
  }

  parseJsxAttributeName(): Node {
    const pos = this.nodePos();
    this.scanJsxIdentifier();
    const attrName = this.parseIdentifierNameErrorOnUnicodeEscapeSequence(IdentifierUse.Name);
    if (this.parseOptional(SyntaxKind.ColonToken)) {
      this.scanJsxIdentifier();
      return this.finishNode(
        new JsxNamespacedName(attrName, this.parseIdentifierNameErrorOnUnicodeEscapeSequence(IdentifierUse.Name)),
        pos,
      );
    }
    return attrName;
  }

  parseJsxAttributeValue(): Expression | undefined {
    if (this.token() === SyntaxKind.EqualsToken) {
      if (this.scanJsxAttributeValue() === SyntaxKind.StringLiteral) return this.parseLiteralExpression(false);
      if (this.token() === SyntaxKind.OpenBraceToken) return this.parseJsxExpression(true);
      // An attribute value is a single element: sibling-element recovery must not wrap it in a binary expression.
      if (this.token() === SyntaxKind.LessThanToken)
        return this.parseJsxElementOrSelfClosingElementOrFragment(true, -1, undefined, true);
      this.parseErrorAtCurrentToken(Diagnostics.X_or_JSX_element_expected);
    }
    return undefined;
  }

  parseJsxClosingFragment(inExpressionContext: boolean): JsxClosingFragment {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.LessThanSlashToken);
    if (
      this.parseExpectedWithDiagnostic(
        SyntaxKind.GreaterThanToken,
        Diagnostics.Expected_corresponding_closing_tag_for_JSX_fragment,
        false,
      )
    ) {
      // Advance manually to scan JSX text inside JSX.
      if (inExpressionContext) this.nextToken();
      else this.scanJsxText();
    }
    const result = new JsxClosingFragment();
    this.finishNode(result, pos);
    return result;
  }

  // Unary and primary expressions

  parseSimpleUnaryExpression(): Expression {
    switch (this.token()) {
      case SyntaxKind.PlusToken:
      case SyntaxKind.MinusToken:
      case SyntaxKind.TildeToken:
      case SyntaxKind.ExclamationToken:
        return this.parsePrefixUnaryExpression();
      case SyntaxKind.DeleteKeyword:
        return this.parseDeleteExpression();
      case SyntaxKind.TypeOfKeyword:
        return this.parseTypeOfExpression();
      case SyntaxKind.VoidKeyword:
        return this.parseVoidExpression();
      case SyntaxKind.LessThanToken:
        // As in parseUpdateExpression, `+ <foo> bar` in JSX is an element, not a type assertion.
        if (this.languageVariant === LanguageVariant.JSX)
          return this.parseJsxElementOrSelfClosingElementOrFragment(true, -1, undefined, true);
        // UnaryExpression (modified): < type > UnaryExpression
        return this.parseTypeAssertion();
      case SyntaxKind.AwaitKeyword:
        if (this.isAwaitExpression()) return this.parseAwaitExpression();
        return this.parseUpdateExpression();
      default:
        return this.parseUpdateExpression();
    }
  }

  parsePrefixUnaryExpression(): Expression {
    const pos = this.nodePos();
    const operator = this.token();
    this.nextToken();
    return this.finishNode(new PrefixUnaryExpression(operator, this.parseSimpleUnaryExpression()), pos);
  }

  parseDeleteExpression(): Expression {
    const pos = this.nodePos();
    this.nextToken();
    return this.finishNode(new DeleteExpression(this.parseSimpleUnaryExpression()), pos);
  }

  parseTypeOfExpression(): Expression {
    const pos = this.nodePos();
    this.nextToken();
    return this.finishNode(new TypeOfExpression(this.parseSimpleUnaryExpression()), pos);
  }

  parseVoidExpression(): Expression {
    const pos = this.nodePos();
    this.nextToken();
    return this.finishNode(new VoidExpression(this.parseSimpleUnaryExpression()), pos);
  }

  isAwaitExpression(): boolean {
    if (this.token() === SyntaxKind.AwaitKeyword) {
      if (this.inAwaitContext()) return true;
      // The same heuristic as isYieldExpression.
      return this.lookAhead(nextTokenIsIdentifierOrKeywordOrLiteralOnSameLine);
    }
    return false;
  }

  parseAwaitExpression(): Expression {
    const pos = this.nodePos();
    this.nextToken();
    return this.finishNode(new AwaitExpression(this.parseSimpleUnaryExpression()), pos);
  }

  parseTypeAssertion(): Expression {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.LessThanToken);
    const type = this.parseType();
    this.parseExpected(SyntaxKind.GreaterThanToken);
    const expression = this.parseSimpleUnaryExpression();
    return this.finishNode(new TypeAssertion(type, expression), pos);
  }

  parseLeftHandSideExpressionOrHigher(): Expression {
    // LeftHandSideExpression is simplified to MemberExpression or CallExpression (NewExpression is
    // folded into MemberExpression, see parseMemberExpressionOrHigher). The recursion bottoms out at
    // `super`, at `import` (import calls and `import.meta`), or at a member expression.
    const pos = this.nodePos();
    let expression: Expression;
    if (this.token() === SyntaxKind.ImportKeyword) {
      if (this.lookAhead(nextTokenIsOpenParenOrLessThan)) {
        // Only an import call if `(` follows, so `import * as foo1 from "module` after an unterminated
        // string stays a statement.
        this.sourceFlags |= NodeFlags.PossiblyContainsDynamicImport;
        expression = this.parseKeywordExpression();
      } else if (this.lookAhead(nextTokenIsDot)) {
        // An `import.*` meta property, such as `import.meta`.
        this.nextToken();
        this.nextToken();
        const name = this.parseIdentifierName(IdentifierUse.Name);
        expression = this.finishNode(new MetaProperty(SyntaxKind.ImportKeyword, name), pos);
        if (name.text === 'defer') {
          if (this.token() === SyntaxKind.OpenParenToken || this.token() === SyntaxKind.LessThanToken)
            this.sourceFlags |= NodeFlags.PossiblyContainsDynamicImport;
        } else {
          this.sourceFlags |= NodeFlags.PossiblyContainsImportMeta;
        }
      } else {
        expression = this.parseMemberExpressionOrHigher();
      }
    } else if (this.token() === SyntaxKind.SuperKeyword) {
      expression = this.parseSuperExpression();
    } else {
      expression = this.parseMemberExpressionOrHigher();
    }
    // We may have consumed the start of a call or optional expression; consume the rest.
    return this.parseCallExpressionRest(pos, expression);
  }

  parseSuperExpression(): Expression {
    const pos = this.nodePos();
    let expression = this.parseKeywordExpression();
    if (this.token() === SyntaxKind.LessThanToken) {
      const startPos = this.nodePos();
      const typeArguments = this.tryParseTypeArgumentsInExpression();
      if (typeArguments !== undefined) {
        this.parseErrorAt(startPos, this.nodePos(), Diagnostics.X_super_may_not_use_type_arguments);
        if (!this.isTemplateStartOfTaggedTemplate())
          expression = this.finishNode(new ExpressionWithTypeArguments(expression, typeArguments), pos);
      }
    }
    const token = this.token();
    if (token === SyntaxKind.OpenParenToken || token === SyntaxKind.DotToken || token === SyntaxKind.OpenBracketToken)
      return expression;
    // `super` must be followed by `(` or `.`: parse a `.` and report an error.
    this.parseErrorAtCurrentToken(Diagnostics.X_super_must_be_followed_by_an_argument_list_or_member_access);
    // `super.#foo` never works, but that's a semantic error.
    return this.finishNode(
      new PropertyAccessExpression(expression, undefined, this.parseRightSideOfDot(true, true, true), NodeFlags.None),
      pos,
    );
  }

  isTemplateStartOfTaggedTemplate(): boolean {
    return this.token() === SyntaxKind.NoSubstitutionTemplateLiteral || this.token() === SyntaxKind.TemplateHead;
  }

  tryParseTypeArgumentsInExpression(): NodeList | undefined {
    // Type arguments aren't parsed in JavaScript files, where they'd be ambiguous with binary
    // operators. Without `<` (or `<<`, which reScanLessThanToken splits) there's nothing to try.
    if (
      (this.contextFlags & NodeFlags.JavaScriptFile) !== 0 ||
      (this.token() !== SyntaxKind.LessThanToken && this.token() !== SyntaxKind.LessThanLessThanToken)
    )
      return undefined;
    const state = this.mark();
    if (this.reScanLessThanToken() === SyntaxKind.LessThanToken) {
      this.nextToken();
      const typeArguments = this.parseDelimitedList(ParsingContext.TypeArguments, ListElement.Type);
      // Without the closing `>` it's not a type argument list.
      if (this.reScanGreaterThanToken() === SyntaxKind.GreaterThanToken) {
        this.nextToken();
        // Followed by `(` or a template, as in `f<number>(42)`, prefer type arguments over a
        // relational expression.
        if (this.canFollowTypeArgumentsInExpression()) return typeArguments;
      }
    }
    this.rewind(state);
    return undefined;
  }

  canFollowTypeArgumentsInExpression(): boolean {
    switch (this.token()) {
      // foo<x>(, foo<T> `...`, foo<T> `...${100}...`
      case SyntaxKind.OpenParenToken:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateHead:
        return true;
      // `<` never makes sense after type arguments, `>` is ambiguous with a rescanned `>>`, and `+`/`-`
      // are unary here.
      case SyntaxKind.LessThanToken:
      case SyntaxKind.GreaterThanToken:
      case SyntaxKind.PlusToken:
      case SyntaxKind.MinusToken:
        return false;
    }
    // Prefer type arguments before a line break, a binary operator, or anything that can't start an expression.
    return this.hasPrecedingLineBreak() || this.isBinaryOperator() || !this.isStartOfExpression();
  }

  parseMemberExpressionOrHigher(): Expression {
    // NewExpression is decomposed: object creation and function expressions are primary expressions,
    // and `new Foo()` always takes its arguments, so further argument lists become calls. Member and
    // call expressions are left recursive, so start with a primary expression.
    const pos = this.nodePos();
    const expression = this.parsePrimaryExpression();
    return this.parseMemberExpressionRest(pos, expression, true);
  }

  parseMemberExpressionRest(pos: number, expression: Expression, allowOptionalChain: boolean): Expression {
    for (;;) {
      let questionDotToken: Token | undefined;
      let isPropertyAccess = false;
      if (allowOptionalChain && this.isStartOfOptionalPropertyOrElementAccessChain()) {
        questionDotToken = this.parseExpectedToken(SyntaxKind.QuestionDotToken);
        isPropertyAccess = tokenIsIdentifierOrKeyword(this.token());
      } else {
        isPropertyAccess = this.parseOptional(SyntaxKind.DotToken);
      }
      if (isPropertyAccess) {
        expression = this.parsePropertyAccessExpressionRest(pos, expression, questionDotToken);
        continue;
      }
      // In a [Decorator] context, `[` may start a computed property name rather than an element access.
      if (
        (questionDotToken !== undefined || !this.inDecoratorContext()) &&
        this.parseOptional(SyntaxKind.OpenBracketToken)
      ) {
        expression = this.parseElementAccessExpressionRest(pos, expression, questionDotToken);
        continue;
      }
      if (this.isTemplateStartOfTaggedTemplate()) {
        // Absorb type arguments into the tagged template.
        if (questionDotToken === undefined && expression instanceof ExpressionWithTypeArguments) {
          const original = expression;
          expression = this.parseTaggedTemplateRest(pos, original.expression, questionDotToken, original.typeArguments);
          this.unparseExpressionWithTypeArguments(original.expression, original.typeArguments, expression);
        } else {
          expression = this.parseTaggedTemplateRest(pos, expression, questionDotToken, undefined);
        }
        continue;
      }
      if (questionDotToken === undefined) {
        if (this.token() === SyntaxKind.ExclamationToken && !this.hasPrecedingLineBreak()) {
          this.nextToken();
          expression = this.checkJSSyntax(this.finishNode(new NonNullExpression(expression, NodeFlags.None), pos));
          continue;
        }
        const typeArguments = this.tryParseTypeArgumentsInExpression();
        if (typeArguments !== undefined) {
          expression = this.finishNode(new ExpressionWithTypeArguments(expression, typeArguments), pos);
          continue;
        }
      }
      return expression;
    }
  }

  isStartOfOptionalPropertyOrElementAccessChain(): boolean {
    return (
      this.token() === SyntaxKind.QuestionDotToken &&
      this.lookAhead(nextTokenIsIdentifierOrKeywordOrOpenBracketOrTemplate)
    );
  }

  parsePropertyAccessExpressionRest(
    pos: number,
    expression: Expression,
    questionDotToken: Token | undefined,
  ): Expression {
    const name = this.parseRightSideOfDot(true, true, true);
    const isOptionalChain = questionDotToken !== undefined || this.tryReparseOptionalChain(expression);
    const propertyAccess = new PropertyAccessExpression(
      expression,
      questionDotToken,
      name,
      isOptionalChain ? NodeFlags.OptionalChain : NodeFlags.None,
    );
    if (isOptionalChain && name.kind === SyntaxKind.PrivateIdentifier)
      this.parseErrorAt(
        skipTrivia(this.sourceText, name.pos),
        name.end,
        Diagnostics.An_optional_chain_cannot_contain_private_identifiers,
      );
    if (expression instanceof ExpressionWithTypeArguments) {
      const typeArguments = (expression as ExpressionWithTypeArguments).typeArguments;
      if (typeArguments !== undefined)
        this.parseErrorAt(
          typeArguments.pos - 1,
          skipTrivia(this.sourceText, typeArguments.end) + 1,
          Diagnostics.An_instantiation_expression_cannot_be_followed_by_a_property_access,
        );
    }
    return this.finishNode(propertyAccess, pos);
  }

  tryReparseOptionalChain(node: Expression): boolean {
    if ((node.flags & NodeFlags.OptionalChain) !== 0) return true;
    // An optional chain inside a non-null expression.
    if (node instanceof NonNullExpression) {
      let expr = (node as NonNullExpression).expression;
      while (expr instanceof NonNullExpression && ((expr as NonNullExpression).flags & NodeFlags.OptionalChain) === 0)
        expr = (expr as NonNullExpression).expression;
      if ((expr.flags & NodeFlags.OptionalChain) !== 0) {
        // Part of an optional chain: flag the non-null expressions down to it.
        let current: Node = node;
        while (current instanceof NonNullExpression) {
          (current as NonNullExpression).flags |= NodeFlags.OptionalChain;
          current = (current as NonNullExpression).expression;
        }
        return true;
      }
    }
    return false;
  }

  parseElementAccessExpressionRest(
    pos: number,
    expression: Expression,
    questionDotToken: Token | undefined,
  ): Expression {
    let argumentExpression: Expression;
    if (this.token() === SyntaxKind.CloseBracketToken) {
      this.parseErrorAt(
        this.nodePos(),
        this.nodePos(),
        Diagnostics.An_element_access_expression_should_take_an_argument,
      );
      argumentExpression = this.createMissingIdentifier();
    } else {
      const argument = this.parseExpressionAllowIn();
      if (
        argument.kind === SyntaxKind.StringLiteral ||
        argument.kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        argument.kind === SyntaxKind.NumericLiteral
      )
        this.internIdentifier(getText(argument));
      argumentExpression = argument;
    }
    this.parseExpected(SyntaxKind.CloseBracketToken);
    const isOptionalChain = questionDotToken !== undefined || this.tryReparseOptionalChain(expression);
    return this.finishNode(
      new ElementAccessExpression(
        expression,
        questionDotToken,
        argumentExpression,
        isOptionalChain ? NodeFlags.OptionalChain : NodeFlags.None,
      ),
      pos,
    );
  }

  parseCallExpressionRest(pos: number, expression: Expression): Expression {
    for (;;) {
      expression = this.parseMemberExpressionRest(pos, expression, true);
      let typeArguments: NodeList | undefined;
      const questionDotToken = this.parseOptionalToken(SyntaxKind.QuestionDotToken);
      if (questionDotToken !== undefined) {
        typeArguments = this.tryParseTypeArgumentsInExpression();
        if (this.isTemplateStartOfTaggedTemplate()) {
          expression = this.parseTaggedTemplateRest(pos, expression, questionDotToken, typeArguments);
          continue;
        }
      }
      if (typeArguments !== undefined || this.token() === SyntaxKind.OpenParenToken) {
        // Absorb type arguments into the call.
        if (questionDotToken === undefined && expression instanceof ExpressionWithTypeArguments) {
          typeArguments = (expression as ExpressionWithTypeArguments).typeArguments;
          expression = (expression as ExpressionWithTypeArguments).expression;
        }
        const inner = expression;
        const argumentList = this.parseArgumentList();
        const isOptionalChain = questionDotToken !== undefined || this.tryReparseOptionalChain(expression);
        expression = this.checkJSSyntax(
          this.finishNode(
            newCallExpression(
              expression,
              questionDotToken,
              typeArguments,
              argumentList,
              isOptionalChain ? NodeFlags.OptionalChain : NodeFlags.None,
              (this.contextFlags & NodeFlags.JavaScriptFile) !== 0,
            ),
            pos,
          ),
        );
        this.unparseExpressionWithTypeArguments(inner, typeArguments, expression);
        continue;
      }
      if (questionDotToken !== undefined) {
        // `?.` followed by nothing parsable: report a missing identifier.
        this.parseErrorAtCurrentToken(Diagnostics.Identifier_expected);
        const name = this.createMissingIdentifier();
        expression = this.finishNode(
          new PropertyAccessExpression(expression, questionDotToken, name, NodeFlags.OptionalChain),
          pos,
        );
      }
      break;
    }
    return expression;
  }

  parseArgumentList(): NodeList {
    this.parseExpected(SyntaxKind.OpenParenToken);
    const result = this.parseDelimitedList(ParsingContext.ArgumentExpressions, ListElement.ArgumentExpression)!;
    this.parseExpected(SyntaxKind.CloseParenToken);
    return result;
  }

  parseArgumentExpression(): Expression {
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DisallowInContext | NodeFlags.DecoratorContext, false);
    const result = this.parseArgumentOrArrayLiteralElement();
    this.contextFlags = saveContextFlags;
    return result;
  }

  parseArgumentOrArrayLiteralElement(): Expression {
    switch (this.token()) {
      case SyntaxKind.DotDotDotToken:
        return this.parseSpreadElement();
      case SyntaxKind.CommaToken:
        return this.finishNode(new OmittedExpression(), this.nodePos());
    }
    return this.parseAssignmentExpressionOrHigher();
  }

  parseSpreadElement(): Expression {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.DotDotDotToken);
    const expression = this.parseAssignmentExpressionOrHigher();
    return this.finishNode(new SpreadElement(expression), pos);
  }

  parseTaggedTemplateRest(
    pos: number,
    tag: Expression,
    questionDotToken: Token | undefined,
    typeArguments: NodeList | undefined,
  ): Expression {
    let template: Expression;
    if (this.token() === SyntaxKind.NoSubstitutionTemplateLiteral) {
      this.reScanTemplateToken(true);
      template = this.parseLiteralExpression(false);
    } else {
      template = this.parseTemplateExpression(true);
    }
    const isOptionalChain = questionDotToken !== undefined || (tag.flags & NodeFlags.OptionalChain) !== 0;
    return this.checkJSSyntax(
      this.finishNode(
        new TaggedTemplateExpression(
          tag,
          questionDotToken,
          typeArguments,
          template,
          isOptionalChain ? NodeFlags.OptionalChain : NodeFlags.None,
        ),
        pos,
      ),
    );
  }

  parseTemplateExpression(isTaggedTemplate: boolean): Expression {
    const pos = this.nodePos();
    const head = this.parseTemplateHead(isTaggedTemplate);
    return this.finishNode(new TemplateExpression(head, this.parseTemplateSpans(isTaggedTemplate)), pos);
  }

  parseTemplateSpans(isTaggedTemplate: boolean): NodeList {
    const pos = this.nodePos();
    const list = this.openList();
    for (;;) {
      const span = this.parseTemplateSpan(isTaggedTemplate);
      list.push(span);
      if (span.literal.kind !== SyntaxKind.TemplateMiddle) break;
    }
    return this.newNodeList(pos, this.nodePos(), this.closeList(list));
  }

  parseTemplateSpan(isTaggedTemplate: boolean): TemplateSpan {
    const pos = this.nodePos();
    const expression = this.parseExpressionAllowIn();
    const literal = this.parseLiteralOfTemplateSpan(isTaggedTemplate);
    const result = new TemplateSpan(expression, literal);
    this.finishNode(result, pos);
    return result;
  }

  parsePrimaryExpression(): Expression {
    switch (this.token()) {
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        if ((this.scanner.getTokenFlags() & TokenFlags.IsInvalid) !== 0) this.reScanTemplateToken(false);
        return this.parseLiteralExpression(false);
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.StringLiteral:
        return this.parseLiteralExpression(false);
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.SuperKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
        return this.parseKeywordExpression();
      case SyntaxKind.OpenParenToken:
        return this.parseParenthesizedExpression();
      case SyntaxKind.OpenBracketToken:
        return this.parseArrayLiteralExpression();
      case SyntaxKind.OpenBraceToken:
        return this.parseObjectLiteralExpression();
      case SyntaxKind.AsyncKeyword:
        // Async arrow functions were parsed in parseAssignmentExpressionOrHigher. `async function` on one
        // line is an async function; otherwise `async` is an identifier.
        if (!this.lookAhead(nextTokenIsFunctionKeywordOnSameLine)) break;
        return this.parseFunctionExpression();
      case SyntaxKind.AtToken:
        return this.parseDecoratedExpression();
      case SyntaxKind.ClassKeyword:
        return this.parseClassExpression();
      case SyntaxKind.FunctionKeyword:
        return this.parseFunctionExpression();
      case SyntaxKind.NewKeyword:
        return this.parseNewExpressionOrNewDotTarget();
      case SyntaxKind.SlashToken:
      case SyntaxKind.SlashEqualsToken:
        if (this.reScanSlashToken() === SyntaxKind.RegularExpressionLiteral) return this.parseLiteralExpression(false);
        break;
      case SyntaxKind.TemplateHead:
        return this.parseTemplateExpression(false);
      case SyntaxKind.PrivateIdentifier:
        return this.parsePrivateIdentifier();
    }
    return this.parseIdentifierWithDiagnostic(Diagnostics.Expression_expected, undefined);
  }

  parseParenthesizedExpression(): Expression {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    this.parseExpected(SyntaxKind.OpenParenToken);
    const expression = this.parseExpressionAllowIn();
    this.parseExpected(SyntaxKind.CloseParenToken);
    return this.finishWithJSDoc(new ParenthesizedExpression(expression), pos, jsdoc);
  }

  parseArrayLiteralExpression(): Expression {
    const pos = this.nodePos();
    const openBracketPosition = this.scanner.getTokenStart();
    const openBracketParsed = this.parseExpected(SyntaxKind.OpenBracketToken);
    const multiLine = this.hasPrecedingLineBreak();
    const elements = this.parseDelimitedList(ParsingContext.ArrayLiteralMembers, ListElement.ArrayLiteralElement)!;
    this.parseExpectedMatchingBrackets(
      SyntaxKind.OpenBracketToken,
      SyntaxKind.CloseBracketToken,
      openBracketParsed,
      openBracketPosition,
    );
    return this.finishNode(new ArrayLiteralExpression(elements, multiLine), pos);
  }

  parseObjectLiteralExpression(): Expression {
    const pos = this.nodePos();
    const openBracePosition = this.scanner.getTokenStart();
    const openBraceParsed = this.parseExpected(SyntaxKind.OpenBraceToken);
    const multiLine = this.hasPrecedingLineBreak();
    const properties = this.parseDelimitedList(ParsingContext.ObjectLiteralMembers, ListElement.ObjectLiteralElement)!;
    this.parseExpectedMatchingBrackets(
      SyntaxKind.OpenBraceToken,
      SyntaxKind.CloseBraceToken,
      openBraceParsed,
      openBracePosition,
    );
    return this.finishNode(new ObjectLiteralExpression(properties, multiLine), pos);
  }

  parseObjectLiteralElement(): Node {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    if (this.parseOptional(SyntaxKind.DotDotDotToken)) {
      const expression = this.parseAssignmentExpressionOrHigher();
      return this.finishWithJSDoc(new SpreadAssignment(expression), pos, jsdoc);
    }
    const modifiers = this.parseModifiersEx(true, false, false);
    if (this.parseContextualModifier(SyntaxKind.GetKeyword))
      return this.parseAccessorDeclaration(pos, jsdoc, modifiers, SyntaxKind.GetAccessor, ParseFlags.None);
    if (this.parseContextualModifier(SyntaxKind.SetKeyword))
      return this.parseAccessorDeclaration(pos, jsdoc, modifiers, SyntaxKind.SetAccessor, ParseFlags.None);
    const asteriskToken = this.parseOptionalToken(SyntaxKind.AsteriskToken);
    const tokenIsIdentifier = this.isIdentifier();
    const name = this.parsePropertyName(IdentifierUse.ElementName);
    // The grammar checker reports optional property assignments, definite assignment assertions,
    // decorators and modifiers.
    let postfixToken = this.parseOptionalToken(SyntaxKind.QuestionToken);
    if (postfixToken === undefined) postfixToken = this.parseOptionalToken(SyntaxKind.ExclamationToken);
    if (
      asteriskToken !== undefined ||
      this.token() === SyntaxKind.OpenParenToken ||
      this.token() === SyntaxKind.LessThanToken
    )
      return this.parseMethodDeclaration(pos, jsdoc, modifiers, asteriskToken, name, postfixToken, undefined);
    // A shorthand property assignment or a normal one. With `=`, this is the CoverInitializedName
    // production, which object literals need to cover ObjectAssignmentPattern.
    let node: Node;
    if (tokenIsIdentifier && this.token() !== SyntaxKind.ColonToken) {
      const equalsToken = this.parseOptionalToken(SyntaxKind.EqualsToken);
      const initializer = equalsToken !== undefined ? this.parseAssignmentExpressionOrHigherAllowIn() : undefined;
      node = new ShorthandPropertyAssignment(modifiers, name, postfixToken, undefined, equalsToken, initializer);
    } else {
      this.parseExpected(SyntaxKind.ColonToken);
      const initializer = this.parseAssignmentExpressionOrHigherAllowIn();
      node = newPropertyAssignment(
        modifiers,
        name,
        postfixToken,
        undefined,
        initializer,
        (this.contextFlags & NodeFlags.JavaScriptFile) !== 0,
      );
    }
    return this.finishWithJSDoc(node, pos, jsdoc);
  }

  parseFunctionExpression(): Expression {
    // GeneratorExpression: function* BindingIdentifier [Yield][opt](FormalParameters[Yield]){ GeneratorBody }
    // FunctionExpression: function BindingIdentifier[opt](FormalParameters){ FunctionBody }
    const saveContextFlags = this.contextFlags;
    this.setContextFlags(NodeFlags.DecoratorContext, false);
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const modifiers = this.parseModifiers();
    this.parseExpected(SyntaxKind.FunctionKeyword);
    const asteriskToken = this.parseOptionalToken(SyntaxKind.AsteriskToken);
    const isGenerator = asteriskToken !== undefined;
    const isAsync = modifiers !== undefined && hasModifierOfKind(modifiers, SyntaxKind.AsyncKeyword);
    const signatureFlags =
      (isGenerator ? ParseFlags.Yield : ParseFlags.None) | (isAsync ? ParseFlags.Await : ParseFlags.None);
    const saveNameContextFlags = this.contextFlags;
    if (isGenerator) this.setContextFlags(NodeFlags.YieldContext, true);
    if (isAsync) this.setContextFlags(NodeFlags.AwaitContext, true);
    const name = this.parseOptionalBindingIdentifier();
    this.contextFlags = saveNameContextFlags;
    const typeParameters = this.parseTypeParameters();
    const parameters = this.parseParameters(signatureFlags);
    const returnType = this.parseReturnType(SyntaxKind.ColonToken, false);
    const body = this.parseFunctionBlock(signatureFlags, undefined);
    this.contextFlags = saveContextFlags;
    const result = this.finishWithJSDoc(
      new FunctionExpression(modifiers, asteriskToken, name, typeParameters, parameters, returnType, undefined, body),
      pos,
      jsdoc,
    );
    this.checkJSSyntax(result);
    return result;
  }

  parseOptionalBindingIdentifier(): Identifier | undefined {
    return this.isBindingIdentifier() ? this.parseBindingIdentifier() : undefined;
  }

  parseDecoratedExpression(): Expression {
    const pos = this.nodePos();
    const jsdoc = this.jsdocScannerInfo();
    const modifiers = this.parseModifiersEx(true, false, false);
    if (this.token() === SyntaxKind.ClassKeyword)
      return this.parseClassDeclarationOrExpression(pos, jsdoc, modifiers, SyntaxKind.ClassExpression);
    this.parseErrorAt(this.nodePos(), this.nodePos(), Diagnostics.Expression_expected);
    return this.finishNode(new MissingDeclaration(modifiers), pos);
  }

  /** Re-parents an expression and type arguments first parsed as an ExpressionWithTypeArguments. */
  unparseExpressionWithTypeArguments(expression: Node, typeArguments: NodeList | undefined, result: Node): void {
    expression.parent = result;
    if (typeArguments !== undefined) for (const a of typeArguments.nodes) a.parent = result;
  }

  parseNewExpressionOrNewDotTarget(): Expression {
    const pos = this.nodePos();
    this.parseExpected(SyntaxKind.NewKeyword);
    if (this.parseOptional(SyntaxKind.DotToken)) {
      const name = this.parseIdentifierName(IdentifierUse.Name);
      return this.finishNode(new MetaProperty(SyntaxKind.NewKeyword, name), pos);
    }
    const expressionPos = this.nodePos();
    let expression = this.parseMemberExpressionRest(expressionPos, this.parsePrimaryExpression(), false);
    let typeArguments: NodeList | undefined;
    // Absorb type arguments into the new expression.
    if (expression instanceof ExpressionWithTypeArguments) {
      typeArguments = (expression as ExpressionWithTypeArguments).typeArguments;
      expression = (expression as ExpressionWithTypeArguments).expression;
    }
    if (this.token() === SyntaxKind.QuestionDotToken)
      this.parseErrorAtCurrentToken(Diagnostics.Invalid_optional_chain_from_new_expression_Did_you_mean_to_call_0, [
        getTextOfNodeFromSourceText(this.sourceText, expression),
      ]);
    const argumentList = this.token() === SyntaxKind.OpenParenToken ? this.parseArgumentList() : undefined;
    const result = this.checkJSSyntax(this.finishNode(new NewExpression(expression, typeArguments, argumentList), pos));
    this.unparseExpressionWithTypeArguments(expression, typeArguments, result);
    return result;
  }

  parseKeywordExpression(): Expression {
    const pos = this.nodePos();
    const result = new KeywordExpression(this.token());
    this.nextToken();
    return this.finishNode(result, pos);
  }

  parseLiteralExpression(intern: boolean): Expression {
    const pos = this.nodePos();
    const text = this.scanner.getTokenValue();
    if (intern) this.internIdentifier(text);
    const tokenFlags = this.scanner.getTokenFlags();
    let result: Node;
    switch (this.token()) {
      case SyntaxKind.StringLiteral:
        result = new StringLiteral(text, tokenFlags);
        break;
      case SyntaxKind.NumericLiteral:
        result = new NumericLiteral(text, tokenFlags);
        break;
      case SyntaxKind.BigIntLiteral:
        result = new BigIntLiteral(text, tokenFlags);
        break;
      case SyntaxKind.RegularExpressionLiteral:
        result = new RegularExpressionLiteral(text, tokenFlags);
        break;
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        result = new NoSubstitutionTemplateLiteral(text, tokenFlags);
        break;
      default:
        throw new Error('Unhandled case in parseLiteralExpression');
    }
    this.nextToken();
    return this.finishNode(result, pos);
  }

  // Identifiers

  parseIdentifierNameErrorOnUnicodeEscapeSequence(use: IdentifierUse = IdentifierUse.Reference): Identifier {
    if (this.scanner.hasUnicodeEscape() || this.scanner.hasExtendedUnicodeEscape())
      this.parseErrorAtCurrentToken(Diagnostics.Unicode_escape_sequence_cannot_appear_here);
    return this.createIdentifier(tokenIsIdentifierOrKeyword(this.token()), use);
  }

  parseBindingIdentifier(): Identifier {
    return this.parseBindingIdentifierWithDiagnostic(undefined);
  }

  parseBindingIdentifierWithDiagnostic(privateIdentifierDiagnosticMessage: DiagnosticMessage | undefined): Identifier {
    const saveHasAwaitIdentifier = this.statementHasAwaitIdentifier;
    const id = this.createIdentifierWithDiagnostic(
      this.isBindingIdentifier(),
      undefined,
      privateIdentifierDiagnosticMessage,
      IdentifierUse.Name,
    );
    this.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return id;
  }

  parseIdentifierName(use: IdentifierUse = IdentifierUse.Reference): Identifier {
    return this.parseIdentifierNameWithDiagnostic(undefined, use);
  }

  parseIdentifierNameWithDiagnostic(
    diagnosticMessage: DiagnosticMessage | undefined,
    use: IdentifierUse = IdentifierUse.Reference,
  ): Identifier {
    return this.createIdentifierWithDiagnostic(
      tokenIsIdentifierOrKeyword(this.token()),
      diagnosticMessage,
      undefined,
      use,
    );
  }

  parseIdentifier(use: IdentifierUse = IdentifierUse.Reference): Identifier {
    return this.parseIdentifierWithDiagnostic(undefined, undefined, use);
  }

  parseIdentifierWithDiagnostic(
    diagnosticMessage: DiagnosticMessage | undefined,
    privateIdentifierDiagnosticMessage: DiagnosticMessage | undefined,
    use: IdentifierUse = IdentifierUse.Reference,
  ): Identifier {
    return this.createIdentifierWithDiagnostic(
      this.isIdentifier(),
      diagnosticMessage,
      privateIdentifierDiagnosticMessage,
      use,
    );
  }

  createIdentifier(isIdentifier: boolean, use: IdentifierUse = IdentifierUse.Reference): Identifier {
    return this.createIdentifierWithDiagnostic(isIdentifier, undefined, undefined, use);
  }

  createIdentifierWithDiagnostic(
    isIdentifier: boolean,
    diagnosticMessage: DiagnosticMessage | undefined,
    privateIdentifierDiagnosticMessage: DiagnosticMessage | undefined,
    use: IdentifierUse = IdentifierUse.Reference,
  ): Identifier {
    if (isIdentifier) {
      const pos = this.scanner.hasPrecedingJSDocLeadingAsterisks() ? this.scanner.getTokenStart() : this.nodePos();
      const text = this.scanner.getIdentifierValue();
      const record = this.scanner.recordIdentifierValue(text);
      this.nextTokenWithoutCheck();
      if (record) this.identifierTexts.push(text);
      const result = this.newIdentifier(text, use);
      this.finishNode(result, pos);
      return result;
    }
    if (this.token() === SyntaxKind.PrivateIdentifier) {
      this.parseErrorAtCurrentToken(
        privateIdentifierDiagnosticMessage !== undefined
          ? privateIdentifierDiagnosticMessage
          : Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies,
      );
      return this.createIdentifier(true, use);
    }
    // Report at the current position only at the end of the file: elsewhere the error would land
    // incorrectly on embedded script tags.
    const reportAtCurrentPosition = this.token() === SyntaxKind.EndOfFile;
    const fullStart = this.scanner.getTokenFullStart();
    if (diagnosticMessage !== undefined) {
      if (reportAtCurrentPosition) this.parseErrorAt(fullStart, fullStart, diagnosticMessage);
      else this.parseErrorAtCurrentToken(diagnosticMessage);
    } else if (isReservedWord(this.token())) {
      const args = [this.scanner.getTokenText()];
      if (reportAtCurrentPosition)
        this.parseErrorAt(
          fullStart,
          fullStart,
          Diagnostics.Identifier_expected_0_is_a_reserved_word_that_cannot_be_used_here,
          args,
        );
      else
        this.parseErrorAtCurrentToken(
          Diagnostics.Identifier_expected_0_is_a_reserved_word_that_cannot_be_used_here,
          args,
        );
    } else if (reportAtCurrentPosition) {
      this.parseErrorAt(fullStart, fullStart, Diagnostics.Identifier_expected);
    } else {
      this.parseErrorAtCurrentToken(Diagnostics.Identifier_expected);
    }
    return this.createMissingIdentifier(use);
  }

  internIdentifier(text: string): string {
    this.identifierTexts.push(text);
    return text;
  }

  // Lookahead predicates

  /** Whether the current token can start a signature member, after any modifiers. */
  scanTypeMemberStart(): boolean {
    const token = this.token();
    if (
      token === SyntaxKind.OpenParenToken ||
      token === SyntaxKind.LessThanToken ||
      token === SyntaxKind.GetKeyword ||
      token === SyntaxKind.SetKeyword
    )
      return true;
    let idToken = false;
    // Eat all modifiers, but remember the last one in case it's an identifier.
    while (isModifierKind(this.token())) {
      idToken = true;
      this.nextToken();
    }
    // Index signatures and computed property names are type members.
    if (this.token() === SyntaxKind.OpenBracketToken) return true;
    if (this.isLiteralPropertyName()) {
      idToken = true;
      this.nextToken();
    }
    // With a potential identifier, check that a member declaration starts.
    if (idToken) {
      const next = this.token();
      return (
        next === SyntaxKind.OpenParenToken ||
        next === SyntaxKind.LessThanToken ||
        next === SyntaxKind.QuestionToken ||
        next === SyntaxKind.ColonToken ||
        next === SyntaxKind.CommaToken ||
        this.canParseSemicolon()
      );
    }
    return false;
  }

  scanClassMemberStart(): boolean {
    let idToken = SyntaxKind.Unknown;
    if (this.token() === SyntaxKind.AtToken) return true;
    // Eat all modifiers, but remember the last one in case it's an identifier.
    while (isModifierKind(this.token())) {
      idToken = this.token();
      // Class member modifiers (`public foo() ...`, `public @dec blah ...`, `export public ...`) are
      // certainly members, for better error recovery.
      if (isClassMemberModifier(idToken)) return true;
      this.nextToken();
    }
    if (this.token() === SyntaxKind.AsteriskToken) return true;
    // The first property-like token: an identifier, or `get` or `set`.
    if (this.isLiteralPropertyName()) {
      idToken = this.token();
      this.nextToken();
    }
    // Index signatures and computed properties are class members.
    if (this.token() === SyntaxKind.OpenBracketToken) return true;
    if (idToken !== SyntaxKind.Unknown) {
      // Non-keyword identifiers and accessors are safe to parse.
      if (!isKeyword(idToken) || idToken === SyntaxKind.SetKeyword || idToken === SyntaxKind.GetKeyword) return true;
      // For other keywords, look a little further.
      switch (this.token()) {
        case SyntaxKind.OpenParenToken: // method
        case SyntaxKind.LessThanToken: // generic method
        case SyntaxKind.ExclamationToken: // non-null assertion on a property name
        case SyntaxKind.ColonToken: // type annotation
        case SyntaxKind.EqualsToken: // initializer
        case SyntaxKind.QuestionToken: // invalid, but reported later
          return true;
      }
      // Semicolons, closing braces, end of file and line breaks (ASI).
      return this.canParseSemicolon();
    }
    return false;
  }

  canParseSemicolon(): boolean {
    // A real semicolon, or ASI.
    const token = this.token();
    return (
      token === SyntaxKind.SemicolonToken ||
      token === SyntaxKind.CloseBraceToken ||
      token === SyntaxKind.EndOfFile ||
      this.hasPrecedingLineBreak()
    );
  }

  tryParseSemicolon(): boolean {
    if (!this.canParseSemicolon()) return false;
    // Consume an explicit semicolon.
    if (this.token() === SyntaxKind.SemicolonToken) this.nextToken();
    return true;
  }

  parseSemicolon(): boolean {
    return this.tryParseSemicolon() || this.parseExpected(SyntaxKind.SemicolonToken);
  }

  isLiteralPropertyName(): boolean {
    const token = this.token();
    return (
      tokenIsIdentifierOrKeyword(token) ||
      token === SyntaxKind.StringLiteral ||
      token === SyntaxKind.NumericLiteral ||
      token === SyntaxKind.BigIntLiteral
    );
  }

  isStartOfStatement(): boolean {
    switch (this.token()) {
      // `catch` and `finally` aren't statements, but are parsed as such and reported later.
      case SyntaxKind.AtToken:
      case SyntaxKind.SemicolonToken:
      case SyntaxKind.OpenBraceToken:
      case SyntaxKind.VarKeyword:
      case SyntaxKind.LetKeyword:
      case SyntaxKind.UsingKeyword:
      case SyntaxKind.FunctionKeyword:
      case SyntaxKind.ClassKeyword:
      case SyntaxKind.EnumKeyword:
      case SyntaxKind.IfKeyword:
      case SyntaxKind.DoKeyword:
      case SyntaxKind.WhileKeyword:
      case SyntaxKind.ForKeyword:
      case SyntaxKind.ContinueKeyword:
      case SyntaxKind.BreakKeyword:
      case SyntaxKind.ReturnKeyword:
      case SyntaxKind.WithKeyword:
      case SyntaxKind.SwitchKeyword:
      case SyntaxKind.ThrowKeyword:
      case SyntaxKind.TryKeyword:
      case SyntaxKind.DebuggerKeyword:
      case SyntaxKind.CatchKeyword:
      case SyntaxKind.FinallyKeyword:
        return true;
      case SyntaxKind.ImportKeyword:
        return this.isStartOfDeclaration() || this.isNextTokenOpenParenOrLessThanOrDot();
      case SyntaxKind.ConstKeyword:
      case SyntaxKind.ExportKeyword:
        return this.isStartOfDeclaration();
      case SyntaxKind.AsyncKeyword:
      case SyntaxKind.DeclareKeyword:
      case SyntaxKind.InterfaceKeyword:
      case SyntaxKind.ModuleKeyword:
      case SyntaxKind.NamespaceKeyword:
      case SyntaxKind.TypeKeyword:
      case SyntaxKind.GlobalKeyword:
      case SyntaxKind.DeferKeyword:
        // Identifiers in an expression statement when they don't start a declaration.
        return true;
      case SyntaxKind.AccessorKeyword:
      case SyntaxKind.PublicKeyword:
      case SyntaxKind.PrivateKeyword:
      case SyntaxKind.ProtectedKeyword:
      case SyntaxKind.StaticKeyword:
      case SyntaxKind.ReadonlyKeyword:
        // Followed by an identifier, possibly a class member; otherwise an identifier in an expression statement.
        return this.isStartOfDeclaration() || !this.lookAhead(nextTokenIsIdentifierOrKeywordOnSameLine);
      default:
        return this.isStartOfExpression();
    }
  }

  isStartOfDeclaration(): boolean {
    return this.lookAhead(scanStartOfDeclaration);
  }

  scanStartOfDeclaration(): boolean {
    for (;;) {
      switch (this.token()) {
        case SyntaxKind.VarKeyword:
        case SyntaxKind.LetKeyword:
        case SyntaxKind.ConstKeyword:
        case SyntaxKind.FunctionKeyword:
        case SyntaxKind.ClassKeyword:
        case SyntaxKind.EnumKeyword:
          return true;
        case SyntaxKind.UsingKeyword:
          return this.isUsingDeclaration();
        case SyntaxKind.AwaitKeyword:
          return this.isAwaitUsingDeclaration();
        // `declare`, `module`, `namespace`, `interface` and `type` are JavaScript identifiers, but an
        // identifier can't be followed by another on the same line: `namespace n` is a declaration,
        // `namespace\nn` two expression statements.
        case SyntaxKind.InterfaceKeyword:
        case SyntaxKind.TypeKeyword:
        case SyntaxKind.DeferKeyword:
          return this.nextTokenIsIdentifierOnSameLine();
        case SyntaxKind.ModuleKeyword:
        case SyntaxKind.NamespaceKeyword:
          return this.nextTokenIsIdentifierOrStringLiteralOnSameLine();
        case SyntaxKind.AbstractKeyword:
        case SyntaxKind.AccessorKeyword:
        case SyntaxKind.AsyncKeyword:
        case SyntaxKind.DeclareKeyword:
        case SyntaxKind.PrivateKeyword:
        case SyntaxKind.ProtectedKeyword:
        case SyntaxKind.PublicKeyword:
        case SyntaxKind.ReadonlyKeyword: {
          const previousToken = this.token();
          this.nextToken();
          // ASI applies after the modifier.
          if (this.hasPrecedingLineBreak()) return false;
          // `declare type` commits to a type alias; it reports any line break itself.
          if (previousToken === SyntaxKind.DeclareKeyword && this.token() === SyntaxKind.TypeKeyword) return true;
          continue;
        }
        case SyntaxKind.GlobalKeyword: {
          const next = this.nextToken();
          return (
            next === SyntaxKind.OpenBraceToken || next === SyntaxKind.Identifier || next === SyntaxKind.ExportKeyword
          );
        }
        case SyntaxKind.ImportKeyword: {
          const next = this.nextToken();
          return (
            next === SyntaxKind.DeferKeyword ||
            next === SyntaxKind.StringLiteral ||
            next === SyntaxKind.AsteriskToken ||
            next === SyntaxKind.OpenBraceToken ||
            tokenIsIdentifierOrKeyword(next)
          );
        }
        case SyntaxKind.ExportKeyword: {
          const next = this.nextToken();
          if (
            next === SyntaxKind.EqualsToken ||
            next === SyntaxKind.AsteriskToken ||
            next === SyntaxKind.OpenBraceToken ||
            next === SyntaxKind.DefaultKeyword ||
            next === SyntaxKind.AsKeyword ||
            next === SyntaxKind.AtToken
          )
            return true;
          if (next === SyntaxKind.TypeKeyword) {
            const afterType = this.nextToken();
            return (
              afterType === SyntaxKind.AsteriskToken ||
              afterType === SyntaxKind.OpenBraceToken ||
              (this.isIdentifier() && !this.hasPrecedingLineBreak())
            );
          }
          continue;
        }
        case SyntaxKind.StaticKeyword:
          this.nextToken();
          continue;
      }
      return false;
    }
  }

  isStartOfExpression(): boolean {
    if (this.isStartOfLeftHandSideExpression()) return true;
    switch (this.token()) {
      case SyntaxKind.PlusToken:
      case SyntaxKind.MinusToken:
      case SyntaxKind.TildeToken:
      case SyntaxKind.ExclamationToken:
      case SyntaxKind.DeleteKeyword:
      case SyntaxKind.TypeOfKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.PlusPlusToken:
      case SyntaxKind.MinusMinusToken:
      case SyntaxKind.LessThanToken:
      case SyntaxKind.AwaitKeyword:
      case SyntaxKind.YieldKeyword:
      case SyntaxKind.PrivateIdentifier:
      case SyntaxKind.AtToken:
        // `yield` and `await` always start an expression: identifiers, or keywords in their contexts.
        return true;
    }
    // Error tolerance: a binary operator starts an expression with a missing identifier.
    if (this.isBinaryOperator()) return true;
    return this.isIdentifier();
  }

  isStartOfLeftHandSideExpression(): boolean {
    switch (this.token()) {
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.SuperKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateHead:
      case SyntaxKind.OpenParenToken:
      case SyntaxKind.OpenBracketToken:
      case SyntaxKind.OpenBraceToken:
      case SyntaxKind.FunctionKeyword:
      case SyntaxKind.ClassKeyword:
      case SyntaxKind.NewKeyword:
      case SyntaxKind.SlashToken:
      case SyntaxKind.SlashEqualsToken:
      case SyntaxKind.Identifier:
        return true;
      case SyntaxKind.ImportKeyword:
        return this.isNextTokenOpenParenOrLessThanOrDot();
    }
    return this.isIdentifier();
  }

  isStartOfType(inStartOfParameter: boolean): boolean {
    switch (this.token()) {
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.StringKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.BigIntKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.ReadonlyKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.UniqueKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.TypeOfKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.OpenBraceToken:
      case SyntaxKind.OpenBracketToken:
      case SyntaxKind.LessThanToken:
      case SyntaxKind.BarToken:
      case SyntaxKind.AmpersandToken:
      case SyntaxKind.NewKeyword:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.ObjectKeyword:
      case SyntaxKind.AsteriskToken:
      case SyntaxKind.QuestionToken:
      case SyntaxKind.ExclamationToken:
      case SyntaxKind.DotDotDotToken:
      case SyntaxKind.InferKeyword:
      case SyntaxKind.ImportKeyword:
      case SyntaxKind.AssertsKeyword:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateHead:
        return true;
      case SyntaxKind.FunctionKeyword:
        return !inStartOfParameter;
      case SyntaxKind.MinusToken:
        return !inStartOfParameter && this.lookAhead(nextTokenIsNumericOrBigIntLiteral);
      case SyntaxKind.OpenParenToken:
        // `(` starts a type when followed by `)`, `...`, an identifier, a modifier or a type, but `(1)` doesn't.
        return !inStartOfParameter && this.lookAhead(nextIsParenthesizedOrFunctionType);
    }
    return this.isIdentifier();
  }

  isStartOfParameter(isJSDocParameter: boolean): boolean {
    return (
      this.token() === SyntaxKind.DotDotDotToken ||
      this.isBindingIdentifierOrPrivateIdentifierOrPattern() ||
      isModifierKind(this.token()) ||
      this.token() === SyntaxKind.AtToken ||
      this.isStartOfType(!isJSDocParameter)
    );
  }

  isBindingIdentifierOrPrivateIdentifierOrPattern(): boolean {
    const token = this.token();
    return (
      token === SyntaxKind.OpenBraceToken ||
      token === SyntaxKind.OpenBracketToken ||
      token === SyntaxKind.PrivateIdentifier ||
      this.isBindingIdentifier()
    );
  }

  isNextTokenOpenParenOrLessThanOrDot(): boolean {
    return this.lookAhead(nextTokenIsOpenParenOrLessThanOrDot);
  }

  nextTokenIsIdentifierOnSameLine(): boolean {
    this.nextToken();
    return this.isIdentifier() && !this.hasPrecedingLineBreak();
  }

  nextTokenIsIdentifierOrStringLiteralOnSameLine(): boolean {
    this.nextToken();
    return (this.isIdentifier() || this.token() === SyntaxKind.StringLiteral) && !this.hasPrecedingLineBreak();
  }

  /** Strict mode reserved words are reported by the checker, not here. */
  isIdentifier(): boolean {
    const token = this.token();
    if (token === SyntaxKind.Identifier) return true;
    // `yield` in a [Yield] context and `await` in an [Await] context are keywords.
    if (
      (token === SyntaxKind.YieldKeyword && this.inYieldContext()) ||
      (token === SyntaxKind.AwaitKeyword && this.inAwaitContext())
    )
      return false;
    return token > SyntaxKind.LastReservedWord;
  }

  isBindingIdentifier(): boolean {
    // `let await`/`let yield` in [Yield] or [Await] are allowed here and reported by the binder.
    return this.token() === SyntaxKind.Identifier || this.token() > SyntaxKind.LastReservedWord;
  }

  isImportAttributeName(): boolean {
    return tokenIsIdentifierOrKeyword(this.token()) || this.token() === SyntaxKind.StringLiteral;
  }

  isBinaryOperator(): boolean {
    if (this.inDisallowInContext() && this.token() === SyntaxKind.InKeyword) return false;
    return getBinaryOperatorPrecedence(this.token()) !== OperatorPrecedence.Invalid;
  }

  isValidHeritageClauseObjectLiteral(): boolean {
    return this.lookAhead(nextIsValidHeritageClauseObjectLiteral);
  }

  isHeritageClause(): boolean {
    return this.token() === SyntaxKind.ExtendsKeyword || this.token() === SyntaxKind.ImplementsKeyword;
  }

  isHeritageClauseExtendsOrImplementsKeyword(): boolean {
    return this.isHeritageClause() && this.lookAhead(nextIsStartOfExpression);
  }

  isUsingDeclaration(): boolean {
    // `using` starts a declaration before an identifier. Object binding patterns are parsed for a
    // grammar error, but not array patterns, which conflict with element access (`using[x]`).
    return this.lookAhead(nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLineAllowOf);
  }

  nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLine(disallowOf: boolean): boolean {
    this.nextToken();
    if (disallowOf && this.token() === SyntaxKind.OfKeyword)
      return this.lookAhead(nextTokenIsEqualsOrSemicolonOrColonToken);
    return (this.isBindingIdentifier() || this.token() === SyntaxKind.OpenBraceToken) && !this.hasPrecedingLineBreak();
  }

  isAwaitUsingDeclaration(): boolean {
    return this.lookAhead(nextIsUsingKeywordThenBindingIdentifierOrStartOfObjectDestructuringOnSameLine);
  }

  // JavaScript checks

  checkJSDecoratorSyntax(node: Node): void {
    const modifierList = getModifiers(node);
    if (modifierList === undefined || modifierList.nodes.length === 0) return;
    const modifiers = modifierList.nodes;
    if (canHaveIllegalDecorators(node)) {
      for (const modifier of modifiers)
        if (modifier.kind === SyntaxKind.Decorator) {
          this.jsErrorAt(modifier.pos, modifier.end, Diagnostics.Decorators_are_not_valid_here);
          break;
        }
    } else if (canHaveDecorators(node)) {
      const decoratorIndex = findKindIndex(modifiers, SyntaxKind.Decorator, 0);
      if (decoratorIndex >= 0 && node.kind === SyntaxKind.ClassDeclaration) {
        const exportIndex = findKindIndex(modifiers, SyntaxKind.ExportKeyword, 0);
        if (exportIndex >= 0) {
          const defaultIndex = findKindIndex(modifiers, SyntaxKind.DefaultKeyword, 0);
          if (decoratorIndex > exportIndex && defaultIndex >= 0 && decoratorIndex < defaultIndex) {
            // A decorator between `export` and `default`.
            const decorator = modifiers[decoratorIndex]!;
            this.jsErrorAt(decorator.pos, decorator.end, Diagnostics.Decorators_are_not_valid_here);
          } else if (decoratorIndex < exportIndex) {
            // A trailing decorator after `export`.
            const trailingDecoratorIndex = findKindIndex(modifiers, SyntaxKind.Decorator, exportIndex);
            if (trailingDecoratorIndex >= 0) {
              const trailing = modifiers[trailingDecoratorIndex]!;
              const leading = modifiers[decoratorIndex]!;
              const diagnostic = new Diagnostic(
                undefined,
                skipTrivia(this.sourceText, trailing.pos),
                trailing.end,
                Diagnostics.Decorators_may_not_appear_after_export_or_export_default_if_they_also_appear_before_export,
                noArgs,
              );
              diagnostic.addRelatedInfo(
                new Diagnostic(
                  undefined,
                  skipTrivia(this.sourceText, leading.pos),
                  leading.end,
                  Diagnostics.Decorator_used_before_export_here,
                  noArgs,
                ),
              );
              this.jsDiagnostics.push(diagnostic);
            }
          }
        }
      }
    }
  }

  /** Reports TypeScript-only syntax in JavaScript files. */
  checkJSSyntax(node: Node): Node {
    if ((node.flags & NodeFlags.JavaScriptFile) === 0 || (node.flags & (NodeFlags.JSDoc | NodeFlags.Reparsed)) !== 0)
      return node;
    switch (node.kind) {
      case SyntaxKind.Parameter:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.IndexSignature: {
        if (
          node.kind === SyntaxKind.Parameter ||
          node.kind === SyntaxKind.PropertyDeclaration ||
          node.kind === SyntaxKind.MethodDeclaration
        ) {
          const token = getQuestionTokenOfNode(node);
          if (
            token !== undefined &&
            (token.flags & NodeFlags.Reparsed) === 0 &&
            token.kind === SyntaxKind.QuestionToken
          )
            this.jsErrorAt(token.pos, token.end, Diagnostics.The_0_modifier_can_only_be_used_in_TypeScript_files, [
              '?',
            ]);
        }
        const type = getType(node);
        if (isFunctionLike(node) && getBody(node) === undefined)
          this.jsErrorAt(node.pos, node.end, Diagnostics.Signature_declarations_can_only_be_used_in_TypeScript_files);
        else if (type !== undefined && (type.flags & NodeFlags.Reparsed) === 0)
          this.jsErrorAt(type.pos, type.end, Diagnostics.Type_annotations_can_only_be_used_in_TypeScript_files);
        break;
      }
      case SyntaxKind.ImportDeclaration:
        if (node instanceof ImportDeclaration) {
          const clause = (node as ImportDeclaration).importClause;
          if (clause !== undefined && clause.phaseModifier === SyntaxKind.TypeKeyword)
            this.jsErrorAt(
              (node as ImportDeclaration).pos,
              (node as ImportDeclaration).end,
              Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files,
              ['import type'],
            );
        }
        break;
      case SyntaxKind.ExportDeclaration:
        if (getIsTypeOnly(node))
          this.jsErrorAt(node.pos, node.end, Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files, [
            'export type',
          ]);
        break;
      case SyntaxKind.ImportSpecifier:
        if (getIsTypeOnly(node))
          this.jsErrorAt(node.pos, node.end, Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files, [
            'import...type',
          ]);
        break;
      case SyntaxKind.ExportSpecifier:
        if (getIsTypeOnly(node))
          this.jsErrorAt(node.pos, node.end, Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files, [
            'export...type',
          ]);
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        this.jsErrorAt(node.pos, node.end, Diagnostics.X_import_can_only_be_used_in_TypeScript_files);
        break;
      case SyntaxKind.ExportAssignment:
        if (node instanceof ExportAssignment && (node as ExportAssignment).isExportEquals)
          this.jsErrorAt(
            (node as ExportAssignment).pos,
            (node as ExportAssignment).end,
            Diagnostics.X_export_can_only_be_used_in_TypeScript_files,
          );
        break;
      case SyntaxKind.HeritageClause:
        if (node instanceof HeritageClause && (node as HeritageClause).token === SyntaxKind.ImplementsKeyword)
          this.jsErrorAt(
            (node as HeritageClause).pos,
            (node as HeritageClause).end,
            Diagnostics.X_implements_clauses_can_only_be_used_in_TypeScript_files,
          );
        break;
      case SyntaxKind.InterfaceDeclaration: {
        const name = getName(node)!;
        this.jsErrorAt(name.pos, name.end, Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files, [
          'interface',
        ]);
        break;
      }
      case SyntaxKind.ModuleDeclaration:
        if (node instanceof ModuleDeclaration)
          this.jsErrorAt(
            (node as ModuleDeclaration).name.pos,
            (node as ModuleDeclaration).name.end,
            Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files,
            [tokenToString((node as ModuleDeclaration).keyword)],
          );
        break;
      case SyntaxKind.TypeAliasDeclaration: {
        const name = getName(node)!;
        this.jsErrorAt(name.pos, name.end, Diagnostics.Type_aliases_can_only_be_used_in_TypeScript_files);
        break;
      }
      case SyntaxKind.EnumDeclaration: {
        const name = getName(node)!;
        this.jsErrorAt(name.pos, name.end, Diagnostics.X_0_declarations_can_only_be_used_in_TypeScript_files, ['enum']);
        break;
      }
      case SyntaxKind.NonNullExpression:
        this.jsErrorAt(node.pos, node.end, Diagnostics.Non_null_assertions_can_only_be_used_in_TypeScript_files);
        break;
      case SyntaxKind.AsExpression: {
        const type = getType(node)!;
        this.jsErrorAt(type.pos, type.end, Diagnostics.Type_assertion_expressions_can_only_be_used_in_TypeScript_files);
        break;
      }
      case SyntaxKind.SatisfiesExpression: {
        const type = getType(node)!;
        this.jsErrorAt(
          type.pos,
          type.end,
          Diagnostics.Type_satisfaction_expressions_can_only_be_used_in_TypeScript_files,
        );
        break;
      }
    }
    this.checkJSDecoratorSyntax(node);
    // Type parameters, type arguments and TypeScript-only modifiers.
    switch (node.kind) {
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.VariableStatement:
      case SyntaxKind.PropertyDeclaration: {
        if (node.kind !== SyntaxKind.VariableStatement && node.kind !== SyntaxKind.PropertyDeclaration) {
          const list = getTypeParameters(node);
          if (list !== undefined && hasNonReparsedNode(list.nodes))
            this.jsErrorAt(
              list.pos,
              list.end,
              Diagnostics.Type_parameter_declarations_can_only_be_used_in_TypeScript_files,
            );
        }
        const modifiers = getModifiers(node);
        if (modifiers !== undefined)
          for (const modifier of modifiers.nodes)
            if (
              (modifier.flags & NodeFlags.Reparsed) === 0 &&
              modifier.kind !== SyntaxKind.Decorator &&
              (modifierToFlag(modifier.kind) & ModifierFlags.JavaScript) === 0
            )
              this.jsErrorAt(
                modifier.pos,
                modifier.end,
                Diagnostics.The_0_modifier_can_only_be_used_in_TypeScript_files,
                [tokenToString(modifier.kind)],
              );
        break;
      }
      case SyntaxKind.Parameter: {
        const modifiers = getModifiers(node);
        if (modifiers !== undefined && hasModifierNode(modifiers.nodes))
          this.jsErrorAt(
            modifiers.pos,
            modifiers.end,
            Diagnostics.Parameter_modifiers_can_only_be_used_in_TypeScript_files,
          );
        break;
      }
      case SyntaxKind.CallExpression:
      case SyntaxKind.NewExpression:
      case SyntaxKind.ExpressionWithTypeArguments:
      case SyntaxKind.JsxSelfClosingElement:
      case SyntaxKind.JsxOpeningElement:
      case SyntaxKind.TaggedTemplateExpression: {
        const list = getTypeArguments(node);
        if (list !== undefined && hasNonReparsedNode(list.nodes))
          this.jsErrorAt(list.pos, list.end, Diagnostics.Type_arguments_can_only_be_used_in_TypeScript_files);
        break;
      }
    }
    return node;
  }

  // JSON

  parseJSONText(): SourceFile {
    const pos = this.nodePos();
    let statements: NodeList;
    let eof: Token;
    if (this.token() === SyntaxKind.EndOfFile) {
      statements = this.newNodeList(pos, this.nodePos(), []);
      eof = this.parseTokenNode();
    } else {
      // Error recovery collects multiple top-level expressions.
      let expressions: Node[] | undefined;
      let first: Node | undefined;
      while (this.token() !== SyntaxKind.EndOfFile) {
        let expression: Node;
        switch (this.token()) {
          case SyntaxKind.OpenBracketToken:
            expression = this.parseArrayLiteralExpression();
            break;
          case SyntaxKind.TrueKeyword:
          case SyntaxKind.FalseKeyword:
          case SyntaxKind.NullKeyword:
            expression = this.parseTokenNode();
            break;
          case SyntaxKind.MinusToken:
            if (this.lookAhead(nextTokenIsNumericLiteralNotFollowedByColon))
              expression = this.parsePrefixUnaryExpression();
            else expression = this.parseObjectLiteralExpression();
            break;
          case SyntaxKind.NumericLiteral:
          case SyntaxKind.StringLiteral:
            if (this.lookAhead(nextTokenIsNotColon)) {
              expression = this.parseLiteralExpression(false);
              break;
            }
            expression = this.parseObjectLiteralExpression();
            break;
          default:
            expression = this.parseObjectLiteralExpression();
        }
        if (first === undefined) {
          first = expression;
          if (this.token() !== SyntaxKind.EndOfFile) this.parseErrorAtCurrentToken(Diagnostics.Unexpected_token);
        } else {
          if (expressions === undefined) expressions = [first];
          expressions.push(expression);
        }
      }
      const expression =
        expressions !== undefined
          ? this.finishNode(new ArrayLiteralExpression(this.newNodeList(pos, this.nodePos(), expressions), false), pos)
          : first!;
      const statement = this.finishNode(new ExpressionStatement(expression), pos);
      statements = this.newNodeList(pos, this.nodePos(), [statement]);
      eof = this.parseExpectedToken(SyntaxKind.EndOfFile);
    }
    const result = this.newSourceFile(statements, eof);
    this.finishNode(result, pos);
    const first = result.statements.nodes.length > 0 ? result.statements.nodes[0]! : undefined;
    if (first instanceof ExpressionStatement) this.validateJsonValue(result, (first as ExpressionStatement).expression);
    this.finishSourceFile(result, false);
    return result;
  }

  jsonError(node: Node, message: DiagnosticMessage): void {
    this.diagnostics.push(new Diagnostic(undefined, skipTrivia(this.sourceText, node.pos), node.end, message, noArgs));
  }

  validateJsonValue(sourceFile: SourceFile, value: Node): void {
    switch (value.kind) {
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.NumericLiteral:
        return;
      case SyntaxKind.StringLiteral:
        if (!isDoubleQuotedString(value)) this.jsonError(value, Diagnostics.String_literal_with_double_quotes_expected);
        return;
      case SyntaxKind.PrefixUnaryExpression:
        if (
          value instanceof PrefixUnaryExpression &&
          (value as PrefixUnaryExpression).operator === SyntaxKind.MinusToken &&
          (value as PrefixUnaryExpression).operand.kind === SyntaxKind.NumericLiteral
        )
          return;
        break;
      case SyntaxKind.ObjectLiteralExpression:
        if (value instanceof ObjectLiteralExpression) this.validateJsonObjectLiteral(sourceFile, value);
        return;
      case SyntaxKind.ArrayLiteralExpression:
        if (value instanceof ArrayLiteralExpression)
          for (const element of (value as ArrayLiteralExpression).elements.nodes)
            this.validateJsonValue(sourceFile, element);
        return;
    }
    this.jsonError(
      value,
      Diagnostics.Property_value_can_only_be_string_literal_numeric_literal_true_false_null_object_literal_or_array_literal,
    );
  }

  validateJsonObjectLiteral(sourceFile: SourceFile, node: ObjectLiteralExpression): void {
    for (const element of node.properties.nodes) {
      if (!(element instanceof PropertyAssignment)) {
        this.jsonError(element, Diagnostics.Property_assignment_expected);
        continue;
      }
      if (!isDoubleQuotedString((element as PropertyAssignment).name))
        this.jsonError((element as PropertyAssignment).name, Diagnostics.String_literal_with_double_quotes_expected);
      this.validateJsonValue(sourceFile, (element as PropertyAssignment).initializer);
    }
  }

  // Pragmas

  processPragmasIntoFields(file: SourceFile): void {
    file.checkJsDirective = undefined;
    file.referencedFiles = emptyFileReferences;
    file.typeReferenceDirectives = emptyFileReferences;
    file.libReferenceDirectives = emptyFileReferences;
    for (const pragma of file.pragmas) {
      switch (pragma.name) {
        case 'reference': {
          const args = pragma.args;
          const types = args.get('types');
          const lib = args.get('lib');
          const path = args.get('path');
          const resolutionMode = args.get('resolution-mode');
          const preserve = args.get('preserve');
          const noDefaultLib = args.get('no-default-lib');
          const isPreserved = preserve !== undefined && preserve.value === 'true';
          if (noDefaultLib !== undefined && noDefaultLib.value === 'true') {
            // Ignored.
          } else if (types !== undefined) {
            const parsed =
              resolutionMode !== undefined
                ? this.parseResolutionMode(resolutionMode.value, resolutionMode.pos, resolutionMode.end)
                : ModuleKind.None;
            file.typeReferenceDirectives = appendToList(
              file.typeReferenceDirectives,
              new FileReference(types.pos, types.end, types.value, parsed, isPreserved),
            );
          } else if (lib !== undefined) {
            file.libReferenceDirectives = appendToList(
              file.libReferenceDirectives,
              new FileReference(lib.pos, lib.end, lib.value, ModuleKind.None, isPreserved),
            );
          } else if (path !== undefined) {
            file.referencedFiles = appendToList(
              file.referencedFiles,
              new FileReference(path.pos, path.end, path.value, ModuleKind.None, isPreserved),
            );
          } else {
            this.parseErrorAt(pragma.range.pos, pragma.range.end, Diagnostics.Invalid_reference_directive_syntax);
          }
          break;
        }
        case 'ts-check':
        case 'ts-nocheck':
          // The last of either wins.
          if (file.checkJsDirective === undefined || pragma.range.pos > file.checkJsDirective.range.pos)
            file.checkJsDirective = new CheckJsDirective(pragma.name === 'ts-check', pragma.range);
          break;
        case 'jsx':
        case 'jsxfrag':
        case 'jsximportsource':
        case 'jsxruntime':
          break;
        default:
          throw new Error('Unhandled pragma kind: ' + pragma.name);
      }
    }
  }

  parseResolutionMode(mode: string, pos: number, end: number): ModuleKind {
    if (mode === 'import') return ModuleKind.ESNext;
    if (mode === 'require') return ModuleKind.CommonJS;
    this.parseErrorAt(pos, end, Diagnostics.X_resolution_mode_should_be_either_require_or_import);
    return ModuleKind.None;
  }

  // JSDoc support

  /** Whether the members of an object literal are being parsed. */
  inObjectLiteralMembers(): boolean {
    return (this.parsingContexts & (1 << ParsingContext.ObjectLiteralMembers)) !== 0;
  }

  /** Enters the JSDoc comment parsing context; returns the previous contexts for restoring. */
  enterJSDocCommentContext(): number {
    const saved = this.parsingContexts;
    this.parsingContexts |= 1 << ParsingContext.JSDocComment;
    return saved;
  }

  // JSDoc

  /** Attaches the JSDoc comments preceding `node`: flags only in TS files (parsed on demand), parsed in JS files. */
  withJSDoc(node: Node, info: JSDocScannerInfo): void {
    if ((info & JSDocScannerInfo.HasJSDoc) === 0) return;
    // TS files parse JSDoc on first use, except comments with @see/@link, which unused-identifier
    // checks need. @deprecated is found by a text scan; callers confirm it with a JSDoc lookup.
    if (!this.isJavaScript()) {
      node.flags |= NodeFlags.HasJSDoc;
      if ((info & JSDocScannerInfo.HasDeprecated) !== 0) node.flags |= NodeFlags.PossiblyContainsDeprecatedTag;
      if ((info & JSDocScannerInfo.HasSeeOrLink) === 0) return;
    }
    this.jsdoc.attachJSDoc(node);
  }
}

/** The JSDoc nodes of `node`, parsing them on first use in TypeScript files. */
export function getJSDoc(file: SourceFile, node: Node): readonly Node[] {
  if ((node.flags & NodeFlags.HasJSDoc) === 0) return noNodes;
  const jsDocs = file.jsDocs;
  if (jsDocs !== undefined) {
    const jsDoc = jsDocs.get(node.id);
    if (jsDoc !== undefined) return jsDoc;
  }
  if (!file.hasLazyJSDoc) return noNodes;
  if (lazyJSDocTable !== undefined) {
    const parsed = lazyJSDocTable.get(node.id);
    if (parsed !== undefined) return parsed;
  }
  let parser = lazyJSDocParser;
  if (parser === undefined || lazyJSDocFile !== file) {
    if (parser !== undefined) parser.release();
    // The parser scans only the comments it parses: copying the code units of the whole file each
    // time the checker moves to another file would cost more than parsing them.
    parser = new Parser(
      file.fileName,
      file.path,
      file.text,
      file.scriptKind,
      file.externalModuleIndicatorOptions,
      true,
    );
    lazyJSDocParser = parser;
    lazyJSDocFile = file;
  }
  const result = parser.jsdoc.parseJSDocForNode(node);
  if (lazyJSDocTable !== undefined) lazyJSDocTable.set(node.id, result);
  else if (jsDocs !== undefined) jsDocs.set(node.id, result);
  else {
    const table = new Map<number, Node[]>();
    table.set(node.id, result);
    file.jsDocs = table;
  }
  return result;
}

/**
 * The JSDoc already attached to `node` (parsed eagerly, or lazily by `getJSDoc`), without parsing:
 * `undefined` when there is none.
 */
export function getAttachedJSDoc(node: Node): readonly Node[] | undefined {
  if ((node.flags & NodeFlags.HasJSDoc) === 0) return undefined;
  let root = node;
  for (;;) {
    const parent: Node | undefined = root.parent;
    if (parent === undefined) break;
    root = parent;
  }
  if (root.kind !== SyntaxKind.SourceFile) return undefined;
  const jsDocs = (root as SourceFile).jsDocs;
  const attached = jsDocs === undefined ? undefined : jsDocs.get(node.id);
  if (attached !== undefined || lazyJSDocTable === undefined) return attached;
  return lazyJSDocTable.get(node.id);
}

/**
 * Keeps lazily parsed JSDoc in a table of this thread instead of on the nodes: a program shared with
 * other threads is never written.
 */
export function useLazyJSDocTable(): void {
  lazyJSDocTable = new Map<number, Node[]>();
}
let lazyJSDocTable: Map<number, Node[]> | undefined;

const noNodes: readonly Node[] = [];
// The parser for lazily parsed JSDoc, reused while the same file is visited.
let lazyJSDocParser: Parser | undefined;
let lazyJSDocFile: SourceFile | undefined;

/** Forgets the file the lazy JSDoc parser last visited. */
export function forgetLazyJSDocFile(): void {
  if (lazyJSDocParser !== undefined) lazyJSDocParser.release();
  lazyJSDocParser = undefined;
  lazyJSDocFile = undefined;
}

const viableKeywordSuggestions = getViableKeywordSuggestions();

// A parser whose JSDoc parser released parsers keep (`Parser.release`), created on first use.
let releasedParserValue: Parser | undefined;
function releasedParser(): Parser {
  let parser = releasedParserValue;
  if (parser === undefined) {
    parser = new Parser('/', '/', '', ScriptKind.TS, new ExternalModuleIndicatorOptions(false, false));
    releasedParserValue = parser;
  }
  return parser;
}

function getSpaceSuggestion(expressionText: string): string {
  for (const keyword of viableKeywordSuggestions)
    if (expressionText.length > keyword.length + 2 && expressionText.startsWith(keyword))
      return keyword + ' ' + expressionText.substring(keyword.length);
  return '';
}

function hasModifierOfKind(modifiers: ModifierList, kind: SyntaxKind): boolean {
  for (const m of modifiers.nodes) if (m.kind === kind) return true;
  return false;
}

function findKindIndex(nodes: readonly Node[], kind: SyntaxKind, start: number): number {
  for (let i = start; i < nodes.length; i++) if (nodes[i]!.kind === kind) return i;
  return -1;
}

function hasNonReparsedNode(nodes: readonly Node[]): boolean {
  for (const n of nodes) if ((n.flags & NodeFlags.Reparsed) === 0) return true;
  return false;
}

function hasModifierNode(nodes: readonly Node[]): boolean {
  for (const n of nodes) if (isModifierKind(n.kind)) return true;
  return false;
}

/** Go's Node.QuestionToken(): a question token field, or a postfix `?`. */
function getQuestionTokenOfNode(node: Node): Node | undefined {
  const token = getQuestionToken(node);
  if (token !== undefined) return token;
  const postfix = getPostfixToken(node);
  return postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken ? postfix : undefined;
}

function isDoubleQuotedString(node: Node): boolean {
  return node instanceof StringLiteral && ((node as StringLiteral).tokenFlags & TokenFlags.SingleQuote) === 0;
}

/** Whether a speculatively parsed return type means the arrow function parse should be abandoned. */
function typeHasArrowFunctionBlockingParseError(node: TypeNode): boolean {
  if (node instanceof TypeReferenceNode) return nodeIsMissing((node as TypeReferenceNode).typeName);
  // Separate checks: a union of classes can't be a receiver natively.
  if (node instanceof FunctionTypeNode)
    return (node as FunctionTypeNode).parameters.isMissingList || typeHasBlockingError((node as FunctionTypeNode).type);
  if (node instanceof ConstructorTypeNode)
    return (
      (node as ConstructorTypeNode).parameters.isMissingList || typeHasBlockingError((node as ConstructorTypeNode).type)
    );
  if (node instanceof ParenthesizedTypeNode)
    return typeHasArrowFunctionBlockingParseError((node as ParenthesizedTypeNode).type);
  return false;
}

function typeHasBlockingError(node: TypeNode | undefined): boolean {
  return node !== undefined && typeHasArrowFunctionBlockingParseError(node);
}

function attachFileToDiagnostics(diagnostics: Diagnostic[], file: SourceFile): readonly Diagnostic[] {
  if (diagnostics.length === 0) return emptyDiagnostics;
  const diagnosticFile = file.diagnosticFile();
  for (const d of diagnostics) {
    d.file = diagnosticFile;
    for (const r of d.relatedInformation) r.file = diagnosticFile;
  }
  return diagnostics;
}

/** The index of the first diagnostic at or after `pos`, starting at `start`, or -1. */
function findDiagnosticAtOrAfter(diagnostics: readonly Diagnostic[], start: number, pos: number): number {
  for (let i = start; i < diagnostics.length; i++) if (diagnostics[i]!.pos >= pos) return i;
  return -1;
}

// Lookahead callbacks for `Parser.lookAhead`.

function nextTokenIsSlash(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.SlashToken;
}

function scanTypeMemberStart(p: Parser): boolean {
  return p.scanTypeMemberStart();
}

function scanClassMemberStart(p: Parser): boolean {
  return p.scanClassMemberStart();
}

function scanStartOfDeclaration(p: Parser): boolean {
  return p.scanStartOfDeclaration();
}

function nextTokenIsTokenStringLiteral(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.StringLiteral;
}

function nextTokenIsBindingIdentifierOrStartOfDestructuring(p: Parser): boolean {
  p.nextToken();
  return (
    p.isBindingIdentifier() || p.token() === SyntaxKind.OpenBraceToken || p.token() === SyntaxKind.OpenBracketToken
  );
}

function nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLineDisallowOf(p: Parser): boolean {
  return p.nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLine(true);
}

function nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLineAllowOf(p: Parser): boolean {
  return p.nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLine(false);
}

function nextIsUsingKeywordThenBindingIdentifierOrStartOfObjectDestructuringOnSameLine(p: Parser): boolean {
  return (
    p.nextToken() === SyntaxKind.UsingKeyword && p.nextTokenIsBindingIdentifierOrStartOfDestructuringOnSameLine(false)
  );
}

function nextTokenIsEqualsOrSemicolonOrColonToken(p: Parser): boolean {
  const next = p.nextToken();
  return next === SyntaxKind.EqualsToken || next === SyntaxKind.SemicolonToken || next === SyntaxKind.ColonToken;
}

function nextIsIdentifierAndCloseParen(p: Parser): boolean {
  return nextTokenIsIdentifier(p) && p.nextToken() === SyntaxKind.CloseParenToken;
}

function nextTokenIsIdentifier(p: Parser): boolean {
  p.nextToken();
  return p.isIdentifier();
}

function nextTokenIsOpenParen(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.OpenParenToken;
}

function nextTokenIsOpenBrace(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.OpenBraceToken;
}

function nextIsNotDot(p: Parser): boolean {
  return p.nextToken() !== SyntaxKind.DotToken;
}

function nextTokenIsFromKeywordOrEqualsToken(p: Parser): boolean {
  const next = p.nextToken();
  return next === SyntaxKind.FromKeyword || next === SyntaxKind.EqualsToken;
}

function nextIsStartOfType(p: Parser): boolean {
  p.nextToken();
  return p.isStartOfType(false);
}

function nextTokenIsNumericOrBigIntLiteral(p: Parser): boolean {
  const next = p.nextToken();
  return next === SyntaxKind.NumericLiteral || next === SyntaxKind.BigIntLiteral;
}

function nextIsParenthesizedOrFunctionType(p: Parser): boolean {
  p.nextToken();
  return p.token() === SyntaxKind.CloseParenToken || p.isStartOfParameter(false) || p.isStartOfType(false);
}

function nextIsStartOfTypeOfImportType(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.ImportKeyword;
}

function nextIsStartOfMappedType(p: Parser): boolean {
  const next = p.nextToken();
  if (next === SyntaxKind.PlusToken || next === SyntaxKind.MinusToken)
    return p.nextToken() === SyntaxKind.ReadonlyKeyword;
  if (next === SyntaxKind.ReadonlyKeyword) p.nextToken();
  return (
    p.token() === SyntaxKind.OpenBracketToken && nextTokenIsIdentifier(p) && p.nextToken() === SyntaxKind.InKeyword
  );
}

function nextTokenIsOpenParenOrLessThan(p: Parser): boolean {
  const next = p.nextToken();
  return next === SyntaxKind.OpenParenToken || next === SyntaxKind.LessThanToken;
}

function nextTokenIsOpenParenOrLessThanOrDot(p: Parser): boolean {
  const next = p.nextToken();
  return next === SyntaxKind.OpenParenToken || next === SyntaxKind.LessThanToken || next === SyntaxKind.DotToken;
}

function nextIsUnambiguouslyIndexSignature(p: Parser): boolean {
  // Only `[id:` is allowed, but for error recovery also `[...`, `[id,`, `[id?,`, `[id?:`, `[id?]`,
  // `[public id`, `[private id`, `[protected id` and `[]`.
  const next = p.nextToken();
  if (next === SyntaxKind.DotDotDotToken || next === SyntaxKind.CloseBracketToken) return true;
  if (isModifierKind(next)) {
    p.nextToken();
    if (p.isIdentifier()) return true;
  } else if (!p.isIdentifier()) {
    return false;
  } else {
    // Skip the identifier.
    p.nextToken();
  }
  // A colon is a well-formed indexer; a comma a badly formed one, since computed properties can't
  // contain comma expressions.
  if (p.token() === SyntaxKind.ColonToken || p.token() === SyntaxKind.CommaToken) return true;
  // `?` could be an optional indexer or a conditional expression in a computed property.
  if (p.token() !== SyntaxKind.QuestionToken) return false;
  // These can't follow the `?` of a conditional expression.
  const afterQuestion = p.nextToken();
  return (
    afterQuestion === SyntaxKind.ColonToken ||
    afterQuestion === SyntaxKind.CommaToken ||
    afterQuestion === SyntaxKind.CloseBracketToken
  );
}

function scanStartOfNamedTupleElement(p: Parser): boolean {
  if (p.token() === SyntaxKind.DotDotDotToken)
    return tokenIsIdentifierOrKeyword(p.nextToken()) && nextTokenIsColonOrQuestionColon(p);
  return tokenIsIdentifierOrKeyword(p.token()) && nextTokenIsColonOrQuestionColon(p);
}

function nextTokenIsColonOrQuestionColon(p: Parser): boolean {
  return (
    p.nextToken() === SyntaxKind.ColonToken ||
    (p.token() === SyntaxKind.QuestionToken && p.nextToken() === SyntaxKind.ColonToken)
  );
}

function nextIsUnambiguouslyStartOfFunctionType(p: Parser): boolean {
  const next = p.nextToken();
  // `( )` and `( ...`
  if (next === SyntaxKind.CloseParenToken || next === SyntaxKind.DotDotDotToken) return true;
  if (p.skipParameterStart()) {
    // After modifiers and a name or binding pattern: `( xxx :`, `( xxx ,`, `( xxx ?` and `( xxx =`.
    const token = p.token();
    if (
      token === SyntaxKind.ColonToken ||
      token === SyntaxKind.CommaToken ||
      token === SyntaxKind.QuestionToken ||
      token === SyntaxKind.EqualsToken
    )
      return true;
    // `( xxx ) =>`
    if (token === SyntaxKind.CloseParenToken && p.nextToken() === SyntaxKind.EqualsGreaterThanToken) return true;
  }
  return false;
}

function nextTokenIsNewKeyword(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.NewKeyword;
}

function nextTokenIsOnSameLineAndCanFollowModifier(p: Parser): boolean {
  return p.nextTokenIsOnSameLineAndCanFollowModifier();
}

function nextTokenCanFollowDefaultKeyword(p: Parser): boolean {
  return p.nextTokenCanFollowDefaultKeyword();
}

function nextTokenCanFollowExportModifier(p: Parser): boolean {
  p.nextToken();
  return p.canFollowExportModifier();
}

function nextTokenIsClassKeywordOnSameLine(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.ClassKeyword && !p.hasPrecedingLineBreak();
}

function nextTokenIsIsKeywordOnSameLine(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.IsKeyword && !p.hasPrecedingLineBreak();
}

function nextTokenIsFunctionKeywordOnSameLine(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.FunctionKeyword && !p.hasPrecedingLineBreak();
}

function nextTokenIsIdentifierOrKeyword(p: Parser): boolean {
  return tokenIsIdentifierOrKeyword(p.nextToken());
}

function nextTokenIsIdentifierOrKeywordOrGreaterThan(p: Parser): boolean {
  return tokenIsIdentifierOrKeywordOrGreaterThan(p.nextToken());
}

function nextTokenIsIdentifierOrKeywordOnSameLine(p: Parser): boolean {
  return nextTokenIsIdentifierOrKeyword(p) && !p.hasPrecedingLineBreak();
}

function nextTokenIsIdentifierOrKeywordOrLiteralOnSameLine(p: Parser): boolean {
  if (!nextTokenIsIdentifierOrKeyword(p)) {
    const token = p.token();
    if (token !== SyntaxKind.NumericLiteral && token !== SyntaxKind.BigIntLiteral && token !== SyntaxKind.StringLiteral)
      return false;
  }
  return !p.hasPrecedingLineBreak();
}

function nextIsValidHeritageClauseObjectLiteral(p: Parser): boolean {
  if (p.nextToken() === SyntaxKind.CloseBraceToken) {
    // `extends {}` is the extended type (not the class body) in `extends {} {`, `extends {},`,
    // `extends {} extends` and `extends {} implements`.
    const next = p.nextToken();
    return (
      next === SyntaxKind.CommaToken ||
      next === SyntaxKind.OpenBraceToken ||
      next === SyntaxKind.ExtendsKeyword ||
      next === SyntaxKind.ImplementsKeyword
    );
  }
  return true;
}

function nextIsStartOfExpression(p: Parser): boolean {
  p.nextToken();
  return p.isStartOfExpression();
}

function nextTokenIsDot(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.DotToken;
}

function nextTokenIsIdentifierOrKeywordOrOpenBracketOrTemplate(p: Parser): boolean {
  p.nextToken();
  return (
    tokenIsIdentifierOrKeyword(p.token()) ||
    p.token() === SyntaxKind.OpenBracketToken ||
    p.isTemplateStartOfTaggedTemplate()
  );
}

function nextIsUnParenthesizedAsyncArrowFunction(p: Parser): boolean {
  // async [no LineTerminator here] AsyncArrowBindingIdentifier [no LineTerminator here] => AsyncConciseBody
  if (p.token() === SyntaxKind.AsyncKeyword) {
    p.nextToken();
    // `async =>` is a simple arrow function with a parameter named `async`.
    if (p.hasPrecedingLineBreak() || p.token() === SyntaxKind.EqualsGreaterThanToken) return false;
    // The binary expression after `async` is a lone identifier followed by `=>` only when an identifier
    // token is followed by `=>`. Any other first token starts another kind of expression or none, and any
    // other token after the identifier continues the expression or ends it before `=>`. Checking the
    // tokens gives the same answer as parsing the expression, whose nodes would be discarded.
    if (!p.isIdentifier()) return false;
    p.nextToken();
    return !p.hasPrecedingLineBreak() && p.token() === SyntaxKind.EqualsGreaterThanToken;
  }
  return false;
}

/** In JSX, `<T,` `<T =` and `<T extends U>` start generic arrow functions, but `<T extends=` is an attribute. */
function isArrowFunctionInJsx(p: Parser): boolean {
  p.parseOptional(SyntaxKind.ConstKeyword);
  const third = p.nextToken();
  if (third === SyntaxKind.ExtendsKeyword) {
    switch (p.nextToken()) {
      case SyntaxKind.EqualsToken:
      case SyntaxKind.GreaterThanToken:
      case SyntaxKind.SlashToken:
        return false;
    }
    return true;
  }
  return third === SyntaxKind.CommaToken || third === SyntaxKind.EqualsToken;
}

function nextTokenIsNumericLiteralNotFollowedByColon(p: Parser): boolean {
  return p.nextToken() === SyntaxKind.NumericLiteral && p.nextToken() !== SyntaxKind.ColonToken;
}

function nextTokenIsNotColon(p: Parser): boolean {
  return p.nextToken() !== SyntaxKind.ColonToken;
}

// Pragmas

function getCommentPragmas(sourceText: string): readonly Pragma[] {
  const ranges = getLeadingCommentRanges(sourceText, 0);
  if (ranges === undefined) return emptyPragmas;
  const pragmas: Pragma[] = [];
  for (const range of ranges) extractPragmas(range, sourceText.substring(range.pos, range.end), pragmas);
  return pragmas.length === 0 ? emptyPragmas : pragmas;
}

function extractPragmas(range: CommentRange, text: string, pragmas: Pragma[]): void {
  if (range.kind === SyntaxKind.SingleLineCommentTrivia) {
    let pos = 2;
    const tripleSlash = text.startsWith('/', pos);
    if (tripleSlash) pos++;
    pos = skipBlanks(text, pos);
    if (tripleSlash && text.startsWith('<', pos)) {
      if (extractName(text, pos + 1) !== 'reference') return;
      pos += 10;
      const args = new Map<string, PragmaArgument>();
      for (;;) {
        pos = skipBlanks(text, pos);
        if (text.startsWith('/>', pos)) break;
        const argName = extractName(text, pos);
        if (argName === '') break;
        pos = skipBlanks(text, pos + argName.length);
        if (!text.startsWith('=', pos)) break;
        pos = skipBlanks(text, pos + 1);
        const valueEnd = quotedStringEnd(text, pos);
        if (valueEnd < 0) break;
        const value = text.substring(pos + 1, valueEnd);
        args.set(argName, new PragmaArgument(range.pos + pos + 1, range.pos + pos + 1 + value.length, argName, value));
        pos += value.length + 2;
      }
      pragmas.push(new Pragma(range, 'reference', args));
      return;
    }
    if (text.startsWith('@', pos)) {
      const pragmaName = extractName(text, pos + 1);
      if (pragmaName === 'ts-check' || pragmaName === 'ts-nocheck')
        pragmas.push(new Pragma(range, pragmaName, new Map()));
    }
    return;
  }
  if (range.kind === SyntaxKind.MultiLineCommentTrivia) {
    if (text.endsWith('*/')) text = text.substring(0, text.length - 2);
    let pos = 2;
    for (;;) {
      pos = pos >= text.length ? -1 : text.indexOf('@', pos);
      if (pos < 0) break;
      // Like TypeScript's /@(\S+)(\s+(?:\S.*)?)?$/gm: a non-blank name right after `@`, with the rest of
      // the line as its arguments. Only the first `@` of a line counts, so an earlier `@token` (an email
      // address, say) hides a later `@jsx` on the same line.
      const namePos = pos + 1;
      const nameEnd = skipNonBlanks(text, namePos);
      if (nameEnd === namePos) {
        pos++;
        continue;
      }
      const lineEnd = lineEndPos(text, pos);
      const pragmaName = text.substring(namePos, nameEnd).toLowerCase();
      if (
        pragmaName === 'jsx' ||
        pragmaName === 'jsxfrag' ||
        pragmaName === 'jsximportsource' ||
        pragmaName === 'jsxruntime'
      ) {
        const start = skipBlanks(text, nameEnd);
        const argEnd = skipNonBlanks(text, start);
        if (argEnd !== start) {
          const args = new Map<string, PragmaArgument>();
          args.set(
            'factory',
            new PragmaArgument(range.pos + start, range.pos + argEnd, 'factory', text.substring(start, argEnd)),
          );
          pragmas.push(new Pragma(range, pragmaName, args));
        }
      }
      pos = lineEnd;
    }
  }
}

function skipBlanks(text: string, pos: number): number {
  while (pos < text.length) {
    const ch = text.charCodeAt(pos);
    if (ch !== CharacterCodes.space && ch !== CharacterCodes.tab) break;
    pos++;
  }
  return pos;
}

function skipNonBlanks(text: string, pos: number): number {
  while (pos < text.length) {
    const ch = text.charCodeAt(pos);
    if (
      ch === CharacterCodes.space ||
      ch === CharacterCodes.tab ||
      ch === CharacterCodes.carriageReturn ||
      ch === CharacterCodes.lineFeed
    )
      break;
    pos++;
  }
  return pos;
}

function lineEndPos(text: string, pos: number): number {
  while (pos < text.length) {
    if (isLineBreak(text.charCodeAt(pos))) return pos;
    pos++;
  }
  return text.length;
}

/** A lowercased run of ASCII letters and `-`. */
function extractName(text: string, pos: number): string {
  const start = pos;
  while (pos < text.length) {
    const ch = text.charCodeAt(pos);
    if (
      !(
        (ch >= CharacterCodes.A && ch <= CharacterCodes.Z) ||
        (ch >= CharacterCodes.a && ch <= CharacterCodes.z) ||
        ch === CharacterCodes.minus
      )
    )
      break;
    pos++;
  }
  return text.substring(start, pos).toLowerCase();
}

/** The position of the closing quote of a quoted string at `pos`, or -1. */
function quotedStringEnd(text: string, pos: number): number {
  if (pos === text.length) return -1;
  const quote = text.charCodeAt(pos);
  if (quote !== CharacterCodes.singleQuote && quote !== CharacterCodes.doubleQuote) return -1;
  pos++;
  while (pos < text.length && text.charCodeAt(pos) !== quote) pos++;
  return pos === text.length ? -1 : pos;
}

// Module references

/** Fills in `imports`, `moduleAugmentations` and `ambientModuleNames`. */
function collectExternalModuleReferences(file: SourceFile): void {
  for (const node of file.statements.nodes) collectModuleReferences(file, node, false);
  if ((file.flags & NodeFlags.PossiblyContainsDynamicImport) !== 0 || isInJSFile(file))
    collectDynamicImportOrRequireCalls(file);
}

function collectModuleReferences(file: SourceFile, node: Statement, inAmbientModule: boolean): void {
  if (isAnyImportOrReExport(node)) {
    const moduleNameExpr = getExternalModuleName(node);
    if (moduleNameExpr instanceof StringLiteral) {
      const moduleName = (moduleNameExpr as StringLiteral).text;
      if (moduleName !== '' && (!inAmbientModule || !isExternalModuleNameRelative(moduleName))) {
        file.imports.push(moduleNameExpr);
        if (file.usesUriStyleNodeCoreModules !== Tristate.True && !file.isDeclarationFile) {
          if (moduleName.startsWith('node:') && !exclusivelyPrefixedNodeCoreModules.has(moduleName))
            file.usesUriStyleNodeCoreModules = Tristate.True;
          else if (file.usesUriStyleNodeCoreModules === Tristate.Unknown && unprefixedNodeCoreModules.has(moduleName))
            file.usesUriStyleNodeCoreModules = Tristate.False;
        }
      }
    }
    return;
  }
  if (
    node instanceof ModuleDeclaration &&
    isAmbientModule(node) &&
    (inAmbientModule || hasModifierFlag(node, ModifierFlags.Ambient) || file.isDeclarationFile)
  ) {
    const nameText = getText((node as ModuleDeclaration).name);
    if (file.externalModuleIndicator !== undefined || (inAmbientModule && !isExternalModuleNameRelative(nameText))) {
      file.moduleAugmentations = appendToList(file.moduleAugmentations, (node as ModuleDeclaration).name);
    } else if (!inAmbientModule) {
      file.ambientModuleNames = appendToList(file.ambientModuleNames, nameText);
      const body = (node as ModuleDeclaration).body;
      if (body !== undefined) {
        const statements = getStatements(body);
        if (statements !== undefined)
          for (const statement of statements.nodes) collectModuleReferences(file, statement, true);
      }
    }
  }
}

function hasModifierFlag(node: Node, flags: ModifierFlags): boolean {
  const modifiers = getModifiers(node);
  return modifiers !== undefined && (modifiers.modifierFlags & flags) !== 0;
}

/** Adds the specifiers of `import(…)` calls, `import("…")` types and, in JS files, `require(…)` calls. */
function collectDynamicImportOrRequireCalls(file: SourceFile): void {
  const text = file.text;
  const isJavaScriptFile = isInJSFile(file);
  // Visit every `import` and `require` in text order. Native substring searches find them faster
  // than reading each code unit; each search resumes only once the visit has passed its match.
  let nextImport = text.indexOf('import');
  let nextRequire = text.indexOf('require');
  while (nextImport >= 0 || nextRequire >= 0) {
    const isImport = nextRequire < 0 || (nextImport >= 0 && nextImport < nextRequire);
    const index = isImport ? nextImport : nextRequire;
    const node = getNodeAtPosition(file, index, isJavaScriptFile);
    if (isJavaScriptFile && node instanceof CallExpression && isRequireCall(node, true)) {
      file.imports.push((node as CallExpression).arguments.nodes[0]!);
    } else if (
      node instanceof CallExpression &&
      isImportCall(node) &&
      (node as CallExpression).arguments.nodes.length > 0 &&
      isStringLiteralLike((node as CallExpression).arguments.nodes[0]!)
    ) {
      file.imports.push((node as CallExpression).arguments.nodes[0]!);
    } else if (node instanceof ImportTypeNode) {
      const literal = getImportTypeNodeLiteral(node);
      if (literal !== undefined) file.imports.push(literal);
    }
    // Skip past `import` or `require`.
    const resume = index + (isImport ? 6 : 7);
    if (nextImport >= 0 && nextImport < resume) nextImport = text.indexOf('import', resume);
    if (nextRequire >= 0 && nextRequire < resume) nextRequire = text.indexOf('require', resume);
  }
}

class PositionFinder extends NodeVisitor {
  position = 0;
  found: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    if (nodeContainsPosition(node, this.position)) {
      this.found = node;
      return true;
    }
    return false;
  }
}

function nodeContainsPosition(node: Node, position: number): boolean {
  return (
    node.kind >= SyntaxKind.FirstNode &&
    node.pos <= position &&
    (position < node.end || (position === node.end && node.kind === SyntaxKind.EndOfFile))
  );
}

/** The innermost node containing `position`, stopping at meta properties. */
export function getNodeAtPosition(file: SourceFile, position: number, includeJSDoc: boolean): Node {
  const finder = new PositionFinder();
  finder.position = position;
  let current: Node = file;
  for (;;) {
    let child: Node | undefined;
    if (includeJSDoc) {
      const jsDoc =
        (current.flags & NodeFlags.HasJSDoc) === 0 || file.jsDocs === undefined
          ? undefined
          : file.jsDocs.get(current.id);
      if (jsDoc !== undefined)
        for (const doc of jsDoc)
          if (nodeContainsPosition(doc, position)) {
            child = doc;
            break;
          }
    }
    if (child === undefined) {
      finder.found = undefined;
      current.forEachChild(finder);
      child = finder.found;
    }
    if (child === undefined || child.kind === SyntaxKind.MetaProperty) return current;
    current = child;
  }
}

class JsxTagFinder extends NodeVisitor {
  found: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    if (
      node.kind === SyntaxKind.JsxOpeningElement ||
      node.kind === SyntaxKind.JsxSelfClosingElement ||
      node.kind === SyntaxKind.JsxFragment
    ) {
      this.found = node;
      return true;
    }
    return node.forEachChild(this);
  }
}

class ImportMetaFinder extends NodeVisitor {
  found: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    if (isImportMeta(node)) {
      this.found = node;
      return true;
    }
    return node.forEachChild(this);
  }
}

function isAnExternalModuleIndicatorNode(node: Node): boolean {
  return (
    hasModifierFlag(node, ModifierFlags.Export) ||
    (node instanceof ImportEqualsDeclaration &&
      (node as ImportEqualsDeclaration).moduleReference.kind === SyntaxKind.ExternalModuleReference) ||
    node.kind === SyntaxKind.ImportDeclaration ||
    node.kind === SyntaxKind.ExportAssignment ||
    node.kind === SyntaxKind.ExportDeclaration
  );
}

function getExternalModuleIndicator(file: SourceFile): Node | undefined {
  if (file.scriptKind === ScriptKind.JSON) return undefined;
  for (const statement of file.statements.nodes) if (isAnExternalModuleIndicatorNode(statement)) return statement;
  if ((file.flags & NodeFlags.PossiblyContainsImportMeta) !== 0) {
    const finder = new ImportMetaFinder();
    file.forEachChild(finder);
    if (finder.found !== undefined) return finder.found;
  }
  if (file.isDeclarationFile) return undefined;
  const options = file.externalModuleIndicatorOptions;
  if (options.jsx) {
    const finder = new JsxTagFinder();
    file.forEachChild(finder);
    if (finder.found !== undefined) return finder.found;
  }
  if (options.force) return file;
  return undefined;
}

function setExternalModuleIndicator(file: SourceFile): void {
  file.externalModuleIndicator = getExternalModuleIndicator(file);
}

/** Whether `moduleName` names a Node.js core module, with or without the `node:` prefix. */
export function isNodeCoreModule(moduleName: string): boolean {
  return (
    unprefixedNodeCoreModules.has(moduleName) ||
    exclusivelyPrefixedNodeCoreModules.has(moduleName) ||
    (moduleName.startsWith('node:') && unprefixedNodeCoreModules.has(moduleName.substring(5)))
  );
}

// `require('module').builtinModules`, without and with only the `node:` prefix.
const unprefixedNodeCoreModules = new Set<string>([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const exclusivelyPrefixedNodeCoreModules = new Set<string>([
  'node:quic',
  'node:sea',
  'node:sqlite',
  'node:test',
  'node:test/reporters',
]);
