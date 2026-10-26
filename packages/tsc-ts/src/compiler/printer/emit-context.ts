// Side tables that transforms fill in and the printer reads: original nodes, emit flags,
// comment and source map ranges, synthesized comments, generated names and emit helpers.
import {
  Block,
  ExpressionStatement,
  FunctionDeclaration,
  Identifier,
  type Node,
  NodeList,
  PrivateIdentifier,
  SourceFile,
  StringLiteral,
  VariableDeclaration,
  VariableStatement,
} from '../ast.js';
import { ClusteredLinkTable } from '../link-tables.js';
import { SyntaxKind } from '../syntax-kind.js';
import { EmitFlags, GeneratedIdentifierFlags } from './emit-flags.js';
import { AutoGenerateInfo } from './auto-generate.js';
import { NodeFactory } from './factory.js';
import type { EmitHelper } from './helpers.js';
import { isParseTreeNode, isPrologueDirective } from './utilities.js';

export { EmitHelper, compareEmitHelpers, noPriority } from './helpers.js';

const enum SpanKind {
  Prologue,
  HoistedFunction,
  HoistedVariable,
  CustomPrologue,
}

/** `left` with `right[start:end]` inserted at `at`. */
function splice(left: Node[], at: number, right: Node[], start: number, end: number): Node[] {
  const result = left.slice(0, at);
  for (let i = start; i < end; i++) result.push(right[i]!);
  for (let i = at; i < left.length; i++) result.push(left[i]!);
  return result;
}

function prologueText(node: Node): string {
  return node instanceof ExpressionStatement && node.expression instanceof StringLiteral ? node.expression.text : '';
}

/** A comment created by a transform rather than read from source text. */

export class SynthesizedComment {
  readonly kind: SyntaxKind;
  readonly hasLeadingNewLine: boolean;
  readonly hasTrailingNewLine: boolean;
  readonly text: string;

  constructor(kind: SyntaxKind, text: string, hasLeadingNewLine: boolean, hasTrailingNewLine: boolean) {
    this.kind = kind;
    this.text = text;
    this.hasLeadingNewLine = hasLeadingNewLine;
    this.hasTrailingNewLine = hasTrailingNewLine;
  }
}

const enum EmitNodeFlags {
  None = 0,
  HasCommentRange = 1 << 0,
  HasSourceMapRange = 1 << 1,
}

/** Per-node emit data. */
class EmitNode {
  flags: EmitNodeFlags;
  emitFlags: EmitFlags;
  commentPos: number;
  commentEnd: number;
  sourceMapPos: number;
  sourceMapEnd: number;
  /** Token kind → [pos, end] ranges of tokens of this node. */
  tokenSourceMapRanges: Map<SyntaxKind, number[]> | undefined;
  helpers: EmitHelper[] | undefined;
  externalHelpersModuleName: Identifier | undefined;
  leadingComments: SynthesizedComment[] | undefined;
  trailingComments: SynthesizedComment[] | undefined;
  /** The type annotation erased from this name, for comment placement. */
  typeNode: Node | undefined;

  constructor() {
    this.flags = EmitNodeFlags.None;
    this.emitFlags = EmitFlags.None;
    this.commentPos = -1;
    this.commentEnd = -1;
    this.sourceMapPos = -1;
    this.sourceMapEnd = -1;
    this.tokenSourceMapRanges = undefined;
    this.helpers = undefined;
    this.externalHelpersModuleName = undefined;
    this.leadingComments = undefined;
    this.trailingComments = undefined;
    this.typeNode = undefined;
  }

  copyFrom(source: EmitNode): EmitNode {
    this.flags = source.flags;
    this.emitFlags = source.emitFlags;
    this.commentPos = source.commentPos;
    this.commentEnd = source.commentEnd;
    this.sourceMapPos = source.sourceMapPos;
    this.sourceMapEnd = source.sourceMapEnd;
    const ranges = source.tokenSourceMapRanges;
    this.tokenSourceMapRanges = ranges === undefined ? undefined : new Map<SyntaxKind, number[]>(ranges);
    this.helpers = source.helpers === undefined ? undefined : source.helpers.slice();
    this.externalHelpersModuleName = source.externalHelpersModuleName;
    return this;
  }
}

const enum EnvironmentFlags {
  None = 0,
  InParameters = 1 << 0,
  VariablesHoistedInParameters = 1 << 1,
}

/** Hoisted declarations collected while transforming a scope. */
export class VariableScope {
  variables: Node[];
  functions: Node[];
  flags: EnvironmentFlags;
  initializationStatements: Node[];

