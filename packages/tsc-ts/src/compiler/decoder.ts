// Decodes TypeScript 7's binary AST format (see encoder.ts) back into nodes: encoded source
// files and standalone nodes such as node builder output. Decoded nodes keep the encoded
// positions and flags but have no parents; JSDoc comments are dropped.
import {
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
  ExternalModuleIndicatorOptions,
  ExternalModuleReference,
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
  JSDoc,
  JSDocAllType,
  JSDocAugmentsTag,
  JSDocCallbackTag,
  JSDocDeprecatedTag,
  JSDocImplementsTag,
  JSDocImportTag,
  JSDocLink,
  JSDocLinkCode,
  JSDocLinkPlain,
  JSDocNameReference,
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  JSDocOverloadTag,
  JSDocOverrideTag,
  JSDocParameterOrPropertyTag,
  JSDocPrivateTag,
  JSDocProtectedTag,
  JSDocPublicTag,
  JSDocReadonlyTag,
  JSDocReturnTag,
  JSDocSatisfiesTag,
  JSDocSeeTag,
  JSDocSignature,
  JSDocTemplateTag,
  JSDocText,
  JSDocThisTag,
  JSDocThrowsTag,
  JSDocTypeExpression,
  JSDocTypeLiteral,
  JSDocTypeTag,
  JSDocTypedefTag,
  JSDocUnknownTag,
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
  type Node,
  NodeList,
  NoSubstitutionTemplateLiteral,
  NonNullExpression,
  NotEmittedStatement,
  NotEmittedTypeElement,
  NumericLiteral,
  ObjectLiteralExpression,
  OmittedExpression,
  OptionalTypeNode,
  ParameterDeclaration,
  ParenthesizedExpression,
  ParenthesizedTypeNode,
  PartiallyEmittedExpression,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  QualifiedName,
  RegularExpressionLiteral,
  RestTypeNode,
  ReturnStatement,
  SatisfiesExpression,
  SemicolonClassElement,
  SetAccessorDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  SwitchStatement,
  SyntaxList,
  SyntheticReferenceExpression,
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
  newCallExpression,
  newPropertyAssignment,
} from './ast.js';
import { modifiersToFlags } from './ast-utilities.js';
import { protocolVersion } from './encoder.js';
import { SyntaxKind } from './syntax-kind.js';

const nodeSize = 28;
const headerSize = 64;
const nodeListKind = 0xffffffff;

const fieldKind = 0;
const fieldPos = 4;
const fieldEnd = 8;
const fieldNext = 12;
const fieldParent = 16;
const fieldData = 20;
const fieldFlags = 24;

const dataTypeMask = 0xc0000000;
const dataTypeString = 0x40000000;
const dataTypeExtended = 0x80000000;
const indexMask = 0x00ffffff;
const childMask = 0xff;

const utf8Decoder = new TextDecoder();

function invalid(message: string): Error {
  return new Error(message);
}

/** Reads node records bottom-up so children exist before their parents. */
class Decoder {
  readonly data: Uint8Array;
  readonly stringOffsets: number;
  readonly stringData: number;
  readonly extendedData: number;
  readonly nodeOffset: number;
  readonly nodeCount: number;
  readonly nodes: (Node | undefined)[];
  readonly lists: (NodeList | undefined)[];
  /** The children of the node being created, and the next one to take. */
  children: number[];
  childAt: number;
  mask: number;

  constructor(data: Uint8Array) {
    if (data.length < headerSize) throw invalid(`data too short for header: ${data.length} bytes`);
    this.data = data;
    const version = data[3];
    if (version !== protocolVersion)
      throw invalid(`unsupported protocol version ${version} (expected ${protocolVersion})`);
    const stringOffsets = this.u32(24);
    const stringData = this.u32(28);
    const extendedData = this.u32(32);
    const nodeOffset = this.u32(40);
    const length = data.length;
    if (stringOffsets > length || stringData > length || extendedData > length || nodeOffset > length)
      throw invalid(`invalid AST header offsets: offsets exceed data length (${length})`);
    if (!(stringOffsets <= stringData && stringData <= extendedData && extendedData <= nodeOffset))
      throw invalid(
        `invalid AST header offsets: expected strTable <= strData <= extData <= nodeOff (got ${stringOffsets}, ${stringData}, ${extendedData}, ${nodeOffset})`,
      );
    this.stringOffsets = stringOffsets;
    this.stringData = stringData;
    this.extendedData = extendedData;
    this.nodeOffset = nodeOffset;
    this.nodeCount = Math.floor((length - nodeOffset) / nodeSize);
    this.nodes = [];
    this.lists = [];
    this.children = [];
    this.childAt = 0;
    this.mask = 0;
  }

