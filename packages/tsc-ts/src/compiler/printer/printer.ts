// Prints syntax trees as source text the way tsgo's printer does: formatting, comments,
// source maps, generated names and emit helpers.
import {
  ArrayLiteralExpression,
  ArrowFunction,
  AsExpression,
  AwaitExpression,
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
  EmptyStatement,
  EnumDeclaration,
  EnumMember,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  ExternalModuleReference,
  type FileReference,
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
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  JSDocVariadicType,
  JsxAttribute,
  JsxAttributes,
  JsxClosingElement,
  JsxElement,
  JsxExpression,
  JsxFragment,
  JsxNamespacedName,
  JsxOpeningElement,
  JsxSelfClosingElement,
  JsxSpreadAttribute,
  JsxText,
  LabeledStatement,
  LiteralTypeNode,
  MappedTypeNode,
  MetaProperty,
  MethodDeclaration,
  MethodSignatureDeclaration,
  type ModifierList,
  ModuleBlock,
  ModuleDeclaration,
  NamedExports,
  NamedImports,
  NamedTupleMember,
  NamespaceExport,
  NamespaceExportDeclaration,
  NamespaceImport,
  NewExpression,
  type Node,
  NodeList,
  NodeFlags,
  NonNullExpression,
  NumericLiteral,
  ObjectLiteralExpression,
  OptionalTypeNode,
  ParameterDeclaration,
  ParenthesizedExpression,
  ParenthesizedTypeNode,
  PartiallyEmittedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  QualifiedName,
  RestTypeNode,
  ReturnStatement,
  SatisfiesExpression,
  ScriptKind,
  SetAccessorDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  SwitchStatement,
  TaggedTemplateExpression,
  TemplateExpression,
  TemplateLiteralTypeNode,
  TemplateLiteralTypeSpan,
  TemplateSpan,
  ThrowStatement,
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
  ArrayTypeNode,
  getName,
  getParameters,
  getTypeParameters,
  getTypeArguments,
  getArguments,
  getElements,
  getProperties,
  getStatements,
  getModifiers,
  callQuestionDotToken,
  callTypeArguments,
} from '../ast.js';
import { OperatorPrecedence } from '../ast-utilities.js';
import {
  computeLineOfPosition,
  computeLineStarts,
  getLeadingCommentRanges,
  getShebang,
  getTrailingCommentRanges,
  skipTrivia,
  tokenToString,
} from '../scanner.js';
import { SyntaxKind } from '../syntax-kind.js';
import { type CommentRange, TokenFlags } from '../types.js';
import { ScriptTarget } from '../options.js';
import { fileExtensionIs } from '../path.js';
import { CharacterCodes, isWhiteSpaceLike } from '../character-codes.js';
import type { SourceMapGenerator } from '../sourcemap.js';
import { EmitContext, compareEmitHelpers, type SynthesizedComment } from './emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from './emit-flags.js';
import { NameGenerator, NameGeneratorHost, isFileLevelUniqueName } from './name-generator.js';
import { TextWriter } from './text-writer.js';
import {
  LiteralTextFlags,
  TypePrecedence,
  blockScopeFlags,
  calculateIndent,
  escapeString,
  getExpressionPrecedence,
  getLeftmostExpression,
  getLinesBetweenPositions,
  getLiteralText,
  getPreviousNonWhitespacePosition,
  getSourceFileOfNode,
  getSourceTextOfNode,
  getStartPositionOfRange,
  getTypeNodePrecedence,
  isBinaryOperation,
  isExpression,
  isImmediatelyInvokedFunctionExpressionOrArrowFunction,
  isJSDocKind,
  isJSDocLikeText,
  isKeywordKind,
  isLineBreakChar,
  isLiteralKind,
  isMemberName,
  isModifier,
  isNewExpressionWithoutArguments,
  isOptionalChain,
  isParseTreeNode,
  isPinnedComment,
  isPrologueDirective,
  isPunctuationKind,
  isRecognizedTripleSlashComment,
  isStatement,
  isTypeNodeKind,
  mixingBinaryOperatorsRequiresParentheses,
  nodeIsSynthesized,
  positionIsSynthesized,
  skipPartiallyEmittedExpressions,
  skipSynthesizedParentheses,
  trimUnicodeSpace,
} from './utilities.js';

export class PrinterOptions {
  removeComments: boolean;
  /** `"\n"` or `"\r\n"`. */
  newLine: string;
  noEmitHelpers: boolean;
  target: ScriptTarget;
  sourceMap: boolean;
  inlineSourceMap: boolean;
  inlineSources: boolean;
  omitBraceSourceMapPositions: boolean;
  /** Only keep JSDoc-style and pinned comments (declaration emit). */
  onlyPrintJSDocStyle: boolean;
  neverAsciiEscape: boolean;
  preserveSourceNewlines: boolean;
  terminateUnterminatedLiterals: boolean;

  constructor() {
    this.removeComments = false;
    this.newLine = '\n';
    this.noEmitHelpers = false;
    this.target = ScriptTarget.ES5;
    this.sourceMap = false;
    this.inlineSourceMap = false;
    this.inlineSources = false;
    this.omitBraceSourceMapPositions = false;
    this.onlyPrintJSDocStyle = false;
    this.neverAsciiEscape = false;
    this.preserveSourceNewlines = false;
    this.terminateUnterminatedLiterals = false;
  }
}

export const enum ListFormat {
  None = 0,
  MultiLine = 1 << 0,
  PreserveLines = 1 << 1,
  LinesMask = MultiLine | PreserveLines,
  BarDelimited = 1 << 2,
  AmpersandDelimited = 1 << 3,
  CommaDelimited = 1 << 4,
  AsteriskDelimited = 1 << 5,
  DelimitersMask = BarDelimited | AmpersandDelimited | CommaDelimited | AsteriskDelimited,
  AllowTrailingComma = 1 << 6,
  Indented = 1 << 7,
  SpaceBetweenBraces = 1 << 8,
  SpaceBetweenSiblings = 1 << 9,
  Braces = 1 << 10,
  Parenthesis = 1 << 11,
  AngleBrackets = 1 << 12,
  SquareBrackets = 1 << 13,
  BracketsMask = Braces | Parenthesis | AngleBrackets | SquareBrackets,
  OptionalIfNil = 1 << 14,
  OptionalIfEmpty = 1 << 15,
  Optional = OptionalIfNil | OptionalIfEmpty,
  PreferNewLine = 1 << 16,
  NoTrailingNewLine = 1 << 17,
  NoInterveningComments = 1 << 18,
  NoSpaceIfEmpty = 1 << 19,
  SingleElement = 1 << 20,
  SpaceAfterList = 1 << 21,

  Modifiers = SpaceBetweenSiblings | NoInterveningComments | SpaceAfterList,
  HeritageClauses = SpaceBetweenSiblings,
  SingleLineTypeLiteralMembers = SpaceBetweenBraces | SpaceBetweenSiblings,
  MultiLineTypeLiteralMembers = MultiLine | Indented | OptionalIfEmpty,
  SingleLineTupleTypeElements = CommaDelimited | SpaceBetweenSiblings,
  MultiLineTupleTypeElements = CommaDelimited | Indented | SpaceBetweenSiblings | MultiLine,
  UnionTypeConstituents = BarDelimited | SpaceBetweenSiblings,
  IntersectionTypeConstituents = AmpersandDelimited | SpaceBetweenSiblings,
  ObjectBindingPatternElements = AllowTrailingComma |
    SpaceBetweenBraces |
    CommaDelimited |
    SpaceBetweenSiblings |
    NoSpaceIfEmpty,
  ArrayBindingPatternElements = AllowTrailingComma | CommaDelimited | SpaceBetweenSiblings | NoSpaceIfEmpty,
  ObjectLiteralExpressionProperties = PreserveLines |
    CommaDelimited |
    SpaceBetweenSiblings |
    SpaceBetweenBraces |
    Indented |
    Braces |
    NoSpaceIfEmpty,
  ImportAttributes = PreserveLines |
    CommaDelimited |
    SpaceBetweenSiblings |
    SpaceBetweenBraces |
    Indented |
    Braces |
    NoSpaceIfEmpty,
  ArrayLiteralExpressionElements = PreserveLines |
    CommaDelimited |
    SpaceBetweenSiblings |
    AllowTrailingComma |
    Indented |
    SquareBrackets,
  CommaListElements = CommaDelimited | SpaceBetweenSiblings,
  CallExpressionArguments = CommaDelimited | SpaceBetweenSiblings | Parenthesis,
  NewExpressionArguments = CommaDelimited | SpaceBetweenSiblings | Parenthesis | OptionalIfNil,
  TemplateExpressionSpans = NoInterveningComments,
  SingleLineBlockStatements = SpaceBetweenBraces | SpaceBetweenSiblings,
  MultiLineBlockStatements = Indented | MultiLine,
  VariableDeclarationList = CommaDelimited | SpaceBetweenSiblings,
  SingleLineFunctionBodyStatements = SpaceBetweenSiblings | SpaceBetweenBraces,
  MultiLineFunctionBodyStatements = MultiLine,
  ClassHeritageClauses = None,
  ClassMembers = Indented | MultiLine,
  InterfaceMembers = Indented | MultiLine,
  EnumMembers = CommaDelimited | Indented | MultiLine,
  CaseBlockClauses = Indented | MultiLine,
  NamedImportsOrExportsElements = CommaDelimited |
    SpaceBetweenSiblings |
    AllowTrailingComma |
    SpaceBetweenBraces |
    NoSpaceIfEmpty,
  JsxElementOrFragmentChildren = NoInterveningComments,
  JsxElementAttributes = SpaceBetweenSiblings | NoInterveningComments,
  CaseOrDefaultClauseStatements = Indented | MultiLine | NoTrailingNewLine | OptionalIfEmpty,
  HeritageClauseTypes = CommaDelimited | SpaceBetweenSiblings,
  SourceFileStatements = MultiLine | NoTrailingNewLine,
  Decorators = MultiLine | Optional | SpaceAfterList,
  TypeArguments = CommaDelimited | SpaceBetweenSiblings | AngleBrackets | Optional,
  TypeParameters = CommaDelimited | SpaceBetweenSiblings | AngleBrackets | Optional,
  Parameters = CommaDelimited | SpaceBetweenSiblings | Parenthesis,
  SingleArrowParameter = CommaDelimited | SpaceBetweenSiblings,
  IndexSignatureParameters = CommaDelimited | SpaceBetweenSiblings | Indented | SquareBrackets,
  JSDocComment = MultiLine | AsteriskDelimited,
}

/** What `emitList` emits each element as. */
const enum ListItem {
  Keyword,
  ModifierLike,
  TypeParameter,
  Parameter,
  TypeElement,
  ClassElement,
  ObjectLiteralElement,
  TypeArgument,
  UnionConstituent,
  TemplateTypeSpan,
  ImportAttribute,
  BindingElement,
  ArrayElement,
  Argument,
  TemplateSpan,
  Statement,
  VariableDeclaration,
  HeritageClause,
  EnumMember,
  CaseOrDefaultClause,
  ImportSpecifier,
  ExportSpecifier,
  ExpressionWithTypeArguments,
  JsxChild,
  JsxAttributeLike,
}

const enum TokenEmitFlags {
  None = 0,
  NoComments = 1 << 0,
  IndentLeadingComments = 1 << 1,
  NoSourceMaps = 1 << 2,
}

const enum CommentSeparator {
  None,
  Before,
  After,
}

/** Bits of the state `enterNode`/`enterToken` push on the comment and source map stacks. */
const enum State {
  None = 0,
  Comments = 1 << 0,
  SourceMaps = 1 << 1,
}

/** The saved emit flags of a node whose comments were not looked for (`Printer.inCommentFreeRange`). */
const commentFreeNode = -1;

export class Printer extends NameGeneratorHost {
  readonly options: PrinterOptions;
  readonly context: EmitContext;
  /**
   * Generates the names of the printed file, created when first needed: it refers back to the printer (its host),
   * and printing a type node never generates names.
   */
  private nameGeneratorStore: NameGenerator | undefined = undefined;
  currentSourceFile: SourceFile | undefined;
  private sourceText: string;
  private lineStarts: readonly number[];
  /**
   * The line of the last `lineOf` lookup, `lookupLine`, and the positions it spans, `[lookupLineStart, lookupLineEnd)`,
   * with `lookupLineEnd` -1 after the last line: printing reads positions mostly in order, so most lookups fall on that line.
   */
  private lookupLine: number;
  private lookupLineStart: number;
  private lookupLineEnd: number;
  private writer: TextWriter;
  private ownWriter: TextWriter | undefined;
  private uniqueHelperNames: Map<string, Identifier> | undefined;
  private externalHelpersModuleName: Identifier | undefined;
  private nextListElementPos: number;
  private containerPos: number;
  private containerEnd: number;
  private declarationListContainerEnd: number;
  /** Pairs of (node pos, end of its detached comments). */
  private readonly detachedComments: number[];
  private commentsDisabled: boolean;
  /** Emitting the `extends` clause of a conditional or infer type. */
  private inExtends: boolean;
  /**
   * Saved comment state, 32-bit values: emit flags, comment pos, comment end, container pos, container end,
   * declaration list end.
   * Flags are `commentFreeNode` for a node that `emitCommentsBeforeNode` handled in a comment-free range.
   */
  private commentStack: Int32Array;
  /** The used length of `commentStack`: entries are written in place and kept for reuse once popped. */
  private commentDepth: number;
  /** Start positions of `//` and `/*` in `sourceText`, ascending; made on first use for each file. */
  private commentStarts: Int32Array | undefined;
  /**
   * A range of `sourceText`, `[freeStart, freeEnd)`, where no comment starts and the last character is not trivia,
   * so no comment is found from any position in it; -1 when there is none. `freeOwner` is the node it was made for.
   */
  private freeStart: number;
  private freeEnd: number;
  /** Whether no trailing comment follows `freeEnd`. */
  private freeEndTrailingNone: boolean;
  private freeOwner: Node | undefined;
  /** Saved source map state: emit flags, pos, end, has token range. */
  private readonly sourceMapStack: number[];
  /** The token position after `enterToken` skipped trivia. */
  private tokenPos: number;

  private sourceMapsDisabled: boolean;
  private sourceMapGenerator: SourceMapGenerator | undefined;
  private sourceMapSource: SourceFile | undefined;
  private sourceMapSourceIndex: number;
  private sourceMapSourceIsJson: boolean;
  private sourceMapLineStarts: readonly number[];
  /** The line of the last source map position, where finding the next one's starts. */
  private sourceMapLine: number;
  private mostRecentSourceMapSource: SourceFile | undefined;
  private mostRecentSourceMapSourceIndex: number;

  get nameGenerator(): NameGenerator {
    let generator = this.nameGeneratorStore;
    if (generator === undefined) {
      generator = new NameGenerator(this.context, this);
      this.nameGeneratorStore = generator;
    }
    return generator;
  }

  constructor(options: PrinterOptions, context: EmitContext | undefined) {
    super();
    this.options = options;
    this.context = context === undefined ? new EmitContext() : context;
    this.currentSourceFile = undefined;
    this.sourceText = '';
    this.lineStarts = [];
    this.lookupLine = -1;
    this.lookupLineStart = 0;
    this.lookupLineEnd = 0;
    this.writer = new TextWriter(options.newLine, 4);
    this.ownWriter = undefined;
    this.uniqueHelperNames = undefined;
    this.externalHelpersModuleName = undefined;
    this.nextListElementPos = 0;
    this.containerPos = -1;
    this.containerEnd = -1;
    this.declarationListContainerEnd = -1;
    this.detachedComments = [];
    this.commentsDisabled = options.removeComments;
    this.inExtends = false;
    this.commentStack = new Int32Array(96);
    this.commentDepth = 0;
    this.commentStarts = undefined;
    this.freeStart = -1;
    this.freeEnd = -1;
    this.freeEndTrailingNone = false;
    this.freeOwner = undefined;
    this.sourceMapStack = [];
    this.tokenPos = 0;
    this.sourceMapsDisabled = true;
    this.sourceMapGenerator = undefined;
    this.sourceMapSource = undefined;
    this.sourceMapSourceIndex = -1;
    this.sourceMapSourceIsJson = false;
    this.sourceMapLineStarts = [];
    this.sourceMapLine = 0;
    this.mostRecentSourceMapSource = undefined;
    this.mostRecentSourceMapSourceIndex = -1;
  }

  // Entry points

  /** Prints `node` (in the context of `sourceFile`, if given) and returns the text. */
  emit(node: Node, sourceFile: SourceFile | undefined): string {
    let writer = this.ownWriter;
    if (writer === undefined) {
      writer = new TextWriter(this.options.newLine, 4);
      this.ownWriter = writer;
    }
    this.write(node, sourceFile, writer, undefined);
    const text = writer.getText();
    writer.clear();
    return text;
  }

  emitSourceFile(sourceFile: SourceFile): string {
    return this.emit(sourceFile, sourceFile);
  }

  private setSourceFile(sourceFile: SourceFile | undefined): boolean {
    this.setCurrentSourceFile(sourceFile);
    this.uniqueHelperNames = undefined;
    this.externalHelpersModuleName = undefined;
    if (sourceFile !== undefined) {
      if ((this.context.getEmitFlags(this.context.mostOriginal(sourceFile)) & EmitFlags.ExternalHelpers) !== 0)
        this.uniqueHelperNames = new Map<string, Identifier>();
      this.externalHelpersModuleName = this.context.getExternalHelpersModuleName(sourceFile);
      this.setSourceMapSource(sourceFile);
    }
    return true;
  }

  private setCurrentSourceFile(sourceFile: SourceFile | undefined): boolean {
    this.currentSourceFile = sourceFile;
    this.sourceText = sourceFile === undefined ? '' : sourceFile.text;
    this.lineStarts = sourceFile === undefined ? [] : sourceFile.lineStarts();
    this.lookupLine = -1;
    this.lookupLineStart = 0;
    this.lookupLineEnd = 0;
    this.commentStarts = undefined;
    this.endCommentFreeRange();
    return true;
  }

  /** Prints `node` into `writer`, adding mappings to `sourceMapGenerator` if given. */
  write(
    node: Node,
    sourceFile: SourceFile | undefined,
    writer: TextWriter,
    sourceMapGenerator: SourceMapGenerator | undefined,
  ): boolean {
    const savedSourceFile = this.currentSourceFile;
    const savedWriter = this.writer;
    const savedUniqueHelperNames = this.uniqueHelperNames;
    const savedSourceMapsDisabled = this.sourceMapsDisabled;
    const savedGenerator = this.sourceMapGenerator;
    const savedSource = this.sourceMapSource;
    const savedSourceIndex = this.sourceMapSourceIndex;
    const savedSourceLineStarts = this.sourceMapLineStarts;

    this.sourceMapsDisabled = sourceMapGenerator === undefined;
    this.sourceMapGenerator = sourceMapGenerator;
    this.sourceMapSource = undefined;
    this.sourceMapSourceIndex = -1;
    this.sourceMapLineStarts = [];
    this.sourceMapLine = 0;
    this.setSourceFile(sourceFile);
    this.writer = writer;
    writer.clear();
    writer.trackColumns = sourceMapGenerator !== undefined;
    this.emitAnyNode(node);

    this.setCurrentSourceFile(savedSourceFile);
    this.writer = savedWriter;
    this.uniqueHelperNames = savedUniqueHelperNames;
    this.sourceMapsDisabled = savedSourceMapsDisabled;
    this.sourceMapGenerator = savedGenerator;
    this.sourceMapSource = savedSource;
    this.sourceMapSourceIndex = savedSourceIndex;
    this.sourceMapLineStarts = savedSourceLineStarts;
    this.sourceMapLine = 0;
    return true;
  }

  // Text of nodes

  isFileLevelUniqueName(name: string): boolean {
    const file = this.currentSourceFile;
    return file === undefined || isFileLevelUniqueName(file, name);
  }

  private getLiteralTextOfNode(node: Node, sourceFile: SourceFile | undefined, flags: LiteralTextFlags): string {
    if (node instanceof StringLiteral) {
      const textSource = this.context.textSource.get(node);
      if (textSource !== undefined) {
        let text: string;
        if (textSource instanceof NumericLiteral) text = textSource.text;
        else if (
          textSource instanceof Identifier ||
          textSource instanceof PrivateIdentifier ||
          textSource instanceof JsxNamespacedName
        )
          text = this.getTextOfNode(textSource);
        else return this.getLiteralTextOfNode(textSource, getSourceFileOfNode(textSource), flags);
        if ((flags & LiteralTextFlags.JsxAttributeEscape) !== 0)
          return (
            '"' +
            escapeString(text, 0x22, LiteralTextFlags.JsxAttributeEscape | LiteralTextFlags.NeverAsciiEscape) +
            '"'
          );
        if (
          (flags & LiteralTextFlags.NeverAsciiEscape) !== 0 ||
          (this.context.getEmitFlags(node) & EmitFlags.NoAsciiEscaping) !== 0
        )
          return '"' + escapeString(text, 0x22, LiteralTextFlags.NeverAsciiEscape) + '"';
        return '"' + escapeString(text, 0x22, LiteralTextFlags.None) + '"';
      }
    }
    if ((this.context.getEmitFlags(node) & EmitFlags.NoAsciiEscaping) !== 0) flags |= LiteralTextFlags.NeverAsciiEscape;
    if (this.options.target >= ScriptTarget.ES2021) flags |= LiteralTextFlags.AllowNumericSeparator;
    const file = sourceFile === undefined ? this.currentSourceFile : sourceFile;
    return getLiteralText(node, file === undefined ? undefined : file.text, flags);
  }

  /** The text of an identifier, private identifier, literal or JSX namespaced name as printed. */
  getTextOfNode(node: Node): string {
    if ((node instanceof Identifier || node instanceof PrivateIdentifier) && this.context.autoGenerate.has(node))
      return this.nameGenerator.generateName(node);
    if (node instanceof StringLiteral) {
      const textSource = this.context.textSource.get(node);
      if (textSource !== undefined) return this.getTextOfNode(textSource);
    }
    const file = this.currentSourceFile;
    const canUseSourceFile = file !== undefined && node.parent !== undefined && !nodeIsSynthesized(node);
    switch (node.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.PrivateIdentifier:
      case SyntaxKind.JsxNamespacedName:
        // Its text either way: the source text, or the text of a node from elsewhere.
        if (this.textIsSourceText(node)) return (node as Identifier | PrivateIdentifier).text;
        if (!canUseSourceFile || !this.isInCurrentSourceFile(node)) {
          if (node instanceof Identifier) return node.text;
          if (node instanceof PrivateIdentifier) return node.text;
          if (node instanceof JsxNamespacedName) return node.namespace.text + ':' + node.name.text;
        }
        break;
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.TemplateHead:
      case SyntaxKind.TemplateMiddle:
      case SyntaxKind.TemplateTail:
        return this.getLiteralTextOfNode(node, undefined, LiteralTextFlags.None);
      default:
        throw new Error('Unexpected node kind ' + node.kind);
    }
    return getSourceTextOfNode(this.sourceText, node);
  }

  /**
   * Whether the source text of an identifier or private identifier of the current file, from the end of its leading
   * trivia to its end, is its text: the text ends the node, and the character before it is not part of the token, as
   * it would be in an identifier written with escapes. Nodes from JSDoc may span other text, so they are left to the
   * general path.
   */
  private textIsSourceText(node: Node): boolean {
    if (!(node instanceof Identifier) && !(node instanceof PrivateIdentifier)) return false;
    if ((node.flags & (NodeFlags.Reparsed | NodeFlags.JSDoc | NodeFlags.ReparserTransformedLiteral)) !== 0)
      return false;
    const text = node.text;
    const source = this.sourceText;
    const end = node.end;
    const start = end - text.length;
    if (text.length === 0 || start < node.pos || end > source.length) return false;
    if (!source.startsWith(text, start)) return false;
    if (start === node.pos) return true;
    const before = source.charCodeAt(start - 1);
    return !(
      (before >= CharacterCodes.a && before <= CharacterCodes.z) ||
      (before >= CharacterCodes.A && before <= CharacterCodes.Z) ||
      (before >= CharacterCodes._0 && before <= CharacterCodes._9) ||
      before === CharacterCodes._ ||
      before === CharacterCodes.$ ||
      before === CharacterCodes.backslash ||
      before === CharacterCodes.openBrace ||
      before === CharacterCodes.closeBrace ||
      before === CharacterCodes.hash ||
      before > CharacterCodes.maxAsciiCharacter
    );
  }