  constructor() {
    this.variables = [];
    this.functions = [];
    this.flags = EnvironmentFlags.None;
    this.initializationStatements = [];
  }
}

export { AutoGenerateInfo, newAutoGenerateId } from './auto-generate.js';

export class EmitContext extends NodeFactory {
  readonly autoGenerate: Map<Node, AutoGenerateInfo>;
  readonly textSource: Map<Node, Node>;
  /** The node each node was made from, by node id. */
  readonly original: ClusteredLinkTable<Node>;
  /** The emit data of nodes, by node id. */
  readonly emitNodes: ClusteredLinkTable<EmitNode>;
  private lastLookup: Node | undefined;
  private lastEmitNode: EmitNode | undefined;
  readonly assignedNames: Map<Node, Node>;
  readonly classThisNames: Map<Node, Node>;
  readonly varScopes: VariableScope[];
  readonly letScopes: VariableScope[];
  /** Requested unscoped helpers, in request order. */
  readonly emitHelpers: EmitHelper[];

  constructor() {
    super();
    this.autoGenerate = new Map<Node, AutoGenerateInfo>();
    this.textSource = new Map<Node, Node>();
    this.original = new ClusteredLinkTable<Node>();
    this.emitNodes = new ClusteredLinkTable<EmitNode>();
    this.lastLookup = undefined;
    this.lastEmitNode = undefined;
    this.assignedNames = new Map<Node, Node>();
    this.classThisNames = new Map<Node, Node>();
    this.varScopes = [];
    this.letScopes = [];
    this.emitHelpers = [];
  }

  /** The factory that creates nodes for this context: the context itself. */
  get factory(): NodeFactory {
    return this;
  }

  get context(): EmitContext {
    return this;
  }

  /**
   * Gives `node` everything emit knows about `source`: its flags, ranges and synthesized
   * comments, as if it were the same node.
   */
  copyEmitNode(node: Node, source: Node): void {
    const emitNode = this.lookup(source);
    if (emitNode === undefined) return;
    const target = this.emitNode(node).copyFrom(emitNode);
    target.leadingComments = emitNode.leadingComments === undefined ? undefined : emitNode.leadingComments.slice();
    target.trailingComments = emitNode.trailingComments === undefined ? undefined : emitNode.trailingComments.slice();
    target.typeNode = emitNode.typeNode;
  }

  private emitNode(node: Node): EmitNode {
    let emitNode = this.lookup(node);
    if (emitNode === undefined) {
      emitNode = new EmitNode();
      this.emitNodes.set(node.id, emitNode);
      this.lastLookup = node;
      this.lastEmitNode = emitNode;
    }
    return emitNode;
  }

  /** The emit data of `node`. The printer asks for several of a node's in a row, so the last answer is kept. */
  private lookup(node: Node): EmitNode | undefined {
    if (node === this.lastLookup) return this.lastEmitNode;
    const emitNode = this.emitNodes.get(node.id);
    this.lastLookup = node;
    this.lastEmitNode = emitNode;
    return emitNode;
  }

  // Original nodes

  setOriginal(node: Node, original: Node): void {
    this.setOriginalEx(node, original, false);
  }

  setOriginalEx(node: Node, original: Node, allowOverwrite: boolean): void {
    const existing = this.original.get(node.id);
    if (existing === undefined) {
      this.original.set(node.id, original);
      const emitNode = this.lookup(original);
      if (emitNode !== undefined) this.emitNode(node).copyFrom(emitNode);
    } else if (allowOverwrite) this.original.set(node.id, original);
    else if (existing !== original) throw new Error('Original node already set.');
  }

  unsetOriginal(node: Node): boolean {
    if (this.original.get(node.id) === undefined) return false;
    this.original.set(node.id, undefined);
    return true;
  }

  getOriginal(node: Node): Node | undefined {
    return this.original.get(node.id);
  }

  /** The node at the end of the chain of original nodes. */
  mostOriginal(node: Node): Node {
    let original = this.original.get(node.id);
    while (original !== undefined) {
      node = original;
      original = this.original.get(node.id);
    }
    return node;
  }

  /** The parse tree node a node was created from, if any. */
  parseNode(node: Node): Node | undefined {
    node = this.mostOriginal(node);
    return isParseTreeNode(node) ? node : undefined;
  }

  // Generated names

  hasAutoGenerateInfo(node: Node): boolean {
    return this.autoGenerate.has(node);
  }