  /** A little-endian uint32, or 0 past the end. */
  u32(at: number): number {
    const data = this.data;
    if (at < 0 || at + 4 > data.length) return 0;
    return (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
  }

  field(index: number, field: number): number {
    return this.u32(this.nodeOffset + index * nodeSize + field);
  }

  string(index: number): string {
    const at = this.stringOffsets + index * 4;
    const start = this.stringData + this.u32(at);
    const end = this.stringData + this.u32(at + 4);
    if (start > end || end > this.data.length) throw invalid(`invalid string ${index}`);
    return utf8Decoder.decode(this.data.subarray(start, end));
  }

  /** Collects the indices of the direct children of record `index`. */
  collectChildren(index: number): void {
    const children = this.children;
    children.length = 0;
    const first = index + 1;
    if (first >= this.nodeCount || this.field(first, fieldParent) !== index) return;
    children.push(first);
    let prev = first;
    let next = this.field(first, fieldNext);
    while (next !== 0) {
      if (next <= prev || next >= this.nodeCount) throw invalid(`invalid sibling ${next} of node ${prev}`);
      children.push(next);
      prev = next;
      next = this.field(next, fieldNext);
    }
  }

  decode(): Node {
    const count = this.nodeCount;
    if (count < 2) throw invalid('no nodes to decode');
    const nodes = this.nodes;
    const lists = this.lists;
    for (let i = 0; i < count; i++) {
      nodes.push(undefined);
      lists.push(undefined);
    }
    for (let i = count - 1; i >= 1; i--) {
      const kind = this.field(i, fieldKind);
      // Positions are int32, so a synthesized node's -1 survives the round trip.
      const pos = this.field(i, fieldPos) | 0;
      const end = this.field(i, fieldEnd) | 0;
      this.collectChildren(i);
      if (kind === nodeListKind) {
        const items: Node[] = [];
        const children = this.children;
        for (let c = 0; c < children.length; c++) {
          const child = nodes[children[c]];
          if (child !== undefined) items.push(child);
        }
        lists[i] = new NodeList(pos, end, items);
        continue;
      }
      // Node kinds and flags are int32 (SyntaxKind, NodeFlags): keep them exact int32s.
      const node = this.create((kind | 0) as SyntaxKind, this.field(i, fieldData));
      node.pos = pos;
      node.end = end;
      node.flags = this.field(i, fieldFlags) | 0;
      nodes[i] = node;
    }
    return nodes[1]!;
  }

  create(kind: SyntaxKind, data: number): Node {
    this.childAt = 0;
    this.mask = data & childMask;
    const common = (data >>> 24) & 0x3f;
    const type = (data & dataTypeMask) >>> 0;
    if (type === dataTypeString) return this.createString(kind, this.string(data & indexMask), common);
    if (type === dataTypeExtended) return this.createExtended(kind, this.extendedData + (data & indexMask));
    return this.createWithChildren(kind, common);
  }

  createString(kind: SyntaxKind, text: string, common: number): Node {
    switch (kind) {
      case SyntaxKind.Identifier:
        return new Identifier(text);
      case SyntaxKind.PrivateIdentifier:
        return new PrivateIdentifier(text);
      case SyntaxKind.JsxText:
        return new JsxText(text, (common & 1) !== 0);
      case SyntaxKind.JSDocText:
        return new JSDocText(text);
      case SyntaxKind.JSDocLink:
        return new JSDocLink(undefined, text);
      case SyntaxKind.JSDocLinkPlain:
        return new JSDocLinkPlain(undefined, text);
      case SyntaxKind.JSDocLinkCode:
        return new JSDocLinkCode(undefined, text);
    }
    throw invalid(`unknown string node kind ${kind}`);
  }

  createExtended(kind: SyntaxKind, at: number): Node {
    switch (kind) {
      case SyntaxKind.StringLiteral:
        return new StringLiteral(this.string(this.u32(at)), this.u32(at + 4));
      case SyntaxKind.NumericLiteral:
        return new NumericLiteral(this.string(this.u32(at)), this.u32(at + 4));
      case SyntaxKind.BigIntLiteral:
        return new BigIntLiteral(this.string(this.u32(at)), this.u32(at + 4));
      case SyntaxKind.RegularExpressionLiteral:
        return new RegularExpressionLiteral(this.string(this.u32(at)), this.u32(at + 4));
      case SyntaxKind.NoSubstitutionTemplateLiteral:
        return new NoSubstitutionTemplateLiteral(this.string(this.u32(at)), this.u32(at + 4));
      case SyntaxKind.TemplateHead:
        return new TemplateHead(this.string(this.u32(at)), this.string(this.u32(at + 4)), this.u32(at + 8));
      case SyntaxKind.TemplateMiddle:
        return new TemplateMiddle(this.string(this.u32(at)), this.string(this.u32(at + 4)), this.u32(at + 8));
      case SyntaxKind.TemplateTail:
        return new TemplateTail(this.string(this.u32(at)), this.string(this.u32(at + 4)), this.u32(at + 8));
      case SyntaxKind.SourceFile:
        return this.createSourceFile(at);
    }
    throw invalid(`unknown extended data node kind ${kind}`);
  }

  createSourceFile(at: number): SourceFile {
    const text = this.string(this.u32(at));
    const fileName = this.string(this.u32(at + 4));
    const path = this.string(this.u32(at + 8));
    const parseOptions = this.u32(20);
    let statements: NodeList | undefined = undefined;
    let endOfFile: Token | undefined = undefined;
    const children = this.children;
    for (let i = 0; i < children.length; i++) {
      const index = children[i];
      const list = this.lists[index];
      const node = this.nodes[index];
      if (list !== undefined) statements = list;
      else if (node instanceof Token && node.kind === SyntaxKind.EndOfFile) endOfFile = node;
    }
    return new SourceFile(
      fileName,
      path,
      text,
      new ExternalModuleIndicatorOptions((parseOptions & 1) !== 0, (parseOptions & 2) !== 0),
      statements ?? emptyList(),
      endOfFile ?? new Token(SyntaxKind.EndOfFile),
    );
  }

  /** The index of the child for property `bit`, or 0 if the property is absent. */
  next(bit: number): number {
    if ((this.mask & (1 << bit)) === 0) return 0;
    const children = this.children;
    if (this.childAt >= children.length) return 0;
    return children[this.childAt++];
  }

  node(bit: number): Node | undefined {
    const index = this.next(bit);
    return index === 0 ? undefined : this.nodes[index];
  }

  list(bit: number): NodeList | undefined {
    const index = this.next(bit);
    return index === 0 ? undefined : this.lists[index];
  }

  modifiers(bit: number): ModifierList | undefined {
    const list = this.list(bit);
    if (list === undefined) return undefined;
    return new ModifierList(list.pos, list.end, list.nodes, modifiersToFlags(list.nodes));
  }

  required(bit: number): Node {
    const node = this.node(bit);
    if (node !== undefined) return node;
    throw invalid(`missing child ${bit}`);
  }

  /** A list the node can't be without; absent ones decode as empty. */
  requiredList(bit: number): NodeList {
    return this.list(bit) ?? emptyList();
  }

  token(bit: number): Token | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof Token) return node as Token;
    throw unexpected(node);
  }

  requiredToken(bit: number): Token {
    const node = this.required(bit);
    if (node instanceof Token) return node as Token;
    throw unexpected(node);
  }

  identifier(bit: number): Identifier | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof Identifier) return node as Identifier;
    throw unexpected(node);
  }

  requiredIdentifier(bit: number): Identifier {
    const node = this.required(bit);
    if (node instanceof Identifier) return node as Identifier;
    throw unexpected(node);
  }

  block(bit: number): Block | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof Block) return node as Block;
    throw unexpected(node);
  }

  requiredBlock(bit: number): Block {
    const node = this.required(bit);
    if (node instanceof Block) return node as Block;
    throw unexpected(node);
  }

  caseBlock(bit: number): CaseBlock {
    const node = this.required(bit);
    if (node instanceof CaseBlock) return node as CaseBlock;
    throw unexpected(node);
  }

  catchClause(bit: number): CatchClause | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof CatchClause) return node as CatchClause;
    throw unexpected(node);
  }

  variableDeclaration(bit: number): VariableDeclaration | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof VariableDeclaration) return node as VariableDeclaration;
    throw unexpected(node);
  }

  variableDeclarationList(bit: number): VariableDeclarationList {
    const node = this.required(bit);
    if (node instanceof VariableDeclarationList) return node as VariableDeclarationList;
    throw unexpected(node);
  }

  typeParameter(bit: number): TypeParameterDeclaration {
    const node = this.required(bit);
    if (node instanceof TypeParameterDeclaration) return node as TypeParameterDeclaration;
    throw unexpected(node);
  }

  importClause(bit: number): ImportClause | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof ImportClause) return node as ImportClause;
    throw unexpected(node);
  }

  typeLiteral(bit: number): TypeLiteralNode | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof TypeLiteralNode) return node as TypeLiteralNode;
    throw unexpected(node);
  }

  importAttributes(bit: number): ImportAttributes | undefined {
    const node = this.node(bit);
    if (node === undefined) return undefined;
    if (node instanceof ImportAttributes) return node as ImportAttributes;
    throw unexpected(node);
  }

  templateHead(bit: number): TemplateHead {
    const node = this.required(bit);
    if (node instanceof TemplateHead) return node as TemplateHead;
    throw unexpected(node);
  }

  jsxOpeningElement(bit: number): JsxOpeningElement {
    const node = this.required(bit);
    if (node instanceof JsxOpeningElement) return node as JsxOpeningElement;
    throw unexpected(node);
  }

  jsxClosingElement(bit: number): JsxClosingElement {
    const node = this.required(bit);
    if (node instanceof JsxClosingElement) return node as JsxClosingElement;
    throw unexpected(node);
  }

  jsxOpeningFragment(bit: number): JsxOpeningFragment {
    const node = this.required(bit);
    if (node instanceof JsxOpeningFragment) return node as JsxOpeningFragment;
    throw unexpected(node);
  }

  jsxClosingFragment(bit: number): JsxClosingFragment {
    const node = this.required(bit);
    if (node instanceof JsxClosingFragment) return node as JsxClosingFragment;
    throw unexpected(node);
  }

  jsxAttributes(bit: number): JsxAttributes {
    const node = this.required(bit);
    if (node instanceof JsxAttributes) return node as JsxAttributes;
    throw unexpected(node);
  }

  expressionWithTypeArguments(bit: number): ExpressionWithTypeArguments {
    const node = this.required(bit);
    if (node instanceof ExpressionWithTypeArguments) return node as ExpressionWithTypeArguments;
    throw unexpected(node);
  }

  /** All children, for nodes holding a plain array of them. */
  allChildren(): Node[] {
    const result: Node[] = [];
    const children = this.children;
    for (let i = 0; i < children.length; i++) {
      const node = this.nodes[children[i]];
      if (node !== undefined) result.push(node);
    }
    return result;
  }

  createWithChildren(kind: SyntaxKind, common: number): Node {
    switch (kind) {
      case SyntaxKind.QualifiedName:
        return new QualifiedName(this.required(0), this.requiredIdentifier(1));
      case SyntaxKind.ComputedPropertyName:
        return new ComputedPropertyName(this.required(0));
      case SyntaxKind.Decorator:
        return new Decorator(this.required(0));
      case SyntaxKind.EmptyStatement:
        return new EmptyStatement();
      case SyntaxKind.IfStatement:
        return new IfStatement(this.required(0), this.required(1), this.node(2));
      case SyntaxKind.DoStatement:
        return new DoStatement(this.required(0), this.required(1));
      case SyntaxKind.WhileStatement:
        return new WhileStatement(this.required(0), this.required(1));
      case SyntaxKind.ForStatement:
        return new ForStatement(this.node(0), this.node(1), this.node(2), this.required(3));
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        return new ForInOrOfStatement(kind, this.token(0), this.required(1), this.required(2), this.required(3));
      case SyntaxKind.BreakStatement:
        return new BreakStatement(this.identifier(0));
      case SyntaxKind.ContinueStatement:
        return new ContinueStatement(this.identifier(0));
      case SyntaxKind.ReturnStatement:
        return new ReturnStatement(this.node(0));
      case SyntaxKind.WithStatement:
        return new WithStatement(this.required(0), this.required(1));
      case SyntaxKind.SwitchStatement:
        return new SwitchStatement(this.required(0), this.caseBlock(1));
      case SyntaxKind.CaseBlock:
        return new CaseBlock(this.requiredList(0));
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause:
        return new CaseOrDefaultClause(kind, this.node(0), this.requiredList(1));
      case SyntaxKind.ThrowStatement:
        return new ThrowStatement(this.required(0));
      case SyntaxKind.TryStatement:
        return new TryStatement(this.requiredBlock(0), this.catchClause(1), this.block(2));
      case SyntaxKind.CatchClause:
        return new CatchClause(this.variableDeclaration(0), this.requiredBlock(1));
      case SyntaxKind.DebuggerStatement:
        return new DebuggerStatement();
      case SyntaxKind.LabeledStatement:
        return new LabeledStatement(this.requiredIdentifier(0), this.required(1));
      case SyntaxKind.ExpressionStatement:
        return new ExpressionStatement(this.required(0));
      case SyntaxKind.Block:
        return new Block(this.requiredList(0), (common & 1) !== 0);
      case SyntaxKind.VariableStatement:
        return new VariableStatement(this.modifiers(0), this.variableDeclarationList(1));
      case SyntaxKind.VariableDeclaration:
        return new VariableDeclaration(this.required(0), this.token(1), this.node(2), this.node(3));
      case SyntaxKind.VariableDeclarationList:
        return new VariableDeclarationList(this.requiredList(0), 0);
      case SyntaxKind.ObjectBindingPattern:
      case SyntaxKind.ArrayBindingPattern:
        return new BindingPattern(kind, this.requiredList(0));
      case SyntaxKind.Parameter:
        return new ParameterDeclaration(
          this.modifiers(0),
          this.token(1),
          this.required(2),
          this.token(3),
          this.node(4),
          this.node(5),
        );
      case SyntaxKind.BindingElement:
        return new BindingElement(this.token(0), this.node(1), this.node(2), this.node(3));
      case SyntaxKind.MissingDeclaration:
        return new MissingDeclaration(this.modifiers(0));
      case SyntaxKind.FunctionDeclaration:
        return new FunctionDeclaration(
          this.modifiers(0),
          this.token(1),
          this.identifier(2),
          this.list(3),
          this.requiredList(4),
          this.node(5),
          undefined,
          this.node(6),
        );
      case SyntaxKind.ClassDeclaration:
        return new ClassDeclaration(
          this.modifiers(0),
          this.identifier(1),
          this.list(2),
          this.list(3),
          this.requiredList(4),
        );
      case SyntaxKind.ClassExpression:
        return new ClassExpression(
          this.modifiers(0),
          this.identifier(1),
          this.list(2),
          this.list(3),
          this.requiredList(4),
        );
      case SyntaxKind.HeritageClause:
        return new HeritageClause(
          (common & 1) !== 0 ? SyntaxKind.ImplementsKeyword : SyntaxKind.ExtendsKeyword,
          this.requiredList(0),
        );
      case SyntaxKind.InterfaceDeclaration:
        return new InterfaceDeclaration(
          this.modifiers(0),
          this.requiredIdentifier(1),
          this.list(2),
          this.list(3),
          this.requiredList(4),
        );
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
        return new TypeAliasDeclaration(
          kind,
          this.modifiers(0),
          this.requiredIdentifier(1),
          this.list(2),
          this.required(3),
        );
      case SyntaxKind.EnumMember:
        return new EnumMember(this.required(0), this.node(1));
      case SyntaxKind.EnumDeclaration:
        return new EnumDeclaration(this.modifiers(0), this.requiredIdentifier(1), this.requiredList(2));
      case SyntaxKind.ModuleBlock:
        return new ModuleBlock(this.requiredList(0));
      case SyntaxKind.NotEmittedStatement:
        return new NotEmittedStatement();
      case SyntaxKind.NotEmittedTypeElement:
        return new NotEmittedTypeElement();
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
        return new ImportDeclaration(
          kind,
          this.modifiers(0),
          this.importClause(1),
          this.required(2),
          this.importAttributes(3),
        );
      case SyntaxKind.ExternalModuleReference:
        return new ExternalModuleReference(this.required(0));
      case SyntaxKind.NamespaceImport:
        return new NamespaceImport(this.requiredIdentifier(0));
      case SyntaxKind.NamedImports:
        return new NamedImports(this.requiredList(0));
      case SyntaxKind.ExportAssignment:
        return new ExportAssignment(this.modifiers(0), (common & 1) !== 0, this.node(1), this.required(2));
      case SyntaxKind.NamespaceExportDeclaration:
        return new NamespaceExportDeclaration(this.modifiers(0), this.requiredIdentifier(1));
      case SyntaxKind.NamespaceExport:
        return new NamespaceExport(this.required(0));
      case SyntaxKind.NamedExports:
        return new NamedExports(this.requiredList(0));
      case SyntaxKind.ExportSpecifier:
        return new ExportSpecifier((common & 1) !== 0, this.node(0), this.required(1));
      case SyntaxKind.CallSignature:
        return new CallSignatureDeclaration(this.list(0), this.requiredList(1), this.node(2));
      case SyntaxKind.ConstructSignature:
        return new ConstructSignatureDeclaration(this.list(0), this.requiredList(1), this.node(2));
      case SyntaxKind.Constructor:
        return new ConstructorDeclaration(
          this.modifiers(0),
          this.list(1),
          this.requiredList(2),
          this.node(3),
          undefined,
          this.node(4),
        );
      case SyntaxKind.GetAccessor:
        return new GetAccessorDeclaration(
          this.modifiers(0),
          this.required(1),
          this.list(2),
          this.requiredList(3),
          this.node(4),
          undefined,
          this.node(5),
        );
      case SyntaxKind.SetAccessor:
        return new SetAccessorDeclaration(
          this.modifiers(0),
          this.required(1),
          this.list(2),
          this.requiredList(3),
          this.node(4),
          undefined,
          this.node(5),
        );
      case SyntaxKind.IndexSignature:
        return new IndexSignatureDeclaration(this.modifiers(0), this.requiredList(1), this.node(2));
      case SyntaxKind.MethodSignature:
        return new MethodSignatureDeclaration(
          this.modifiers(0),
          this.required(1),
          this.token(2),
          this.list(3),
          this.requiredList(4),
          this.node(5),
        );
      case SyntaxKind.MethodDeclaration:
        return new MethodDeclaration(
          this.modifiers(0),
          this.token(1),
          this.required(2),
          this.token(3),
          this.list(4),
          this.requiredList(5),
          this.node(6),
          undefined,
          this.node(7),
        );
      case SyntaxKind.PropertySignature:
        return new PropertySignatureDeclaration(
          this.modifiers(0),
          this.required(1),
          this.token(2),
          this.node(3),
          this.node(4),
        );
      case SyntaxKind.PropertyDeclaration:
        return new PropertyDeclaration(this.modifiers(0), this.required(1), this.token(2), this.node(3), this.node(4));
      case SyntaxKind.SemicolonClassElement:
        return new SemicolonClassElement();
      case SyntaxKind.ClassStaticBlockDeclaration:
        return new ClassStaticBlockDeclaration(this.modifiers(0), this.requiredBlock(1));
      case SyntaxKind.OmittedExpression:
        return new OmittedExpression();
      case SyntaxKind.FalseKeyword:
      case SyntaxKind.ImportKeyword:
      case SyntaxKind.NullKeyword:
      case SyntaxKind.SuperKeyword:
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.TrueKeyword:
        return new KeywordExpression(kind);
      case SyntaxKind.BinaryExpression:
        return new BinaryExpression(
          this.modifiers(0),
          this.required(1),
          this.node(2),
          this.requiredToken(3),
          this.required(4),
        );
      case SyntaxKind.PrefixUnaryExpression:
        return new PrefixUnaryExpression(prefixOperator(common & 7), this.required(0));
      case SyntaxKind.PostfixUnaryExpression:
        return new PostfixUnaryExpression(
          this.required(0),
          (common & 1) !== 0 ? SyntaxKind.MinusMinusToken : SyntaxKind.PlusPlusToken,
        );
      case SyntaxKind.YieldExpression:
        return new YieldExpression(this.token(0), this.node(1));
      case SyntaxKind.ArrowFunction:
        return new ArrowFunction(
          this.modifiers(0),
          this.list(1),
          this.requiredList(2),
          this.node(3),
          undefined,
          this.token(4),
          this.required(5),
        );
      case SyntaxKind.FunctionExpression:
        return new FunctionExpression(
          this.modifiers(0),
          this.token(1),
          this.identifier(2),
          this.list(3),
          this.requiredList(4),
          this.node(5),
          undefined,
          this.required(6),
        );
      case SyntaxKind.AsExpression:
        return new AsExpression(this.required(0), this.required(1));
      case SyntaxKind.SatisfiesExpression:
        return new SatisfiesExpression(this.required(0), this.required(1));
      case SyntaxKind.ConditionalExpression:
        return new ConditionalExpression(
          this.required(0),
          this.requiredToken(1),
          this.required(2),
          this.requiredToken(3),
          this.required(4),
        );
      case SyntaxKind.PropertyAccessExpression:
        return new PropertyAccessExpression(this.required(0), this.token(1), this.required(2), 0);
      case SyntaxKind.ElementAccessExpression:
        return new ElementAccessExpression(this.required(0), this.token(1), this.required(2), 0);
      case SyntaxKind.CallExpression:
        return newCallExpression(this.required(0), this.token(1), this.list(2), this.requiredList(3), 0, false);
      case SyntaxKind.NewExpression:
        return new NewExpression(this.required(0), this.list(1), this.list(2));
      case SyntaxKind.MetaProperty:
        return new MetaProperty(
          (common & 1) !== 0 ? SyntaxKind.NewKeyword : SyntaxKind.ImportKeyword,
          this.requiredIdentifier(0),
        );
      case SyntaxKind.NonNullExpression:
        return new NonNullExpression(this.required(0), 0);
      case SyntaxKind.SpreadElement:
        return new SpreadElement(this.required(0));
      case SyntaxKind.TemplateExpression:
        return new TemplateExpression(this.templateHead(0), this.requiredList(1));
      case SyntaxKind.TemplateSpan:
        return new TemplateSpan(this.required(0), this.required(1));
      case SyntaxKind.TaggedTemplateExpression:
        return new TaggedTemplateExpression(this.required(0), this.token(1), this.list(2), this.required(3), 0);
      case SyntaxKind.ParenthesizedExpression:
        return new ParenthesizedExpression(this.required(0));
      case SyntaxKind.ArrayLiteralExpression:
        return new ArrayLiteralExpression(this.requiredList(0), (common & 1) !== 0);
      case SyntaxKind.ObjectLiteralExpression:
        return new ObjectLiteralExpression(this.requiredList(0), (common & 1) !== 0);
      case SyntaxKind.SpreadAssignment:
        return new SpreadAssignment(this.required(0));
      case SyntaxKind.PropertyAssignment:
        return newPropertyAssignment(
          this.modifiers(0),
          this.required(1),
          this.token(2),
          this.node(3),
          this.required(4),
          false,
        );
      case SyntaxKind.ShorthandPropertyAssignment:
        return new ShorthandPropertyAssignment(
          this.modifiers(0),
          this.required(1),
          this.token(2),
          this.node(3),
          this.token(4),
          this.node(5),
        );
      case SyntaxKind.DeleteExpression:
        return new DeleteExpression(this.required(0));
      case SyntaxKind.TypeOfExpression:
        return new TypeOfExpression(this.required(0));
      case SyntaxKind.VoidExpression:
        return new VoidExpression(this.required(0));
      case SyntaxKind.AwaitExpression:
        return new AwaitExpression(this.required(0));
      case SyntaxKind.TypeAssertionExpression:
        return new TypeAssertion(this.required(0), this.required(1));
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.IntrinsicKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.ObjectKeyword:
      case SyntaxKind.StringKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.BigIntKeyword:
        return new KeywordTypeNode(kind);
      case SyntaxKind.UnionType:
        return new UnionTypeNode(this.requiredList(0));
      case SyntaxKind.IntersectionType:
        return new IntersectionTypeNode(this.requiredList(0));
      case SyntaxKind.ConditionalType:
        return new ConditionalTypeNode(this.required(0), this.required(1), this.required(2), this.required(3));
      case SyntaxKind.TypeOperator:
        return new TypeOperatorNode(typeOperator(common & 3), this.required(0));
      case SyntaxKind.InferType:
        return new InferTypeNode(this.typeParameter(0));
      case SyntaxKind.ArrayType:
        return new ArrayTypeNode(this.required(0));
      case SyntaxKind.IndexedAccessType:
        return new IndexedAccessTypeNode(this.required(0), this.required(1));
      case SyntaxKind.TypeReference:
        return new TypeReferenceNode(this.required(0), this.list(1));
      case SyntaxKind.ExpressionWithTypeArguments:
        return new ExpressionWithTypeArguments(this.required(0), this.list(1));
      case SyntaxKind.LiteralType:
        return new LiteralTypeNode(this.required(0));
      case SyntaxKind.ThisType:
        return new ThisTypeNode();
      case SyntaxKind.TypePredicate:
        return new TypePredicateNode(this.token(0), this.required(1), this.node(2));
      case SyntaxKind.ImportAttribute:
        return new ImportAttribute(this.node(0), this.required(1));
      case SyntaxKind.ImportAttributes:
        return new ImportAttributes(
          (common & 2) !== 0 ? SyntaxKind.AssertKeyword : SyntaxKind.WithKeyword,
          this.requiredList(0),
          (common & 1) !== 0,
        );
      case SyntaxKind.TypeQuery:
        return new TypeQueryNode(this.required(0), this.list(1));
      case SyntaxKind.MappedType:
        return new MappedTypeNode(
          this.token(0),
          this.typeParameter(1),
          this.node(2),
          this.token(3),
          this.node(4),
          this.list(5),
        );
      case SyntaxKind.TypeLiteral:
        return new TypeLiteralNode(this.requiredList(0));
      case SyntaxKind.TupleType:
        return new TupleTypeNode(this.requiredList(0));
      case SyntaxKind.NamedTupleMember:
        return new NamedTupleMember(this.token(0), this.requiredIdentifier(1), this.token(2), this.required(3));
      case SyntaxKind.OptionalType:
        return new OptionalTypeNode(this.required(0));
      case SyntaxKind.RestType:
        return new RestTypeNode(this.required(0));
      case SyntaxKind.ParenthesizedType:
        return new ParenthesizedTypeNode(this.required(0));
      case SyntaxKind.FunctionType:
        return new FunctionTypeNode(this.list(0), this.requiredList(1), this.node(2));
      case SyntaxKind.ConstructorType:
        return new ConstructorTypeNode(this.modifiers(0), this.list(1), this.requiredList(2), this.node(3));
      case SyntaxKind.TemplateLiteralType:
        return new TemplateLiteralTypeNode(this.templateHead(0), this.requiredList(1));
      case SyntaxKind.TemplateLiteralTypeSpan:
        return new TemplateLiteralTypeSpan(this.required(0), this.required(1));
      case SyntaxKind.PartiallyEmittedExpression:
        return new PartiallyEmittedExpression(this.required(0));
      case SyntaxKind.JsxElement:
        return new JsxElement(this.jsxOpeningElement(0), this.requiredList(1), this.jsxClosingElement(2));
      case SyntaxKind.JsxAttributes:
        return new JsxAttributes(this.requiredList(0));
      case SyntaxKind.JsxNamespacedName:
        return new JsxNamespacedName(this.requiredIdentifier(0), this.requiredIdentifier(1));
      case SyntaxKind.JsxOpeningElement:
        return new JsxOpeningElement(this.required(0), this.list(1), this.jsxAttributes(2));
      case SyntaxKind.JsxSelfClosingElement:
        return new JsxSelfClosingElement(this.required(0), this.list(1), this.jsxAttributes(2));
      case SyntaxKind.JsxFragment:
        return new JsxFragment(this.jsxOpeningFragment(0), this.requiredList(1), this.jsxClosingFragment(2));
      case SyntaxKind.JsxOpeningFragment:
        return new JsxOpeningFragment();
      case SyntaxKind.JsxClosingFragment:
        return new JsxClosingFragment();
      case SyntaxKind.JsxAttribute:
        return new JsxAttribute(this.required(0), this.node(1));
      case SyntaxKind.JsxSpreadAttribute:
        return new JsxSpreadAttribute(this.required(0));
      case SyntaxKind.JsxClosingElement:
        return new JsxClosingElement(this.required(0));
      case SyntaxKind.JsxExpression:
        return new JsxExpression(this.token(0), this.node(1));
      case SyntaxKind.SyntaxList:
        return new SyntaxList(this.allChildren());
      case SyntaxKind.JSDoc:
        return new JSDoc(this.requiredList(0), this.list(1));
      case SyntaxKind.JSDocTypeExpression:
        return new JSDocTypeExpression(this.required(0));
      case SyntaxKind.JSDocNonNullableType:
        return new JSDocNonNullableType(this.required(0));
      case SyntaxKind.JSDocNullableType:
        return new JSDocNullableType(this.required(0));
      case SyntaxKind.JSDocAllType:
        return new JSDocAllType();
      case SyntaxKind.JSDocVariadicType:
        return new JSDocVariadicType(this.required(0));
      case SyntaxKind.JSDocOptionalType:
        return new JSDocOptionalType(this.required(0));
      case SyntaxKind.JSDocTypeTag:
        return new JSDocTypeTag(this.requiredIdentifier(0), this.required(1), this.list(2));
      case SyntaxKind.JSDocUnknownTag:
        return new JSDocUnknownTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocTemplateTag:
        return new JSDocTemplateTag(this.requiredIdentifier(0), this.node(1), this.requiredList(2), this.list(3));
      case SyntaxKind.JSDocReturnTag:
        return new JSDocReturnTag(this.requiredIdentifier(0), this.node(1), this.list(2));
      case SyntaxKind.JSDocPublicTag:
        return new JSDocPublicTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocPrivateTag:
        return new JSDocPrivateTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocProtectedTag:
        return new JSDocProtectedTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocReadonlyTag:
        return new JSDocReadonlyTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocOverrideTag:
        return new JSDocOverrideTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocDeprecatedTag:
        return new JSDocDeprecatedTag(this.requiredIdentifier(0), this.list(1));
      case SyntaxKind.JSDocSeeTag:
        return new JSDocSeeTag(this.requiredIdentifier(0), this.node(1), this.list(2));
      case SyntaxKind.JSDocImplementsTag:
        return new JSDocImplementsTag(this.requiredIdentifier(0), this.expressionWithTypeArguments(1), this.list(2));
      case SyntaxKind.JSDocAugmentsTag:
        return new JSDocAugmentsTag(this.requiredIdentifier(0), this.expressionWithTypeArguments(1), this.list(2));
      case SyntaxKind.JSDocSatisfiesTag:
        return new JSDocSatisfiesTag(this.requiredIdentifier(0), this.required(1), this.list(2));
      case SyntaxKind.JSDocThrowsTag:
        return new JSDocThrowsTag(this.requiredIdentifier(0), this.node(1), this.list(2));
      case SyntaxKind.JSDocThisTag:
        return new JSDocThisTag(this.requiredIdentifier(0), this.required(1), this.list(2));
      case SyntaxKind.JSDocImportTag:
        return new JSDocImportTag(
          this.requiredIdentifier(0),
          this.importClause(1),
          this.required(2),
          this.importAttributes(3),
          this.list(4),
        );
      case SyntaxKind.JSDocCallbackTag:
        return new JSDocCallbackTag(this.requiredIdentifier(0), this.required(1), this.node(2), this.list(3));
      case SyntaxKind.JSDocOverloadTag:
        return new JSDocOverloadTag(this.requiredIdentifier(0), this.required(1), this.list(2));
      case SyntaxKind.JSDocTypedefTag:
        return new JSDocTypedefTag(this.requiredIdentifier(0), this.node(1), this.node(2), this.list(3));
      case SyntaxKind.JSDocSignature:
        return new JSDocSignature(this.list(0), this.requiredList(1), this.node(2));
      case SyntaxKind.JSDocNameReference:
        return new JSDocNameReference(this.node(0));
      case SyntaxKind.ModuleDeclaration:
        return new ModuleDeclaration(
          this.modifiers(0),
          (common & 1) !== 0 ? SyntaxKind.NamespaceKeyword : SyntaxKind.ModuleKeyword,
          this.required(1),
          this.typeLiteral(2),
          this.node(3),
        );
      case SyntaxKind.ImportEqualsDeclaration:
        return new ImportEqualsDeclaration(
          this.modifiers(0),
          (common & 1) !== 0,
          this.requiredIdentifier(1),
          this.required(2),
        );
      case SyntaxKind.ExportDeclaration:
        return new ExportDeclaration(
          this.modifiers(0),
          (common & 1) !== 0,
          this.node(1),
          this.node(2),
          this.importAttributes(3),
        );
      case SyntaxKind.ImportType:
        return new ImportTypeNode(
          (common & 1) !== 0,
          this.required(0),
          this.importAttributes(1),
          this.node(2),
          this.list(3),
        );
      case SyntaxKind.ImportClause:
        return new ImportClause(importPhase(common & 3), this.identifier(0), this.node(1));
      case SyntaxKind.ImportSpecifier:
        return new ImportSpecifier((common & 1) !== 0, this.node(0), this.requiredIdentifier(1));
      case SyntaxKind.TypeParameter:
        return new TypeParameterDeclaration(
          this.modifiers(0),
          this.requiredIdentifier(1),
          this.node(2),
          this.node(3),
          this.node(4),
        );
      case SyntaxKind.SyntheticReferenceExpression:
        return new SyntheticReferenceExpression(this.required(0), this.required(1));
      case SyntaxKind.JSDocTypeLiteral:
        return new JSDocTypeLiteral(this.allChildren(), (common & 1) !== 0);
      case SyntaxKind.JSDocParameterTag:
      case SyntaxKind.JSDocPropertyTag:
        return new JSDocParameterOrPropertyTag(
          kind,
          this.requiredIdentifier(0),
          this.required(1),
          (common & 1) !== 0,
          this.node(2),
          (common & 2) !== 0,
          this.list(3),
        );
    }
    if (kind <= SyntaxKind.LastToken) return new Token(kind);
    throw invalid(`unhandled node kind ${kind} with ${this.children.length} children`);
  }
}