  private isInCurrentSourceFile(node: Node): boolean {
    const file = this.currentSourceFile;
    if (file === undefined) return false;
    const original: Node = this.context.mostOriginal(file);
    const own: Node | undefined = getSourceFileOfNode(node);
    return own !== undefined && own === original;
  }

  // Low-level writing

  private write1(text: string): boolean {
    return this.writer.write(text);
  }

  private space(): boolean {
    return this.writer.write(' ');
  }

  private line(): boolean {
    return this.writer.writeLine(false);
  }

  private lines(count: number): boolean {
    for (let i = 0; i < count; i++) this.writer.writeLine(false);
    return count > 0;
  }

  private indentIf(condition: boolean, delta: number): boolean {
    if (condition) this.writer.indent += delta;
    return condition;
  }

  private writeLinesOfText(text: string): boolean {
    const lines = splitLines(text);
    const indentation = guessIndentation(lines);
    for (const text of lines) {
      const line = indentation > 0 ? text.substring(indentation) : text;
      if (line.length > 0) {
        this.line();
        this.write1(line);
      }
    }
    return true;
  }

  private writeLineOrSpace(parent: Node, prev: Node, next: Node): boolean {
    if (this.shouldEmitOnSingleLine(parent)) return this.space();
    if (this.options.preserveSourceNewlines) {
      const lines = this.getLinesBetweenNodes(parent, prev, next);
      return lines > 0 ? this.lines(lines) : this.space();
    }
    return this.line();
  }

  private writeLinesAndIndent(lineCount: number, writeSpaceIfNotIndenting: boolean): boolean {
    if (lineCount > 0) {
      this.writer.indent++;
      this.lines(lineCount);
    } else if (writeSpaceIfNotIndenting) this.space();
    return true;
  }

  private writeLineSeparatorsAndIndentBefore(node: Node, parent: Node): boolean {
    if (this.options.preserveSourceNewlines) {
      const leading = this.getLeadingLineTerminatorCount(parent, node, ListFormat.None);
      if (leading > 0) {
        this.writeLinesAndIndent(leading, false);
        return true;
      }
    }
    return false;
  }

  private writeLineSeparatorsAfter(node: Node, parent: Node): boolean {
    if (this.options.preserveSourceNewlines)
      return this.lines(this.getClosingLineTerminatorCount(parent, node, ListFormat.None, -1));
    return false;
  }

  // Lines between nodes

  private positionsAreOnSameLine(pos1: number, pos2: number): boolean {
    if (pos1 === pos2) return true;
    const lower = pos1 < pos2 ? pos1 : pos2;
    const upper = pos1 < pos2 ? pos2 : pos1;
    // What getLinesBetweenPositions finds: no line starts in (lower, upper].
    if (lower < 0) {
      const first = this.lineStarts.length > 0 ? this.lineStarts[0] | 0 : -1;
      return first < 0 || upper < first;
    }
    this.lineOf(lower);
    return this.lookupLineEnd < 0 || upper < this.lookupLineEnd;
  }

  /** The zero-based line of `pos` (-1 before the first line), which becomes the line of the last lookup. */
  private lineOf(pos: number): number {
    if (pos >= this.lookupLineStart && (pos < this.lookupLineEnd || this.lookupLineEnd < 0) && this.lookupLine >= 0)
      return this.lookupLine;
    const starts = this.lineStarts;
    const line = computeLineOfPosition(starts, pos);
    this.lookupLine = line;
    this.lookupLineStart = line >= 0 ? starts[line] | 0 : 0;
    this.lookupLineEnd = line + 1 < starts.length ? starts[line + 1] | 0 : -1;
    return line;
  }

  private rangeStart(pos: number): number {
    return getStartPositionOfRange(this.sourceText, pos, false);
  }

  private rangeIsOnSingleLine(node: Node): boolean {
    return this.positionsAreOnSameLine(this.rangeStart(node.pos), node.end);
  }

  private rangeEndIsOnSameLineAsRangeStart(end: number, start: number): boolean {
    return this.positionsAreOnSameLine(end, this.rangeStart(start));
  }

  private getEffectiveLinesBetweenEndAndStart(end: number, start: number): number {
    const lines = getLinesBetweenPositions(this.lineStarts, end, getStartPositionOfRange(this.sourceText, start, true));
    if (lines !== 0) return lines;
    return getLinesBetweenPositions(this.lineStarts, end, getStartPositionOfRange(this.sourceText, start, false));
  }

  private getLinesBetweenNodes(parent: Node, node1: Node, node2: Node): number {
    if (this.shouldElideIndentation(parent)) return 0;
    parent = skipSynthesizedParentheses(parent);
    node1 = skipSynthesizedParentheses(node1);
    node2 = skipSynthesizedParentheses(node2);
    if (this.shouldEmitOnNewLine(node2, ListFormat.None)) return 1;
    if (
      this.currentSourceFile !== undefined &&
      !nodeIsSynthesized(parent) &&
      !nodeIsSynthesized(node1) &&
      !nodeIsSynthesized(node2)
    ) {
      if (this.options.preserveSourceNewlines) return this.getEffectiveLinesBetweenEndAndStart(node1.end, node2.pos);
      return this.rangeEndIsOnSameLineAsRangeStart(node1.end, node2.pos) ? 0 : 1;
    }
    return 0;
  }

  private linesToPrecedingNonWhitespace(pos: number, stopPos: number, includeComments: boolean): number {
    const start = skipTrivia(this.sourceText, pos, false, includeComments);
    const prev = getPreviousNonWhitespacePosition(this.sourceText, start, stopPos);
    return getLinesBetweenPositions(this.lineStarts, prev >= 0 ? prev : stopPos, start);
  }

  private linesToNextNonWhitespace(pos: number, stopPos: number, includeComments: boolean): number {
    const next = skipTrivia(this.sourceText, pos, false, includeComments);
    return getLinesBetweenPositions(this.lineStarts, pos, stopPos < next ? stopPos : next);
  }

  private getLeadingLineTerminatorCount(
    parent: Node | undefined,
    firstChild: Node | undefined,
    format: ListFormat,
  ): number {
    if ((format & ListFormat.PreserveLines) !== 0 || this.options.preserveSourceNewlines) {
      if ((format & ListFormat.PreferNewLine) !== 0) return 1;
      if (firstChild === undefined)
        return parent === undefined || (this.currentSourceFile !== undefined && this.rangeIsOnSingleLine(parent))
          ? 0
          : 1;
      if (this.nextListElementPos > 0 && firstChild.pos === this.nextListElementPos) return 0;
      if (firstChild.kind === SyntaxKind.JsxText) return 0;
      if (
        this.currentSourceFile !== undefined &&
        parent !== undefined &&
        !positionIsSynthesized(parent.pos) &&
        !nodeIsSynthesized(firstChild) &&
        firstChild.parent === undefined
      ) {
        if (this.options.preserveSourceNewlines) {
          const lines = this.linesToPrecedingNonWhitespace(firstChild.pos, parent.pos, true);
          return lines !== 0 ? lines : this.linesToPrecedingNonWhitespace(firstChild.pos, parent.pos, false);
        }
        return this.positionsAreOnSameLine(this.rangeStart(parent.pos), this.rangeStart(firstChild.pos)) ? 0 : 1;
      }
      if (this.shouldEmitOnNewLine(firstChild, format)) return 1;
    }
    return (format & ListFormat.MultiLine) !== 0 ? 1 : 0;
  }

  private getSeparatingLineTerminatorCount(
    previous: Node | undefined,
    next: Node | undefined,
    format: ListFormat,
  ): number {
    if ((format & ListFormat.PreserveLines) !== 0 || this.options.preserveSourceNewlines) {
      if (previous === undefined || next === undefined) return 0;
      if (next.kind === SyntaxKind.JsxText) return 0;
      if (this.currentSourceFile !== undefined && !nodeIsSynthesized(previous) && !nodeIsSynthesized(next)) {
        if (this.options.preserveSourceNewlines && this.siblingNodePositionsAreComparable(previous, next))
          return this.getEffectiveLinesBetweenEndAndStart(previous.end, next.pos);
        if (!this.options.preserveSourceNewlines && this.originalNodesHaveSameParent(previous, next))
          return this.rangeEndIsOnSameLineAsRangeStart(previous.end, next.pos) ? 0 : 1;
        return (format & ListFormat.PreferNewLine) !== 0 ? 1 : 0;
      }
      if (this.shouldEmitOnNewLine(previous, format) || this.shouldEmitOnNewLine(next, format)) return 1;
    } else if (next !== undefined && this.shouldEmitOnNewLine(next, ListFormat.None)) return 1;
    return (format & ListFormat.MultiLine) !== 0 ? 1 : 0;
  }

  private getClosingLineTerminatorCount(
    parent: Node | undefined,
    lastChild: Node | undefined,
    format: ListFormat,
    childrenEnd: number,
  ): number {
    if ((format & ListFormat.PreserveLines) !== 0 || this.options.preserveSourceNewlines) {
      if ((format & ListFormat.PreferNewLine) !== 0) return 1;
      if (lastChild === undefined)
        return parent === undefined || (this.currentSourceFile !== undefined && this.rangeIsOnSingleLine(parent))
          ? 0
          : 1;
      if (
        this.currentSourceFile !== undefined &&
        parent !== undefined &&
        !positionIsSynthesized(parent.pos) &&
        !nodeIsSynthesized(lastChild) &&
        (lastChild.parent === undefined || lastChild.parent === parent)
      ) {
        if (this.options.preserveSourceNewlines) {
          const end = childrenEnd > lastChild.end ? childrenEnd : lastChild.end;
          const lines = this.linesToNextNonWhitespace(end, parent.end, true);
          return lines !== 0 ? lines : this.linesToNextNonWhitespace(end, parent.end, false);
        }
        return this.positionsAreOnSameLine(parent.end, lastChild.end) ? 0 : 1;
      }
      if (this.shouldEmitOnNewLine(lastChild, format)) return 1;
    }
    if ((format & ListFormat.MultiLine) !== 0 && (format & ListFormat.NoTrailingNewLine) === 0) return 1;
    return 0;
  }

  private siblingNodePositionsAreComparable(previous: Node, next: Node): boolean {
    if (next.pos < previous.end) return false;
    previous = this.context.mostOriginal(previous);
    next = this.context.mostOriginal(next);
    const parent = previous.parent;
    if (parent === undefined || parent !== next.parent) return false;
    const list = getContainingNodeArray(previous);
    if (list === undefined) return false;
    const index = list.nodes.indexOf(previous);
    return index >= 0 && list.nodes.indexOf(next) === index + 1;
  }

  private originalNodesHaveSameParent(a: Node, b: Node): boolean {
    a = this.context.mostOriginal(a);
    if (a.parent === undefined) return false;
    return a.parent === this.context.mostOriginal(b).parent;
  }

  // Comment text

  private writeCommentRange(comment: CommentRange): boolean {
    if (this.currentSourceFile === undefined) return false;
    return this.writeCommentText(this.sourceText, this.lineStarts, comment.kind, comment.pos, comment.end);
  }

  private writeCommentText(
    text: string,
    lineStarts: readonly number[],
    kind: SyntaxKind,
    pos: number,
    end: number,
  ): boolean {
    if (kind !== SyntaxKind.MultiLineCommentTrivia) return this.writer.writeComment(text.substring(pos, end));
    const writer = this.writer;
    const firstLine = computeLineOfPosition(lineStarts, pos);
    const lineCount = lineStarts.length;
    let firstCommentLineIndent = -1;
    const start = pos;
    for (let currentLine = firstLine; pos < end; currentLine++) {
      const nextLineStart = currentLine + 1 === lineCount ? text.length + 1 : lineStarts[currentLine + 1] | 0;
      if (pos !== start) {
        if (firstCommentLineIndent === -1)
          firstCommentLineIndent = calculateIndent(text, lineStarts[firstLine] | 0, start);
        const spacesToEmit = writer.indent * 4 - firstCommentLineIndent + calculateIndent(text, pos, nextLineStart);
        if (spacesToEmit > 0) {
          const singleSpaces = spacesToEmit & 3;
          writer.rawWrite(' '.repeat(spacesToEmit - singleSpaces));
          for (let i = 0; i < singleSpaces; i++) writer.rawWrite(' ');
        } else writer.rawWrite('');
      }
      // Line starts split at every line break, so only the end of the line can hold one.
      let lineEnd = end < nextLineStart ? end : nextLineStart;
      while (lineEnd > pos && isLineBreakChar(text.charCodeAt(lineEnd - 1))) lineEnd -= 1;
      const lineText = trimUnicodeSpace(text, pos, lineEnd);
      if (lineText.length > 0) {
        writer.writeComment(lineText);
        if (lineEnd !== end) writer.writeLine(false);
      } else writer.writeLine(true);
      pos = nextLineStart;
    }
    return true;
  }

  // Emit flags

  private shouldEmitComments(node: Node): boolean {
    return !this.commentsDisabled && this.currentSourceFile !== undefined && node.kind !== SyntaxKind.SourceFile;
  }

  private shouldWriteComment(comment: CommentRange): boolean {
    return (
      !this.options.onlyPrintJSDocStyle ||
      (this.currentSourceFile !== undefined &&
        (isJSDocLikeText(this.sourceText, comment) || isPinnedComment(this.sourceText, comment)))
    );
  }

  private hasEmitFlag(node: Node, flag: EmitFlags): boolean {
    return (this.context.getEmitFlags(node) & flag) !== 0;
  }

  private shouldEmitIndented(node: Node): boolean {
    return this.hasEmitFlag(node, EmitFlags.Indented);
  }

  private shouldElideIndentation(node: Node): boolean {
    return this.hasEmitFlag(node, EmitFlags.NoIndentation);
  }

  private shouldEmitOnSingleLine(node: Node): boolean {
    return this.hasEmitFlag(node, EmitFlags.SingleLine);
  }

  private shouldEmitOnNewLine(node: Node, format: ListFormat): boolean {
    return this.hasEmitFlag(node, EmitFlags.StartOnNewLine) || (format & ListFormat.PreferNewLine) !== 0;
  }

  private shouldEmitBlockFunctionBodyOnSingleLine(body: Block): boolean {
    if (this.shouldEmitOnSingleLine(body)) return true;
    if (body.multiLine) return false;
    if (!nodeIsSynthesized(body) && this.currentSourceFile !== undefined && !this.rangeIsOnSingleLine(body))
      return false;
    const statements = body.statements.nodes;
    if (
      this.getLeadingLineTerminatorCount(
        body,
        statements.length > 0 ? statements[0]! : undefined,
        ListFormat.PreserveLines,
      ) > 0 ||
      this.getClosingLineTerminatorCount(
        body,
        statements.length > 0 ? statements[statements.length - 1]! : undefined,
        ListFormat.PreserveLines,
        body.statements.end,
      ) > 0
    )
      return false;
    let previous: Node | undefined = undefined;
    for (const statement of statements) {
      if (this.getSeparatingLineTerminatorCount(previous, statement, ListFormat.PreserveLines) > 0) return false;
      previous = statement;
    }
    return true;
  }

  private shouldEmitSourceMaps(node: Node): boolean {
    return (
      !this.sourceMapsDisabled &&
      this.sourceMapSource !== undefined &&
      node.kind !== SyntaxKind.SourceFile &&
      (node.flags & NodeFlags.JsonFile) === 0
    );
  }

  private shouldAllowTrailingComma(node: Node): boolean {
    return (
      this.currentSourceFile !== undefined &&
      this.currentSourceFile.scriptKind !== ScriptKind.JSON &&
      node.kind === SyntaxKind.ObjectLiteralExpression
    );
  }

  private hasCommentsAtPosition(pos: number): boolean {
    if (this.currentSourceFile === undefined) return false;
    return (
      getTrailingCommentRanges(this.sourceText, pos + 1) !== undefined ||
      getLeadingCommentRanges(this.sourceText, pos + 1) !== undefined
    );
  }

  // Tokens

  private writeTokenText(token: SyntaxKind, pos: number): number {
    const text = tokenToString(token);
    this.writer.write(text);
    return pos < 0 ? pos : pos + text.length;
  }

  private emitToken(token: SyntaxKind, pos: number, contextNode: Node): number {
    return this.emitTokenEx(token, pos, contextNode, TokenEmitFlags.None);
  }

  private emitTokenEx(token: SyntaxKind, pos: number, contextNode: Node, flags: TokenEmitFlags): number {
    const state = this.enterToken(token, pos, contextNode, flags);
    pos = this.writeTokenText(token, this.tokenPos);
    this.exitToken(token, pos, contextNode, state);
    return pos;
  }

  private emitOptionalToken(node: Node | undefined): boolean {
    return node !== undefined && this.emitTokenNodeEx(node, TokenEmitFlags.None);
  }

  private emitTokenNode(node: Node): boolean {
    return this.emitTokenNodeEx(node, TokenEmitFlags.None);
  }

  private emitTokenNodeEx(node: Node, flags: TokenEmitFlags): boolean {
    if (!isKeywordKind(node.kind) && !isPunctuationKind(node.kind)) throw new Error('Unexpected token ' + node.kind);
    const state = this.enterTokenNode(node, flags);
    this.writeTokenText(node.kind, node.pos);
    this.exitTokenNode(node, state);
    return true;
  }

  // Literals

  private emitLiteral(node: Node): boolean {
    let flags = LiteralTextFlags.None;
    if (this.options.neverAsciiEscape) flags |= LiteralTextFlags.NeverAsciiEscape;
    if (this.options.terminateUnterminatedLiterals) flags |= LiteralTextFlags.TerminateUnterminatedLiterals;
    const state = this.enterNode(node);
    this.writer.writeText(this.getLiteralTextOfNode(node, undefined, flags));
    this.exitNode(node, state);
    return true;
  }

  // Names

  // Source text of names reparsed from JSDoc can span lines; an identifier's own source text has no line breaks.
  private emitIdentifierText(node: Identifier): boolean {
    if (!this.context.autoGenerate.has(node) && this.textIsSourceText(node)) {
      // writeText's answer for text without line breaks.
      this.writer.write(node.text);
      return false;
    }
    return this.writer.writeText(this.getTextOfNode(node));
  }

  private emitIdentifierName(node: Identifier): boolean {
    const state = this.enterNode(node);
    this.emitIdentifierText(node);
    this.exitNode(node, state);
    return true;
  }

  private getUniqueHelperName(name: string): Identifier {
    const names = this.uniqueHelperNames!;
    const existing = names.get(name);
    if (existing !== undefined) return this.context.factory.cloneIdentifier(existing);
    const helperName = this.context.factory.createUniqueName(
      name,
      GeneratedIdentifierFlags.FileLevel | GeneratedIdentifierFlags.Optimistic,
    );
    this.nameGenerator.generateName(helperName);
    names.set(name, helperName);
    return helperName;
  }

  private emitIdentifierReference(node: Identifier): boolean {
    if (
      (this.externalHelpersModuleName !== undefined || this.uniqueHelperNames !== undefined) &&
      this.hasEmitFlag(node, EmitFlags.HelperName)
    ) {
      const moduleName = this.externalHelpersModuleName;
      if (moduleName !== undefined) {
        const factory = this.context.factory;
        const helper = factory.createPropertyAccessExpression(
          factory.cloneIdentifier(moduleName),
          factory.cloneIdentifier(node),
        );
        this.context.assignCommentAndSourceMapRanges(helper, node);
        return this.emitPropertyAccessExpression(helper);
      }
      const helperName = this.getUniqueHelperName(node.text);
      this.context.assignCommentAndSourceMapRanges(helperName, node);
      node = helperName;
    }
    return this.emitIdentifierName(node);
  }

  private emitBindingIdentifier(node: Identifier): boolean {
    if (this.uniqueHelperNames !== undefined && this.hasEmitFlag(node, EmitFlags.HelperName)) {
      const helperName = this.getUniqueHelperName(node.text);
      this.context.assignCommentAndSourceMapRanges(helperName, node);
      node = helperName;
    }
    return this.emitIdentifierName(node);
  }

  private emitPrivateIdentifier(node: PrivateIdentifier): boolean {
    const state = this.enterNode(node);
    this.writer.writeText(this.getTextOfNode(node));
    this.exitNode(node, state);
    return true;
  }

  private emitQualifiedName(node: QualifiedName): boolean {
    const state = this.enterNode(node);
    this.emitEntityName(node.left);
    this.write1('.');
    this.emitIdentifierName(node.right);
    this.exitNode(node, state);
    return true;
  }

  private emitComputedPropertyName(node: ComputedPropertyName): boolean {
    const state = this.enterNode(node);
    this.write1('[');
    this.emitExpression(node.expression, OperatorPrecedence.DisallowComma);
    this.write1(']');
    this.exitNode(node, state);
    return true;
  }

  private emitEntityName(node: Node): boolean {
    if (node instanceof Identifier) return this.emitIdentifierReference(node);
    if (node instanceof QualifiedName) return this.emitQualifiedName(node);
    if (node instanceof PropertyAccessExpression) return this.emitExpression(node, OperatorPrecedence.DisallowComma);
    throw new Error('Unexpected entity name ' + node.kind);
  }

  private emitBindingName(node: Node | undefined): boolean {
    if (node === undefined) return false;
    if (node instanceof Identifier) return this.emitBindingIdentifier(node);
    if (node instanceof BindingPattern) return this.emitBindingPattern(node);
    throw new Error('Unexpected binding name ' + node.kind);
  }

  private emitPropertyName(node: Node | undefined): boolean {
    if (node === undefined) return false;
    if (node instanceof Identifier) return this.emitIdentifierName(node);
    if (node instanceof PrivateIdentifier) return this.emitPrivateIdentifier(node);
    if (node instanceof ComputedPropertyName) return this.emitComputedPropertyName(node);
    if (isLiteralKind(node.kind)) return this.emitLiteral(node);
    throw new Error('Unexpected property name ' + node.kind);
  }

  private emitMemberName(node: Node): boolean {
    if (node instanceof Identifier) return this.emitIdentifierName(node);
    if (node instanceof PrivateIdentifier) return this.emitPrivateIdentifier(node);
    throw new Error('Unexpected member name ' + node.kind);
  }

  /** Module names, module export names, import attribute names and nested module names. */
  private emitIdentifierOrString(node: Node, binding: boolean): boolean {
    if (node instanceof Identifier) return binding ? this.emitBindingIdentifier(node) : this.emitIdentifierName(node);
    if (node instanceof StringLiteral) return this.emitLiteral(node);
    throw new Error('Unexpected name ' + node.kind);
  }

  // Signature elements

  private emitModifierList(parent: Node, modifiers: ModifierList | undefined, allowDecorators: boolean): number {
    if (modifiers === undefined || modifiers.nodes.length === 0) return parent.pos;
    const nodes = modifiers.nodes;
    let allModifiers = true;
    let allDecorators = true;
    for (const n of nodes) {
      if (n.kind === SyntaxKind.Decorator) allModifiers = false;
      else allDecorators = false;
      if (!isModifier(n)) allModifiers = false;
    }
    if (allModifiers) this.emitList(ListItem.Keyword, parent, modifiers, ListFormat.Modifiers);
    else if (allDecorators) {
      if (!allowDecorators) return parent.pos;
      this.emitList(ListItem.ModifierLike, parent, modifiers, ListFormat.Decorators);
    } else {
      // Emit runs of modifiers and decorators with their own formats.
      let lastDecorators = false;
      let decorators = false;
      let haveMode = false;
      let start = 0;
      let pos = 0;
      while (start < nodes.length) {
        while (pos < nodes.length) {
          decorators = nodes[pos].kind === SyntaxKind.Decorator;
          if (!haveMode) {
            lastDecorators = decorators;
            haveMode = true;
          } else if (decorators !== lastDecorators) break;
          pos++;
        }
        const rangePos = start === 0 ? modifiers.pos : -1;
        const rangeEnd = pos === nodes.length - 1 ? modifiers.end : -1;
        if (allowDecorators || !lastDecorators)
          this.emitListItems(
            ListItem.ModifierLike,
            parent,
            nodes,
            start,
            pos,
            lastDecorators ? ListFormat.Decorators : ListFormat.Modifiers,
            false,
            rangePos,
            rangeEnd,
          );
        start = pos;
        lastDecorators = decorators;
        pos++;
      }
    }
    const last = nodes[nodes.length - 1]!;
    return last.end > parent.pos ? last.end : parent.pos;
  }