  getAutoGenerateInfo(node: Node): AutoGenerateInfo | undefined {
    return this.autoGenerate.get(node);
  }

  /** The node a generated name is based on, following clones of generated names. */
  getNodeForGeneratedName(name: Node): Node {
    const info = this.autoGenerate.get(name);
    if (info === undefined || (info.flags & GeneratedIdentifierFlags.KindMask) !== GeneratedIdentifierFlags.Node)
      return name;
    let node = info.node!;
    const id = info.id;
    let original = this.original.get(node.id);
    while (original !== undefined) {
      node = original;
      if (node instanceof Identifier || node instanceof PrivateIdentifier) {
        const other = this.autoGenerate.get(node);
        if (
          other === undefined ||
          ((other.flags & GeneratedIdentifierFlags.KindMask) === GeneratedIdentifierFlags.Node && other.id !== id)
        )
          break;
        if ((other.flags & GeneratedIdentifierFlags.KindMask) === GeneratedIdentifierFlags.Node) {
          original = other.node;
          continue;
        }
      }
      original = this.original.get(node.id);
    }
    return node;
  }

  // Emit data

  /** Whether `node` has emit data: flags, ranges, helpers or synthesized comments. */
  hasEmitNode(node: Node): boolean {
    return this.lookup(node) !== undefined;
  }

  getEmitFlags(node: Node): EmitFlags {
    const emitNode = this.lookup(node);
    return emitNode === undefined ? EmitFlags.None : emitNode.emitFlags;
  }

  setEmitFlags(node: Node, flags: EmitFlags): Node {
    this.emitNode(node).emitFlags = flags;
    return node;
  }

  addEmitFlags(node: Node, flags: EmitFlags): Node {
    this.emitNode(node).emitFlags |= flags;
    return node;
  }

  commentPos(node: Node): number {
    const emitNode = this.lookup(node);
    return emitNode !== undefined && (emitNode.flags & EmitNodeFlags.HasCommentRange) !== 0
      ? emitNode.commentPos
      : node.pos;
  }

  commentEnd(node: Node): number {
    const emitNode = this.lookup(node);
    return emitNode !== undefined && (emitNode.flags & EmitNodeFlags.HasCommentRange) !== 0
      ? emitNode.commentEnd
      : node.end;
  }

  setCommentRange(node: Node, pos: number, end: number): Node {
    const emitNode = this.emitNode(node);
    emitNode.commentPos = pos;
    emitNode.commentEnd = end;
    emitNode.flags |= EmitNodeFlags.HasCommentRange;
    return node;
  }

  assignCommentRange(to: Node, from: Node): Node {
    return this.setCommentRange(to, this.commentPos(from), this.commentEnd(from));
  }

  sourceMapPos(node: Node): number {
    const emitNode = this.lookup(node);
    return emitNode !== undefined && (emitNode.flags & EmitNodeFlags.HasSourceMapRange) !== 0
      ? emitNode.sourceMapPos
      : node.pos;
  }

  sourceMapEnd(node: Node): number {
    const emitNode = this.lookup(node);
    return emitNode !== undefined && (emitNode.flags & EmitNodeFlags.HasSourceMapRange) !== 0
      ? emitNode.sourceMapEnd
      : node.end;
  }

  setSourceMapRange(node: Node, pos: number, end: number): Node {
    const emitNode = this.emitNode(node);
    emitNode.sourceMapPos = pos;
    emitNode.sourceMapEnd = end;
    emitNode.flags |= EmitNodeFlags.HasSourceMapRange;
    return node;
  }

  assignSourceMapRange(to: Node, from: Node): Node {
    return this.setSourceMapRange(to, this.sourceMapPos(from), this.sourceMapEnd(from));
  }

  assignCommentAndSourceMapRanges(to: Node, from: Node): Node {
    const commentPos = this.commentPos(from);
    const commentEnd = this.commentEnd(from);
    const sourceMapPos = this.sourceMapPos(from);
    const sourceMapEnd = this.sourceMapEnd(from);
    const emitNode = this.emitNode(to);
    emitNode.commentPos = commentPos;
    emitNode.commentEnd = commentEnd;
    emitNode.sourceMapPos = sourceMapPos;
    emitNode.sourceMapEnd = sourceMapEnd;
    emitNode.flags |= EmitNodeFlags.HasCommentRange | EmitNodeFlags.HasSourceMapRange;
    return to;
  }