function emptyList(): NodeList {
  return new NodeList(-1, -1, []);
}

function unexpected(node: Node): Error {
  return invalid(`unexpected child of kind ${node.kind}`);
}

function prefixOperator(index: number): SyntaxKind {
  switch (index) {
    case 1:
      return SyntaxKind.MinusToken;
    case 2:
      return SyntaxKind.TildeToken;
    case 3:
      return SyntaxKind.ExclamationToken;
    case 4:
      return SyntaxKind.PlusPlusToken;
    case 5:
      return SyntaxKind.MinusMinusToken;
  }
  return SyntaxKind.PlusToken;
}

function typeOperator(index: number): SyntaxKind {
  if (index === 1) return SyntaxKind.ReadonlyKeyword;
  if (index === 2) return SyntaxKind.UniqueKeyword;
  return SyntaxKind.KeyOfKeyword;
}

function importPhase(index: number): SyntaxKind | undefined {
  if (index === 1) return SyntaxKind.TypeKeyword;
  if (index === 2) return SyntaxKind.DeferKeyword;
  if (index === 3) return SyntaxKind.SourceKeyword;
  return undefined;
}

/** The root node of an encoded node or source file; throws on malformed data. */
export function decodeNodes(data: Uint8Array): Node {
  return new Decoder(data).decode();
}