  private emitTypeParameter(node: TypeParameterDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.emitBindingIdentifier(node.name);
    if (node.constraint !== undefined) {
      this.write1(' extends ');
      this.emitTypeNodeOutsideExtends(node.constraint);
    }
    if (node.defaultType !== undefined) {
      this.write1(' = ');
      this.emitTypeNodeOutsideExtends(node.defaultType);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitParameter(node: ParameterDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, true);
    this.emitOptionalToken(node.dotDotDotToken);
    this.emitBindingName(node.name);
    this.emitOptionalToken(node.questionToken);
    this.emitTypeAnnotation(node.type);
    let end = node.pos;
    if (node.modifiers !== undefined && node.modifiers.end > end) end = node.modifiers.end;
    if (node.name.end > end) end = node.name.end;
    if (node.questionToken !== undefined && node.questionToken.end > end) end = node.questionToken.end;
    if (node.type !== undefined && node.type.end > end) end = node.type.end;
    this.emitInitializer(node.initializer, end, node);
    this.exitNode(node, state);
    return true;
  }

  private emitDecorator(node: Decorator): boolean {
    const state = this.enterNode(node);
    this.write1('@');
    this.emitExpression(node.expression, OperatorPrecedence.LeftHandSide);
    this.exitNode(node, state);
    return true;
  }

  private emitTypeParameters(parent: Node, nodes: NodeList | undefined): boolean {
    if (nodes === undefined) return false;
    return this.emitList(
      ListItem.TypeParameter,
      parent,
      nodes,
      ListFormat.TypeParameters | (parent.kind === SyntaxKind.ArrowFunction ? ListFormat.AllowTrailingComma : 0),
    );
  }

  private emitTypeAnnotation(node: Node | undefined): boolean {
    if (node === undefined) return false;
    this.write1(': ');
    return this.emitTypeNodeOutsideExtends(node);
  }

  private emitInitializer(node: Node | undefined, equalsPos: number, contextNode: Node): boolean {
    if (node === undefined) return false;
    this.space();
    this.emitToken(SyntaxKind.EqualsToken, equalsPos, contextNode);
    this.space();
    return this.emitExpression(node, OperatorPrecedence.DisallowComma);
  }

  private emitParameters(parent: Node, parameters: NodeList): boolean {
    this.generateAllNames(parameters);
    return this.emitList(ListItem.Parameter, parent, parameters, ListFormat.Parameters);
  }

  private canEmitSimpleArrowHead(parent: Node, parameters: NodeList): boolean {
    if (!(parent instanceof ArrowFunction) || parameters.nodes.length !== 1) return false;
    const parameter = parameters.nodes[0]!;
    return (
      parameter instanceof ParameterDeclaration &&
      parameter.pos === parent.pos &&
      parent.typeParameters === undefined &&
      parent.type === undefined &&
      (parent.modifiers === undefined || parent.modifiers.nodes.length === 0) &&
      !parameters.hasTrailingComma() &&
      parameter.modifiers === undefined &&
      parameter.dotDotDotToken === undefined &&
      parameter.questionToken === undefined &&
      parameter.type === undefined &&
      parameter.initializer === undefined &&
      parameter.name.kind === SyntaxKind.Identifier
    );
  }

  private emitParametersForArrow(parent: Node, parameters: NodeList): boolean {
    if (this.canEmitSimpleArrowHead(parent, parameters)) {
      this.generateAllNames(parameters);
      return this.emitList(ListItem.Parameter, parent, parameters, ListFormat.SingleArrowParameter);
    }
    return this.emitParameters(parent, parameters);
  }

  private emitSignature(
    node: Node,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: Node | undefined,
  ): boolean {
    this.emitTypeParameters(node, typeParameters);
    this.emitParameters(node, parameters);
    return this.emitTypeAnnotation(type);
  }

  private emitFunctionBody(body: Block): boolean {
    this.context.addEmitFlags(body, EmitFlags.NoSourceMap);
    this.generateNames(body);
    this.write1('{');
    this.writer.indent++;
    const detached = this.emitDetachedCommentsBeforeStatementList(body, body.statements.pos);
    const statementOffset = this.emitPrologueDirectives(body.statements);
    const pos = this.writer.getWriteCount();
    this.emitHelpers(body);
    if (
      statementOffset === 0 &&
      pos === this.writer.getWriteCount() &&
      this.shouldEmitBlockFunctionBodyOnSingleLine(body)
    ) {
      this.writer.indent--;
      this.emitListRange(
        ListItem.Statement,
        body,
        body.statements,
        ListFormat.SingleLineFunctionBodyStatements,
        statementOffset,
      );
      this.writer.indent++;
    } else
      this.emitListRange(
        ListItem.Statement,
        body,
        body.statements,
        ListFormat.MultiLineFunctionBodyStatements,
        statementOffset,
      );
    this.emitDetachedCommentsAfterStatementList(body, body.statements.end, detached);
    this.writer.indent--;
    this.emitTokenEx(SyntaxKind.CloseBraceToken, body.statements.end, body, TokenEmitFlags.NoComments);
    return true;
  }

  private emitFunctionBodyNode(node: Node | undefined): boolean {
    if (node === undefined) return this.write1(';');
    this.space();
    if (node instanceof Block) return this.emitFunctionBody(node);
    throw new Error('Unexpected function body ' + node.kind);
  }

  // Type members and class elements

  private emitPropertySignature(node: PropertySignatureDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.emitPropertyName(node.name);
    this.emitOptionalToken(node.postfixToken);
    this.emitTypeAnnotation(node.type);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitPropertyDeclaration(node: PropertyDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, true);
    this.emitPropertyName(node.name);
    this.emitOptionalToken(node.postfixToken);
    this.emitTypeAnnotation(node.type);
    let end = node.name.end;
    if (node.type !== undefined && node.type.end > end) end = node.type.end;
    if (node.postfixToken !== undefined && node.postfixToken.end > end) end = node.postfixToken.end;
    this.emitInitializer(node.initializer, end, node);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  /** Emits a signature in its own name scope, indented if the node asks for it. */
  private emitScopedSignature(
    node: Node,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: Node | undefined,
    body: Node | undefined,
    hasBody: boolean,
  ): boolean {
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.pushNameGenerationScope(node);
    this.emitSignature(node, typeParameters, parameters, type);
    if (hasBody) this.emitFunctionBodyNode(body);
    else this.write1(';');
    this.popNameGenerationScope(node);
    this.indentIf(indented, -1);
    return true;
  }

  private emitMethodSignature(node: MethodSignatureDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.emitPropertyName(node.name);
    this.emitOptionalToken(node.postfixToken);
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, undefined, false);
    this.exitNode(node, state);
    return true;
  }

  private emitMethodDeclaration(node: MethodDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, true);
    this.emitOptionalToken(node.asteriskToken);
    this.emitPropertyName(node.name);
    this.emitOptionalToken(node.postfixToken);
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, node.body, true);
    this.exitNode(node, state);
    return true;
  }

  private emitClassStaticBlockDeclaration(node: ClassStaticBlockDeclaration): boolean {
    const state = this.enterNode(node);
    this.write1('static');
    this.pushNameGenerationScope(node);
    this.emitFunctionBodyNode(node.body);
    this.popNameGenerationScope(node);
    this.exitNode(node, state);
    return true;
  }

  private emitConstructor(node: ConstructorDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('constructor');
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, node.body, true);
    this.exitNode(node, state);
    return true;
  }

  private emitAccessor(
    node: Node,
    token: SyntaxKind,
    modifiers: ModifierList | undefined,
    name: Node,
    typeParameters: NodeList | undefined,
    parameters: NodeList,
    type: Node | undefined,
    body: Node | undefined,
  ): boolean {
    const state = this.enterNode(node);
    const pos = this.emitModifierList(node, modifiers, true);
    this.emitToken(token, pos, node);
    this.space();
    this.emitPropertyName(name);
    this.emitScopedSignature(node, typeParameters, parameters, type, body, true);
    this.exitNode(node, state);
    return true;
  }

  private emitGetAccessor(node: GetAccessorDeclaration): boolean {
    return this.emitAccessor(
      node,
      SyntaxKind.GetKeyword,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      node.body,
    );
  }

  private emitSetAccessor(node: SetAccessorDeclaration): boolean {
    return this.emitAccessor(
      node,
      SyntaxKind.SetKeyword,
      node.modifiers,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      node.body,
    );
  }

  private emitCallSignature(node: CallSignatureDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, undefined, false);
    this.exitNode(node, state);
    return true;
  }

  private emitConstructSignature(node: ConstructSignatureDeclaration): boolean {
    const state = this.enterNode(node);
    this.write1('new ');
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, undefined, false);
    this.exitNode(node, state);
    return true;
  }

  private emitIndexSignature(node: IndexSignatureDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.pushNameGenerationScope(node);
    this.generateAllNames(node.parameters);
    this.emitList(ListItem.Parameter, node, node.parameters, ListFormat.IndexSignatureParameters);
    this.emitTypeAnnotation(node.type);
    this.write1(';');
    this.popNameGenerationScope(node);
    this.indentIf(indented, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitClassElement(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.PropertyDeclaration:
        if (node instanceof PropertyDeclaration) return this.emitPropertyDeclaration(node);
        break;
      case SyntaxKind.MethodDeclaration:
        if (node instanceof MethodDeclaration) return this.emitMethodDeclaration(node);
        break;
      case SyntaxKind.ClassStaticBlockDeclaration:
        if (node instanceof ClassStaticBlockDeclaration) return this.emitClassStaticBlockDeclaration(node);
        break;
      case SyntaxKind.Constructor:
        if (node instanceof ConstructorDeclaration) return this.emitConstructor(node);
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration) return this.emitGetAccessor(node);
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration) return this.emitSetAccessor(node);
        break;
      case SyntaxKind.IndexSignature:
        if (node instanceof IndexSignatureDeclaration) return this.emitIndexSignature(node);
        break;
      case SyntaxKind.SemicolonClassElement:
        return this.emitSimpleNode(node, ';');
      case SyntaxKind.NotEmittedStatement:
        return this.emitSimpleNode(node, '');
      case SyntaxKind.JSTypeAliasDeclaration:
        if (node instanceof TypeAliasDeclaration) return this.emitTypeAliasDeclaration(node);
        break;
    }
    throw new Error('Unexpected class element ' + node.kind);
  }

  private emitTypeElement(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.PropertySignature:
        if (node instanceof PropertySignatureDeclaration) return this.emitPropertySignature(node);
        break;
      case SyntaxKind.MethodSignature:
        if (node instanceof MethodSignatureDeclaration) return this.emitMethodSignature(node);
        break;
      case SyntaxKind.CallSignature:
        if (node instanceof CallSignatureDeclaration) return this.emitCallSignature(node);
        break;
      case SyntaxKind.ConstructSignature:
        if (node instanceof ConstructSignatureDeclaration) return this.emitConstructSignature(node);
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration) return this.emitGetAccessor(node);
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration) return this.emitSetAccessor(node);
        break;
      case SyntaxKind.IndexSignature:
        if (node instanceof IndexSignatureDeclaration) return this.emitIndexSignature(node);
        break;
      case SyntaxKind.NotEmittedTypeElement:
        return this.emitSimpleNode(node, '');
    }
    throw new Error('Unexpected type element ' + node.kind);
  }

  private emitObjectLiteralElement(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.PropertyAssignment:
        if (node instanceof PropertyAssignment) return this.emitPropertyAssignment(node);
        break;
      case SyntaxKind.ShorthandPropertyAssignment:
        if (node instanceof ShorthandPropertyAssignment) return this.emitShorthandPropertyAssignment(node);
        break;
      case SyntaxKind.SpreadAssignment:
        if (node instanceof SpreadAssignment) return this.emitSpreadAssignment(node);
        break;
      case SyntaxKind.MethodDeclaration:
        if (node instanceof MethodDeclaration) return this.emitMethodDeclaration(node);
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration) return this.emitGetAccessor(node);
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration) return this.emitSetAccessor(node);
        break;
    }
    throw new Error('Unexpected object literal element ' + node.kind);
  }

  /** A node printed as fixed text, such as `;` for a semicolon class element. */
  private emitSimpleNode(node: Node, text: string): boolean {
    const state = this.enterNode(node);
    if (text.length > 0) this.write1(text);
    this.exitNode(node, state);
    return true;
  }

  // Types

  private emitTypePredicate(node: TypePredicateNode): boolean {
    const state = this.enterNode(node);
    if (node.assertsModifier !== undefined) {
      this.emitOptionalToken(node.assertsModifier);
      this.space();
    }
    const name = node.parameterName;
    if (name instanceof Identifier) this.emitIdentifierReference(name);
    else this.emitSimpleNode(name, 'this');
    if (node.type !== undefined) {
      this.write1(' is ');
      this.emitTypeNodeOutsideExtends(node.type);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitTypeArguments(parent: Node, nodes: NodeList | undefined): boolean {
    if (nodes === undefined) return false;
    return this.emitList(ListItem.TypeArgument, parent, nodes, ListFormat.TypeArguments);
  }

  private emitReturnType(node: Node | undefined): boolean {
    if (node === undefined) return false;
    this.write1('=> ');
    if (this.inExtends && node instanceof InferTypeNode && node.typeParameter.constraint !== undefined)
      return this.emitTypeNode(node, TypePrecedence.Highest);
    return this.emitTypeNode(node, TypePrecedence.Lowest);
  }

  private emitFunctionType(node: FunctionTypeNode): boolean {
    const state = this.enterNode(node);
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.pushNameGenerationScope(node);
    this.emitTypeParameters(node, node.typeParameters);
    this.emitParameters(node, node.parameters);
    this.space();
    this.emitReturnType(node.type);
    this.popNameGenerationScope(node);
    this.indentIf(indented, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitConstructorType(node: ConstructorTypeNode): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('new ');
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.pushNameGenerationScope(node);
    this.emitTypeParameters(node, node.typeParameters);
    this.emitParameters(node, node.parameters);
    this.space();
    this.emitReturnType(node.type);
    this.popNameGenerationScope(node);
    this.indentIf(indented, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitTypeLiteral(node: TypeLiteralNode): boolean {
    const state = this.enterNode(node);
    this.pushNameGenerationScope(node);
    this.generateAllMemberNames(node.members);
    this.write1('{');
    const format = this.shouldEmitOnSingleLine(node)
      ? ListFormat.SingleLineTypeLiteralMembers
      : ListFormat.MultiLineTypeLiteralMembers;
    this.emitList(ListItem.TypeElement, node, node.members, format | ListFormat.NoSpaceIfEmpty);
    this.write1('}');
    this.popNameGenerationScope(node);
    this.exitNode(node, state);
    return true;
  }

  /** The operand of a postfix type; a parsed `typeof X` operand keeps no parentheses. */
  private emitPostfixTypeOperand(operand: Node, parent: Node): boolean {
    if (isParseTreeNode(parent) && operand.kind === SyntaxKind.TypeQuery)
      return this.emitTypeNode(operand, TypePrecedence.TypeOperator);
    return this.emitTypeNode(operand, TypePrecedence.Postfix);
  }

  private emitTupleType(node: TupleTypeNode): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.OpenBracketToken, node.pos, node);
    const format = this.shouldEmitOnSingleLine(node)
      ? ListFormat.SingleLineTupleTypeElements
      : ListFormat.MultiLineTupleTypeElements;
    this.emitList(ListItem.TypeArgument, node, node.elements, format | ListFormat.NoSpaceIfEmpty);
    this.emitToken(SyntaxKind.CloseBracketToken, node.elements.end, node);
    this.exitNode(node, state);
    return true;
  }

  private emitNamedTupleMember(node: NamedTupleMember): boolean {
    const state = this.enterNode(node);
    this.emitOptionalToken(node.dotDotDotToken);
    this.emitIdentifierName(node.name);
    this.emitOptionalToken(node.questionToken);
    let end = node.name.end;
    if (node.questionToken !== undefined && node.questionToken.end > end) end = node.questionToken.end;
    this.emitToken(SyntaxKind.ColonToken, end, node);
    this.space();
    this.emitTypeNodeOutsideExtends(node.type);
    this.exitNode(node, state);
    return true;
  }

  private emitConditionalType(node: ConditionalTypeNode): boolean {
    const state = this.enterNode(node);
    this.emitTypeNode(node.checkType, TypePrecedence.Union);
    this.write1(' extends ');
    this.emitTypeNodeInExtends(node.extendsType);
    this.write1(' ? ');
    this.emitTypeNodeOutsideExtends(node.trueType);
    this.write1(' : ');
    this.emitTypeNodeOutsideExtends(node.falseType);
    this.exitNode(node, state);
    return true;
  }

  private emitInferType(node: InferTypeNode): boolean {
    const state = this.enterNode(node);
    this.write1('infer ');
    const parameter = node.typeParameter;
    const parameterState = this.enterNode(parameter);
    this.emitBindingIdentifier(parameter.name);
    if (parameter.constraint !== undefined) {
      this.write1(' extends ');
      this.emitTypeNodeInExtends(parameter.constraint);
    }
    this.exitNode(parameter, parameterState);
    this.exitNode(node, state);
    return true;
  }

  private emitTypeOperator(node: TypeOperatorNode): boolean {
    const state = this.enterNode(node);
    this.emitToken(node.operator, node.pos, node);
    this.space();
    this.emitTypeNode(
      node.type,
      node.operator === SyntaxKind.ReadonlyKeyword ? TypePrecedence.Postfix : TypePrecedence.TypeOperator,
    );
    this.exitNode(node, state);
    return true;
  }

  private emitMappedType(node: MappedTypeNode): boolean {
    const state = this.enterNode(node);
    const singleLine = this.shouldEmitOnSingleLine(node);
    this.write1('{');
    if (singleLine) this.space();
    else {
      this.line();
      this.writer.indent++;
    }
    const readonlyToken = node.readonlyToken;
    if (readonlyToken !== undefined) {
      this.emitOptionalToken(readonlyToken);
      if (readonlyToken.kind !== SyntaxKind.ReadonlyKeyword) this.write1('readonly');
      this.space();
    }
    this.write1('[');
    const parameter = node.typeParameter;
    const parameterState = this.enterNode(parameter);
    this.emitBindingIdentifier(parameter.name);
    this.write1(' in ');
    this.emitTypeNodeOutsideExtends(parameter.constraint!);
    this.exitNode(parameter, parameterState);
    if (node.nameType !== undefined) {
      this.write1(' as ');
      this.emitTypeNodeOutsideExtends(node.nameType);
    }
    this.write1(']');
    const questionToken = node.questionToken;
    if (questionToken !== undefined) {
      this.emitOptionalToken(questionToken);
      if (questionToken.kind !== SyntaxKind.QuestionToken) this.write1('?');
    }
    this.write1(': ');
    // tsgo's printer fails on a mapped type without a type, too.
    if (node.type === undefined) throw new Error('Mapped type without a type');
    this.emitTypeNodeOutsideExtends(node.type);
    this.write1(';');
    if (node.members !== undefined && node.members.nodes.length > 0) {
      if (singleLine) this.space();
      else this.line();
      this.emitList(ListItem.TypeElement, node, node.members, ListFormat.PreserveLines);
    }
    if (singleLine) this.space();
    else {
      this.line();
      this.writer.indent--;
    }
    this.write1('}');
    this.exitNode(node, state);
    return true;
  }

  private emitTemplateType(node: TemplateLiteralTypeNode): boolean {
    const state = this.enterNode(node);
    this.emitLiteral(node.head);
    this.emitList(ListItem.TemplateTypeSpan, node, node.templateSpans, ListFormat.TemplateExpressionSpans);
    this.exitNode(node, state);
    return true;
  }

  private emitTemplateTypeSpan(node: TemplateLiteralTypeSpan): boolean {
    const state = this.enterNode(node);
    this.emitTypeNodeOutsideExtends(node.type);
    this.emitLiteral(node.literal);
    this.exitNode(node, state);
    return true;
  }

  private emitImportType(node: ImportTypeNode): boolean {
    const state = this.enterNode(node);
    if (node.isTypeOf) this.write1('typeof ');
    this.write1('import(');
    this.emitTypeNodeOutsideExtends(node.argument);
    const attributes = node.attributes;
    if (attributes !== undefined) {
      this.write1(', ');
      const attributesState = this.enterNode(attributes);
      this.write1('{ ');
      this.write1(attributes.token === SyntaxKind.AssertKeyword ? 'assert' : 'with');
      this.write1(': ');
      this.emitList(ListItem.ImportAttribute, attributes, attributes.attributes, ListFormat.ImportAttributes);
      this.write1(' }');
      this.exitNode(attributes, attributesState);
    }
    this.write1(')');
    if (node.qualifier !== undefined) {
      this.write1('.');
      this.emitEntityName(node.qualifier);
    }
    this.emitTypeArguments(node, node.typeArguments);
    this.exitNode(node, state);
    return true;
  }

  private emitTypeNodeInExtends(node: Node): boolean {
    const saved = this.inExtends;
    this.inExtends = true;
    this.emitTypeNode(node, TypePrecedence.Lowest);
    this.inExtends = saved;
    return true;
  }

  private emitTypeNodeOutsideExtends(node: Node): boolean {
    const saved = this.inExtends;
    this.inExtends = false;
    this.emitTypeNode(node, TypePrecedence.Lowest);
    this.inExtends = saved;
    return true;
  }

  private emitTypeNode(node: Node, precedence: TypePrecedence): boolean {
    if (this.inExtends && precedence <= TypePrecedence.Conditional) precedence = TypePrecedence.Function;
    const savedInExtends = this.inExtends;
    const parens = getTypeNodePrecedence(node) < precedence;
    if (parens) {
      this.inExtends = false;
      this.write1('(');
    }
    this.emitTypeNodeWorker(node);
    if (parens) this.write1(')');
    this.inExtends = savedInExtends;
    return true;
  }

  private emitTypeNodeWorker(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.BigIntKeyword:
      case SyntaxKind.ObjectKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.StringKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.IntrinsicKeyword:
        return this.emitTokenNode(node);
      case SyntaxKind.JSDocAllType:
        return this.emitSimpleNode(node, tokenToString(node.kind));
      case SyntaxKind.ThisType:
        return this.emitSimpleNode(node, 'this');
      case SyntaxKind.TypePredicate:
        if (node instanceof TypePredicateNode) return this.emitTypePredicate(node);
        break;
      case SyntaxKind.TypeReference:
        if (node instanceof TypeReferenceNode) {
          const state = this.enterNode(node);
          this.emitEntityName(node.typeName);
          this.emitTypeArguments(node, node.typeArguments);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.FunctionType:
        if (node instanceof FunctionTypeNode) return this.emitFunctionType(node);
        break;
      case SyntaxKind.ConstructorType:
        if (node instanceof ConstructorTypeNode) return this.emitConstructorType(node);
        break;
      case SyntaxKind.TypeQuery:
        if (node instanceof TypeQueryNode) {
          const state = this.enterNode(node);
          this.write1('typeof ');
          this.emitEntityName(node.exprName);
          this.emitTypeArguments(node, node.typeArguments);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.TypeLiteral:
        if (node instanceof TypeLiteralNode) return this.emitTypeLiteral(node);
        break;
      case SyntaxKind.ArrayType:
        if (node instanceof ArrayTypeNode) {
          const state = this.enterNode(node);
          this.emitPostfixTypeOperand(node.elementType, node);
          this.write1('[');
          this.write1(']');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.TupleType:
        if (node instanceof TupleTypeNode) return this.emitTupleType(node);
        break;
      case SyntaxKind.OptionalType:
        if (node instanceof OptionalTypeNode) {
          const state = this.enterNode(node);
          this.emitPostfixTypeOperand(node.type, node);
          this.write1('?');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.RestType:
        if (node instanceof RestTypeNode) {
          const state = this.enterNode(node);
          this.write1('...');
          this.emitTypeNodeOutsideExtends(node.type);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.UnionType:
        if (node instanceof UnionTypeNode) {
          const state = this.enterNode(node);
          this.emitList(ListItem.UnionConstituent, node, node.types, ListFormat.UnionTypeConstituents);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.IntersectionType:
        if (node instanceof IntersectionTypeNode) {
          const state = this.enterNode(node);
          this.emitList(ListItem.UnionConstituent, node, node.types, ListFormat.IntersectionTypeConstituents);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.ConditionalType:
        if (node instanceof ConditionalTypeNode) return this.emitConditionalType(node);
        break;
      case SyntaxKind.InferType:
        if (node instanceof InferTypeNode) return this.emitInferType(node);
        break;
      case SyntaxKind.ParenthesizedType:
        if (node instanceof ParenthesizedTypeNode) {
          const state = this.enterNode(node);
          this.write1('(');
          this.emitTypeNodeOutsideExtends(node.type);
          this.write1(')');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.TypeOperator:
        if (node instanceof TypeOperatorNode) return this.emitTypeOperator(node);
        break;
      case SyntaxKind.IndexedAccessType:
        if (node instanceof IndexedAccessTypeNode) {
          const state = this.enterNode(node);
          this.emitPostfixTypeOperand(node.objectType, node);
          this.write1('[');
          this.emitTypeNodeOutsideExtends(node.indexType);
          this.write1(']');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.MappedType:
        if (node instanceof MappedTypeNode) return this.emitMappedType(node);
        break;
      case SyntaxKind.LiteralType:
        if (node instanceof LiteralTypeNode) {
          const state = this.enterNode(node);
          this.emitExpression(node.literal, OperatorPrecedence.Comma);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.NamedTupleMember:
        if (node instanceof NamedTupleMember) return this.emitNamedTupleMember(node);
        break;
      case SyntaxKind.TemplateLiteralType:
        if (node instanceof TemplateLiteralTypeNode) return this.emitTemplateType(node);
        break;
      case SyntaxKind.TemplateLiteralTypeSpan:
        if (node instanceof TemplateLiteralTypeSpan) return this.emitTemplateTypeSpan(node);
        break;
      case SyntaxKind.ImportType:
        if (node instanceof ImportTypeNode) return this.emitImportType(node);
        break;
      case SyntaxKind.PropertyAccessExpression:
        if (node instanceof PropertyAccessExpression) return this.emitPropertyAccessExpression(node);
        break;
      case SyntaxKind.ExpressionWithTypeArguments:
        if (node instanceof ExpressionWithTypeArguments) return this.emitExpressionWithTypeArguments(node);
        break;
      case SyntaxKind.JSDocNonNullableType:
        if (node instanceof JSDocNonNullableType) return this.emitJSDocPrefixType(node, '!', node.type);
        break;
      case SyntaxKind.JSDocNullableType:
        if (node instanceof JSDocNullableType) return this.emitJSDocPrefixType(node, '?', node.type);
        break;
      case SyntaxKind.JSDocOptionalType:
        if (node instanceof JSDocOptionalType) {
          const state = this.enterNode(node);
          this.emitTypeNode(node.type, TypePrecedence.JSDoc);
          this.write1('=');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.JSDocVariadicType:
        if (node instanceof JSDocVariadicType) {
          const state = this.enterNode(node);
          this.write1('...');
          this.emitTypeNode(node.type, TypePrecedence.JSDoc);
          this.exitNode(node, state);
          return true;
        }
        break;
    }
    throw new Error('Unexpected type node ' + node.kind);
  }

  private emitJSDocPrefixType(node: Node, prefix: string, type: Node): boolean {
    const state = this.enterNode(node);
    this.write1(prefix);
    this.emitTypeNode(type, TypePrecedence.NonArray);
    this.exitNode(node, state);
    return true;
  }

  // Binding patterns

  private emitBindingPattern(node: BindingPattern): boolean {
    const state = this.enterNode(node);
    const object = node.kind === SyntaxKind.ObjectBindingPattern;
    this.write1(object ? '{' : '[');
    this.emitList(
      ListItem.BindingElement,
      node,
      node.elements,
      object ? ListFormat.ObjectBindingPatternElements : ListFormat.ArrayBindingPatternElements,
    );
    this.write1(object ? '}' : ']');
    this.exitNode(node, state);
    return true;
  }

  private emitBindingElement(node: BindingElement): boolean {
    const state = this.enterNode(node);
    this.emitOptionalToken(node.dotDotDotToken);
    if (node.propertyName !== undefined) {
      this.emitPropertyName(node.propertyName);
      this.write1(': ');
    }
    const name = node.name;
    if (name !== undefined) {
      this.emitBindingName(name);
      this.emitInitializer(node.initializer, name.end, node);
    }
    this.exitNode(node, state);
    return true;
  }

  // Expressions

  private emitArrayLiteralExpression(node: ArrayLiteralExpression): boolean {
    const state = this.enterNode(node);
    this.emitList(
      ListItem.ArrayElement,
      node,
      node.elements,
      ListFormat.ArrayLiteralExpressionElements | (node.multiLine ? ListFormat.PreferNewLine : 0),
    );
    this.exitNode(node, state);
    return true;
  }

  private emitObjectLiteralExpression(node: ObjectLiteralExpression): boolean {
    const state = this.enterNode(node);
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.pushNameGenerationScope(node);
    this.generateAllMemberNames(node.properties);
    this.emitList(
      ListItem.ObjectLiteralElement,
      node,
      node.properties,
      ListFormat.ObjectLiteralExpressionProperties |
        (node.multiLine ? ListFormat.PreferNewLine : 0) |
        (this.shouldAllowTrailingComma(node) ? ListFormat.AllowTrailingComma : 0),
    );
    this.popNameGenerationScope(node);
    this.indentIf(indented, -1);
    this.exitNode(node, state);
    return true;
  }

  /** `1..toString()`: a decimal integer literal needs a second dot before a property access. */
  private mayNeedDotDotForPropertyAccess(expression: Node): boolean {
    expression = skipPartiallyEmittedExpressions(expression);
    if (!(expression instanceof NumericLiteral)) return false;
    const text = this.getLiteralTextOfNode(expression, undefined, LiteralTextFlags.NeverAsciiEscape);
    return (
      (expression.tokenFlags & TokenFlags.WithSpecifier) === 0 &&
      text.indexOf('.') < 0 &&
      text.indexOf('E') < 0 &&
      text.indexOf('e') < 0
    );
  }

  private emitPropertyAccessExpression(node: PropertyAccessExpression): boolean {
    const state = this.enterNode(node);
    this.emitExpression(
      node.expression,
      isOptionalChain(node) ? OperatorPrecedence.OptionalChain : OperatorPrecedence.Member,
    );
    let token: Node | undefined = node.questionDotToken;
    if (token === undefined) {
      const dot = this.context.factory.createToken(SyntaxKind.DotToken);
      dot.pos = node.expression.end;
      dot.end = node.name.pos;
      this.context.addEmitFlags(dot, EmitFlags.NoSourceMap);
      token = dot;
    }
    const linesBeforeDot = this.getLinesBetweenNodes(node, node.expression, token);
    this.lines(linesBeforeDot);
    this.indentIf(linesBeforeDot > 0, 1);
    if (
      token.kind !== SyntaxKind.QuestionDotToken &&
      this.mayNeedDotDotForPropertyAccess(node.expression) &&
      !this.writer.hasTrailingComment() &&
      !this.writer.hasTrailingWhitespace()
    )
      this.write1('.');
    if (node.questionDotToken !== undefined) this.emitTokenNode(token);
    else this.emitToken(SyntaxKind.DotToken, node.expression.end, node);
    const linesAfterDot = this.getLinesBetweenNodes(node, token, node.name);
    this.lines(linesAfterDot);
    this.indentIf(linesAfterDot > 0, 1);
    this.emitMemberName(node.name);
    this.indentIf(linesAfterDot > 0, -1);
    this.indentIf(linesBeforeDot > 0, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitElementAccessExpression(node: ElementAccessExpression): boolean {
    const state = this.enterNode(node);
    this.emitExpression(
      node.expression,
      isOptionalChain(node) ? OperatorPrecedence.OptionalChain : OperatorPrecedence.Member,
    );
    this.emitOptionalToken(node.questionDotToken);
    let pos = node.expression.end;
    if (node.questionDotToken !== undefined && node.questionDotToken.end > pos) pos = node.questionDotToken.end;
    this.emitToken(SyntaxKind.OpenBracketToken, pos, node);
    this.emitExpression(node.argumentExpression, OperatorPrecedence.Comma);
    this.emitToken(SyntaxKind.CloseBracketToken, node.argumentExpression.end, node);
    this.exitNode(node, state);
    return true;
  }

  private emitCallee(callee: Node, parent: Node): boolean {
    if (this.hasEmitFlag(parent, EmitFlags.IndirectCall)) {
      this.write1('(');
      this.write1('0');
      this.write1(', ');
      this.emitExpression(callee, OperatorPrecedence.Comma);
      return this.write1(')');
    }
    if (
      parent.kind === SyntaxKind.CallExpression &&
      isNewExpressionWithoutArguments(skipPartiallyEmittedExpressions(callee))
    )
      return this.emitExpression(callee, OperatorPrecedence.Parentheses);
    return this.emitExpression(
      callee,
      isOptionalChain(parent) ? OperatorPrecedence.OptionalChain : OperatorPrecedence.Member,
    );
  }

  private emitCallExpression(node: CallExpression): boolean {
    const state = this.enterNode(node);
    this.emitCallee(node.expression, node);
    this.emitOptionalToken(callQuestionDotToken(node));
    this.emitTypeArguments(node, callTypeArguments(node));
    this.emitList(ListItem.Argument, node, node.arguments, ListFormat.CallExpressionArguments);
    this.exitNode(node, state);
    return true;
  }

  private emitNewExpression(node: NewExpression): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.NewKeyword, node.pos, node);
    this.space();
    if (skipPartiallyEmittedExpressions(node.expression).kind === SyntaxKind.CallExpression)
      this.emitExpression(node.expression, OperatorPrecedence.Parentheses);
    else this.emitExpression(node.expression, OperatorPrecedence.Member);
    this.emitTypeArguments(node, node.typeArguments);
    this.emitList(ListItem.Argument, node, node.arguments, ListFormat.NewExpressionArguments);
    this.exitNode(node, state);
    return true;
  }

  private emitTaggedTemplateExpression(node: TaggedTemplateExpression): boolean {
    const state = this.enterNode(node);
    this.emitCallee(node.tag, node);
    this.emitTypeArguments(node, node.typeArguments);
    this.space();
    const template = node.template;
    if (template instanceof TemplateExpression) this.emitTemplateExpression(template);
    else this.emitLiteral(template);
    this.exitNode(node, state);
    return true;
  }

  private emitParenthesizedExpression(node: ParenthesizedExpression): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.OpenParenToken, node.pos, node);
    const indented = this.writeLineSeparatorsAndIndentBefore(node.expression, node);
    this.emitExpression(node.expression, OperatorPrecedence.Comma);
    this.writeLineSeparatorsAfter(node.expression, node);
    this.indentIf(indented, -1);
    this.emitToken(SyntaxKind.CloseParenToken, node.expression.end, node);
    this.exitNode(node, state);
    return true;
  }

  private emitFunctionExpression(node: FunctionExpression): boolean {
    const state = this.enterNode(node);
    this.generateNameIfNeeded(node.name);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('function');
    this.emitOptionalToken(node.asteriskToken);
    this.space();
    if (node.name !== undefined) this.emitIdentifierName(node.name);
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, node.body, true);
    this.exitNode(node, state);
    return true;
  }

  private emitConciseBody(node: Node): boolean {
    if (node instanceof Block) return this.emitFunctionBody(node);
    if (getLeftmostExpression(node, false).kind === SyntaxKind.ObjectLiteralExpression) {
      const paren = this.context.factory.createParenthesizedExpression(node);
      paren.pos = node.pos;
      paren.end = node.end;
      return this.emitExpression(paren, OperatorPrecedence.Lowest);
    }
    if (isExpression(node)) return this.emitExpression(node, OperatorPrecedence.Yield);
    throw new Error('Unexpected concise body ' + node.kind);
  }

  private emitArrowFunction(node: ArrowFunction): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.pushNameGenerationScope(node);
    this.emitTypeParameters(node, node.typeParameters);
    this.emitParametersForArrow(node, node.parameters);
    this.emitTypeAnnotation(node.type);
    this.space();
    this.emitOptionalToken(node.equalsGreaterThanToken);
    this.space();
    this.emitConciseBody(node.body);
    this.popNameGenerationScope(node);
    this.indentIf(indented, -1);
    this.exitNode(node, state);
    return true;
  }

  /** `delete`, `typeof`, `void` and `await` expressions. */
  private emitKeywordUnary(node: Node, keyword: SyntaxKind, operand: Node): boolean {
    const state = this.enterNode(node);
    this.emitToken(keyword, node.pos, node);
    this.space();
    this.emitExpression(operand, OperatorPrecedence.Unary);
    this.exitNode(node, state);
    return true;
  }

  private emitPrefixUnaryExpression(node: PrefixUnaryExpression): boolean {
    const state = this.enterNode(node);
    const operator = node.operator;
    const operand = node.operand;
    this.emitToken(operator, node.pos, node);
    if (operand instanceof PrefixUnaryExpression) {
      const inner = operand.operator;
      if (
        (operator === SyntaxKind.PlusToken && (inner === SyntaxKind.PlusToken || inner === SyntaxKind.PlusPlusToken)) ||
        (operator === SyntaxKind.MinusToken &&
          (inner === SyntaxKind.MinusToken || inner === SyntaxKind.MinusMinusToken))
      )
        this.space();
    }
    this.emitExpression(operand, OperatorPrecedence.Unary);
    this.exitNode(node, state);
    return true;
  }

  private emitPostfixUnaryExpression(node: PostfixUnaryExpression): boolean {
    const state = this.enterNode(node);
    this.emitExpression(node.operand, OperatorPrecedence.LeftHandSide);
    this.emitToken(node.operator, node.operand.end, node);
    this.exitNode(node, state);
    return true;
  }

  /** The literal kind shared by all operands of a chain of `+`, or Unknown. */
  private getLiteralKindOfBinaryPlusOperand(node: Node): SyntaxKind {
    node = skipPartiallyEmittedExpressions(node);
    if (isLiteralKind(node.kind)) return node.kind;
    if (node instanceof BinaryExpression && node.operatorToken.kind === SyntaxKind.PlusToken) {
      const left = this.getLiteralKindOfBinaryPlusOperand(node.left);
      if (isLiteralKind(left) && left === this.getLiteralKindOfBinaryPlusOperand(node.right)) return left;
    }
    return SyntaxKind.Unknown;
  }

  /** The precedence the right operand of a binary expression needs; the left's is `getExpressionPrecedence`. */
  private getBinaryRightPrecedence(node: BinaryExpression, precedence: OperatorPrecedence): OperatorPrecedence {
    switch (precedence) {
      case OperatorPrecedence.Assignment:
        return OperatorPrecedence.Yield;
      case OperatorPrecedence.LogicalOR:
        return OperatorPrecedence.LogicalAND;
      case OperatorPrecedence.LogicalAND:
        return OperatorPrecedence.BitwiseOR;
      case OperatorPrecedence.Equality:
        return OperatorPrecedence.Relational;
      case OperatorPrecedence.Relational:
        return OperatorPrecedence.Shift;
      case OperatorPrecedence.Shift:
        return OperatorPrecedence.Additive;
      case OperatorPrecedence.Additive:
        if (node.operatorToken.kind === SyntaxKind.PlusToken && isBinaryOperation(node.right, SyntaxKind.PlusToken)) {
          const left = this.getLiteralKindOfBinaryPlusOperand(node.left);
          if (isLiteralKind(left) && left === this.getLiteralKindOfBinaryPlusOperand(node.right)) return precedence;
        }
        return OperatorPrecedence.Multiplicative;
      case OperatorPrecedence.Multiplicative:
        if (
          node.operatorToken.kind === SyntaxKind.AsteriskToken &&
          isBinaryOperation(node.right, SyntaxKind.AsteriskToken)
        )
          return precedence;
        return OperatorPrecedence.Exponentiation;
    }
    return precedence;
  }

  private emitBinaryExpression(node: BinaryExpression): boolean {
    const precedence = getExpressionPrecedence(node);
    let leftPrec = precedence;
    if (precedence === OperatorPrecedence.Assignment) leftPrec = OperatorPrecedence.Conditional;
    else if (precedence === OperatorPrecedence.Exponentiation) leftPrec = OperatorPrecedence.Update;
    let rightPrec = this.getBinaryRightPrecedence(node, precedence);
    const operator = node.operatorToken.kind;
    const left = skipPartiallyEmittedExpressions(node.left);
    if (
      nodeIsSynthesized(left) &&
      left instanceof BinaryExpression &&
      mixingBinaryOperatorsRequiresParentheses(operator, left.operatorToken.kind)
    )
      leftPrec = OperatorPrecedence.Highest;
    const right = skipPartiallyEmittedExpressions(node.right);
    if (
      nodeIsSynthesized(right) &&
      right instanceof BinaryExpression &&
      mixingBinaryOperatorsRequiresParentheses(operator, right.operatorToken.kind)
    )
      rightPrec = OperatorPrecedence.Highest;
    const state = this.enterNode(node);
    this.emitExpression(node.left, leftPrec);
    const linesBefore = this.getLinesBetweenNodes(node, node.left, node.operatorToken);
    const linesAfter = this.getLinesBetweenNodes(node, node.operatorToken, node.right);
    this.writeLinesAndIndent(linesBefore, operator !== SyntaxKind.CommaToken);
    this.emitTokenNodeEx(node.operatorToken, TokenEmitFlags.NoSourceMaps);
    this.writeLinesAndIndent(linesAfter, true);
    this.emitExpression(node.right, rightPrec);
    this.indentIf(linesAfter > 0, -1);
    this.indentIf(linesBefore > 0, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitConditionalExpression(node: ConditionalExpression): boolean {
    const state = this.enterNode(node);
    const linesBeforeQuestion = this.getLinesBetweenNodes(node, node.condition, node.questionToken);
    const linesAfterQuestion = this.getLinesBetweenNodes(node, node.questionToken, node.whenTrue);
    const linesBeforeColon = this.getLinesBetweenNodes(node, node.whenTrue, node.colonToken);
    const linesAfterColon = this.getLinesBetweenNodes(node, node.colonToken, node.whenFalse);
    this.emitExpression(
      node.condition,
      isBinaryOperation(skipPartiallyEmittedExpressions(node.condition), SyntaxKind.QuestionQuestionToken)
        ? OperatorPrecedence.Coalesce
        : OperatorPrecedence.LogicalOR,
    );
    this.writeLinesAndIndent(linesBeforeQuestion, true);
    this.emitOptionalToken(node.questionToken);
    this.writeLinesAndIndent(linesAfterQuestion, true);
    this.emitExpression(node.whenTrue, OperatorPrecedence.Yield);
    this.indentIf(linesAfterQuestion > 0, -1);
    this.indentIf(linesBeforeQuestion > 0, -1);
    this.writeLinesAndIndent(linesBeforeColon, true);
    this.emitOptionalToken(node.colonToken);
    this.writeLinesAndIndent(linesAfterColon, true);
    this.emitExpression(node.whenFalse, OperatorPrecedence.Yield);
    this.indentIf(linesAfterColon > 0, -1);
    this.indentIf(linesBeforeColon > 0, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitTemplateExpression(node: TemplateExpression): boolean {
    const state = this.enterNode(node);
    this.emitLiteral(node.head);
    this.emitList(ListItem.TemplateSpan, node, node.templateSpans, ListFormat.TemplateExpressionSpans);
    this.exitNode(node, state);
    return true;
  }

  private emitYieldExpression(node: YieldExpression): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.YieldKeyword, node.pos, node);
    this.emitOptionalToken(node.asteriskToken);
    if (node.expression !== undefined) {
      this.space();
      this.emitExpressionNoASI(node.expression, OperatorPrecedence.DisallowComma);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitSpreadElement(node: SpreadElement): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.DotDotDotToken, node.pos, node);
    this.emitExpression(node.expression, OperatorPrecedence.DisallowComma);
    this.exitNode(node, state);
    return true;
  }

  private emitClassLike(
    node: Node,
    modifiers: ModifierList | undefined,
    name: Identifier | undefined,
    typeParameters: NodeList | undefined,
    heritageClauses: NodeList | undefined,
    members: NodeList,
  ): boolean {
    const state = this.enterNode(node);
    this.generateNameIfNeeded(name);
    const pos = this.emitModifierList(node, modifiers, true);
    this.emitToken(SyntaxKind.ClassKeyword, pos, node);
    if (name !== undefined) {
      this.space();
      this.emitIdentifierName(name);
    }
    const indented = this.indentIf(this.shouldEmitIndented(node), 1);
    this.emitTypeParameters(node, typeParameters);
    this.emitList(ListItem.HeritageClause, node, heritageClauses, ListFormat.ClassHeritageClauses);
    this.write1(' {');
    this.pushNameGenerationScope(node);
    this.generateAllMemberNames(members);
    this.emitList(ListItem.ClassElement, node, members, ListFormat.ClassMembers);
    this.popNameGenerationScope(node);
    this.write1('}');
    this.indentIf(indented, -1);
    this.exitNode(node, state);
    return true;
  }

  private emitExpressionWithTypeArguments(node: ExpressionWithTypeArguments): boolean {
    const state = this.enterNode(node);
    this.emitExpression(node.expression, OperatorPrecedence.Member);
    this.emitTypeArguments(node, node.typeArguments);
    this.exitNode(node, state);
    return true;
  }

  /** `as` and `satisfies` expressions. */
  private emitTypeRelation(node: Node, expression: Node, keyword: string, type: Node): boolean {
    const state = this.enterNode(node);
    this.emitExpression(expression, OperatorPrecedence.Relational);
    this.space();
    this.write1(keyword);
    this.space();
    this.emitTypeNodeOutsideExtends(type);
    this.exitNode(node, state);
    return true;
  }

  private emitPartiallyEmittedExpression(node: PartiallyEmittedExpression): boolean {
    // Nested partially emitted expressions share one pass so their parentheses aren't repeated.
    const nodes: PartiallyEmittedExpression[] = [];
    const states: number[] = [];
    for (;;) {
      const state = this.enterNode(node);
      if (!this.hasEmitFlag(node, EmitFlags.NoLeadingComments) && node.pos !== node.expression.pos)
        this.emitTrailingCommentsOfPosition(node.expression.pos, false, false);
      nodes.push(node);
      states.push(state);
      const inner = node.expression;
      if (!(inner instanceof PartiallyEmittedExpression)) break;
      node = inner;
    }
    this.emitExpression(node.expression, OperatorPrecedence.Lowest);
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!this.hasEmitFlag(node, EmitFlags.NoTrailingComments) && node.end !== node.expression.end)
        this.emitLeadingCommentsOfPosition(node.expression.end);
      this.exitNode(node, states[i]!);
      node = nodes[i]!;
    }
    return true;
  }

  private commentWillEmitNewLine(comment: CommentRange): boolean {
    return comment.kind === SyntaxKind.SingleLineCommentTrivia || comment.hasTrailingNewLine;
  }

  private willEmitLeadingNewLine(node: Node): boolean {
    if (this.currentSourceFile === undefined) return false;
    const comments = getLeadingCommentRanges(this.sourceText, node.pos);
    let hasNewLineComment = false;
    if (comments !== undefined) {
      for (const comment of comments) if (this.commentWillEmitNewLine(comment)) hasNewLineComment = true;
      const parseNode = this.context.parseNode(node);
      if (
        parseNode !== undefined &&
        parseNode.parent !== undefined &&
        parseNode.parent.kind === SyntaxKind.ParenthesizedExpression
      )
        return true;
    }
    if (hasNewLineComment) return true;
    const synthesized = this.context.getSyntheticLeadingComments(node);
    if (synthesized !== undefined)
      for (let i = 0; i < synthesized.length; i++)
        if (synthesized[i].kind === SyntaxKind.SingleLineCommentTrivia || synthesized[i].hasTrailingNewLine)
          return true;
    if (node instanceof PartiallyEmittedExpression) {
      if (node.pos !== node.expression.pos) {
        const trailing = getTrailingCommentRanges(this.sourceText, node.expression.pos);
        if (trailing !== undefined)
          for (const comment of trailing) if (this.commentWillEmitNewLine(comment)) return true;
      }
      return this.willEmitLeadingNewLine(node.expression);
    }
    return false;
  }

  /** Parenthesizes an expression whose leading comments would put a line break after `return` or `throw`. */
  private parenthesizeExpressionForNoAsi(node: Node): Node {
    if (this.commentsDisabled) return node;
    const factory = this.context.factory;
    if (node instanceof PartiallyEmittedExpression) {
      if (this.willEmitLeadingNewLine(node)) {
        const parseNode = this.context.parseNode(node);
        if (parseNode instanceof ParenthesizedExpression) {
          const parens = factory.createParenthesizedExpression(node.expression);
          this.context.setOriginal(parens, node);
          parens.pos = parseNode.pos;
          parens.end = parseNode.end;
          return parens;
        }
        return factory.createParenthesizedExpression(node);
      }
      return factory.updatePartiallyEmittedExpression(node, this.parenthesizeExpressionForNoAsi(node.expression));
    }
    if (node instanceof PropertyAccessExpression)
      return factory.updatePropertyAccessExpression(
        node,
        this.parenthesizeExpressionForNoAsi(node.expression),
        node.questionDotToken,
        node.name,
        node.flags,
      );
    if (node instanceof ElementAccessExpression)
      return factory.updateElementAccessExpression(
        node,
        this.parenthesizeExpressionForNoAsi(node.expression),
        node.questionDotToken,
        node.argumentExpression,
        node.flags,
      );
    if (node instanceof CallExpression)
      return factory.updateCallExpression(
        node,
        this.parenthesizeExpressionForNoAsi(node.expression),
        callQuestionDotToken(node),
        callTypeArguments(node),
        node.arguments,
        node.flags,
      );
    if (node instanceof TaggedTemplateExpression)
      return factory.updateTaggedTemplateExpression(
        node,
        this.parenthesizeExpressionForNoAsi(node.tag),
        node.questionDotToken,
        node.typeArguments,
        node.template,
        node.flags,
      );
    if (node instanceof PostfixUnaryExpression)
      return factory.updatePostfixUnaryExpression(
        node,
        this.parenthesizeExpressionForNoAsi(node.operand),
        node.operator,
      );
    if (node instanceof BinaryExpression)
      return factory.updateBinaryExpression(
        node,
        node.modifiers,
        this.parenthesizeExpressionForNoAsi(node.left),
        node.type,
        node.operatorToken,
        node.right,
      );
    if (node instanceof ConditionalExpression)
      return factory.updateConditionalExpression(
        node,
        this.parenthesizeExpressionForNoAsi(node.condition),
        node.questionToken,
        node.whenTrue,
        node.colonToken,
        node.whenFalse,
      );
    if (node instanceof AsExpression)
      return factory.updateAsExpression(node, this.parenthesizeExpressionForNoAsi(node.expression), node.type);
    if (node instanceof SatisfiesExpression)
      return factory.updateSatisfiesExpression(node, this.parenthesizeExpressionForNoAsi(node.expression), node.type);
    if (node instanceof NonNullExpression)
      return factory.updateNonNullExpression(node, this.parenthesizeExpressionForNoAsi(node.expression), node.flags);
    return node;
  }

  private emitExpressionNoASI(node: Node, precedence: OperatorPrecedence): boolean {
    return this.emitExpression(this.parenthesizeExpressionForNoAsi(node), precedence);
  }

  private emitExpression(node: Node, precedence: OperatorPrecedence): boolean {
    const parens = getExpressionPrecedence(skipPartiallyEmittedExpressions(node)) < precedence;
    if (parens) this.write1('(');
    this.emitExpressionWorker(node);
    if (parens) this.write1(')');
    return true;
  }

  private emitExpressionWorker(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.TrueKeyword:
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.SuperKeyword:
      case SyntaxKind.ImportKeyword:
        return this.emitTokenNode(node);
      case SyntaxKind.NumericLiteral:
      case SyntaxKind.BigIntLiteral:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.RegularExpressionLiteral:
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return this.emitLiteral(node);
      case SyntaxKind.Identifier:
        if (node instanceof Identifier) return this.emitIdentifierReference(node);
        break;
      case SyntaxKind.PrivateIdentifier:
        if (node instanceof PrivateIdentifier) return this.emitPrivateIdentifier(node);
        break;
      case SyntaxKind.ArrayLiteralExpression:
        if (node instanceof ArrayLiteralExpression) return this.emitArrayLiteralExpression(node);
        break;
      case SyntaxKind.ObjectLiteralExpression:
        if (node instanceof ObjectLiteralExpression) return this.emitObjectLiteralExpression(node);
        break;
      case SyntaxKind.PropertyAccessExpression:
        if (node instanceof PropertyAccessExpression) return this.emitPropertyAccessExpression(node);
        break;
      case SyntaxKind.ElementAccessExpression:
        if (node instanceof ElementAccessExpression) return this.emitElementAccessExpression(node);
        break;
      case SyntaxKind.CallExpression:
        if (node instanceof CallExpression) return this.emitCallExpression(node);
        break;
      case SyntaxKind.NewExpression:
        if (node instanceof NewExpression) return this.emitNewExpression(node);
        break;
      case SyntaxKind.TaggedTemplateExpression:
        if (node instanceof TaggedTemplateExpression) return this.emitTaggedTemplateExpression(node);
        break;
      case SyntaxKind.TypeAssertionExpression:
        if (node instanceof TypeAssertion) {
          const state = this.enterNode(node);
          this.write1('<');
          this.emitTypeNodeOutsideExtends(node.type);
          this.write1('>');
          this.emitExpression(node.expression, OperatorPrecedence.Update);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.ParenthesizedExpression:
        if (node instanceof ParenthesizedExpression) return this.emitParenthesizedExpression(node);
        break;
      case SyntaxKind.FunctionExpression:
        if (node instanceof FunctionExpression) return this.emitFunctionExpression(node);
        break;
      case SyntaxKind.ArrowFunction:
        if (node instanceof ArrowFunction) return this.emitArrowFunction(node);
        break;
      case SyntaxKind.DeleteExpression:
        if (node instanceof DeleteExpression)
          return this.emitKeywordUnary(node, SyntaxKind.DeleteKeyword, node.expression);
        break;
      case SyntaxKind.TypeOfExpression:
        if (node instanceof TypeOfExpression)
          return this.emitKeywordUnary(node, SyntaxKind.TypeOfKeyword, node.expression);
        break;
      case SyntaxKind.VoidExpression:
        if (node instanceof VoidExpression) return this.emitKeywordUnary(node, SyntaxKind.VoidKeyword, node.expression);
        break;
      case SyntaxKind.AwaitExpression:
        if (node instanceof AwaitExpression)
          return this.emitKeywordUnary(node, SyntaxKind.AwaitKeyword, node.expression);
        break;
      case SyntaxKind.PrefixUnaryExpression:
        if (node instanceof PrefixUnaryExpression) return this.emitPrefixUnaryExpression(node);
        break;
      case SyntaxKind.PostfixUnaryExpression:
        if (node instanceof PostfixUnaryExpression) return this.emitPostfixUnaryExpression(node);
        break;
      case SyntaxKind.BinaryExpression:
        if (node instanceof BinaryExpression) return this.emitBinaryExpression(node);
        break;
      case SyntaxKind.ConditionalExpression:
        if (node instanceof ConditionalExpression) return this.emitConditionalExpression(node);
        break;
      case SyntaxKind.TemplateExpression:
        if (node instanceof TemplateExpression) return this.emitTemplateExpression(node);
        break;
      case SyntaxKind.YieldExpression:
        if (node instanceof YieldExpression) return this.emitYieldExpression(node);
        break;
      case SyntaxKind.SpreadElement:
        if (node instanceof SpreadElement) return this.emitSpreadElement(node);
        break;
      case SyntaxKind.ClassExpression:
        if (node instanceof ClassExpression)
          return this.emitClassLike(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members,
          );
        break;
      case SyntaxKind.OmittedExpression:
        return this.emitSimpleNode(node, '');
      case SyntaxKind.AsExpression:
        if (node instanceof AsExpression) return this.emitTypeRelation(node, node.expression, 'as', node.type);
        break;
      case SyntaxKind.SatisfiesExpression:
        if (node instanceof SatisfiesExpression)
          return this.emitTypeRelation(node, node.expression, 'satisfies', node.type);
        break;
      case SyntaxKind.NonNullExpression:
        if (node instanceof NonNullExpression) {
          const state = this.enterNode(node);
          this.emitExpression(node.expression, OperatorPrecedence.Member);
          this.write1('!');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.ExpressionWithTypeArguments:
        if (node instanceof ExpressionWithTypeArguments) return this.emitExpressionWithTypeArguments(node);
        break;
      case SyntaxKind.MetaProperty:
        if (node instanceof MetaProperty) {
          const state = this.enterNode(node);
          this.emitToken(node.keywordToken, node.pos, node);
          this.write1('.');
          this.emitIdentifierName(node.name);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.MissingDeclaration:
      case SyntaxKind.NotEmittedStatement:
        return false;
      case SyntaxKind.JsxElement:
        if (node instanceof JsxElement) return this.emitJsxElement(node);
        break;
      case SyntaxKind.JsxSelfClosingElement:
        if (node instanceof JsxSelfClosingElement) return this.emitJsxSelfClosingElement(node);
        break;
      case SyntaxKind.JsxFragment:
        if (node instanceof JsxFragment) return this.emitJsxFragment(node);
        break;
      case SyntaxKind.PartiallyEmittedExpression:
        if (node instanceof PartiallyEmittedExpression) return this.emitPartiallyEmittedExpression(node);
        break;
    }
    throw new Error('Unexpected expression ' + node.kind);
  }

  // Statements

  private isEmptyBlock(block: Node, statements: NodeList): boolean {
    return (
      statements.nodes.length === 0 &&
      (this.currentSourceFile === undefined || this.rangeEndIsOnSameLineAsRangeStart(block.end, block.pos))
    );
  }

  private emitBlock(node: Block): boolean {
    const state = this.enterNode(node);
    this.generateNames(node);
    this.emitToken(SyntaxKind.OpenBraceToken, node.pos, node);
    const format =
      (!node.multiLine && this.isEmptyBlock(node, node.statements)) || this.shouldEmitOnSingleLine(node)
        ? ListFormat.SingleLineBlockStatements
        : ListFormat.MultiLineBlockStatements;
    this.emitList(ListItem.Statement, node, node.statements, format);
    this.emitTokenEx(
      SyntaxKind.CloseBraceToken,
      node.statements.end,
      node,
      (format & ListFormat.MultiLine) !== 0 ? TokenEmitFlags.IndentLeadingComments : TokenEmitFlags.None,
    );
    this.exitNode(node, state);
    return true;
  }

  private emitVariableStatement(node: VariableStatement): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.emitVariableDeclarationList(node.declarationList);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitExpressionStatement(node: ExpressionStatement): boolean {
    const state = this.enterNode(node);
    const json = this.currentSourceFile !== undefined && this.currentSourceFile.scriptKind === ScriptKind.JSON;
    const expression = node.expression;
    if (json) this.emitExpression(expression, OperatorPrecedence.Comma);
    else if (isImmediatelyInvokedFunctionExpressionOrArrowFunction(expression)) {
      // Parenthesize only the callee: `(function () {})()`.
      const call = skipPartiallyEmittedExpressions(expression);
      if (call instanceof CallExpression) {
        const callState = this.enterNode(call);
        this.write1('(');
        this.emitExpression(call.expression, OperatorPrecedence.Lowest);
        this.write1(')');
        this.emitOptionalToken(callQuestionDotToken(call));
        this.emitTypeArguments(call, callTypeArguments(call));
        this.emitList(ListItem.Argument, call, call.arguments, ListFormat.CallExpressionArguments);
        this.exitNode(call, callState);
      }
    } else {
      const leftmost = getLeftmostExpression(expression, false).kind;
      this.emitExpression(
        expression,
        leftmost === SyntaxKind.FunctionExpression || leftmost === SyntaxKind.ObjectLiteralExpression
          ? OperatorPrecedence.Parentheses
          : OperatorPrecedence.Comma,
      );
    }
    if (!json || nodeIsSynthesized(expression)) this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  /** `if`/`while`/`with`/`switch` heads: keyword, `(`, expression, `)`. */
  private emitKeywordAndParenthesizedExpression(
    node: Node,
    keyword: SyntaxKind,
    keywordPos: number,
    expression: Node,
  ): boolean {
    const pos = this.emitToken(keyword, keywordPos, node);
    this.space();
    this.emitToken(SyntaxKind.OpenParenToken, pos, node);
    this.emitExpression(expression, OperatorPrecedence.Lowest);
    this.emitToken(SyntaxKind.CloseParenToken, expression.end, node);
    return true;
  }

  private emitIfStatement(node: IfStatement): boolean {
    const state = this.enterNode(node);
    this.emitKeywordAndParenthesizedExpression(node, SyntaxKind.IfKeyword, node.pos, node.expression);
    this.emitEmbeddedStatement(node, node.thenStatement);
    const elseStatement = node.elseStatement;
    if (elseStatement !== undefined) {
      this.writeLineOrSpace(node, node.thenStatement, elseStatement);
      this.emitToken(SyntaxKind.ElseKeyword, node.thenStatement.end, node);
      if (elseStatement instanceof IfStatement) {
        this.space();
        this.emitIfStatement(elseStatement);
      } else this.emitEmbeddedStatement(node, elseStatement);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitDoStatement(node: DoStatement): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.DoKeyword, node.pos, node);
    this.emitEmbeddedStatement(node, node.statement);
    if (node.statement instanceof Block && !this.options.preserveSourceNewlines) this.space();
    else this.writeLineOrSpace(node, node.statement, node.expression);
    this.emitKeywordAndParenthesizedExpression(node, SyntaxKind.WhileKeyword, node.statement.end, node.expression);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitForInitializer(node: Node): boolean {
    if (node instanceof VariableDeclarationList) return this.emitVariableDeclarationList(node);
    return this.emitExpression(node, OperatorPrecedence.Lowest);
  }

  private emitForStatement(node: ForStatement): boolean {
    const state = this.enterNode(node);
    let pos = this.emitToken(SyntaxKind.ForKeyword, node.pos, node);
    this.space();
    pos = this.emitToken(SyntaxKind.OpenParenToken, pos, node);
    if (node.initializer !== undefined) {
      this.emitForInitializer(node.initializer);
      pos = node.initializer.end;
    }
    pos = this.emitToken(SyntaxKind.SemicolonToken, pos, node);
    if (node.condition !== undefined) {
      this.space();
      this.emitExpression(node.condition, OperatorPrecedence.Lowest);
      pos = node.condition.end;
    }
    pos = this.emitToken(SyntaxKind.SemicolonToken, pos, node);
    if (node.incrementor !== undefined) {
      this.space();
      this.emitExpression(node.incrementor, OperatorPrecedence.Lowest);
      pos = node.incrementor.end;
    }
    this.emitToken(SyntaxKind.CloseParenToken, pos, node);
    this.emitEmbeddedStatement(node, node.statement);
    this.exitNode(node, state);
    return true;
  }

  private emitForInOrOfStatement(node: ForInOrOfStatement): boolean {
    const state = this.enterNode(node);
    const pos = this.emitToken(SyntaxKind.ForKeyword, node.pos, node);
    this.space();
    if (node.kind === SyntaxKind.ForOfStatement && node.awaitModifier !== undefined) {
      this.emitOptionalToken(node.awaitModifier);
      this.space();
    }
    this.emitToken(SyntaxKind.OpenParenToken, pos, node);
    this.emitForInitializer(node.initializer);
    this.space();
    this.emitToken(
      node.kind === SyntaxKind.ForOfStatement ? SyntaxKind.OfKeyword : SyntaxKind.InKeyword,
      node.initializer.end,
      node,
    );
    this.space();
    this.emitExpression(node.expression, OperatorPrecedence.Lowest);
    this.emitToken(SyntaxKind.CloseParenToken, node.expression.end, node);
    this.emitEmbeddedStatement(node, node.statement);
    this.exitNode(node, state);
    return true;
  }

  /** `break`, `continue` and `return` with their optional operand. */
  private emitJumpStatement(
    node: Node,
    keyword: SyntaxKind,
    label: Identifier | undefined,
    expression: Node | undefined,
  ): boolean {
    const state = this.enterNode(node);
    this.emitToken(keyword, node.pos, node);
    if (label !== undefined) {
      this.space();
      this.emitIdentifierName(label);
    }
    if (expression !== undefined) {
      this.space();
      this.emitExpressionNoASI(expression, OperatorPrecedence.Lowest);
    }
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitTryStatement(node: TryStatement): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.TryKeyword, node.pos, node);
    this.space();
    this.emitBlock(node.tryBlock);
    const catchClause = node.catchClause;
    if (catchClause !== undefined) {
      this.writeLineOrSpace(node, node.tryBlock, catchClause);
      this.emitCatchClause(catchClause);
    }
    if (node.finallyBlock !== undefined) {
      const previous: Node = catchClause !== undefined ? catchClause : node.tryBlock;
      this.writeLineOrSpace(node, previous, node.finallyBlock);
      this.emitToken(SyntaxKind.FinallyKeyword, previous.end, node);
      this.space();
      this.emitBlock(node.finallyBlock);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitEmbeddedStatement(parent: Node, node: Node): boolean {
    if (
      node instanceof Block ||
      this.shouldEmitOnSingleLine(parent) ||
      (this.options.preserveSourceNewlines && this.getLeadingLineTerminatorCount(parent, node, ListFormat.None) === 0)
    ) {
      this.space();
      return this.emitStatement(node);
    }
    this.line();
    this.writer.indent++;
    // An embedded empty statement is significant.
    if (node instanceof EmptyStatement) this.emitSimpleNode(node, ';');
    else this.emitStatement(node);
    this.writer.indent--;
    return true;
  }

  // Declarations

  private emitVariableDeclaration(node: VariableDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitBindingName(node.name);
    this.emitOptionalToken(node.exclamationToken);
    this.emitTypeAnnotation(node.type);
    let end = node.name.end;
    if (node.type !== undefined && node.type.end > end) end = node.type.end;
    const erasedType = this.context.getTypeNode(node.name);
    if (erasedType !== undefined && erasedType.end > end) end = erasedType.end;
    this.emitInitializer(node.initializer, end, node);
    this.exitNode(node, state);
    return true;
  }

  private emitVariableDeclarationList(node: VariableDeclarationList): boolean {
    const state = this.enterNode(node);
    switch (blockScopeFlags(node)) {
      case NodeFlags.Let:
        this.write1('let');
        break;
      case NodeFlags.Const:
        this.write1('const');
        break;
      case NodeFlags.Using:
        this.write1('using');
        break;
      case NodeFlags.AwaitUsing:
        this.write1('await using');
        break;
      default:
        this.write1('var');
    }
    this.space();
    this.emitList(ListItem.VariableDeclaration, node, node.declarations, ListFormat.VariableDeclarationList);
    this.exitNode(node, state);
    return true;
  }

  private emitFunctionDeclaration(node: FunctionDeclaration): boolean {
    const state = this.enterNode(node);
    this.generateNameIfNeeded(node.name);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('function');
    this.emitOptionalToken(node.asteriskToken);
    this.space();
    if (node.name !== undefined) this.emitIdentifierName(node.name);
    this.emitScopedSignature(node, node.typeParameters, node.parameters, node.type, node.body, true);
    this.exitNode(node, state);
    return true;
  }

  private emitInterfaceDeclaration(node: InterfaceDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('interface ');
    this.emitBindingIdentifier(node.name);
    this.emitTypeParameters(node, node.typeParameters);
    this.emitList(ListItem.HeritageClause, node, node.heritageClauses, ListFormat.HeritageClauses);
    this.write1(' {');
    this.pushNameGenerationScope(node);
    this.generateAllMemberNames(node.members);
    this.emitList(ListItem.TypeElement, node, node.members, ListFormat.InterfaceMembers);
    this.popNameGenerationScope(node);
    this.write1('}');
    this.exitNode(node, state);
    return true;
  }

  private emitTypeAliasDeclaration(node: TypeAliasDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('type ');
    this.emitBindingIdentifier(node.name);
    this.emitTypeParameters(node, node.typeParameters);
    this.write1(' = ');
    this.emitTypeNodeOutsideExtends(node.type);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitEnumDeclaration(node: EnumDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    this.write1('enum ');
    this.emitBindingIdentifier(node.name);
    this.write1(' {');
    this.emitList(ListItem.EnumMember, node, node.members, ListFormat.EnumMembers);
    this.write1('}');
    this.exitNode(node, state);
    return true;
  }

  private emitModuleDeclaration(node: ModuleDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    if (node.keyword !== SyntaxKind.GlobalKeyword)
      this.write1(node.keyword === SyntaxKind.NamespaceKeyword ? 'namespace ' : 'module ');
    this.emitIdentifierOrString(node.name, true);
    let body = node.body;
    while (body instanceof ModuleDeclaration) {
      this.write1('.');
      this.emitIdentifierOrString(body.name, false);
      body = body.body;
    }
    if (body === undefined) this.write1(';');
    else if (body instanceof ModuleBlock) {
      this.space();
      this.emitBlockLike(body, body.statements, false);
    }
    this.exitNode(node, state);
    return true;
  }

  /** Module blocks and case blocks: braces around a statement or clause list. */
  private emitBlockLike(node: Node, statements: NodeList, caseBlock: boolean): boolean {
    const state = this.enterNode(node);
    if (!caseBlock) this.generateNames(node);
    this.emitToken(SyntaxKind.OpenBraceToken, node.pos, node);
    let format: ListFormat;
    if (caseBlock) format = ListFormat.CaseBlockClauses;
    else
      format =
        this.isEmptyBlock(node, statements) || this.shouldEmitOnSingleLine(node)
          ? ListFormat.SingleLineBlockStatements
          : ListFormat.MultiLineBlockStatements;
    this.emitList(caseBlock ? ListItem.CaseOrDefaultClause : ListItem.Statement, node, statements, format);
    this.emitTokenEx(
      SyntaxKind.CloseBraceToken,
      statements.end,
      node,
      caseBlock || (format & ListFormat.MultiLine) !== 0 ? TokenEmitFlags.IndentLeadingComments : TokenEmitFlags.None,
    );
    this.exitNode(node, state);
    return true;
  }

  private emitImportEqualsDeclaration(node: ImportEqualsDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    const modifiersEnd = node.modifiers !== undefined && node.modifiers.end > node.pos ? node.modifiers.end : node.pos;
    const pos = this.emitToken(SyntaxKind.ImportKeyword, modifiersEnd, node);
    this.space();
    if (node.isTypeOnly) {
      this.emitToken(SyntaxKind.TypeKeyword, pos, node);
      this.space();
    }
    this.emitBindingIdentifier(node.name);
    this.space();
    this.emitToken(SyntaxKind.EqualsToken, node.name.end, node);
    this.space();
    const reference = node.moduleReference;
    if (reference instanceof Identifier) this.emitIdentifierReference(reference);
    else if (reference instanceof QualifiedName) this.emitQualifiedName(reference);
    else if (reference instanceof ExternalModuleReference) {
      const referenceState = this.enterNode(reference);
      this.write1('require(');
      this.emitExpression(reference.expression, OperatorPrecedence.DisallowComma);
      this.write1(')');
      this.exitNode(reference, referenceState);
    } else throw new Error('Unexpected module reference ' + reference.kind);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitImportDeclaration(node: ImportDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    const modifiersEnd = node.modifiers !== undefined && node.modifiers.end > node.pos ? node.modifiers.end : node.pos;
    this.emitToken(SyntaxKind.ImportKeyword, modifiersEnd, node);
    this.space();
    const clause = node.importClause;
    if (clause !== undefined) {
      this.emitImportClause(clause);
      this.space();
      this.emitToken(SyntaxKind.FromKeyword, clause.end, node);
      this.space();
    }
    this.emitExpression(node.moduleSpecifier, OperatorPrecedence.Lowest);
    if (node.attributes !== undefined) {
      this.space();
      this.emitImportAttributes(node.attributes);
    }
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitImportClause(node: ImportClause): boolean {
    const state = this.enterNode(node);
    if (node.phaseModifier !== undefined && node.phaseModifier !== SyntaxKind.Unknown) {
      this.emitToken(node.phaseModifier, node.pos, node);
      this.space();
    }
    const name = node.name;
    if (name !== undefined) {
      this.emitBindingIdentifier(name);
      if (node.namedBindings !== undefined) {
        this.emitToken(SyntaxKind.CommaToken, name.end, node);
        this.space();
      }
    }
    const bindings = node.namedBindings;
    if (bindings instanceof NamespaceImport) {
      const bindingsState = this.enterNode(bindings);
      const pos = this.emitToken(SyntaxKind.AsteriskToken, bindings.pos, bindings);
      this.space();
      this.emitToken(SyntaxKind.AsKeyword, pos, bindings);
      this.space();
      this.emitBindingIdentifier(bindings.name);
      this.exitNode(bindings, bindingsState);
    } else if (bindings instanceof NamedImports) {
      const bindingsState = this.enterNode(bindings);
      this.write1('{');
      this.emitList(ListItem.ImportSpecifier, bindings, bindings.elements, ListFormat.NamedImportsOrExportsElements);
      this.write1('}');
      this.exitNode(bindings, bindingsState);
    }
    this.exitNode(node, state);
    return true;
  }

  /** Import and export specifiers. */
  private emitSpecifier(
    node: Node,
    isTypeOnly: boolean,
    propertyName: Node | undefined,
    name: Node,
    binding: boolean,
  ): boolean {
    const state = this.enterNode(node);
    if (isTypeOnly) this.write1('type ');
    if (propertyName !== undefined) {
      this.emitIdentifierOrString(propertyName, false);
      this.space();
      this.emitToken(SyntaxKind.AsKeyword, propertyName.end, node);
      this.space();
    }
    this.emitIdentifierOrString(name, binding);
    this.exitNode(node, state);
    return true;
  }

  private emitExportAssignment(node: ExportAssignment): boolean {
    const state = this.enterNode(node);
    const nextPos = this.emitToken(SyntaxKind.ExportKeyword, node.pos, node);
    this.space();
    this.emitToken(node.isExportEquals ? SyntaxKind.EqualsToken : SyntaxKind.DefaultKeyword, nextPos, node);
    this.space();
    if (node.isExportEquals) this.emitExpression(node.expression, OperatorPrecedence.Assignment);
    else {
      const leftmost = getLeftmostExpression(node.expression, false).kind;
      this.emitExpression(
        node.expression,
        leftmost === SyntaxKind.ClassExpression || leftmost === SyntaxKind.FunctionExpression
          ? OperatorPrecedence.Parentheses
          : OperatorPrecedence.Assignment,
      );
    }
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitExportDeclaration(node: ExportDeclaration): boolean {
    const state = this.enterNode(node);
    this.emitModifierList(node, node.modifiers, false);
    let pos = this.emitToken(SyntaxKind.ExportKeyword, node.pos, node);
    this.space();
    if (node.isTypeOnly) {
      pos = this.emitToken(SyntaxKind.TypeKeyword, pos, node);
      this.space();
    }
    const clause = node.exportClause;
    if (clause instanceof NamespaceExport) {
      const clauseState = this.enterNode(clause);
      const asteriskEnd = this.emitToken(SyntaxKind.AsteriskToken, clause.pos, clause);
      this.space();
      this.emitToken(SyntaxKind.AsKeyword, asteriskEnd, clause);
      this.space();
      this.emitIdentifierOrString(clause.name, false);
      this.exitNode(clause, clauseState);
    } else if (clause instanceof NamedExports) {
      const clauseState = this.enterNode(clause);
      this.write1('{');
      this.emitList(ListItem.ExportSpecifier, clause, clause.elements, ListFormat.NamedImportsOrExportsElements);
      this.write1('}');
      this.exitNode(clause, clauseState);
    } else pos = this.emitToken(SyntaxKind.AsteriskToken, pos, node);
    if (node.moduleSpecifier !== undefined) {
      this.space();
      this.emitToken(SyntaxKind.FromKeyword, clause !== undefined && clause.end > pos ? clause.end : pos, node);
      this.space();
      this.emitExpression(node.moduleSpecifier, OperatorPrecedence.Lowest);
    }
    if (node.attributes !== undefined) {
      this.space();
      this.emitImportAttributes(node.attributes);
    }
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitImportAttributes(node: ImportAttributes): boolean {
    const state = this.enterNode(node);
    this.emitToken(node.token, node.pos, node);
    this.space();
    this.emitList(ListItem.ImportAttribute, node, node.attributes, ListFormat.ImportAttributes);
    this.exitNode(node, state);
    return true;
  }

  private emitImportAttribute(node: ImportAttribute): boolean {
    const state = this.enterNode(node);
    if (node.name !== undefined) this.emitIdentifierOrString(node.name, false);
    this.write1(': ');
    const value = node.value;
    if (!this.hasEmitFlag(value, EmitFlags.NoLeadingComments))
      this.emitTrailingComments(this.context.commentPos(value), CommentSeparator.After);
    this.emitExpression(value, OperatorPrecedence.DisallowComma);
    this.exitNode(node, state);
    return true;
  }

  private emitNamespaceExportDeclaration(node: NamespaceExportDeclaration): boolean {
    const state = this.enterNode(node);
    let pos = this.emitToken(SyntaxKind.ExportKeyword, node.pos, node);
    this.space();
    pos = this.emitToken(SyntaxKind.AsKeyword, pos, node);
    this.space();
    this.emitToken(SyntaxKind.NamespaceKeyword, pos, node);
    this.space();
    this.emitBindingIdentifier(node.name);
    this.write1(';');
    this.exitNode(node, state);
    return true;
  }

  private emitStatement(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.Block:
        if (node instanceof Block) return this.emitBlock(node);
        break;
      case SyntaxKind.EmptyStatement:
        return this.emitSimpleNode(node, ';');
      case SyntaxKind.VariableStatement:
        if (node instanceof VariableStatement) return this.emitVariableStatement(node);
        break;
      case SyntaxKind.ExpressionStatement:
        if (node instanceof ExpressionStatement) return this.emitExpressionStatement(node);
        break;
      case SyntaxKind.IfStatement:
        if (node instanceof IfStatement) return this.emitIfStatement(node);
        break;
      case SyntaxKind.DoStatement:
        if (node instanceof DoStatement) return this.emitDoStatement(node);
        break;
      case SyntaxKind.WhileStatement:
        if (node instanceof WhileStatement) {
          const state = this.enterNode(node);
          this.emitKeywordAndParenthesizedExpression(node, SyntaxKind.WhileKeyword, node.pos, node.expression);
          this.emitEmbeddedStatement(node, node.statement);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.ForStatement:
        if (node instanceof ForStatement) return this.emitForStatement(node);
        break;
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        if (node instanceof ForInOrOfStatement) return this.emitForInOrOfStatement(node);
        break;
      case SyntaxKind.ContinueStatement:
        if (node instanceof ContinueStatement)
          return this.emitJumpStatement(node, SyntaxKind.ContinueKeyword, node.label, undefined);
        break;
      case SyntaxKind.BreakStatement:
        if (node instanceof BreakStatement)
          return this.emitJumpStatement(node, SyntaxKind.BreakKeyword, node.label, undefined);
        break;
      case SyntaxKind.ReturnStatement:
        if (node instanceof ReturnStatement)
          return this.emitJumpStatement(node, SyntaxKind.ReturnKeyword, undefined, node.expression);
        break;
      case SyntaxKind.WithStatement:
        if (node instanceof WithStatement) {
          const state = this.enterNode(node);
          this.emitKeywordAndParenthesizedExpression(node, SyntaxKind.WithKeyword, node.pos, node.expression);
          this.emitEmbeddedStatement(node, node.statement);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.SwitchStatement:
        if (node instanceof SwitchStatement) {
          const state = this.enterNode(node);
          this.emitKeywordAndParenthesizedExpression(node, SyntaxKind.SwitchKeyword, node.pos, node.expression);
          this.space();
          this.emitBlockLike(node.caseBlock, node.caseBlock.clauses, true);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.LabeledStatement:
        if (node instanceof LabeledStatement) {
          const state = this.enterNode(node);
          this.emitIdentifierName(node.label);
          this.emitToken(SyntaxKind.ColonToken, node.label.end, node);
          this.space();
          this.emitStatement(node.statement);
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.ThrowStatement:
        if (node instanceof ThrowStatement) {
          const state = this.enterNode(node);
          this.emitToken(SyntaxKind.ThrowKeyword, node.pos, node);
          this.space();
          this.emitExpressionNoASI(node.expression, OperatorPrecedence.Lowest);
          this.write1(';');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.TryStatement:
        if (node instanceof TryStatement) return this.emitTryStatement(node);
        break;
      case SyntaxKind.DebuggerStatement:
        if (node instanceof DebuggerStatement) {
          const state = this.enterNode(node);
          this.emitToken(SyntaxKind.DebuggerKeyword, node.pos, node);
          this.write1(';');
          this.exitNode(node, state);
          return true;
        }
        break;
      case SyntaxKind.NotEmittedStatement:
        return this.emitSimpleNode(node, '');
      case SyntaxKind.FunctionDeclaration:
        if (node instanceof FunctionDeclaration) return this.emitFunctionDeclaration(node);
        break;
      case SyntaxKind.ClassDeclaration:
        if (node instanceof ClassDeclaration)
          return this.emitClassLike(
            node,
            node.modifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members,
          );
        break;
      case SyntaxKind.InterfaceDeclaration:
        if (node instanceof InterfaceDeclaration) return this.emitInterfaceDeclaration(node);
        break;
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
        if (node instanceof TypeAliasDeclaration) return this.emitTypeAliasDeclaration(node);
        break;
      case SyntaxKind.EnumDeclaration:
        if (node instanceof EnumDeclaration) return this.emitEnumDeclaration(node);
        break;
      case SyntaxKind.ModuleDeclaration:
        if (node instanceof ModuleDeclaration) return this.emitModuleDeclaration(node);
        break;
      case SyntaxKind.MissingDeclaration:
        return false;
      case SyntaxKind.NamespaceExportDeclaration:
        if (node instanceof NamespaceExportDeclaration) return this.emitNamespaceExportDeclaration(node);
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration) return this.emitImportEqualsDeclaration(node);
        break;
      case SyntaxKind.ImportDeclaration:
        if (node instanceof ImportDeclaration) return this.emitImportDeclaration(node);
        break;
      case SyntaxKind.ExportAssignment:
        if (node instanceof ExportAssignment) return this.emitExportAssignment(node);
        break;
      case SyntaxKind.ExportDeclaration:
        if (node instanceof ExportDeclaration) return this.emitExportDeclaration(node);
        break;
    }
    throw new Error('Unexpected statement ' + node.kind);
  }

  // JSX

  private emitJsxElement(node: JsxElement): boolean {
    const state = this.enterNode(node);
    this.emitJsxOpeningElement(node.openingElement);
    this.emitList(ListItem.JsxChild, node, node.children, ListFormat.JsxElementOrFragmentChildren);
    this.emitJsxClosingElement(node.closingElement);
    this.exitNode(node, state);
    return true;
  }

  private emitJsxSelfClosingElement(node: JsxSelfClosingElement): boolean {
    const state = this.enterNode(node);
    this.write1('<');
    this.emitJsxTagName(node.tagName);
    this.emitTypeArguments(node, node.typeArguments);
    this.space();
    this.emitJsxAttributes(node.attributes);
    this.write1('/>');
    this.exitNode(node, state);
    return true;
  }

  private emitJsxFragment(node: JsxFragment): boolean {
    const state = this.enterNode(node);
    this.emitSimpleNode(node.openingFragment, '<>');
    this.emitList(ListItem.JsxChild, node, node.children, ListFormat.JsxElementOrFragmentChildren);
    this.emitSimpleNode(node.closingFragment, '</>');
    this.exitNode(node, state);
    return true;
  }

  private emitJsxOpeningElement(node: JsxOpeningElement): boolean {
    const state = this.enterNode(node);
    this.write1('<');
    const indented = this.writeLineSeparatorsAndIndentBefore(node.tagName, node);
    this.emitJsxTagName(node.tagName);
    this.emitTypeArguments(node, node.typeArguments);
    if (node.attributes.properties.nodes.length > 0) this.space();
    this.emitJsxAttributes(node.attributes);
    this.writeLineSeparatorsAfter(node.attributes, node);
    this.indentIf(indented, -1);
    this.write1('>');
    this.exitNode(node, state);
    return true;
  }

  private emitJsxClosingElement(node: JsxClosingElement): boolean {
    const state = this.enterNode(node);
    this.write1('</');
    this.emitJsxTagName(node.tagName);
    this.write1('>');
    this.exitNode(node, state);
    return true;
  }

  private emitJsxAttributes(node: JsxAttributes): boolean {
    const state = this.enterNode(node);
    this.emitList(ListItem.JsxAttributeLike, node, node.properties, ListFormat.JsxElementAttributes);
    this.exitNode(node, state);
    return true;
  }

  private emitJsxAttribute(node: JsxAttribute): boolean {
    const state = this.enterNode(node);
    this.emitJsxName(node.name);
    const initializer = node.initializer;
    if (initializer !== undefined) {
      this.write1('=');
      if (initializer instanceof StringLiteral) this.emitLiteral(initializer);
      else if (initializer instanceof JsxExpression) this.emitJsxExpression(initializer);
      else if (initializer instanceof JsxElement) this.emitJsxElement(initializer);
      else if (initializer instanceof JsxSelfClosingElement) this.emitJsxSelfClosingElement(initializer);
      else if (initializer instanceof JsxFragment) this.emitJsxFragment(initializer);
      else this.emitExpression(initializer, OperatorPrecedence.Lowest);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitJsxExpression(node: JsxExpression): boolean {
    const state = this.enterNode(node);
    if (
      node.expression !== undefined ||
      (!this.commentsDisabled && !nodeIsSynthesized(node) && this.hasCommentsAtPosition(node.pos))
    ) {
      const indented =
        this.currentSourceFile !== undefined &&
        !nodeIsSynthesized(node) &&
        getLinesBetweenPositions(this.lineStarts, node.pos, node.end) !== 0;
      this.indentIf(indented, 1);
      let end = this.emitToken(SyntaxKind.OpenBraceToken, node.pos, node);
      this.emitOptionalToken(node.dotDotDotToken);
      if (node.expression !== undefined) this.emitExpression(node.expression, OperatorPrecedence.DisallowComma);
      if (node.expression !== undefined && node.expression.end > end) end = node.expression.end;
      if (node.dotDotDotToken !== undefined && node.dotDotDotToken.end > end) end = node.dotDotDotToken.end;
      this.emitToken(SyntaxKind.CloseBraceToken, end, node);
      this.indentIf(indented, -1);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitJsxName(node: Node | undefined): boolean {
    if (node === undefined) return false;
    if (node instanceof Identifier) return this.emitIdentifierName(node);
    if (node instanceof JsxNamespacedName) {
      const state = this.enterNode(node);
      this.emitIdentifierName(node.namespace);
      this.write1(':');
      this.emitIdentifierName(node.name);
      this.exitNode(node, state);
      return true;
    }
    throw new Error('Unexpected JSX name ' + node.kind);
  }

  private emitJsxTagName(node: Node): boolean {
    if (node instanceof Identifier) return this.emitIdentifierReference(node);
    if (node instanceof PropertyAccessExpression) return this.emitPropertyAccessExpression(node);
    if (node.kind === SyntaxKind.ThisKeyword) return this.emitTokenNode(node);
    return this.emitJsxName(node);
  }

  // Typed `Node | undefined` (with a check) so scriptc narrows elements read from arrays.
  private emitJsxChild(node: Node | undefined): boolean {
    if (node === undefined) return false;
    if (node instanceof JsxText) {
      const state = this.enterNode(node);
      this.writer.writeText(node.text);
      this.exitNode(node, state);
      return true;
    }
    if (node instanceof JsxExpression) return this.emitJsxExpression(node);
    if (node instanceof JsxElement) return this.emitJsxElement(node);
    if (node instanceof JsxSelfClosingElement) return this.emitJsxSelfClosingElement(node);
    if (node instanceof JsxFragment) return this.emitJsxFragment(node);
    throw new Error('Unexpected JSX child ' + node.kind);
  }

  // Clauses

  private emitCaseOrDefaultClause(node: CaseOrDefaultClause): boolean {
    const state = this.enterNode(node);
    let colonPos: number;
    if (node.kind === SyntaxKind.CaseClause && node.expression !== undefined) {
      this.emitToken(SyntaxKind.CaseKeyword, node.pos, node);
      this.space();
      this.emitExpression(node.expression, OperatorPrecedence.Lowest);
      colonPos = node.expression.end;
    } else colonPos = this.emitToken(SyntaxKind.DefaultKeyword, node.pos, node);
    const statements = node.statements.nodes;
    const single =
      statements.length === 1 &&
      (this.currentSourceFile === undefined ||
        nodeIsSynthesized(node) ||
        nodeIsSynthesized(statements[0]!) ||
        this.positionsAreOnSameLine(this.rangeStart(node.pos), this.rangeStart(statements[0]!.pos)));
    let format = ListFormat.CaseOrDefaultClauseStatements;
    if (single) {
      // The statement list emits the colon's trailing comments.
      this.writeTokenText(SyntaxKind.ColonToken, colonPos);
      this.space();
      format &= ~(ListFormat.MultiLine | ListFormat.Indented);
    } else this.emitToken(SyntaxKind.ColonToken, colonPos, node);
    this.emitList(ListItem.Statement, node, node.statements, format);
    this.exitNode(node, state);
    return true;
  }

  private emitHeritageClause(node: HeritageClause): boolean {
    const state = this.enterNode(node);
    this.space();
    this.emitToken(node.token, node.pos, node);
    this.space();
    this.emitList(ListItem.ExpressionWithTypeArguments, node, node.types, ListFormat.HeritageClauseTypes);
    this.exitNode(node, state);
    return true;
  }

  private emitCatchClause(node: CatchClause): boolean {
    const state = this.enterNode(node);
    const openParenPos = this.emitToken(SyntaxKind.CatchKeyword, node.pos, node);
    this.space();
    const declaration = node.variableDeclaration;
    if (declaration !== undefined) {
      this.emitToken(SyntaxKind.OpenParenToken, openParenPos, node);
      this.emitVariableDeclaration(declaration);
      this.emitToken(SyntaxKind.CloseParenToken, declaration.end, node);
      this.space();
    }
    this.emitBlock(node.block);
    this.exitNode(node, state);
    return true;
  }

  // Property assignments

  private emitPropertyAssignment(node: PropertyAssignment): boolean {
    const state = this.enterNode(node);
    this.emitPropertyName(node.name);
    this.write1(': ');
    // `{ id: /*comment*/ () => {} }`: the comment trails the colon rather than leading the initializer.
    const initializer = node.initializer;
    if (!this.hasEmitFlag(initializer, EmitFlags.NoLeadingComments))
      this.emitTrailingComments(this.context.commentPos(initializer), CommentSeparator.After);
    this.emitExpression(initializer, OperatorPrecedence.DisallowComma);
    this.exitNode(node, state);
    return true;
  }

  private emitShorthandPropertyAssignment(node: ShorthandPropertyAssignment): boolean {
    const state = this.enterNode(node);
    this.emitPropertyName(node.name);
    if (node.objectAssignmentInitializer !== undefined) {
      this.write1(' = ');
      this.emitExpression(node.objectAssignmentInitializer, OperatorPrecedence.DisallowComma);
    }
    this.exitNode(node, state);
    return true;
  }

  private emitSpreadAssignment(node: SpreadAssignment): boolean {
    const state = this.enterNode(node);
    this.emitToken(SyntaxKind.DotDotDotToken, node.pos, node);
    this.emitExpression(node.expression, OperatorPrecedence.DisallowComma);
    this.exitNode(node, state);
    return true;
  }

  private emitEnumMember(node: EnumMember): boolean {
    const state = this.enterNode(node);
    this.emitPropertyName(node.name);
    this.emitInitializer(node.initializer, node.name.end, node);
    this.exitNode(node, state);
    return true;
  }

  // Source files

  private emitPrologueDirectives(statements: NodeList): number {
    const nodes = statements.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (!isPrologueDirective(node)) return i;
      this.line();
      this.emitStatement(node);
    }
    return nodes.length;
  }

  private emitHelpers(node: Node): boolean {
    const nodeHelpers = this.context.getEmitHelpers(node);
    if (nodeHelpers === undefined || nodeHelpers.length === 0) return false;
    const file = this.currentSourceFile;
    const shouldSkip =
      this.options.noEmitHelpers || (file !== undefined && this.context.hasRecordedExternalHelpers(file));
    const helpers = nodeHelpers.slice();
    helpers.sort(compareEmitHelpers);
    let emitted = false;
    for (const helper of helpers) {
      if (!helper.scoped && shouldSkip) continue;
      let text = helper.text;
      if (helper.uniqueName.length > 0)
        text = text.split('{name}').join(this.nameGenerator.makeFileLevelOptimisticUniqueName(helper.uniqueName));
      this.writeLinesOfText(text);
      emitted = true;
    }
    return emitted;
  }

  private emitSourceFileNode(node: SourceFile): boolean {
    const savedSourceFile = this.currentSourceFile;
    const savedCommentsDisabled = this.commentsDisabled;
    this.setCurrentSourceFile(node);
    this.line();
    this.pushNameGenerationScope(node);
    this.generateAllNames(node.statements);
    let index = 0;
    let detached: number;
    if (node.scriptKind !== ScriptKind.JSON) {
      if (!nodeIsSynthesized(node)) {
        const shebang = getShebang(node.text);
        if (shebang.length > 0) {
          this.writer.writeComment(shebang);
          this.line();
        }
      }
      index = this.emitPrologueDirectives(node.statements);
      if (!this.writer.isAtStartOfLine()) this.line();
      detached = this.emitDetachedCommentsBeforeStatementList(node, node.statements.pos);
      this.emitHelpers(node);
      if (node.isDeclarationFile) this.emitTripleSlashDirectives(node);
    } else detached = this.emitDetachedCommentsBeforeStatementList(node, node.statements.pos);
    this.emitListRange(ListItem.Statement, node, node.statements, ListFormat.MultiLine, index);
    this.popNameGenerationScope(node);
    this.emitDetachedCommentsAfterStatementList(node, node.statements.end, detached);
    this.setCurrentSourceFile(savedSourceFile);
    this.commentsDisabled = savedCommentsDisabled;
    return true;
  }

  private emitTripleSlashDirectives(node: SourceFile): boolean {
    this.emitDirectives('path', node.referencedFiles);
    this.emitDirectives('types', node.typeReferenceDirectives);
    return this.emitDirectives('lib', node.libReferenceDirectives);
  }

  private emitDirectives(kind: string, refs: readonly FileReference[]): boolean {
    for (const ref of refs) {
      let mode = '';
      if (ref.resolutionMode !== 0)
        mode = 'resolution-mode="' + (ref.resolutionMode === 99 ? 'import' : 'require') + '" ';
      this.writer.writeComment(
        '/// <reference ' + kind + '="' + ref.fileName + '" ' + mode + (ref.preserve ? 'preserve="true" ' : '') + '/>',
      );
      this.line();
    }
    return true;
  }

  // Lists

  // Typed `Node | undefined` (with a check) so scriptc narrows elements read from arrays.
  private emitListItem(item: ListItem, node: Node | undefined): boolean {
    if (node === undefined) return false;
    switch (item) {
      case ListItem.Keyword:
        return this.emitTokenNode(node);
      case ListItem.ModifierLike:
        if (node instanceof Decorator) return this.emitDecorator(node);
        if (isModifier(node)) return this.emitTokenNode(node);
        break;
      case ListItem.TypeParameter:
        if (node instanceof TypeParameterDeclaration) return this.emitTypeParameter(node);
        return this.emitTypeNodeOutsideExtends(node);
      case ListItem.Parameter:
        if (node instanceof ParameterDeclaration) return this.emitParameter(node);
        break;
      case ListItem.TypeElement:
        return this.emitTypeElement(node);
      case ListItem.ClassElement:
        return this.emitClassElement(node);
      case ListItem.ObjectLiteralElement:
        return this.emitObjectLiteralElement(node);
      case ListItem.TypeArgument:
        if (node instanceof TypeParameterDeclaration) return this.emitTypeParameter(node);
        return this.emitTypeNodeOutsideExtends(node);
      case ListItem.UnionConstituent:
        return this.emitTypeNode(node, TypePrecedence.TypeOperator);
      case ListItem.TemplateTypeSpan:
        if (node instanceof TemplateLiteralTypeSpan) return this.emitTemplateTypeSpan(node);
        break;
      case ListItem.ImportAttribute:
        if (node instanceof ImportAttribute) return this.emitImportAttribute(node);
        break;
      case ListItem.BindingElement:
        if (node instanceof BindingElement) return this.emitBindingElement(node);
        break;
      case ListItem.ArrayElement:
      case ListItem.Argument:
        return this.emitExpression(node, OperatorPrecedence.Spread);
      case ListItem.TemplateSpan:
        if (node instanceof TemplateSpan) {
          const state = this.enterNode(node);
          this.emitExpression(node.expression, OperatorPrecedence.Comma);
          this.emitLiteral(node.literal);
          this.exitNode(node, state);
          return true;
        }
        break;
      case ListItem.Statement:
        return this.emitStatement(node);
      case ListItem.VariableDeclaration:
        if (node instanceof VariableDeclaration) return this.emitVariableDeclaration(node);
        break;
      case ListItem.HeritageClause:
        if (node instanceof HeritageClause) return this.emitHeritageClause(node);
        break;
      case ListItem.EnumMember:
        if (node instanceof EnumMember) return this.emitEnumMember(node);
        break;
      case ListItem.CaseOrDefaultClause:
        if (node instanceof CaseOrDefaultClause) return this.emitCaseOrDefaultClause(node);
        break;
      case ListItem.ImportSpecifier:
        if (node instanceof ImportSpecifier)
          return this.emitSpecifier(node, node.isTypeOnly, node.propertyName, node.name, true);
        break;
      case ListItem.ExportSpecifier:
        if (node instanceof ExportSpecifier)
          return this.emitSpecifier(node, node.isTypeOnly, node.propertyName, node.name, false);
        break;
      case ListItem.ExpressionWithTypeArguments:
        if (node instanceof ExpressionWithTypeArguments) return this.emitExpressionWithTypeArguments(node);
        break;
      case ListItem.JsxChild:
        return this.emitJsxChild(node);
      case ListItem.JsxAttributeLike:
        if (node instanceof JsxAttribute) return this.emitJsxAttribute(node);
        if (node instanceof JsxSpreadAttribute) {
          const state = this.enterNode(node);
          this.write1('{...');
          this.emitExpression(node.expression, OperatorPrecedence.Lowest);
          this.write1('}');
          this.exitNode(node, state);
          return true;
        }
        break;
    }
    throw new Error('Unexpected list element ' + node.kind);
  }

  private emitList(item: ListItem, parent: Node, children: NodeList | undefined, format: ListFormat): boolean {
    if (this.hasEmitFlag(parent, EmitFlags.MultiLine)) format |= ListFormat.PreferNewLine | ListFormat.Indented;
    return this.emitListRange(item, parent, children, format, 0);
  }

  private emitListRange(
    item: ListItem,
    parent: Node,
    children: NodeList | undefined,
    format: ListFormat,
    start: number,
  ): boolean {
    if (children === undefined && (format & ListFormat.OptionalIfNil) !== 0) return false;
    const length = children === undefined ? 0 : children.nodes.length;
    const isEmpty = children === undefined || start >= length;
    if (isEmpty && (format & ListFormat.OptionalIfEmpty) !== 0) return false;
    const brackets = (format & ListFormat.BracketsMask) !== 0;
    if (brackets) {
      this.write1(openingBracket(format));
      if (isEmpty && children !== undefined) this.emitTrailingComments(children.pos, CommentSeparator.Before);
    }
    if (isEmpty) {
      if (
        (format & ListFormat.MultiLine) !== 0 &&
        !(
          this.options.preserveSourceNewlines &&
          (parent === undefined || (this.currentSourceFile !== undefined && this.rangeIsOnSingleLine(parent)))
        )
      )
        this.line();
      else if ((format & ListFormat.SpaceBetweenBraces) !== 0 && (format & ListFormat.NoSpaceIfEmpty) === 0)
        this.space();
    } else
      this.emitListItems(
        item,
        parent,
        children!.nodes,
        start,
        length,
        format,
        this.hasTrailingComma(parent, children!),
        children!.pos,
        children!.end,
      );
    if (brackets) {
      if (isEmpty && children !== undefined) this.emitLeadingComments(children.end, false);
      this.write1(closingBracket(format));
    }
    return true;
  }

  /** Whether to keep a list's trailing comma; for transformed nodes, as in the original list. */
  private hasTrailingComma(parent: Node, children: NodeList): boolean {
    if (!children.hasTrailingComma()) return false;
    const original = this.context.mostOriginal(parent);
    if (original === parent) return true;
    if (original.kind !== parent.kind) return false;
    let originalList: NodeList | undefined = children;
    switch (original.kind) {
      case SyntaxKind.ObjectLiteralExpression:
        originalList = getProperties(original);
        break;
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.ObjectBindingPattern:
      case SyntaxKind.ArrayBindingPattern:
      case SyntaxKind.NamedImports:
      case SyntaxKind.NamedExports:
        originalList = getElements(original);
        break;
      case SyntaxKind.CallExpression:
      case SyntaxKind.NewExpression:
        if (children === getTypeArguments(parent)) originalList = getTypeArguments(original);
        else if (children === getArguments(parent)) originalList = getArguments(original);
        break;
      case SyntaxKind.Constructor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
        if (children === getTypeParameters(parent)) originalList = getTypeParameters(original);
        else if (children === getParameters(parent)) originalList = getParameters(original);
        break;
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
        if (children === getTypeParameters(parent)) originalList = getTypeParameters(original);
        break;
      case SyntaxKind.ImportAttributes:
        if (original instanceof ImportAttributes) originalList = original.attributes;
        break;
    }
    return originalList !== undefined && originalList.hasTrailingComma();
  }

  private writeDelimiter(format: ListFormat): boolean {
    switch (format & ListFormat.DelimitersMask) {
      case ListFormat.CommaDelimited:
        return this.write1(',');
      case ListFormat.BarDelimited:
        return this.write1(' |');
      case ListFormat.AsteriskDelimited:
        return this.write1(' * ');
      case ListFormat.AmpersandDelimited:
        return this.write1(' &');
    }
    return false;
  }

  private emitListItems(
    item: ListItem,
    parent: Node,
    nodes: readonly Node[],
    start: number,
    end: number,
    format: ListFormat,
    hasTrailingComma: boolean,
    childrenPos: number,
    childrenEnd: number,
  ): boolean {
    const mayEmitInterveningComments = (format & ListFormat.NoInterveningComments) === 0;
    let shouldEmitInterveningComments = mayEmitInterveningComments;
    const leadingLineTerminatorCount =
      end > start ? this.getLeadingLineTerminatorCount(parent, nodes[start]!, format) : 0;
    if (leadingLineTerminatorCount > 0) {
      this.lines(leadingLineTerminatorCount);
      shouldEmitInterveningComments = false;
    } else if ((format & ListFormat.SpaceBetweenBraces) !== 0) this.space();
    if ((format & ListFormat.Indented) !== 0) this.writer.indent++;
    const parentEnd = parent.end;
    let previous: Node | undefined = undefined;
    let shouldDecreaseIndentAfterEmit = false;
    for (let i = start; i < end; i++) {
      const child = nodes[i]!;
      if ((format & ListFormat.AsteriskDelimited) !== 0) {
        this.line();
        this.writeDelimiter(format);
      } else if (previous !== undefined) {
        // A comment between an element and its delimiter, on a line of its own, leads the delimiter.
        if (
          (format & ListFormat.DelimitersMask) !== 0 &&
          previous.end !== parentEnd &&
          !this.commentsDisabled &&
          !this.hasEmitFlag(previous, EmitFlags.NoTrailingComments)
        )
          this.emitLeadingComments(previous.end, false);
        this.writeDelimiter(format);
        const separating = this.getSeparatingLineTerminatorCount(previous, child, format);
        if (separating > 0) {
          if ((format & (ListFormat.LinesMask | ListFormat.Indented)) === 0) {
            this.writer.indent++;
            shouldDecreaseIndentAfterEmit = true;
          }
          if (
            shouldEmitInterveningComments &&
            (format & ListFormat.DelimitersMask) !== 0 &&
            !positionIsSynthesized(child.pos) &&
            !this.hasEmitFlag(child, EmitFlags.NoLeadingComments)
          )
            this.emitTrailingCommentsOfPosition(
              this.context.commentPos(child),
              (format & ListFormat.SpaceBetweenSiblings) !== 0,
              true,
            );
          this.lines(separating);
          shouldEmitInterveningComments = false;
        } else if ((format & ListFormat.SpaceBetweenSiblings) !== 0) this.space();
      }
      if (shouldEmitInterveningComments && !this.hasEmitFlag(child, EmitFlags.NoLeadingComments))
        this.emitTrailingCommentsOfPosition(this.context.commentPos(child), false, false);
      else shouldEmitInterveningComments = mayEmitInterveningComments;
      this.nextListElementPos = child.pos;
      this.emitListItem(item, child);
      if (shouldDecreaseIndentAfterEmit) {
        this.writer.indent--;
        shouldDecreaseIndentAfterEmit = false;
      }
      previous = child;
    }
    const skipTrailingComments =
      this.commentsDisabled || (previous !== undefined && this.hasEmitFlag(previous, EmitFlags.NoTrailingComments));
    const emitTrailingComma =
      hasTrailingComma && (format & ListFormat.AllowTrailingComma) !== 0 && (format & ListFormat.CommaDelimited) !== 0;
    if (emitTrailingComma) {
      if (previous !== undefined && !skipTrailingComments)
        this.emitToken(SyntaxKind.CommaToken, previous.end, previous);
      else this.write1(',');
    }
    if (
      previous !== undefined &&
      parentEnd !== previous.end &&
      (format & ListFormat.DelimitersMask) !== 0 &&
      !skipTrailingComments
    )
      this.emitLeadingComments(emitTrailingComma && childrenEnd > 0 ? childrenEnd : previous.end, false);
    if ((format & ListFormat.Indented) !== 0) this.writer.indent--;
    const closing = this.getClosingLineTerminatorCount(
      parent,
      end > start ? nodes[end - 1]! : undefined,
      format,
      childrenEnd,
    );
    if (closing > 0) this.lines(closing);
    else if ((format & (ListFormat.SpaceAfterList | ListFormat.SpaceBetweenBraces)) !== 0) this.space();
    return childrenPos >= -1;
  }

  // Any node

  private emitAnyNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.TemplateHead:
      case SyntaxKind.TemplateMiddle:
      case SyntaxKind.TemplateTail:
        return this.emitLiteral(node);
      case SyntaxKind.Identifier:
        if (node instanceof Identifier) return this.emitIdentifierName(node);
        break;
      case SyntaxKind.PrivateIdentifier:
        if (node instanceof PrivateIdentifier) return this.emitPrivateIdentifier(node);
        break;
      case SyntaxKind.QualifiedName:
        if (node instanceof QualifiedName) return this.emitQualifiedName(node);
        break;
      case SyntaxKind.ComputedPropertyName:
        if (node instanceof ComputedPropertyName) return this.emitComputedPropertyName(node);
        break;
      case SyntaxKind.TypeParameter:
        if (node instanceof TypeParameterDeclaration) return this.emitTypeParameter(node);
        break;
      case SyntaxKind.Parameter:
        if (node instanceof ParameterDeclaration) return this.emitParameter(node);
        break;
      case SyntaxKind.Decorator:
        if (node instanceof Decorator) return this.emitDecorator(node);
        break;
      case SyntaxKind.PropertySignature:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.NotEmittedTypeElement:
        return this.emitTypeElement(node);
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.ClassStaticBlockDeclaration:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.SemicolonClassElement:
        return this.emitClassElement(node);
      case SyntaxKind.ObjectBindingPattern:
      case SyntaxKind.ArrayBindingPattern:
        if (node instanceof BindingPattern) return this.emitBindingPattern(node);
        break;
      case SyntaxKind.BindingElement:
        if (node instanceof BindingElement) return this.emitBindingElement(node);
        break;
      case SyntaxKind.TemplateSpan:
        return this.emitListItem(ListItem.TemplateSpan, node);
      case SyntaxKind.VariableDeclaration:
        if (node instanceof VariableDeclaration) return this.emitVariableDeclaration(node);
        break;
      case SyntaxKind.VariableDeclarationList:
        if (node instanceof VariableDeclarationList) return this.emitVariableDeclarationList(node);
        break;
      case SyntaxKind.ModuleBlock:
        if (node instanceof ModuleBlock) return this.emitBlockLike(node, node.statements, false);
        break;
      case SyntaxKind.CaseBlock:
        if (node instanceof CaseBlock) return this.emitBlockLike(node, node.clauses, true);
        break;
      case SyntaxKind.ImportClause:
        if (node instanceof ImportClause) return this.emitImportClause(node);
        break;
      case SyntaxKind.ImportSpecifier:
        return this.emitListItem(ListItem.ImportSpecifier, node);
      case SyntaxKind.ExportSpecifier:
        return this.emitListItem(ListItem.ExportSpecifier, node);
      case SyntaxKind.ImportAttributes:
        if (node instanceof ImportAttributes) return this.emitImportAttributes(node);
        break;
      case SyntaxKind.ImportAttribute:
        if (node instanceof ImportAttribute) return this.emitImportAttribute(node);
        break;
      case SyntaxKind.JsxText:
      case SyntaxKind.JsxExpression:
        return this.emitJsxChild(node);
      case SyntaxKind.JsxOpeningElement:
        if (node instanceof JsxOpeningElement) return this.emitJsxOpeningElement(node);
        break;
      case SyntaxKind.JsxClosingElement:
        if (node instanceof JsxClosingElement) return this.emitJsxClosingElement(node);
        break;
      case SyntaxKind.JsxAttribute:
      case SyntaxKind.JsxSpreadAttribute:
        return this.emitListItem(ListItem.JsxAttributeLike, node);
      case SyntaxKind.JsxAttributes:
        if (node instanceof JsxAttributes) return this.emitJsxAttributes(node);
        break;
      case SyntaxKind.JsxNamespacedName:
        return this.emitJsxName(node);
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause:
        if (node instanceof CaseOrDefaultClause) return this.emitCaseOrDefaultClause(node);
        break;
      case SyntaxKind.HeritageClause:
        if (node instanceof HeritageClause) return this.emitHeritageClause(node);
        break;
      case SyntaxKind.CatchClause:
        if (node instanceof CatchClause) return this.emitCatchClause(node);
        break;
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
      case SyntaxKind.SpreadAssignment:
        return this.emitObjectLiteralElement(node);
      case SyntaxKind.EnumMember:
        if (node instanceof EnumMember) return this.emitEnumMember(node);
        break;
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) return this.emitSourceFileNode(node);
        break;
    }
    if (isTypeNodeKind(node.kind)) return this.emitTypeNodeOutsideExtends(node);
    if (isStatement(node)) return this.emitStatement(node);
    if (isExpression(node)) return this.emitExpression(node, OperatorPrecedence.Lowest);
    if (isKeywordKind(node.kind) || isPunctuationKind(node.kind)) return this.emitTokenNode(node);
    if (isJSDocKind(node.kind)) throw new Error('Printing JSDoc is not implemented');
    throw new Error('Unexpected node ' + node.kind);
  }

  // Comments

  private emitCommentsBeforeNode(node: Node): boolean {
    if (!this.shouldEmitComments(node)) return false;
    if (this.inCommentFreeRange(node)) {
      // What the general path does for a node without emit data and without comments.
      this.pushCommentState(commentFreeNode, node.pos, node.end);
      this.containerPos = node.pos;
      this.containerEnd = node.end;
      if (node.kind === SyntaxKind.VariableDeclarationList) this.declarationListContainerEnd = node.end;
      return true;
    }
    const flags = this.context.getEmitFlags(node);
    const pos = this.context.commentPos(node);
    const end = this.context.commentEnd(node);
    this.pushCommentState(flags, pos, end);
    this.emitLeadingCommentsOfNode(node, flags, pos, end);
    if ((flags & EmitFlags.NoLeadingComments) === 0) {
      const synthesized = this.context.getSyntheticLeadingComments(node);
      if (synthesized !== undefined) for (const comment of synthesized) this.emitLeadingSynthesizedComment(comment);
    }
    if ((flags & EmitFlags.NoNestedComments) !== 0) this.commentsDisabled = true;
    return true;
  }

  /** Saves the comment state of a node: its emit flags (or `commentFreeNode`), comment range and the containers. */
  private pushCommentState(flags: number, pos: number, end: number): boolean {
    let stack = this.commentStack;
    const at = this.commentDepth;
    if (at + 6 > stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      this.commentStack = grown;
      stack = grown;
    }
    stack[at] = flags;
    stack[at + 1] = pos;
    stack[at + 2] = end;
    stack[at + 3] = this.containerPos;
    stack[at + 4] = this.containerEnd;
    stack[at + 5] = this.declarationListContainerEnd;
    this.commentDepth = at + 6;
    return true;
  }

  private emitCommentsAfterNode(node: Node): boolean {
    const stack = this.commentStack;
    const base = this.commentDepth - 6;
    const flags = stack[base]!;
    const pos = stack[base + 1]!;
    const end = stack[base + 2]!;
    const containerPos = stack[base + 3]!;
    const containerEnd = stack[base + 4]!;
    const declarationListContainerEnd = stack[base + 5]!;
    this.commentDepth = base;
    if (node === this.freeOwner) this.endCommentFreeRange();
    if (flags === commentFreeNode) {
      this.containerPos = containerPos;
      this.containerEnd = containerEnd;
      this.declarationListContainerEnd = declarationListContainerEnd;
      return true;
    }
    if ((flags & EmitFlags.NoNestedComments) !== 0) this.commentsDisabled = false;
    if ((flags & EmitFlags.NoTrailingComments) === 0) {
      const synthesized = this.context.getSyntheticTrailingComments(node);
      if (synthesized !== undefined) for (const comment of synthesized) this.emitTrailingSynthesizedComment(comment);
    }
    this.emitTrailingCommentsOfNode(node, flags, pos, end, containerPos, containerEnd, declarationListContainerEnd);
    // Comments after an erased type annotation.
    const typeNode = this.context.getTypeNode(node);
    if (typeNode !== undefined)
      this.emitTrailingCommentsOfNode(
        node,
        flags,
        typeNode.pos,
        typeNode.end,
        containerPos,
        containerEnd,
        declarationListContainerEnd,
      );
    return true;
  }

  /**
   * Whether `node` has no emit data and lies in a range of the source text where no comment is found, so that its
   * comments need not be looked for. Outside such a range, a node whose own range is one starts it (`freeOwner`).
   */
  private inCommentFreeRange(node: Node): boolean {
    const pos = node.pos;
    const end = node.end;
    if (pos < 0 || end <= pos || node.kind === SyntaxKind.JsxText || node.kind === SyntaxKind.NotEmittedStatement)
      return false;
    if (this.freeEnd < 0) {
      if (!this.startCommentFreeRange(pos, end)) return false;
      this.freeOwner = node;
    } else if (pos < this.freeStart) return false;
    if (this.context.hasEmitNode(node)) return false;
    return end < this.freeEnd || (end === this.freeEnd && this.freeEndTrailingNone);
  }

  private endCommentFreeRange(): boolean {
    this.freeStart = -1;
    this.freeEnd = -1;
    this.freeEndTrailingNone = false;
    this.freeOwner = undefined;
    return true;
  }

  /** Whether the comment-free range shows that no trailing comment follows `pos`. */
  private noCommentsAfter(pos: number): boolean {
    return pos >= this.freeStart && (pos < this.freeEnd || (pos === this.freeEnd && this.freeEndTrailingNone));
  }

  /** Makes `[pos, end)` the comment-free range if no comment starts in it and its last character is not trivia. */
  private startCommentFreeRange(pos: number, end: number): boolean {
    const text = this.sourceText;
    if (end > text.length) return false;
    const last = text.charCodeAt(end - 1);
    if (
      last === CharacterCodes.space ||
      last === CharacterCodes.tab ||
      last === CharacterCodes.lineFeed ||
      last === CharacterCodes.carriageReturn ||
      last === CharacterCodes.verticalTab ||
      last === CharacterCodes.formFeed ||
      last > CharacterCodes.maxAsciiCharacter
    )
      return false;
    const starts = this.commentStartsOfFile();
    // The first comment start at or after `pos`.
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle]! < pos) low = middle + 1;
      else high = middle;
    }
    if (low < starts.length && starts[low]! < end) return false;
    this.freeStart = pos;
    this.freeEnd = end;
    this.freeEndTrailingNone = getTrailingCommentRanges(text, end) === undefined;
    return true;
  }

  private commentStartsOfFile(): Int32Array {
    const cached = this.commentStarts;
    if (cached !== undefined) return cached;
    const text = this.sourceText;
    const length = text.length;
    const list: number[] = [];
    for (let i = text.indexOf('/'); i >= 0 && i + 1 < length; i = text.indexOf('/', i + 1)) {
      const next = text.charCodeAt(i + 1);
      if (next === CharacterCodes.slash || next === CharacterCodes.asterisk) list.push(i);
    }
    const starts = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) starts[i] = list[i]!;
    this.commentStarts = starts;
    return starts;
  }

  /** Emits comments before a token; returns whether `emitCommentsAfterToken` applies, with the token's position in `tokenPos`. */
  private emitCommentsBeforeToken(pos: number, contextNode: Node, flags: TokenEmitFlags): boolean {
    if ((flags & TokenEmitFlags.NoComments) !== 0 || this.commentsDisabled) {
      this.tokenPos = this.currentSourceFile !== undefined && pos >= 0 ? skipTrivia(this.sourceText, pos) : pos;
      return false;
    }
    const startPos = pos;
    if (this.currentSourceFile !== undefined) pos = skipTrivia(this.sourceText, startPos);
    this.tokenPos = pos;
    const parseNode = this.context.parseNode(contextNode);
    if (parseNode === undefined || parseNode.kind !== contextNode.kind) return false;
    if (contextNode.pos !== startPos) {
      const needsIndent =
        (flags & TokenEmitFlags.IndentLeadingComments) !== 0 &&
        this.currentSourceFile !== undefined &&
        !this.positionsAreOnSameLine(startPos, pos);
      this.indentIf(needsIndent, 1);
      this.emitLeadingComments(startPos, false);
      this.indentIf(needsIndent, -1);
    }
    return true;
  }

  private emitCommentsAfterToken(pos: number, contextNode: Node): boolean {
    if (contextNode.end !== pos)
      this.emitTrailingComments(
        pos,
        contextNode.kind === SyntaxKind.JsxExpression ? CommentSeparator.None : CommentSeparator.Before,
      );
    return true;
  }

  private emitDetachedCommentsBeforeStatementList(node: Node, pos: number): number {
    if (node instanceof SourceFile) {
      const statements = node.statements.nodes;
      if (statements.length > 0 && isPrologueDirective(statements[0]!) && !nodeIsSynthesized(statements[0]!)) return -1;
    }
    const flags = this.context.getEmitFlags(node);
    if (!positionIsSynthesized(pos) && (flags & EmitFlags.NoLeadingComments) === 0)
      this.emitDetachedCommentsAndUpdateCommentsInfo(pos);
    if ((flags & EmitFlags.NoNestedComments) !== 0) this.commentsDisabled = true;
    return flags;
  }

  /** `flags` is what `emitDetachedCommentsBeforeStatementList` returned; -1 if it emitted nothing. */
  private emitDetachedCommentsAfterStatementList(node: Node, end: number, flags: number): boolean {
    if (flags < 0) return false;
    if (this.commentsDisabled || positionIsSynthesized(end) || (flags & EmitFlags.NoTrailingComments) !== 0)
      return false;
    if (this.emitLeadingComments(end, false) && !this.writer.isAtStartOfLine()) this.line();
    return node.kind >= 0;
  }

  private emitLeadingCommentsOfNode(node: Node, flags: EmitFlags, pos: number, end: number): boolean {
    if ((positionIsSynthesized(pos) && positionIsSynthesized(end)) || pos === end) return false;
    const jsxText = node.kind === SyntaxKind.JsxText;
    const skipLeading = positionIsSynthesized(pos) || (flags & EmitFlags.NoLeadingComments) !== 0 || jsxText;
    const skipTrailing = positionIsSynthesized(end) || (flags & EmitFlags.NoTrailingComments) !== 0 || jsxText;
    if (!skipLeading) this.emitLeadingComments(pos, node.kind === SyntaxKind.NotEmittedStatement);
    if (!skipLeading || (pos >= 0 && (flags & EmitFlags.NoLeadingComments) !== 0)) this.containerPos = pos;
    if (!skipTrailing || (end >= 0 && (flags & EmitFlags.NoTrailingComments) !== 0)) {
      this.containerEnd = end;
      if (node.kind === SyntaxKind.VariableDeclarationList) this.declarationListContainerEnd = end;
    }
    return true;
  }

  private emitTrailingCommentsOfNode(
    node: Node,
    flags: EmitFlags,
    pos: number,
    end: number,
    containerPos: number,
    containerEnd: number,
    declarationListContainerEnd: number,
  ): boolean {
    const skipTrailing = end < 0 || (flags & EmitFlags.NoTrailingComments) !== 0 || node.kind === SyntaxKind.JsxText;
    if ((positionIsSynthesized(pos) && positionIsSynthesized(end)) || pos === end) return false;
    this.containerPos = containerPos;
    this.containerEnd = containerEnd;
    this.declarationListContainerEnd = declarationListContainerEnd;
    if (!skipTrailing && node.kind !== SyntaxKind.NotEmittedStatement)
      this.emitTrailingComments(end, CommentSeparator.Before);
    return true;
  }

  private emitLeadingSynthesizedComment(comment: SynthesizedComment): boolean {
    if (comment.hasLeadingNewLine || comment.kind === SyntaxKind.SingleLineCommentTrivia) this.line();
    this.writeSynthesizedComment(comment);
    if (comment.hasTrailingNewLine || comment.kind === SyntaxKind.SingleLineCommentTrivia) this.line();
    else this.space();
    return true;
  }

  private emitTrailingSynthesizedComment(comment: SynthesizedComment): boolean {
    if (!this.writer.isAtStartOfLine()) this.space();
    this.writeSynthesizedComment(comment);
    if (comment.hasTrailingNewLine) this.line();
    return true;
  }

  private writeSynthesizedComment(comment: SynthesizedComment): boolean {
    const multiLine = comment.kind === SyntaxKind.MultiLineCommentTrivia;
    const text = multiLine ? '/*' + comment.text + '*/' : '//' + comment.text;
    return this.writeCommentText(text, multiLine ? computeLineStarts(text) : [0], comment.kind, 0, text.length);
  }

  private emitLeadingComments(pos: number, elided: boolean): boolean {
    if (this.commentsDisabled || this.currentSourceFile === undefined || pos < 0 || pos === this.containerPos)
      return false;
    if (pos >= this.freeStart && pos < this.freeEnd) return false;
    // 1: only triple-slash comments, 2: all but triple-slash comments, 0: all.
    let tripleSlash = 0;
    if (!elided) {
      if (pos === 0 && this.currentSourceFile.isDeclarationFile) tripleSlash = 2;
    } else if (pos === 0) tripleSlash = 1;
    else return false;
    const detached = this.detachedComments;
    if (detached.length > 0 && detached[detached.length - 2] === pos) {
      pos = detached[detached.length - 1] | 0;
      detached.pop();
      detached.pop();
    }
    const ranges = getLeadingCommentRanges(this.sourceText, pos);
    if (ranges === undefined) return false;
    let comments: CommentRange[] | undefined = undefined;
    for (const comment of ranges) {
      if (!this.shouldWriteComment(comment)) continue;
      if (tripleSlash !== 0 && isRecognizedTripleSlashComment(this.sourceText, comment) !== (tripleSlash === 1))
        continue;
      if (comments === undefined) comments = [];
      comments.push(comment);
    }
    if (comments === undefined) return false;
    if (this.shouldEmitNewLineBeforeLeadingComment(pos, comments[0]!.pos)) this.line();
    return this.emitComments(comments, CommentSeparator.After);
  }

  private shouldEmitNewLineBeforeLeadingComment(pos: number, commentPos: number): boolean {
    return (
      this.currentSourceFile !== undefined &&
      pos !== commentPos &&
      computeLineOfPosition(this.lineStarts, pos) !== computeLineOfPosition(this.lineStarts, commentPos)
    );
  }

  private emitLeadingCommentsOfPosition(pos: number): boolean {
    if (this.commentsDisabled || pos === -1) return false;
    return this.emitLeadingComments(pos, false);
  }

  private emitTrailingComments(pos: number, separator: CommentSeparator): boolean {
    if (
      this.commentsDisabled ||
      this.currentSourceFile === undefined ||
      (this.containerEnd !== -1 && (pos === this.containerEnd || pos === this.declarationListContainerEnd))
    )
      return false;
    if (this.noCommentsAfter(pos)) return false;
    const ranges = getTrailingCommentRanges(this.sourceText, pos);
    if (ranges === undefined) return false;
    let comments: CommentRange[] | undefined = undefined;
    for (const comment of ranges) {
      if (!this.shouldWriteComment(comment)) continue;
      if (comments === undefined) comments = [];
      comments.push(comment);
    }
    return comments !== undefined && this.emitComments(comments, separator);
  }

  private emitTrailingCommentsOfPosition(pos: number, prefixSpace: boolean, forceNoNewline: boolean): boolean {
    if (this.commentsDisabled || this.currentSourceFile === undefined) return false;
    if (this.containerEnd !== -1 && (pos === this.containerEnd || pos === this.declarationListContainerEnd))
      return false;
    if (this.noCommentsAfter(pos)) return false;
    const comments = getTrailingCommentRanges(this.sourceText, pos);
    if (comments === undefined) return false;
    for (const comment of comments) {
      if (prefixSpace) {
        if (!this.shouldWriteComment(comment)) continue;
        if (!this.writer.isAtStartOfLine()) this.space();
        this.emitComment(comment);
        if (comment.hasTrailingNewLine) this.line();
        continue;
      }
      this.emitComment(comment);
      if (forceNoNewline) {
        if (comment.kind === SyntaxKind.SingleLineCommentTrivia) this.line();
      } else if (comment.hasTrailingNewLine) this.line();
      else this.space();
    }
    return true;
  }

  private emitDetachedCommentsAndUpdateCommentsInfo(pos: number): boolean {
    if (this.currentSourceFile === undefined) return false;
    const end = this.emitDetachedComments(pos);
    if (end < 0) return false;
    this.detachedComments.push(pos, end);
    return true;
  }

  /** Emits a leading copyright-style comment block; returns its end, or -1 if there is none. */
  private emitDetachedComments(pos: number): number {
    const text = this.sourceText;
    let leading: CommentRange[] | undefined;
    if (this.commentsDisabled) {
      // Without comments, keep pinned comments at the top of the file.
      if (pos === 0) {
        const ranges = getLeadingCommentRanges(text, pos);
        if (ranges !== undefined)
          for (const range of ranges)
            if (isPinnedComment(text, range)) {
              if (leading === undefined) leading = [];
              leading.push(range);
            }
      }
    } else leading = getLeadingCommentRanges(text, pos);
    if (leading === undefined || leading.length === 0) return -1;
    const lineStarts = this.lineStarts;
    let count = 0;
    for (let i = 0; i < leading.length; i++) {
      if (i > 0) {
        const lastLine = computeLineOfPosition(lineStarts, leading[i - 1].end);
        const line = computeLineOfPosition(lineStarts, leading[i].pos);
        // A blank line ends the block.
        if (line >= lastLine + 2) break;
      }
      count++;
    }
    const lastEnd = leading[count - 1].end;
    const lastLine = computeLineOfPosition(lineStarts, lastEnd);
    const nodeLine = computeLineOfPosition(lineStarts, skipTrivia(text, pos));
    if (nodeLine < lastLine + 2) return -1;
    let toEmit: CommentRange[] | undefined = undefined;
    for (let i = 0; i < count; i++) {
      const comment = leading[i]!;
      if (!this.shouldWriteComment(comment)) continue;
      if (toEmit === undefined) toEmit = [];
      toEmit.push(comment);
    }
    if (toEmit !== undefined) {
      if (this.shouldEmitNewLineBeforeLeadingComment(pos, toEmit[0].pos)) this.line();
      this.emitComments(toEmit, CommentSeparator.After);
    }
    return lastEnd;
  }

  private emitComments(comments: readonly CommentRange[], separator: CommentSeparator): boolean {
    if (comments.length === 0) return false;
    let interveningSeparator = false;
    if (separator === CommentSeparator.Before) this.space();
    for (const comment of comments) {
      if (interveningSeparator) {
        this.space();
        interveningSeparator = false;
      }
      this.emitComment(comment);
      if (
        comment.kind === SyntaxKind.SingleLineCommentTrivia ||
        (comment.hasTrailingNewLine && separator !== CommentSeparator.None)
      )
        this.line();
      else interveningSeparator = separator !== CommentSeparator.None;
    }
    if (interveningSeparator && separator === CommentSeparator.After) this.space();
    return true;
  }

  private emitComment(comment: CommentRange): boolean {
    this.emitPos(comment.pos);
    this.writeCommentRange(comment);
    return this.emitPos(comment.end);
  }

  // Source maps

  private setSourceMapSource(source: SourceFile): boolean {
    if (this.sourceMapsDisabled) return false;
    this.sourceMapSource = source;
    this.sourceMapLineStarts = source.lineStarts();
    this.sourceMapLine = 0;
    if (this.mostRecentSourceMapSource === source) {
      this.sourceMapSourceIndex = this.mostRecentSourceMapSourceIndex;
      return true;
    }
    this.sourceMapSourceIsJson = fileExtensionIs(source.fileName, '.json');
    if (this.sourceMapSourceIsJson) return true;
    const generator = this.sourceMapGenerator!;
    this.sourceMapSourceIndex = generator.addSource(source.fileName);
    if (this.options.inlineSources) generator.setSourceContent(this.sourceMapSourceIndex, source.text);
    this.mostRecentSourceMapSource = source;
    this.mostRecentSourceMapSourceIndex = this.sourceMapSourceIndex;
    return true;
  }

  private emitPos(pos: number): boolean {
    const generator = this.sourceMapGenerator;
    if (
      this.sourceMapsDisabled ||
      this.sourceMapSource === undefined ||
      generator === undefined ||
      this.sourceMapSourceIsJson ||
      pos < 0
    )
      return false;
    const lineStarts = this.sourceMapLineStarts;
    const line = this.sourceMapLineOf(pos);
    return generator.addSourceMapping(
      this.writer.getLine(),
      this.writer.getColumn(),
      this.sourceMapSourceIndex,
      line,
      pos - (lineStarts[line] | 0),
    );
  }

  /**
   * The line of `pos` in the source map source, as `computeLineOfPosition` finds it. Positions mostly
   * increase, so the line of the last position and the few after it are tried first.
   */
  private sourceMapLineOf(pos: number): number {
    const lineStarts = this.sourceMapLineStarts;
    let line = this.sourceMapLine;
    if (line < lineStarts.length && (lineStarts[line] | 0) <= pos) {
      for (let k = 0; k < 4; k++) {
        if (line + 1 >= lineStarts.length || (lineStarts[line + 1] | 0) > pos) {
          this.sourceMapLine = line;
          return line;
        }
        line++;
      }
    }
    line = computeLineOfPosition(lineStarts, pos);
    this.sourceMapLine = line;
    return line;
  }

  private emitSourceMapsBeforeNode(node: Node): boolean {
    if (!this.shouldEmitSourceMaps(node)) return false;
    const flags = this.context.getEmitFlags(node);
    const pos = this.context.sourceMapPos(node);
    const end = this.context.sourceMapEnd(node);
    if (
      node.kind !== SyntaxKind.NotEmittedStatement &&
      (flags & EmitFlags.NoLeadingSourceMap) === 0 &&
      this.currentSourceFile !== undefined &&
      pos >= 0
    )
      this.emitPos(skipTrivia(this.sourceText, pos));
    if ((flags & EmitFlags.NoNestedSourceMaps) !== 0) this.sourceMapsDisabled = true;
    this.sourceMapStack.push(flags, pos, end, 0);
    return true;
  }

  private emitSourceMapsAfterNode(node: Node): boolean {
    const stack = this.sourceMapStack;
    const base = stack.length - 4;
    const flags = stack[base] | 0;
    const end = stack[base + 2] | 0;
    stack.length = base;
    if ((flags & EmitFlags.NoNestedSourceMaps) !== 0) this.sourceMapsDisabled = false;
    if (node.kind !== SyntaxKind.NotEmittedStatement && (flags & EmitFlags.NoTrailingSourceMap) === 0 && end >= 0)
      this.emitPos(end);
    return true;
  }

  private emitSourceMapsBeforeToken(token: SyntaxKind, pos: number, contextNode: Node, flags: TokenEmitFlags): boolean {
    if (
      (flags & TokenEmitFlags.NoSourceMaps) !== 0 ||
      !this.shouldEmitSourceMaps(contextNode) ||
      this.options.omitBraceSourceMapPositions ||
      (token !== SyntaxKind.OpenBraceToken && token !== SyntaxKind.CloseBraceToken)
    )
      return false;
    const emitFlags = this.context.getEmitFlags(contextNode);
    const range = this.context.tokenSourceMapRange(contextNode, token);
    if (range !== undefined) pos = range[0] | 0;
    if (pos >= 0 && this.currentSourceFile !== undefined) pos = skipTrivia(this.sourceText, pos);
    if ((emitFlags & EmitFlags.NoTokenLeadingSourceMaps) === 0 && pos >= 0) this.emitPos(pos);
    this.sourceMapStack.push(
      emitFlags,
      range === undefined ? -1 : range[0] | 0,
      range === undefined ? -1 : range[1] | 0,
      range === undefined ? 0 : 1,
    );
    return true;
  }

  private emitSourceMapsAfterToken(pos: number): boolean {
    const stack = this.sourceMapStack;
    const base = stack.length - 4;
    const flags = stack[base] | 0;
    const end = stack[base + 2] | 0;
    const hasRange = stack[base + 3] !== 0;
    stack.length = base;
    if ((flags & EmitFlags.NoTokenTrailingSourceMaps) === 0) {
      if (hasRange) pos = end;
      if (pos >= 0) this.emitPos(pos);
    }
    return true;
  }

  // Name generation

  private pushNameGenerationScope(node: Node): boolean {
    return this.nameGenerator.pushScope(this.hasEmitFlag(node, EmitFlags.ReuseTempVariableScope));
  }

  private popNameGenerationScope(node: Node): boolean {
    return this.nameGenerator.popScope(this.hasEmitFlag(node, EmitFlags.ReuseTempVariableScope));
  }

  private generateAllNames(nodes: NodeList | undefined): boolean {
    if (nodes === undefined) return false;
    for (const node of nodes.nodes) this.generateNames(node);
    return true;
  }

  private generateNames(node: Node | undefined): boolean {
    if (node === undefined) return false;
    // Only generated names need work; parse trees without them are common.
    if (this.context.autoGenerate.size === 0) return false;
    if (node instanceof Block) return this.generateAllNames(node.statements);
    if (node instanceof CaseOrDefaultClause) return this.generateAllNames(node.statements);
    if (node instanceof LabeledStatement) return this.generateNames(node.statement);
    if (node instanceof WithStatement) return this.generateNames(node.statement);
    if (node instanceof DoStatement) return this.generateNames(node.statement);
    if (node instanceof WhileStatement) return this.generateNames(node.statement);
    if (node instanceof IfStatement) {
      this.generateNames(node.thenStatement);
      return this.generateNames(node.elseStatement);
    }
    if (node instanceof ForStatement) {
      this.generateNames(node.initializer);
      return this.generateNames(node.statement);
    }
    if (node instanceof ForInOrOfStatement) {
      this.generateNames(node.initializer);
      return this.generateNames(node.statement);
    }
    if (node instanceof SwitchStatement) return this.generateNames(node.caseBlock);
    if (node instanceof CaseBlock) return this.generateAllNames(node.clauses);
    if (node instanceof TryStatement) {
      this.generateNames(node.tryBlock);
      this.generateNames(node.catchClause);
      return this.generateNames(node.finallyBlock);
    }
    if (node instanceof CatchClause) {
      this.generateNames(node.variableDeclaration);
      return this.generateNames(node.block);
    }
    if (node instanceof VariableStatement) return this.generateNames(node.declarationList);
    if (node instanceof VariableDeclarationList) return this.generateAllNames(node.declarations);
    if (node instanceof VariableDeclaration) return this.generateNameIfNeeded(node.name);
    if (node instanceof ParameterDeclaration) return this.generateNameIfNeeded(node.name);
    if (node instanceof BindingElement) return this.generateNameIfNeeded(node.name);
    if (node instanceof ClassDeclaration) return this.generateNameIfNeeded(node.name);
    if (node instanceof FunctionDeclaration) {
      this.generateNameIfNeeded(node.name);
      if (this.hasEmitFlag(node, EmitFlags.ReuseTempVariableScope)) {
        this.generateAllNames(node.parameters);
        this.generateNames(node.body);
      }
      return true;
    }
    if (node instanceof BindingPattern) return this.generateAllNames(node.elements);
    if (node instanceof ImportDeclaration) return this.generateNames(node.importClause);
    if (node instanceof ImportClause) {
      this.generateNameIfNeeded(node.name);
      return this.generateNames(node.namedBindings);
    }
    if (node instanceof NamespaceImport) return this.generateNameIfNeeded(node.name);
    if (node instanceof NamespaceExport) return this.generateNameIfNeeded(node.name);
    if (node instanceof NamedImports) return this.generateAllNames(node.elements);
    if (node instanceof ImportSpecifier)
      return this.generateNameIfNeeded(node.propertyName !== undefined ? node.propertyName : node.name);
    return false;
  }

  private generateAllMemberNames(nodes: NodeList | undefined): boolean {
    if (nodes === undefined || this.context.autoGenerate.size === 0) return false;
    for (const node of nodes.nodes) {
      switch (node.kind) {
        case SyntaxKind.PropertyAssignment:
        case SyntaxKind.ShorthandPropertyAssignment:
        case SyntaxKind.PropertyDeclaration:
        case SyntaxKind.PropertySignature:
        case SyntaxKind.MethodDeclaration:
        case SyntaxKind.MethodSignature:
        case SyntaxKind.GetAccessor:
        case SyntaxKind.SetAccessor:
          this.generateNameIfNeeded(getName(node));
      }
    }
    return true;
  }

  private generateNameIfNeeded(name: Node | undefined): boolean {
    if (name === undefined || this.context.autoGenerate.size === 0) return false;
    if (isMemberName(name)) {
      this.nameGenerator.generateName(name);
      return true;
    }
    if (name instanceof BindingPattern) return this.generateNames(name);
    return false;
  }

  // Scopes

  private enterNode(node: Node): State {
    let state = State.None;
    if (this.emitCommentsBeforeNode(node)) state |= State.Comments;
    if (this.emitSourceMapsBeforeNode(node)) state |= State.SourceMaps;
    return state;
  }

  private exitNode(node: Node, state: State): boolean {
    if ((state & State.SourceMaps) !== 0) this.emitSourceMapsAfterNode(node);
    if ((state & State.Comments) !== 0) this.emitCommentsAfterNode(node);
    return true;
  }

  private enterTokenNode(node: Node, flags: TokenEmitFlags): State {
    let state = State.None;
    if ((flags & TokenEmitFlags.NoComments) === 0 && this.emitCommentsBeforeNode(node)) state |= State.Comments;
    if ((flags & TokenEmitFlags.NoSourceMaps) === 0 && this.emitSourceMapsBeforeNode(node)) state |= State.SourceMaps;
    return state;
  }

  private exitTokenNode(node: Node, state: State): boolean {
    return this.exitNode(node, state);
  }

  private enterToken(token: SyntaxKind, pos: number, contextNode: Node, flags: TokenEmitFlags): State {
    let state = State.None;
    if (this.emitCommentsBeforeToken(pos, contextNode, flags)) state |= State.Comments;
    if (this.emitSourceMapsBeforeToken(token, this.tokenPos, contextNode, flags)) state |= State.SourceMaps;
    return state;
  }

  private exitToken(token: SyntaxKind, pos: number, contextNode: Node, state: State): boolean {
    if ((state & State.SourceMaps) !== 0) this.emitSourceMapsAfterToken(pos);
    if ((state & State.Comments) !== 0) this.emitCommentsAfterToken(pos, contextNode);
    return token >= 0;
  }
}

function openingBracket(format: ListFormat): string {
  switch (format & ListFormat.BracketsMask) {
    case ListFormat.Braces:
      return '{';
    case ListFormat.Parenthesis:
      return '(';
    case ListFormat.AngleBrackets:
      return '<';
  }
  return '[';
}

function closingBracket(format: ListFormat): string {
  switch (format & ListFormat.BracketsMask) {
    case ListFormat.Braces:
      return '}';
    case ListFormat.Parenthesis:
      return ')';
    case ListFormat.AngleBrackets:
      return '>';
  }
  return ']';
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0d || ch === 0x0a) {
      lines.push(text.substring(start, i));
      if (ch === 0x0d && i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) i++;
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.substring(start));
  return lines;
}

/** The smallest leading whitespace of the non-blank lines. */
function guessIndentation(lines: readonly string[]): number {
  let indentation = 0x7fffffff;
  for (const line of lines) {
    if (line.length === 0) continue;
    let i = 0;
    while (i < line.length && i < indentation) {
      const ch = line.charCodeAt(i);
      if (!isWhiteSpaceLike(ch)) break;
      i++;
    }
    if (i < indentation) indentation = i;
    if (indentation === 0) return 0;
  }
  return indentation === 0x7fffffff ? 0 : indentation;
}

/** The list holding `node` in its parent, for comparing sibling positions. */
function getContainingNodeArray(node: Node): NodeList | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (node.kind) {
    case SyntaxKind.TypeParameter:
      return getTypeParameters(parent);
    case SyntaxKind.Parameter:
      return getParameters(parent);
    case SyntaxKind.TemplateLiteralTypeSpan:
      return parent instanceof TemplateLiteralTypeNode ? parent.templateSpans : undefined;
    case SyntaxKind.TemplateSpan:
      return parent instanceof TemplateExpression ? parent.templateSpans : undefined;
    case SyntaxKind.Decorator:
      return getModifiers(parent);
    case SyntaxKind.HeritageClause:
      if (parent instanceof ClassDeclaration) return parent.heritageClauses;
      if (parent instanceof ClassExpression) return parent.heritageClauses;
      if (parent instanceof InterfaceDeclaration) return parent.heritageClauses;
      return undefined;
  }
  switch (parent.kind) {
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.EnumDeclaration:
      if (parent instanceof TypeLiteralNode) return parent.members;
      if (parent instanceof InterfaceDeclaration) return parent.members;
      if (parent instanceof ClassDeclaration) return parent.members;
      if (parent instanceof ClassExpression) return parent.members;
      if (parent instanceof EnumDeclaration) return parent.members;
      break;
    case SyntaxKind.UnionType:
      if (parent instanceof UnionTypeNode) return parent.types;
      break;
    case SyntaxKind.IntersectionType:
      if (parent instanceof IntersectionTypeNode) return parent.types;
      break;
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.TupleType:
    case SyntaxKind.NamedImports:
    case SyntaxKind.NamedExports:
      return getElements(parent);
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.JsxAttributes:
      return getProperties(parent);
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
      if (isTypeNodeKind(node.kind)) return getTypeArguments(parent);
      if (parent instanceof CallExpression && node !== parent.expression) return parent.arguments;
      if (parent instanceof NewExpression && node !== parent.expression) return parent.arguments;
      break;
    case SyntaxKind.JsxElement:
      if (parent instanceof JsxElement) return parent.children;
      break;
    case SyntaxKind.JsxFragment:
      if (parent instanceof JsxFragment) return parent.children;
      break;
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
      if (isTypeNodeKind(node.kind)) return getTypeArguments(parent);
      break;
    case SyntaxKind.Block:
    case SyntaxKind.ModuleBlock:
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
    case SyntaxKind.SourceFile:
      return getStatements(parent);
    case SyntaxKind.CaseBlock:
      if (parent instanceof CaseBlock) return parent.clauses;
      break;
  }
  if (isModifier(node)) return getModifiers(parent);
  return undefined;
}