  /** The `[pos, end]` source map range of a token of `node`, if one was set. */
  tokenSourceMapRange(node: Node, kind: SyntaxKind): number[] | undefined {
    const emitNode = this.lookup(node);
    if (emitNode === undefined || emitNode.tokenSourceMapRanges === undefined) return undefined;
    return emitNode.tokenSourceMapRanges.get(kind);
  }

  setTokenSourceMapRange(node: Node, kind: SyntaxKind, pos: number, end: number): Node {
    const emitNode = this.emitNode(node);
    let ranges = emitNode.tokenSourceMapRanges;
    if (ranges === undefined) {
      ranges = new Map<SyntaxKind, number[]>();
      emitNode.tokenSourceMapRanges = ranges;
    }
    ranges.set(kind, [pos, end]);
    return node;
  }

  getAssignedName(node: Node): Node | undefined {
    return this.assignedNames.get(node);
  }

  setAssignedName(node: Node, name: Node): Node {
    this.assignedNames.set(node, name);
    return node;
  }

  getClassThis(node: Node): Node | undefined {
    return this.classThisNames.get(node);
  }

  setClassThis(node: Node, classThis: Node): Node {
    this.classThisNames.set(node, classThis);
    return node;
  }

  getTextSource(node: Node): Node | undefined {
    return this.textSource.get(node);
  }

  setTextSource(node: Node, source: Node): Node {
    this.textSource.set(node, source);
    return node;
  }

  getTypeNode(node: Node): Node | undefined {
    const emitNode = this.lookup(node);
    return emitNode === undefined ? undefined : emitNode.typeNode;
  }

  /** Keeps the erased type annotation of a name so its comments can still be emitted. */
  setTypeNode(node: Node, typeNode: Node): Node {
    this.emitNode(node).typeNode = typeNode;
    return node;
  }

  // Synthesized comments

  getSyntheticLeadingComments(node: Node): SynthesizedComment[] | undefined {
    const emitNode = this.lookup(node);
    return emitNode === undefined ? undefined : emitNode.leadingComments;
  }

  setSyntheticLeadingComments(node: Node, comments: SynthesizedComment[] | undefined): Node {
    this.emitNode(node).leadingComments = comments;
    return node;
  }

  addSyntheticLeadingComment(node: Node, kind: SyntaxKind, text: string, hasTrailingNewLine: boolean): Node {
    const emitNode = this.emitNode(node);
    if (emitNode.leadingComments === undefined) emitNode.leadingComments = [];
    emitNode.leadingComments.push(new SynthesizedComment(kind, text, false, hasTrailingNewLine));
    return node;
  }

  getSyntheticTrailingComments(node: Node): SynthesizedComment[] | undefined {
    const emitNode = this.lookup(node);
    return emitNode === undefined ? undefined : emitNode.trailingComments;
  }

  setSyntheticTrailingComments(node: Node, comments: SynthesizedComment[] | undefined): Node {
    this.emitNode(node).trailingComments = comments;
    return node;
  }

  addSyntheticTrailingComment(node: Node, kind: SyntaxKind, text: string, hasTrailingNewLine: boolean): Node {
    const emitNode = this.emitNode(node);
    if (emitNode.trailingComments === undefined) emitNode.trailingComments = [];
    emitNode.trailingComments.push(new SynthesizedComment(kind, text, false, hasTrailingNewLine));
    return node;
  }

  // Emit helpers

  requestEmitHelper(helper: EmitHelper): EmitHelper {
    if (helper.scoped) throw new Error('Cannot request a scoped emit helper');
    for (const dependency of helper.dependencies) this.requestEmitHelper(dependency);
    if (this.emitHelpers.indexOf(helper) < 0) this.emitHelpers.push(helper);
    return helper;
  }

  readEmitHelpers(): EmitHelper[] {
    const helpers = this.emitHelpers.slice();
    this.emitHelpers.length = 0;
    return helpers;
  }

  addEmitHelper(node: Node, helper: EmitHelper): Node {
    const emitNode = this.emitNode(node);
    if (emitNode.helpers === undefined) emitNode.helpers = [];
    if (emitNode.helpers.indexOf(helper) < 0) emitNode.helpers.push(helper);
    return node;
  }

  getEmitHelpers(node: Node): EmitHelper[] | undefined {
    const emitNode = this.lookup(node);
    return emitNode === undefined ? undefined : emitNode.helpers;
  }

  getExternalHelpersModuleName(file: SourceFile): Identifier | undefined {
    const parseNode = this.parseNode(file);
    if (parseNode === undefined) return undefined;
    const emitNode = this.lookup(parseNode);
    return emitNode === undefined ? undefined : emitNode.externalHelpersModuleName;
  }

  setExternalHelpersModuleName(file: SourceFile, name: Identifier): Identifier {
    const parseNode = this.parseNode(file);
    if (parseNode === undefined) throw new Error('Node must be a parse tree node or have an original parse tree node.');
    this.emitNode(parseNode).externalHelpersModuleName = name;
    return name;
  }

  hasRecordedExternalHelpers(file: SourceFile): boolean {
    const parseNode = this.parseNode(file);
    if (parseNode === undefined) return false;
    const emitNode = this.lookup(parseNode);
    return (
      emitNode !== undefined &&
      (emitNode.externalHelpersModuleName !== undefined || (emitNode.emitFlags & EmitFlags.ExternalHelpers) !== 0)
    );
  }

  // Hoisted declarations

  /** Starts collecting hoisted `var` and function declarations (and a lexical scope). */
  startVariableEnvironment(): VariableScope {
    const scope = new VariableScope();
    this.varScopes.push(scope);
    this.startLexicalEnvironment();
    return scope;
  }

  /** Ends the current variable environment, returning the statements to add at the start of its scope. */
  endVariableEnvironment(): Node[] {
    const scope = this.varScopes.pop()!;
    const factory = this.factory;
    const statements: Node[] = scope.functions.slice();
    if (scope.variables.length > 0) {
      const statement = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(factory.createNodeList(scope.variables), 0),
      );
      this.setEmitFlags(statement, EmitFlags.CustomPrologue);
      statements.push(statement);
    }
    for (const statement of scope.initializationStatements) statements.push(statement);
    const lexical = this.endLexicalEnvironment();
    for (const statement of lexical) statements.push(statement);
    return statements;
  }

  startLexicalEnvironment(): VariableScope {
    const scope = new VariableScope();
    this.letScopes.push(scope);
    return scope;
  }

  endLexicalEnvironment(): Node[] {
    const scope = this.letScopes.pop()!;
    const statements: Node[] = [];
    if (scope.variables.length > 0) {
      const factory = this.factory;
      const statement = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(factory.createNodeList(scope.variables), 1 /* NodeFlags.Let */),
      );
      this.setEmitFlags(statement, EmitFlags.CustomPrologue);
      statements.push(statement);
    }
    return statements;
  }

  /** Adds a `var` declaration to the current variable environment. */
  addVariableDeclaration(name: Identifier): Identifier {
    const declaration = this.factory.createVariableDeclaration(name, undefined, undefined, undefined);
    this.setEmitFlags(declaration, EmitFlags.NoNestedSourceMaps);
    const scope = this.varScopes[this.varScopes.length - 1]!;
    scope.variables.push(declaration);
    if ((scope.flags & EnvironmentFlags.InParameters) !== 0)
      scope.flags |= EnvironmentFlags.VariablesHoistedInParameters;
    return name;
  }

  /** Adds a `let` declaration to the current lexical environment. */
  addLexicalDeclaration(name: Identifier): Identifier {
    const declaration = this.factory.createVariableDeclaration(name, undefined, undefined, undefined);
    this.setEmitFlags(declaration, EmitFlags.NoNestedSourceMaps);
    this.letScopes[this.letScopes.length - 1].variables.push(declaration);
    return name;
  }

  addHoistedFunctionDeclaration(node: FunctionDeclaration): FunctionDeclaration {
    this.setEmitFlags(node, EmitFlags.CustomPrologue);
    this.varScopes[this.varScopes.length - 1].functions.push(node);
    return node;
  }

  addInitializationStatement(node: Node): Node {
    if (this.varScopes.length === 0)
      throw new Error('Tried to add an initialization statement without a surrounding variable scope');
    this.addEmitFlags(node, EmitFlags.CustomPrologue);
    this.varScopes[this.varScopes.length - 1].initializationStatements.push(node);
    return node;
  }

  /** `node` as a function body: a block as it is, an expression as `{ return node; }` with the expression's range. */
  convertToFunctionBlock(node: Node, multiLine: boolean): Block {
    if (node instanceof Block) return node as Block;
    const factory = this.factory;
    const statement = factory.createReturnStatement(node);
    statement.pos = node.pos;
    statement.end = node.end;
    const block = factory.createBlock([statement], multiLine);
    block.statements.pos = node.pos;
    block.statements.end = node.end;
    block.pos = node.pos;
    block.end = node.end;
    return block;
  }

  /** Marks the current variable scope as visiting parameters; returns the previous flags. */
  enterParameters(): number {
    const scope = this.varScopes[this.varScopes.length - 1]!;
    const flags = scope.flags;
    scope.flags |= EnvironmentFlags.InParameters;
    return flags;
  }

  /** Restores the scope flags; returns whether a variable was hoisted while visiting the parameters. */
  exitParameters(previousFlags: number): boolean {
    const scope = this.varScopes[this.varScopes.length - 1]!;
    const hoisted = (scope.flags & EnvironmentFlags.VariablesHoistedInParameters) !== 0;
    scope.flags = previousFlags;
    return hoisted;
  }

  /** `statements` with `declarations` from an ended environment merged in, keeping the list's range. */
  mergeEnvironmentList(statements: NodeList, declarations: Node[]): NodeList {
    const merged = this.mergeEnvironment(statements.nodes, declarations);
    return merged === statements.nodes ? statements : new NodeList(statements.pos, statements.end, merged);
  }

  /**
   * Merges hoisted declarations into statements: prologue directives, then hoisted functions,
   * hoisted variables and other custom prologues, the new ones before the existing ones of each group.
   */
  mergeEnvironment(statements: Node[], declarations: Node[]): Node[] {
    if (declarations.length === 0) return statements;
    const leftPrologueEnd = this.spanEnd(statements, 0, SpanKind.Prologue);
    const leftFunctionsEnd = this.spanEnd(statements, leftPrologueEnd, SpanKind.HoistedFunction);
    const leftVariablesEnd = this.spanEnd(statements, leftFunctionsEnd, SpanKind.HoistedVariable);
    const rightPrologueEnd = this.spanEnd(declarations, 0, SpanKind.Prologue);
    const rightFunctionsEnd = this.spanEnd(declarations, rightPrologueEnd, SpanKind.HoistedFunction);
    const rightVariablesEnd = this.spanEnd(declarations, rightFunctionsEnd, SpanKind.HoistedVariable);
    const rightCustomEnd = this.spanEnd(declarations, rightVariablesEnd, SpanKind.CustomPrologue);
    if (rightCustomEnd !== declarations.length)
      throw new Error('Expected declarations to be valid standard or custom prologues');
    let left = statements;
    if (rightCustomEnd > rightVariablesEnd)
      left = splice(left, leftVariablesEnd, declarations, rightVariablesEnd, rightCustomEnd);
    if (rightVariablesEnd > rightFunctionsEnd)
      left = splice(left, leftFunctionsEnd, declarations, rightFunctionsEnd, rightVariablesEnd);
    if (rightFunctionsEnd > rightPrologueEnd)
      left = splice(left, leftPrologueEnd, declarations, rightPrologueEnd, rightFunctionsEnd);
    if (rightPrologueEnd > 0) {
      if (leftPrologueEnd === 0) left = splice(left, 0, declarations, 0, rightPrologueEnd);
      else {
        const existing = new Set<string>();
        for (let i = 0; i < leftPrologueEnd; i++) existing.add(prologueText(statements[i]!));
        for (let i = rightPrologueEnd - 1; i >= 0; i--) {
          const declaration = declarations[i]!;
          if (!existing.has(prologueText(declaration))) left = [declaration].concat(left);
        }
      }
    }
    return left;
  }

  private spanEnd(nodes: Node[], start: number, kind: SpanKind): number {
    let i = start;
    while (i < nodes.length && this.isSpanKind(nodes[i]!, kind)) i++;
    return i;
  }

  private isSpanKind(node: Node, kind: SpanKind): boolean {
    switch (kind) {
      case SpanKind.Prologue:
        return isPrologueDirective(node);
      case SpanKind.HoistedFunction:
        return this.isCustomPrologue(node) && node instanceof FunctionDeclaration;
      case SpanKind.HoistedVariable:
        if (!this.isCustomPrologue(node) || !(node instanceof VariableStatement)) return false;
        for (const declaration of node.declarationList.declarations.nodes)
          if (
            !(declaration instanceof VariableDeclaration) ||
            !(declaration.name instanceof Identifier) ||
            declaration.initializer !== undefined
          )
            return false;
        return true;
    }
    return this.isCustomPrologue(node);
  }

  isCustomPrologue(node: Node): boolean {
    return (this.getEmitFlags(node) & EmitFlags.CustomPrologue) !== 0;
  }
}
