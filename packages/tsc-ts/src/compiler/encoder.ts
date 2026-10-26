// Encodes a source file in TypeScript 7.1's binary AST format (protocol version 9), the
// `getSourceFile` payload of the API.
//
// Layout: a 64-byte header, string offsets (UTF-8 start/end pairs), string data (the
// UTF-8 file text, then strings that aren't slices of it), extended node data,
// msgpack structured data, and 28-byte node records in visit order. Node positions are
// UTF-16 offsets.
import {
  ArrayLiteralExpression,
  ArrayTypeNode,
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
  Decorator,
  DeleteExpression,
  DoStatement,
  ElementAccessExpression,
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
  MissingDeclaration,
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
  type NodeList,
  NodeVisitor,
  NoSubstitutionTemplateLiteral,
  NonNullExpression,
  NumericLiteral,
  ObjectLiteralExpression,
  OptionalTypeNode,
  ParameterDeclaration,
  ParenthesizedExpression,
  ParenthesizedTypeNode,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  QualifiedName,
  RegularExpressionLiteral,
  RestTypeNode,
  ReturnStatement,
  SatisfiesExpression,
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
  BigIntLiteral,
  Identifier,
  propertyAssignmentPostfixToken,
  propertyAssignmentType,
  callQuestionDotToken,
  propertyAssignmentModifiers,
  callTypeArguments,
} from './ast.js';
import { getJSDoc } from './parser.js';
import { SyntaxKind } from './syntax-kind.js';
import { hash128 } from './xxh3.js';
import { utf8Offsets } from './character-codes.js';

export const protocolVersion = 9;

const nodeSize = 28;
const headerSize = 64;
const nodeListKind = 0xffffffff;
const noStructuredData = 0xffffffff;

const dataTypeChildren = 0;
const dataTypeString = 1 << 30;
const dataTypeExtended = 2 << 30;

const utf8Encoder = new TextEncoder();

/** A node list record's last word: 1 when the list ends with a comma. */
function trailingComma(list: NodeList): number {
  return list.hasTrailingComma() ? 1 : 0;
}

/** A growable little-endian byte buffer. */
class ByteWriter {
  bytes: Uint8Array;
  length: number;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity < 16 ? 16 : capacity);
    this.length = 0;
  }

  /** Makes room for `count` more bytes and returns the offset to write them at. */
  reserve(count: number): number {
    const at = this.length;
    const needed = at + count;
    if (needed > this.bytes.length) {
      let size = this.bytes.length * 2;
      while (size < needed) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.bytes.subarray(0, at));
      this.bytes = grown;
    }
    this.length = needed;
    return at;
  }

  u8(value: number): void {
    const at = this.reserve(1);
    this.bytes[at] = value & 0xff;
  }

  u32(value: number): void {
    this.setU32(this.reserve(4), value);
  }

  setU32(at: number, value: number): void {
    const bytes = this.bytes;
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
    bytes[at + 2] = (value >>> 16) & 0xff;
    bytes[at + 3] = (value >>> 24) & 0xff;
  }

  /** Big-endian, for msgpack. */
  be(value: number, size: number): void {
    const at = this.reserve(size);
    for (let i = 0; i < size; i++) this.bytes[at + i] = (value >>> ((size - 1 - i) * 8)) & 0xff;
  }

  append(data: Uint8Array): void {
    const at = this.reserve(data.length);
    this.bytes.set(data, at);
  }

  view(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

/** Whether typed arrays store numbers little-endian, as the encoding does. */
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Node records: seven 32-bit fields each (`nodeSize` bytes), written a field at a time. */
class NodeRecords {
  private words: Uint32Array;
  count = 0;

  constructor(capacity: number) {
    this.words = new Uint32Array((capacity < 2 ? 2 : capacity) * 7);
  }

  /** The records' size in bytes. */
  get length(): number {
    return this.count * nodeSize;
  }

  push(kind: number, pos: number, end: number, parent: number, data: number, flags: number): void {
    const at = this.count * 7;
    if (at + 7 > this.words.length) {
      const grown = new Uint32Array(this.words.length * 2);
      grown.set(this.words);
      this.words = grown;
    }
    const words = this.words;
    words[at] = kind;
    words[at + 1] = pos;
    words[at + 2] = end;
    words[at + 3] = 0;
    words[at + 4] = parent;
    words[at + 5] = data;
    words[at + 6] = flags;
    this.count++;
  }

  /** Sets the `next` field of record `index`. */
  setNext(index: number, next: number): void {
    this.words[index * 7 + 3] = next;
  }

  /** The records as little-endian bytes. */
  view(): Uint8Array {
    if (littleEndian) return new Uint8Array(this.words.buffer, 0, this.length);
    const bytes = new Uint8Array(this.length);
    for (let i = 0; i < this.count * 7; i++) {
      const value = this.words[i];
      bytes[i * 4] = value & 0xff;
      bytes[i * 4 + 1] = (value >>> 8) & 0xff;
      bytes[i * 4 + 2] = (value >>> 16) & 0xff;
      bytes[i * 4 + 3] = (value >>> 24) & 0xff;
    }
    return bytes;
  }
}

function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch < 0x80) length += 1;
    else if (ch < 0x800) length += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

/** UTF-8 bytes of `text`, with lone surrogates as WTF-8 like tsgo's strings. */
function encodeUTF8(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8Length(text));
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let ch = text.charCodeAt(i);
    if (ch < 0x80) {
      bytes[at++] = ch;
      continue;
    }
    if (ch < 0x800) {
      bytes[at++] = 0xc0 | (ch >> 6);
      bytes[at++] = 0x80 | (ch & 0x3f);
      continue;
    }
    if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        ch = (ch - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
        bytes[at++] = 0xf0 | (ch >> 18);
        bytes[at++] = 0x80 | ((ch >> 12) & 0x3f);
        bytes[at++] = 0x80 | ((ch >> 6) & 0x3f);
        bytes[at++] = 0x80 | (ch & 0x3f);
        continue;
      }
    }
    bytes[at++] = 0xe0 | (ch >> 12);
    bytes[at++] = 0x80 | ((ch >> 6) & 0x3f);
    bytes[at++] = 0x80 | (ch & 0x3f);
  }
  return bytes;
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch < 0xd800 || ch > 0xdfff) continue;
    if (ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        i++;
        continue;
      }
    }
    return true;
  }
  return false;
}

function isASCII(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x80) return false;
  return true;
}

/**
 * Strings referenced by nodes. A string that equals the file text just before the node's
 * end (less a closing quote) is stored as that slice; others are appended after the text.
 */
class StringTable {
  readonly fileText: Uint8Array;
  readonly asciiFile: boolean;
  readonly offsets8: Int32Array | undefined;
  readonly offsets: ByteWriter;
  readonly others: ByteWriter;
  count: number;

  constructor(
    private readonly text: string,
    fileText: Uint8Array,
  ) {
    this.fileText = fileText;
    this.asciiFile = fileText.length === text.length;
    this.offsets8 = this.asciiFile ? undefined : utf8Offsets(text);
    this.offsets = new ByteWriter(1024);
    this.others = new ByteWriter(64);
    this.count = 0;
  }

  /** The UTF-8 offset of UTF-16 offset `pos`. */
  utf8(pos: number): number {
    const offsets = this.offsets8;
    if (offsets === undefined || pos < 0 || pos >= offsets.length) return pos;
    return offsets[pos];
  }

  private push(start: number, end: number): number {
    const index = this.count;
    this.offsets.u32(start);
    this.offsets.u32(end);
    this.count += 2;
    return index;
  }

  /** Records the whole file text. */
  addFileText(pos: number, end: number): number {
    return this.push(this.utf8(pos), this.utf8(end));
  }

  add(text: string, kind: SyntaxKind, pos: number, end: number): number {
    const fileText = this.fileText;
    const pos8 = this.utf8(pos);
    let end8 = this.utf8(end);
    if (end8 - pos8 > 0 && end8 <= fileText.length) {
      // A closing quote takes one byte and one UTF-16 unit.
      let end16 = end;
      if (
        kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.TemplateTail ||
        kind === SyntaxKind.NoSubstitutionTemplateLiteral
      ) {
        end8 -= 1;
        end16 -= 1;
      }
      // Where the text is the file text before `end16`, its UTF-8 bytes are those of that slice, unless it
      // has lone surrogates: `encodeUTF8` writes them as WTF-8, and the file's UTF-8 has none.
      const start16 = end16 - text.length;
      if (
        start16 >= 0 &&
        end16 <= this.text.length &&
        this.text.startsWith(text, start16) &&
        (this.asciiFile || !hasLoneSurrogate(text))
      )
        return this.push(this.utf8(start16), end8);
    }
    const ascii = isASCII(text);
    const length = ascii ? text.length : utf8Length(text);
    if (end8 - pos8 > 0 && end8 <= fileText.length) {
      const start8 = end8 - length;
      if (start8 >= 0 && this.matches(text, ascii, start8, end8)) return this.push(start8, end8);
    }
    const offset = fileText.length + this.others.length;
    if (ascii) {
      const at = this.others.reserve(length);
      const bytes = this.others.bytes;
      for (let i = 0; i < length; i++) bytes[at + i] = text.charCodeAt(i);
    } else this.others.append(encodeUTF8(text));
    return this.push(offset, offset + length);
  }

  private matches(text: string, ascii: boolean, start8: number, end8: number): boolean {
    const fileText = this.fileText;
    if (ascii) {
      for (let i = 0; i < text.length; i++) if (fileText[start8 + i] !== text.charCodeAt(i)) return false;
      return true;
    }
    const encoded = encodeUTF8(text);
    if (encoded.length !== end8 - start8) return false;
    for (let i = 0; i < encoded.length; i++) if (fileText[start8 + i] !== encoded[i]) return false;
    return true;
  }
}

function hasModifiers(modifiers: ModifierList | undefined): boolean {
  return modifiers !== undefined && modifiers.nodes.length > 0;
}

/** Which of a node's child properties are present, one bit per property in visit order. */
function hasElements(nodes: readonly Node[] | undefined): boolean {
  return nodes !== undefined && nodes.length > 0;
}

function childrenPropertyMask(node: Node): number {
  switch (node.kind) {
    case SyntaxKind.QualifiedName:
      return node instanceof QualifiedName
        ? ((node as QualifiedName).left !== undefined ? 1 : 0) | ((node as QualifiedName).right !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ComputedPropertyName:
      return node instanceof ComputedPropertyName
        ? (node as ComputedPropertyName).expression !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.Decorator:
      return node instanceof Decorator ? ((node as Decorator).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.IfStatement:
      return node instanceof IfStatement
        ? ((node as IfStatement).expression !== undefined ? 1 : 0) |
            ((node as IfStatement).thenStatement !== undefined ? 2 : 0) |
            ((node as IfStatement).elseStatement !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.DoStatement:
      return node instanceof DoStatement
        ? ((node as DoStatement).statement !== undefined ? 1 : 0) |
            ((node as DoStatement).expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.WhileStatement:
      return node instanceof WhileStatement
        ? ((node as WhileStatement).expression !== undefined ? 1 : 0) |
            ((node as WhileStatement).statement !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ForStatement:
      return node instanceof ForStatement
        ? ((node as ForStatement).initializer !== undefined ? 1 : 0) |
            ((node as ForStatement).condition !== undefined ? 2 : 0) |
            ((node as ForStatement).incrementor !== undefined ? 4 : 0) |
            ((node as ForStatement).statement !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return node instanceof ForInOrOfStatement
        ? ((node as ForInOrOfStatement).awaitModifier !== undefined ? 1 : 0) |
            ((node as ForInOrOfStatement).initializer !== undefined ? 2 : 0) |
            ((node as ForInOrOfStatement).expression !== undefined ? 4 : 0) |
            ((node as ForInOrOfStatement).statement !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.BreakStatement:
      return node instanceof BreakStatement ? ((node as BreakStatement).label !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ContinueStatement:
      return node instanceof ContinueStatement ? ((node as ContinueStatement).label !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ReturnStatement:
      return node instanceof ReturnStatement ? ((node as ReturnStatement).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.WithStatement:
      return node instanceof WithStatement
        ? ((node as WithStatement).expression !== undefined ? 1 : 0) |
            ((node as WithStatement).statement !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.SwitchStatement:
      return node instanceof SwitchStatement
        ? ((node as SwitchStatement).expression !== undefined ? 1 : 0) |
            ((node as SwitchStatement).caseBlock !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.CaseBlock:
      return node instanceof CaseBlock ? ((node as CaseBlock).clauses !== undefined ? 1 : 0) : 0;
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
      return node instanceof CaseOrDefaultClause
        ? ((node as CaseOrDefaultClause).expression !== undefined ? 1 : 0) |
            ((node as CaseOrDefaultClause).statements !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ThrowStatement:
      return node instanceof ThrowStatement ? ((node as ThrowStatement).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TryStatement:
      return node instanceof TryStatement
        ? ((node as TryStatement).tryBlock !== undefined ? 1 : 0) |
            ((node as TryStatement).catchClause !== undefined ? 2 : 0) |
            ((node as TryStatement).finallyBlock !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.CatchClause:
      return node instanceof CatchClause
        ? ((node as CatchClause).variableDeclaration !== undefined ? 1 : 0) |
            ((node as CatchClause).block !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.LabeledStatement:
      return node instanceof LabeledStatement
        ? ((node as LabeledStatement).label !== undefined ? 1 : 0) |
            ((node as LabeledStatement).statement !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ExpressionStatement:
      return node instanceof ExpressionStatement ? ((node as ExpressionStatement).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.Block:
      return node instanceof Block ? ((node as Block).statements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.VariableStatement:
      return node instanceof VariableStatement
        ? (hasModifiers((node as VariableStatement).modifiers) ? 1 : 0) |
            ((node as VariableStatement).declarationList !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.VariableDeclaration:
      return node instanceof VariableDeclaration
        ? ((node as VariableDeclaration).name !== undefined ? 1 : 0) |
            ((node as VariableDeclaration).exclamationToken !== undefined ? 2 : 0) |
            ((node as VariableDeclaration).type !== undefined ? 4 : 0) |
            ((node as VariableDeclaration).initializer !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.VariableDeclarationList:
      return node instanceof VariableDeclarationList
        ? (node as VariableDeclarationList).declarations !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
      return node instanceof BindingPattern ? ((node as BindingPattern).elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.Parameter:
      return node instanceof ParameterDeclaration
        ? (hasModifiers((node as ParameterDeclaration).modifiers) ? 1 : 0) |
            ((node as ParameterDeclaration).dotDotDotToken !== undefined ? 2 : 0) |
            ((node as ParameterDeclaration).name !== undefined ? 4 : 0) |
            ((node as ParameterDeclaration).questionToken !== undefined ? 8 : 0) |
            ((node as ParameterDeclaration).type !== undefined ? 16 : 0) |
            ((node as ParameterDeclaration).initializer !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.BindingElement:
      return node instanceof BindingElement
        ? ((node as BindingElement).dotDotDotToken !== undefined ? 1 : 0) |
            ((node as BindingElement).propertyName !== undefined ? 2 : 0) |
            ((node as BindingElement).name !== undefined ? 4 : 0) |
            ((node as BindingElement).initializer !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.MissingDeclaration:
      return node instanceof MissingDeclaration ? (hasModifiers((node as MissingDeclaration).modifiers) ? 1 : 0) : 0;
    case SyntaxKind.FunctionDeclaration:
      return node instanceof FunctionDeclaration
        ? (hasModifiers((node as FunctionDeclaration).modifiers) ? 1 : 0) |
            ((node as FunctionDeclaration).asteriskToken !== undefined ? 2 : 0) |
            ((node as FunctionDeclaration).name !== undefined ? 4 : 0) |
            ((node as FunctionDeclaration).typeParameters !== undefined ? 8 : 0) |
            ((node as FunctionDeclaration).parameters !== undefined ? 16 : 0) |
            ((node as FunctionDeclaration).type !== undefined ? 32 : 0) |
            ((node as FunctionDeclaration).body !== undefined ? 64 : 0)
        : 0;
    case SyntaxKind.ClassDeclaration:
      return node instanceof ClassDeclaration
        ? (hasModifiers((node as ClassDeclaration).modifiers) ? 1 : 0) |
            ((node as ClassDeclaration).name !== undefined ? 2 : 0) |
            ((node as ClassDeclaration).typeParameters !== undefined ? 4 : 0) |
            ((node as ClassDeclaration).heritageClauses !== undefined ? 8 : 0) |
            ((node as ClassDeclaration).members !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.ClassExpression:
      return node instanceof ClassExpression
        ? (hasModifiers((node as ClassExpression).modifiers) ? 1 : 0) |
            ((node as ClassExpression).name !== undefined ? 2 : 0) |
            ((node as ClassExpression).typeParameters !== undefined ? 4 : 0) |
            ((node as ClassExpression).heritageClauses !== undefined ? 8 : 0) |
            ((node as ClassExpression).members !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.HeritageClause:
      return node instanceof HeritageClause ? ((node as HeritageClause).types !== undefined ? 1 : 0) : 0;
    case SyntaxKind.InterfaceDeclaration:
      return node instanceof InterfaceDeclaration
        ? (hasModifiers((node as InterfaceDeclaration).modifiers) ? 1 : 0) |
            ((node as InterfaceDeclaration).name !== undefined ? 2 : 0) |
            ((node as InterfaceDeclaration).typeParameters !== undefined ? 4 : 0) |
            ((node as InterfaceDeclaration).heritageClauses !== undefined ? 8 : 0) |
            ((node as InterfaceDeclaration).members !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      return node instanceof TypeAliasDeclaration
        ? (hasModifiers((node as TypeAliasDeclaration).modifiers) ? 1 : 0) |
            ((node as TypeAliasDeclaration).name !== undefined ? 2 : 0) |
            ((node as TypeAliasDeclaration).typeParameters !== undefined ? 4 : 0) |
            ((node as TypeAliasDeclaration).type !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.EnumMember:
      return node instanceof EnumMember
        ? ((node as EnumMember).name !== undefined ? 1 : 0) | ((node as EnumMember).initializer !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.EnumDeclaration:
      return node instanceof EnumDeclaration
        ? (hasModifiers((node as EnumDeclaration).modifiers) ? 1 : 0) |
            ((node as EnumDeclaration).name !== undefined ? 2 : 0) |
            ((node as EnumDeclaration).members !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ModuleBlock:
      return node instanceof ModuleBlock ? ((node as ModuleBlock).statements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      return node instanceof ImportDeclaration
        ? (hasModifiers((node as ImportDeclaration).modifiers) ? 1 : 0) |
            ((node as ImportDeclaration).importClause !== undefined ? 2 : 0) |
            ((node as ImportDeclaration).moduleSpecifier !== undefined ? 4 : 0) |
            ((node as ImportDeclaration).attributes !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ExternalModuleReference:
      return node instanceof ExternalModuleReference
        ? (node as ExternalModuleReference).expression !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.NamespaceImport:
      return node instanceof NamespaceImport ? ((node as NamespaceImport).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamedImports:
      return node instanceof NamedImports ? ((node as NamedImports).elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ExportAssignment:
      return node instanceof ExportAssignment
        ? (hasModifiers((node as ExportAssignment).modifiers) ? 1 : 0) |
            ((node as ExportAssignment).type !== undefined ? 2 : 0) |
            ((node as ExportAssignment).expression !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.NamespaceExportDeclaration:
      return node instanceof NamespaceExportDeclaration
        ? (hasModifiers((node as NamespaceExportDeclaration).modifiers) ? 1 : 0) |
            ((node as NamespaceExportDeclaration).name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.NamespaceExport:
      return node instanceof NamespaceExport ? ((node as NamespaceExport).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamedExports:
      return node instanceof NamedExports ? ((node as NamedExports).elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ExportSpecifier:
      return node instanceof ExportSpecifier
        ? ((node as ExportSpecifier).propertyName !== undefined ? 1 : 0) |
            ((node as ExportSpecifier).name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.CallSignature:
      return node instanceof CallSignatureDeclaration
        ? ((node as CallSignatureDeclaration).typeParameters !== undefined ? 1 : 0) |
            ((node as CallSignatureDeclaration).parameters !== undefined ? 2 : 0) |
            ((node as CallSignatureDeclaration).type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ConstructSignature:
      return node instanceof ConstructSignatureDeclaration
        ? ((node as ConstructSignatureDeclaration).typeParameters !== undefined ? 1 : 0) |
            ((node as ConstructSignatureDeclaration).parameters !== undefined ? 2 : 0) |
            ((node as ConstructSignatureDeclaration).type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.Constructor:
      return node instanceof ConstructorDeclaration
        ? (hasModifiers((node as ConstructorDeclaration).modifiers) ? 1 : 0) |
            ((node as ConstructorDeclaration).typeParameters !== undefined ? 2 : 0) |
            ((node as ConstructorDeclaration).parameters !== undefined ? 4 : 0) |
            ((node as ConstructorDeclaration).type !== undefined ? 8 : 0) |
            ((node as ConstructorDeclaration).body !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.GetAccessor:
      return node instanceof GetAccessorDeclaration
        ? (hasModifiers((node as GetAccessorDeclaration).modifiers) ? 1 : 0) |
            ((node as GetAccessorDeclaration).name !== undefined ? 2 : 0) |
            ((node as GetAccessorDeclaration).typeParameters !== undefined ? 4 : 0) |
            ((node as GetAccessorDeclaration).parameters !== undefined ? 8 : 0) |
            ((node as GetAccessorDeclaration).type !== undefined ? 16 : 0) |
            ((node as GetAccessorDeclaration).body !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.SetAccessor:
      return node instanceof SetAccessorDeclaration
        ? (hasModifiers((node as SetAccessorDeclaration).modifiers) ? 1 : 0) |
            ((node as SetAccessorDeclaration).name !== undefined ? 2 : 0) |
            ((node as SetAccessorDeclaration).typeParameters !== undefined ? 4 : 0) |
            ((node as SetAccessorDeclaration).parameters !== undefined ? 8 : 0) |
            ((node as SetAccessorDeclaration).type !== undefined ? 16 : 0) |
            ((node as SetAccessorDeclaration).body !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.IndexSignature:
      return node instanceof IndexSignatureDeclaration
        ? (hasModifiers((node as IndexSignatureDeclaration).modifiers) ? 1 : 0) |
            ((node as IndexSignatureDeclaration).parameters !== undefined ? 2 : 0) |
            ((node as IndexSignatureDeclaration).type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.MethodSignature:
      return node instanceof MethodSignatureDeclaration
        ? (hasModifiers((node as MethodSignatureDeclaration).modifiers) ? 1 : 0) |
            ((node as MethodSignatureDeclaration).name !== undefined ? 2 : 0) |
            ((node as MethodSignatureDeclaration).postfixToken !== undefined ? 4 : 0) |
            ((node as MethodSignatureDeclaration).typeParameters !== undefined ? 8 : 0) |
            ((node as MethodSignatureDeclaration).parameters !== undefined ? 16 : 0) |
            ((node as MethodSignatureDeclaration).type !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.MethodDeclaration:
      return node instanceof MethodDeclaration
        ? (hasModifiers((node as MethodDeclaration).modifiers) ? 1 : 0) |
            ((node as MethodDeclaration).asteriskToken !== undefined ? 2 : 0) |
            ((node as MethodDeclaration).name !== undefined ? 4 : 0) |
            ((node as MethodDeclaration).postfixToken !== undefined ? 8 : 0) |
            ((node as MethodDeclaration).typeParameters !== undefined ? 16 : 0) |
            ((node as MethodDeclaration).parameters !== undefined ? 32 : 0) |
            ((node as MethodDeclaration).type !== undefined ? 64 : 0) |
            ((node as MethodDeclaration).body !== undefined ? 128 : 0)
        : 0;
    case SyntaxKind.PropertySignature:
      return node instanceof PropertySignatureDeclaration
        ? (hasModifiers((node as PropertySignatureDeclaration).modifiers) ? 1 : 0) |
            ((node as PropertySignatureDeclaration).name !== undefined ? 2 : 0) |
            ((node as PropertySignatureDeclaration).postfixToken !== undefined ? 4 : 0) |
            ((node as PropertySignatureDeclaration).type !== undefined ? 8 : 0) |
            ((node as PropertySignatureDeclaration).initializer !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.PropertyDeclaration:
      return node instanceof PropertyDeclaration
        ? (hasModifiers((node as PropertyDeclaration).modifiers) ? 1 : 0) |
            ((node as PropertyDeclaration).name !== undefined ? 2 : 0) |
            ((node as PropertyDeclaration).postfixToken !== undefined ? 4 : 0) |
            ((node as PropertyDeclaration).type !== undefined ? 8 : 0) |
            ((node as PropertyDeclaration).initializer !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.ClassStaticBlockDeclaration:
      return node instanceof ClassStaticBlockDeclaration
        ? (hasModifiers((node as ClassStaticBlockDeclaration).modifiers) ? 1 : 0) |
            ((node as ClassStaticBlockDeclaration).body !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.BinaryExpression:
      return node instanceof BinaryExpression
        ? (hasModifiers((node as BinaryExpression).modifiers) ? 1 : 0) |
            ((node as BinaryExpression).left !== undefined ? 2 : 0) |
            ((node as BinaryExpression).type !== undefined ? 4 : 0) |
            ((node as BinaryExpression).operatorToken !== undefined ? 8 : 0) |
            ((node as BinaryExpression).right !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.PrefixUnaryExpression:
      return node instanceof PrefixUnaryExpression
        ? (node as PrefixUnaryExpression).operand !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.PostfixUnaryExpression:
      return node instanceof PostfixUnaryExpression
        ? (node as PostfixUnaryExpression).operand !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.YieldExpression:
      return node instanceof YieldExpression
        ? ((node as YieldExpression).asteriskToken !== undefined ? 1 : 0) |
            ((node as YieldExpression).expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ArrowFunction:
      return node instanceof ArrowFunction
        ? (hasModifiers((node as ArrowFunction).modifiers) ? 1 : 0) |
            ((node as ArrowFunction).typeParameters !== undefined ? 2 : 0) |
            ((node as ArrowFunction).parameters !== undefined ? 4 : 0) |
            ((node as ArrowFunction).type !== undefined ? 8 : 0) |
            ((node as ArrowFunction).equalsGreaterThanToken !== undefined ? 16 : 0) |
            ((node as ArrowFunction).body !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.FunctionExpression:
      return node instanceof FunctionExpression
        ? (hasModifiers((node as FunctionExpression).modifiers) ? 1 : 0) |
            ((node as FunctionExpression).asteriskToken !== undefined ? 2 : 0) |
            ((node as FunctionExpression).name !== undefined ? 4 : 0) |
            ((node as FunctionExpression).typeParameters !== undefined ? 8 : 0) |
            ((node as FunctionExpression).parameters !== undefined ? 16 : 0) |
            ((node as FunctionExpression).type !== undefined ? 32 : 0) |
            ((node as FunctionExpression).body !== undefined ? 64 : 0)
        : 0;
    case SyntaxKind.AsExpression:
      return node instanceof AsExpression
        ? ((node as AsExpression).expression !== undefined ? 1 : 0) |
            ((node as AsExpression).type !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.SatisfiesExpression:
      return node instanceof SatisfiesExpression
        ? ((node as SatisfiesExpression).expression !== undefined ? 1 : 0) |
            ((node as SatisfiesExpression).type !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ConditionalExpression:
      return node instanceof ConditionalExpression
        ? ((node as ConditionalExpression).condition !== undefined ? 1 : 0) |
            ((node as ConditionalExpression).questionToken !== undefined ? 2 : 0) |
            ((node as ConditionalExpression).whenTrue !== undefined ? 4 : 0) |
            ((node as ConditionalExpression).colonToken !== undefined ? 8 : 0) |
            ((node as ConditionalExpression).whenFalse !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.PropertyAccessExpression:
      return node instanceof PropertyAccessExpression
        ? ((node as PropertyAccessExpression).expression !== undefined ? 1 : 0) |
            ((node as PropertyAccessExpression).questionDotToken !== undefined ? 2 : 0) |
            ((node as PropertyAccessExpression).name !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ElementAccessExpression:
      return node instanceof ElementAccessExpression
        ? ((node as ElementAccessExpression).expression !== undefined ? 1 : 0) |
            ((node as ElementAccessExpression).questionDotToken !== undefined ? 2 : 0) |
            ((node as ElementAccessExpression).argumentExpression !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.CallExpression:
      return node instanceof CallExpression
        ? ((node as CallExpression).expression !== undefined ? 1 : 0) |
            (callQuestionDotToken(node as CallExpression) !== undefined ? 2 : 0) |
            (callTypeArguments(node as CallExpression) !== undefined ? 4 : 0) |
            ((node as CallExpression).arguments !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.NewExpression:
      return node instanceof NewExpression
        ? ((node as NewExpression).expression !== undefined ? 1 : 0) |
            ((node as NewExpression).typeArguments !== undefined ? 2 : 0) |
            ((node as NewExpression).arguments !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.MetaProperty:
      return node instanceof MetaProperty ? ((node as MetaProperty).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NonNullExpression:
      return node instanceof NonNullExpression ? ((node as NonNullExpression).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.SpreadElement:
      return node instanceof SpreadElement ? ((node as SpreadElement).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TemplateExpression:
      return node instanceof TemplateExpression
        ? ((node as TemplateExpression).head !== undefined ? 1 : 0) |
            ((node as TemplateExpression).templateSpans !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TemplateSpan:
      return node instanceof TemplateSpan
        ? ((node as TemplateSpan).expression !== undefined ? 1 : 0) |
            ((node as TemplateSpan).literal !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TaggedTemplateExpression:
      return node instanceof TaggedTemplateExpression
        ? ((node as TaggedTemplateExpression).tag !== undefined ? 1 : 0) |
            ((node as TaggedTemplateExpression).questionDotToken !== undefined ? 2 : 0) |
            ((node as TaggedTemplateExpression).typeArguments !== undefined ? 4 : 0) |
            ((node as TaggedTemplateExpression).template !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ParenthesizedExpression:
      return node instanceof ParenthesizedExpression
        ? (node as ParenthesizedExpression).expression !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.ArrayLiteralExpression:
      return node instanceof ArrayLiteralExpression
        ? (node as ArrayLiteralExpression).elements !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.ObjectLiteralExpression:
      return node instanceof ObjectLiteralExpression
        ? (node as ObjectLiteralExpression).properties !== undefined
          ? 1
          : 0
        : 0;
    case SyntaxKind.SpreadAssignment:
      return node instanceof SpreadAssignment ? ((node as SpreadAssignment).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.PropertyAssignment:
      return node instanceof PropertyAssignment
        ? (hasModifiers(propertyAssignmentModifiers(node as PropertyAssignment)) ? 1 : 0) |
            ((node as PropertyAssignment).name !== undefined ? 2 : 0) |
            (propertyAssignmentPostfixToken(node as PropertyAssignment) !== undefined ? 4 : 0) |
            (propertyAssignmentType(node as PropertyAssignment) !== undefined ? 8 : 0) |
            ((node as PropertyAssignment).initializer !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.ShorthandPropertyAssignment:
      return node instanceof ShorthandPropertyAssignment
        ? (hasModifiers((node as ShorthandPropertyAssignment).modifiers) ? 1 : 0) |
            ((node as ShorthandPropertyAssignment).name !== undefined ? 2 : 0) |
            ((node as ShorthandPropertyAssignment).postfixToken !== undefined ? 4 : 0) |
            ((node as ShorthandPropertyAssignment).type !== undefined ? 8 : 0) |
            ((node as ShorthandPropertyAssignment).equalsToken !== undefined ? 16 : 0) |
            ((node as ShorthandPropertyAssignment).objectAssignmentInitializer !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.DeleteExpression:
      return node instanceof DeleteExpression ? ((node as DeleteExpression).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeOfExpression:
      return node instanceof TypeOfExpression ? ((node as TypeOfExpression).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.VoidExpression:
      return node instanceof VoidExpression ? ((node as VoidExpression).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.AwaitExpression:
      return node instanceof AwaitExpression ? ((node as AwaitExpression).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeAssertionExpression:
      return node instanceof TypeAssertion
        ? ((node as TypeAssertion).type !== undefined ? 1 : 0) |
            ((node as TypeAssertion).expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.UnionType:
      return node instanceof UnionTypeNode ? ((node as UnionTypeNode).types !== undefined ? 1 : 0) : 0;
    case SyntaxKind.IntersectionType:
      return node instanceof IntersectionTypeNode ? ((node as IntersectionTypeNode).types !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ConditionalType:
      return node instanceof ConditionalTypeNode
        ? ((node as ConditionalTypeNode).checkType !== undefined ? 1 : 0) |
            ((node as ConditionalTypeNode).extendsType !== undefined ? 2 : 0) |
            ((node as ConditionalTypeNode).trueType !== undefined ? 4 : 0) |
            ((node as ConditionalTypeNode).falseType !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.TypeOperator:
      return node instanceof TypeOperatorNode ? ((node as TypeOperatorNode).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.InferType:
      return node instanceof InferTypeNode ? ((node as InferTypeNode).typeParameter !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ArrayType:
      return node instanceof ArrayTypeNode ? ((node as ArrayTypeNode).elementType !== undefined ? 1 : 0) : 0;
    case SyntaxKind.IndexedAccessType:
      return node instanceof IndexedAccessTypeNode
        ? ((node as IndexedAccessTypeNode).objectType !== undefined ? 1 : 0) |
            ((node as IndexedAccessTypeNode).indexType !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TypeReference:
      return node instanceof TypeReferenceNode
        ? ((node as TypeReferenceNode).typeName !== undefined ? 1 : 0) |
            ((node as TypeReferenceNode).typeArguments !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ExpressionWithTypeArguments:
      return node instanceof ExpressionWithTypeArguments
        ? ((node as ExpressionWithTypeArguments).expression !== undefined ? 1 : 0) |
            ((node as ExpressionWithTypeArguments).typeArguments !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.LiteralType:
      return node instanceof LiteralTypeNode ? ((node as LiteralTypeNode).literal !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypePredicate:
      return node instanceof TypePredicateNode
        ? ((node as TypePredicateNode).assertsModifier !== undefined ? 1 : 0) |
            ((node as TypePredicateNode).parameterName !== undefined ? 2 : 0) |
            ((node as TypePredicateNode).type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ImportAttribute:
      return node instanceof ImportAttribute
        ? ((node as ImportAttribute).name !== undefined ? 1 : 0) |
            ((node as ImportAttribute).value !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ImportAttributes:
      return node instanceof ImportAttributes ? ((node as ImportAttributes).attributes !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeQuery:
      return node instanceof TypeQueryNode
        ? ((node as TypeQueryNode).exprName !== undefined ? 1 : 0) |
            ((node as TypeQueryNode).typeArguments !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.MappedType:
      return node instanceof MappedTypeNode
        ? ((node as MappedTypeNode).readonlyToken !== undefined ? 1 : 0) |
            ((node as MappedTypeNode).typeParameter !== undefined ? 2 : 0) |
            ((node as MappedTypeNode).nameType !== undefined ? 4 : 0) |
            ((node as MappedTypeNode).questionToken !== undefined ? 8 : 0) |
            ((node as MappedTypeNode).type !== undefined ? 16 : 0) |
            ((node as MappedTypeNode).members !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.TypeLiteral:
      return node instanceof TypeLiteralNode ? ((node as TypeLiteralNode).members !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TupleType:
      return node instanceof TupleTypeNode ? ((node as TupleTypeNode).elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamedTupleMember:
      return node instanceof NamedTupleMember
        ? ((node as NamedTupleMember).dotDotDotToken !== undefined ? 1 : 0) |
            ((node as NamedTupleMember).name !== undefined ? 2 : 0) |
            ((node as NamedTupleMember).questionToken !== undefined ? 4 : 0) |
            ((node as NamedTupleMember).type !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.OptionalType:
      return node instanceof OptionalTypeNode ? ((node as OptionalTypeNode).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.RestType:
      return node instanceof RestTypeNode ? ((node as RestTypeNode).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ParenthesizedType:
      return node instanceof ParenthesizedTypeNode ? ((node as ParenthesizedTypeNode).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.FunctionType:
      return node instanceof FunctionTypeNode
        ? ((node as FunctionTypeNode).typeParameters !== undefined ? 1 : 0) |
            ((node as FunctionTypeNode).parameters !== undefined ? 2 : 0) |
            ((node as FunctionTypeNode).type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ConstructorType:
      return node instanceof ConstructorTypeNode
        ? (hasModifiers((node as ConstructorTypeNode).modifiers) ? 1 : 0) |
            ((node as ConstructorTypeNode).typeParameters !== undefined ? 2 : 0) |
            ((node as ConstructorTypeNode).parameters !== undefined ? 4 : 0) |
            ((node as ConstructorTypeNode).type !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.TemplateLiteralType:
      return node instanceof TemplateLiteralTypeNode
        ? ((node as TemplateLiteralTypeNode).head !== undefined ? 1 : 0) |
            ((node as TemplateLiteralTypeNode).templateSpans !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TemplateLiteralTypeSpan:
      return node instanceof TemplateLiteralTypeSpan
        ? ((node as TemplateLiteralTypeSpan).type !== undefined ? 1 : 0) |
            ((node as TemplateLiteralTypeSpan).literal !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JsxElement:
      return node instanceof JsxElement
        ? ((node as JsxElement).openingElement !== undefined ? 1 : 0) |
            ((node as JsxElement).children !== undefined ? 2 : 0) |
            ((node as JsxElement).closingElement !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxAttributes:
      return node instanceof JsxAttributes ? ((node as JsxAttributes).properties !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JsxNamespacedName:
      return node instanceof JsxNamespacedName
        ? ((node as JsxNamespacedName).namespace !== undefined ? 1 : 0) |
            ((node as JsxNamespacedName).name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JsxOpeningElement:
      return node instanceof JsxOpeningElement
        ? ((node as JsxOpeningElement).tagName !== undefined ? 1 : 0) |
            ((node as JsxOpeningElement).typeArguments !== undefined ? 2 : 0) |
            ((node as JsxOpeningElement).attributes !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxSelfClosingElement:
      return node instanceof JsxSelfClosingElement
        ? ((node as JsxSelfClosingElement).tagName !== undefined ? 1 : 0) |
            ((node as JsxSelfClosingElement).typeArguments !== undefined ? 2 : 0) |
            ((node as JsxSelfClosingElement).attributes !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxFragment:
      return node instanceof JsxFragment
        ? ((node as JsxFragment).openingFragment !== undefined ? 1 : 0) |
            ((node as JsxFragment).children !== undefined ? 2 : 0) |
            ((node as JsxFragment).closingFragment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxAttribute:
      return node instanceof JsxAttribute
        ? ((node as JsxAttribute).name !== undefined ? 1 : 0) |
            ((node as JsxAttribute).initializer !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JsxSpreadAttribute:
      return node instanceof JsxSpreadAttribute ? ((node as JsxSpreadAttribute).expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JsxClosingElement:
      return node instanceof JsxClosingElement ? ((node as JsxClosingElement).tagName !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JsxExpression:
      return node instanceof JsxExpression
        ? ((node as JsxExpression).dotDotDotToken !== undefined ? 1 : 0) |
            ((node as JsxExpression).expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDoc:
      return node instanceof JSDoc
        ? ((node as JSDoc).comment !== undefined ? 1 : 0) | ((node as JSDoc).tags !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocTypeExpression:
      return node instanceof JSDocTypeExpression ? ((node as JSDocTypeExpression).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocNonNullableType:
      return node instanceof JSDocNonNullableType ? ((node as JSDocNonNullableType).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocNullableType:
      return node instanceof JSDocNullableType ? ((node as JSDocNullableType).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocVariadicType:
      return node instanceof JSDocVariadicType ? ((node as JSDocVariadicType).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocOptionalType:
      return node instanceof JSDocOptionalType ? ((node as JSDocOptionalType).type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocTypeTag:
      return node instanceof JSDocTypeTag
        ? ((node as JSDocTypeTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocTypeTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocTypeTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocUnknownTag:
      return node instanceof JSDocUnknownTag
        ? ((node as JSDocUnknownTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocUnknownTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocTemplateTag:
      return node instanceof JSDocTemplateTag
        ? ((node as JSDocTemplateTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocTemplateTag).constraint !== undefined ? 2 : 0) |
            ((node as JSDocTemplateTag).typeParameters !== undefined ? 4 : 0) |
            ((node as JSDocTemplateTag).comment !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.JSDocReturnTag:
      return node instanceof JSDocReturnTag
        ? ((node as JSDocReturnTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocReturnTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocReturnTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocPublicTag:
      return node instanceof JSDocPublicTag
        ? ((node as JSDocPublicTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocPublicTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocPrivateTag:
      return node instanceof JSDocPrivateTag
        ? ((node as JSDocPrivateTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocPrivateTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocProtectedTag:
      return node instanceof JSDocProtectedTag
        ? ((node as JSDocProtectedTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocProtectedTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocReadonlyTag:
      return node instanceof JSDocReadonlyTag
        ? ((node as JSDocReadonlyTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocReadonlyTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocOverrideTag:
      return node instanceof JSDocOverrideTag
        ? ((node as JSDocOverrideTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocOverrideTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocDeprecatedTag:
      return node instanceof JSDocDeprecatedTag
        ? ((node as JSDocDeprecatedTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocDeprecatedTag).comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocSeeTag:
      return node instanceof JSDocSeeTag
        ? ((node as JSDocSeeTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocSeeTag).nameExpression !== undefined ? 2 : 0) |
            ((node as JSDocSeeTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocImplementsTag:
      return node instanceof JSDocImplementsTag
        ? ((node as JSDocImplementsTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocImplementsTag).className !== undefined ? 2 : 0) |
            ((node as JSDocImplementsTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocAugmentsTag:
      return node instanceof JSDocAugmentsTag
        ? ((node as JSDocAugmentsTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocAugmentsTag).className !== undefined ? 2 : 0) |
            ((node as JSDocAugmentsTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocSatisfiesTag:
      return node instanceof JSDocSatisfiesTag
        ? ((node as JSDocSatisfiesTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocSatisfiesTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocSatisfiesTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocThrowsTag:
      return node instanceof JSDocThrowsTag
        ? ((node as JSDocThrowsTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocThrowsTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocThrowsTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocThisTag:
      return node instanceof JSDocThisTag
        ? ((node as JSDocThisTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocThisTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocThisTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocImportTag:
      return node instanceof JSDocImportTag
        ? ((node as JSDocImportTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocImportTag).importClause !== undefined ? 2 : 0) |
            ((node as JSDocImportTag).moduleSpecifier !== undefined ? 4 : 0) |
            ((node as JSDocImportTag).attributes !== undefined ? 8 : 0) |
            ((node as JSDocImportTag).comment !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.JSDocCallbackTag:
      return node instanceof JSDocCallbackTag
        ? ((node as JSDocCallbackTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocCallbackTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocCallbackTag).name !== undefined ? 4 : 0) |
            ((node as JSDocCallbackTag).comment !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.JSDocOverloadTag:
      return node instanceof JSDocOverloadTag
        ? ((node as JSDocOverloadTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocOverloadTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocOverloadTag).comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocTypedefTag:
      return node instanceof JSDocTypedefTag
        ? ((node as JSDocTypedefTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocTypedefTag).typeExpression !== undefined ? 2 : 0) |
            ((node as JSDocTypedefTag).name !== undefined ? 4 : 0) |
            ((node as JSDocTypedefTag).comment !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.JSDocSignature:
      return node instanceof JSDocSignature
        ? ((node as JSDocSignature).typeParameters !== undefined ? 1 : 0) |
            ((node as JSDocSignature).parameters !== undefined ? 2 : 0) |
            ((node as JSDocSignature).type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocNameReference:
      return node instanceof JSDocNameReference ? ((node as JSDocNameReference).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ModuleDeclaration:
      return node instanceof ModuleDeclaration
        ? (hasModifiers((node as ModuleDeclaration).modifiers) ? 1 : 0) |
            ((node as ModuleDeclaration).name !== undefined ? 2 : 0) |
            ((node as ModuleDeclaration).attributes !== undefined ? 4 : 0) |
            ((node as ModuleDeclaration).body !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ImportEqualsDeclaration:
      return node instanceof ImportEqualsDeclaration
        ? (hasModifiers((node as ImportEqualsDeclaration).modifiers) ? 1 : 0) |
            ((node as ImportEqualsDeclaration).name !== undefined ? 2 : 0) |
            ((node as ImportEqualsDeclaration).moduleReference !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ExportDeclaration:
      return node instanceof ExportDeclaration
        ? (hasModifiers((node as ExportDeclaration).modifiers) ? 1 : 0) |
            ((node as ExportDeclaration).exportClause !== undefined ? 2 : 0) |
            ((node as ExportDeclaration).moduleSpecifier !== undefined ? 4 : 0) |
            ((node as ExportDeclaration).attributes !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ImportType:
      return node instanceof ImportTypeNode
        ? ((node as ImportTypeNode).argument !== undefined ? 1 : 0) |
            ((node as ImportTypeNode).attributes !== undefined ? 2 : 0) |
            ((node as ImportTypeNode).qualifier !== undefined ? 4 : 0) |
            ((node as ImportTypeNode).typeArguments !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ImportClause:
      return node instanceof ImportClause
        ? ((node as ImportClause).name !== undefined ? 1 : 0) |
            ((node as ImportClause).namedBindings !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ImportSpecifier:
      return node instanceof ImportSpecifier
        ? ((node as ImportSpecifier).propertyName !== undefined ? 1 : 0) |
            ((node as ImportSpecifier).name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocLink:
      return node instanceof JSDocLink ? ((node as JSDocLink).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocLinkPlain:
      return node instanceof JSDocLinkPlain ? ((node as JSDocLinkPlain).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocLinkCode:
      return node instanceof JSDocLinkCode ? ((node as JSDocLinkCode).name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeParameter:
      return node instanceof TypeParameterDeclaration
        ? (hasModifiers((node as TypeParameterDeclaration).modifiers) ? 1 : 0) |
            ((node as TypeParameterDeclaration).name !== undefined ? 2 : 0) |
            ((node as TypeParameterDeclaration).constraint !== undefined ? 4 : 0) |
            ((node as TypeParameterDeclaration).expression !== undefined ? 8 : 0) |
            ((node as TypeParameterDeclaration).defaultType !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.JSDocTypeLiteral:
      return node instanceof JSDocTypeLiteral ? (hasElements((node as JSDocTypeLiteral).jsdocPropertyTags) ? 1 : 0) : 0;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      return node instanceof JSDocParameterOrPropertyTag
        ? ((node as JSDocParameterOrPropertyTag).tagName !== undefined ? 1 : 0) |
            ((node as JSDocParameterOrPropertyTag).name !== undefined ? 2 : 0) |
            ((node as JSDocParameterOrPropertyTag).typeExpression !== undefined ? 4 : 0) |
            ((node as JSDocParameterOrPropertyTag).comment !== undefined ? 8 : 0)
        : 0;
    default:
      return 0;
  }
}

function bit(value: boolean): number {
  return value ? 1 : 0;
}

/** Small per-kind values in bits 24-29 of the data word. */
function commonData(node: Node): number {
  switch (node.kind) {
    case SyntaxKind.Block:
      return node instanceof Block ? bit((node as Block).multiLine) << 24 : 0;
    case SyntaxKind.HeritageClause:
      return node instanceof HeritageClause
        ? bit((node as HeritageClause).token === SyntaxKind.ImplementsKeyword) << 24
        : 0;
    case SyntaxKind.ExportAssignment:
      return node instanceof ExportAssignment ? bit((node as ExportAssignment).isExportEquals) << 24 : 0;
    case SyntaxKind.ExportSpecifier:
      return node instanceof ExportSpecifier ? bit((node as ExportSpecifier).isTypeOnly) << 24 : 0;
    case SyntaxKind.PrefixUnaryExpression:
      return node instanceof PrefixUnaryExpression
        ? prefixOperatorIndex((node as PrefixUnaryExpression).operator) << 24
        : 0;
    case SyntaxKind.PostfixUnaryExpression:
      return node instanceof PostfixUnaryExpression
        ? bit((node as PostfixUnaryExpression).operator === SyntaxKind.MinusMinusToken) << 24
        : 0;
    case SyntaxKind.MetaProperty:
      return node instanceof MetaProperty
        ? bit((node as MetaProperty).keywordToken === SyntaxKind.NewKeyword) << 24
        : 0;
    case SyntaxKind.ArrayLiteralExpression:
      return node instanceof ArrayLiteralExpression ? bit((node as ArrayLiteralExpression).multiLine) << 24 : 0;
    case SyntaxKind.ObjectLiteralExpression:
      return node instanceof ObjectLiteralExpression ? bit((node as ObjectLiteralExpression).multiLine) << 24 : 0;
    case SyntaxKind.TypeOperator:
      if (!(node instanceof TypeOperatorNode)) return 0;
      if ((node as TypeOperatorNode).operator === SyntaxKind.ReadonlyKeyword) return 1 << 24;
      if ((node as TypeOperatorNode).operator === SyntaxKind.UniqueKeyword) return 2 << 24;
      return 0;
    case SyntaxKind.ImportAttributes:
      return node instanceof ImportAttributes
        ? (bit((node as ImportAttributes).multiLine) << 24) |
            (bit((node as ImportAttributes).token === SyntaxKind.AssertKeyword) << 25)
        : 0;
    case SyntaxKind.JsxText:
      return node instanceof JsxText ? bit((node as JsxText).containsOnlyTriviaWhiteSpaces) << 24 : 0;
    case SyntaxKind.ModuleDeclaration:
      return node instanceof ModuleDeclaration
        ? bit((node as ModuleDeclaration).keyword === SyntaxKind.NamespaceKeyword) << 24
        : 0;
    case SyntaxKind.ImportEqualsDeclaration:
      return node instanceof ImportEqualsDeclaration ? bit((node as ImportEqualsDeclaration).isTypeOnly) << 24 : 0;
    case SyntaxKind.ExportDeclaration:
      return node instanceof ExportDeclaration ? bit((node as ExportDeclaration).isTypeOnly) << 24 : 0;
    case SyntaxKind.ImportType:
      return node instanceof ImportTypeNode ? bit((node as ImportTypeNode).isTypeOf) << 24 : 0;
    case SyntaxKind.ImportClause:
      if (!(node instanceof ImportClause)) return 0;
      if ((node as ImportClause).phaseModifier === SyntaxKind.TypeKeyword) return 1 << 24;
      if ((node as ImportClause).phaseModifier === SyntaxKind.DeferKeyword) return 2 << 24;
      if ((node as ImportClause).phaseModifier === SyntaxKind.SourceKeyword) return 3 << 24;
      return 0;
    case SyntaxKind.ImportSpecifier:
      return node instanceof ImportSpecifier ? bit((node as ImportSpecifier).isTypeOnly) << 24 : 0;
    case SyntaxKind.JSDocTypeLiteral:
      return node instanceof JSDocTypeLiteral ? bit((node as JSDocTypeLiteral).isArrayType) << 24 : 0;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      return node instanceof JSDocParameterOrPropertyTag
        ? (bit((node as JSDocParameterOrPropertyTag).isBracketed) << 24) |
            (bit((node as JSDocParameterOrPropertyTag).isNameFirst) << 25)
        : 0;
  }
  return 0;
}

function prefixOperatorIndex(operator: SyntaxKind): number {
  switch (operator) {
    case SyntaxKind.MinusToken:
      return 1;
    case SyntaxKind.TildeToken:
      return 2;
    case SyntaxKind.ExclamationToken:
      return 3;
    case SyntaxKind.PlusPlusToken:
      return 4;
    case SyntaxKind.MinusMinusToken:
      return 5;
  }
  return 0;
}

function dataType(kind: SyntaxKind): number {
  switch (kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.JsxText:
    case SyntaxKind.JSDocText:
    case SyntaxKind.JSDocLink:
    case SyntaxKind.JSDocLinkPlain:
    case SyntaxKind.JSDocLinkCode:
      return dataTypeString;
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateHead:
    case SyntaxKind.TemplateMiddle:
    case SyntaxKind.TemplateTail:
    case SyntaxKind.SourceFile:
      return dataTypeExtended;
  }
  return dataTypeChildren;
}

/** The text of a node encoded as a string. */
function nodeText(node: Node): string {
  if (node instanceof Identifier) return (node as Identifier).text;
  if (node instanceof PrivateIdentifier) return (node as PrivateIdentifier).text;
  if (node instanceof JsxText) return (node as JsxText).text;
  if (node instanceof JSDocText) return (node as JSDocText).text;
  if (node instanceof JSDocLink) return (node as JSDocLink).text;
  if (node instanceof JSDocLinkPlain) return (node as JSDocLinkPlain).text;
  if (node instanceof JSDocLinkCode) return (node as JSDocLinkCode).text;
  return '';
}

function writeArrayHeader(out: ByteWriter, length: number): void {
  if (length <= 0x0f) out.u8(0x90 | length);
  else if (length <= 0xffff) {
    out.u8(0xdc);
    out.be(length, 2);
  } else {
    out.u8(0xdd);
    out.be(length, 4);
  }
}

function writeUint(out: ByteWriter, value: number): void {
  if (value <= 0x7f) out.u8(value);
  else if (value <= 0xff) {
    out.u8(0xcc);
    out.u8(value);
  } else if (value <= 0xffff) {
    out.u8(0xcd);
    out.be(value, 2);
  } else {
    out.u8(0xce);
    out.be(value, 4);
  }
}

function writeString(out: ByteWriter, text: string): void {
  const bytes = encodeUTF8(text);
  const n = bytes.length;
  if (n <= 0x1f) out.u8(0xa0 | n);
  else if (n <= 0xff) {
    out.u8(0xd9);
    out.u8(n);
  } else if (n <= 0xffff) {
    out.u8(0xda);
    out.be(n, 2);
  } else {
    out.u8(0xdb);
    out.be(n, 4);
  }
  out.append(bytes);
}

function writeFileReferences(out: ByteWriter, refs: readonly FileReference[]): number {
  if (refs.length === 0) return noStructuredData;
  const offset = out.length;
  writeArrayHeader(out, refs.length);
  for (const ref of refs) {
    writeArrayHeader(out, 5);
    writeUint(out, ref.pos);
    writeUint(out, ref.end);
    writeString(out, ref.fileName);
    writeUint(out, ref.resolutionMode);
    out.u8(ref.preserve ? 0xc3 : 0xc2);
  }
  return offset;
}

/** Walks the tree in the API's order and writes node records. */
class Encoder extends NodeVisitor {
  /** The file whose JSDoc comments are encoded, if any. */
  readonly file: SourceFile | undefined;
  readonly strings: StringTable;
  readonly nodes: NodeRecords;
  readonly extended: ByteWriter;
  readonly structured: ByteWriter;
  /** Node indices of imports, module augmentations and the external module indicator. */
  readonly tracked: Map<Node, number>;
  /** Whether a node of each kind is tracked (`track`), so that other nodes need no lookup. */
  private readonly trackedKinds = new Uint8Array(512);
  nodeCount: number;
  parentIndex: number;
  prevIndex: number;
  /** For a node outside a parsed file whose positions are in another file's text, that text's UTF-8 offsets. */
  positions: Utf8Positions | undefined = undefined;

  constructor(file: SourceFile | undefined, text: string, fileText: Uint8Array, nodeCount: number) {
    super();
    this.file = file;
    this.strings = new StringTable(text, fileText);
    this.nodes = new NodeRecords(nodeCount + 2);
    this.extended = new ByteWriter(256);
    this.structured = new ByteWriter(64);
    this.tracked = new Map<Node, number>();
    this.nodeCount = 0;
    this.parentIndex = 0;
    this.prevIndex = 0;
  }

  /** Records the index `node` gets (`tracked`). */
  track(node: Node): void {
    this.tracked.set(node, 0);
    this.trackedKinds[node.kind] = 1;
  }

  /** Points the previous sibling's `next` at the record about to be written. */
  private linkSibling(index: number): void {
    if (this.prevIndex !== 0) this.nodes.setNext(this.prevIndex, index);
  }

  visitNode(node: Node): boolean {
    const index = ++this.nodeCount;
    this.linkSibling(index);
    const positions = this.positions;
    if (positions === undefined)
      this.nodes.push(node.kind, node.pos, node.end, this.parentIndex, this.nodeData(node), node.flags);
    else
      this.nodes.push(
        node.kind,
        positions.of(node.pos),
        positions.of(node.end),
        this.parentIndex,
        this.nodeData(node),
        node.flags,
      );
    if (this.trackedKinds[node.kind] === 1 && this.tracked.has(node)) this.tracked.set(node, index);
    const saveParent = this.parentIndex;
    this.prevIndex = 0;
    this.parentIndex = index;
    this.visitChildren(node);
    this.prevIndex = index;
    this.parentIndex = saveParent;
    return false;
  }

  visitList(list: NodeList): boolean {
    const index = ++this.nodeCount;
    this.linkSibling(index);
    const positions = this.positions;
    if (positions === undefined)
      this.nodes.push(nodeListKind, list.pos, list.end, this.parentIndex, list.nodes.length, trailingComma(list));
    else
      this.nodes.push(
        nodeListKind,
        positions.of(list.pos),
        positions.of(list.end),
        this.parentIndex,
        list.nodes.length,
        trailingComma(list),
      );
    const saveParent = this.parentIndex;
    this.prevIndex = 0;
    this.parentIndex = index;
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) this.visitNode(nodes[i]!);
    this.prevIndex = index;
    this.parentIndex = saveParent;
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    if (list.nodes.length > 0) this.visitList(list);
    return false;
  }

  /** The children in the API's order, then the node's JSDoc comments. */
  visitChildren(node: Node): boolean {
    if (node instanceof JSDocParameterOrPropertyTag) {
      const tag = node as JSDocParameterOrPropertyTag;
      this.visitNode(tag.tagName);
      this.visitNode(tag.name);
      if (tag.typeExpression !== undefined) this.visitNode(tag.typeExpression);
      if (tag.comment !== undefined) this.visitList(tag.comment);
    } else node.forEachChild(this);
    const file = this.file;
    if (file !== undefined) {
      const jsDoc = getJSDoc(file, node);
      for (let i = 0; i < jsDoc.length; i++) this.visitNode(jsDoc[i]!);
    }
    return false;
  }

  /** Writes the nil record and the root, then the root's descendants. */
  encodeRoot(root: Node): void {
    const nodes = this.nodes;
    nodes.push(0, 0, 0, 0, 0, 0);
    this.nodeCount = 1;
    this.parentIndex = 1;
    const positions = this.positions;
    nodes.push(
      root.kind,
      positions === undefined ? root.pos : positions.of(root.pos),
      positions === undefined ? root.end : positions.of(root.end),
      0,
      this.nodeData(root),
      root.flags,
    );
    this.visitChildren(root);
  }

  /** The encoding: header, string table, extended and structured data, then node records. */
  finish(fileText: Uint8Array, hash: Uint8Array | undefined, parseOptions: number): Uint8Array {
    const strings = this.strings;
    const extended = this.extended;
    const structured = this.structured;
    const nodes = this.nodes;
    const offsetStringOffsets = headerSize;
    const offsetStringData = offsetStringOffsets + strings.offsets.length;
    const offsetExtended = offsetStringData + fileText.length + strings.others.length;
    const offsetStructured = offsetExtended + extended.length;
    const offsetNodes = offsetStructured + structured.length;

    const out = new ByteWriter(offsetNodes + nodes.length);
    out.u32((protocolVersion << 24) >>> 0);
    if (hash !== undefined) out.append(hash);
    else for (let i = 0; i < 4; i++) out.u32(0);
    out.u32(parseOptions);
    out.u32(offsetStringOffsets);
    out.u32(offsetStringData);
    out.u32(offsetExtended);
    out.u32(offsetStructured);
    out.u32(offsetNodes);
    // Source file ID and lease ID (u64 each) and binder data offset: 0, none.
    for (let i = 0; i < 5; i++) out.u32(0);
    out.append(strings.offsets.view());
    out.append(fileText);
    out.append(strings.others.view());
    out.append(extended.view());
    out.append(structured.view());
    out.append(nodes.view());
    return out.view();
  }

  nodeData(node: Node): number {
    const type = dataType(node.kind);
    const common = commonData(node);
    if (type === dataTypeChildren) return (type | common | childrenPropertyMask(node)) >>> 0;
    if (type === dataTypeString)
      return (type | common | this.strings.add(nodeText(node), node.kind, node.pos, node.end)) >>> 0;
    return (type | common | this.extendedData(node)) >>> 0;
  }

  /** Writes the node's extended data and returns its offset. */
  extendedData(node: Node): number {
    const out = this.extended;
    const offset = out.length;
    const strings = this.strings;
    if (node instanceof StringLiteral) {
      out.u32(
        strings.add(
          (node as StringLiteral).text,
          (node as StringLiteral).kind,
          (node as StringLiteral).pos,
          (node as StringLiteral).end,
        ),
      );
      out.u32((node as StringLiteral).tokenFlags);
    } else if (node instanceof NumericLiteral) {
      out.u32(
        strings.add(
          (node as NumericLiteral).text,
          (node as NumericLiteral).kind,
          (node as NumericLiteral).pos,
          (node as NumericLiteral).end,
        ),
      );
      out.u32((node as NumericLiteral).tokenFlags);
    } else if (node instanceof BigIntLiteral) {
      out.u32(
        strings.add(
          (node as BigIntLiteral).text,
          (node as BigIntLiteral).kind,
          (node as BigIntLiteral).pos,
          (node as BigIntLiteral).end,
        ),
      );
      out.u32((node as BigIntLiteral).tokenFlags);
    } else if (node instanceof RegularExpressionLiteral) {
      out.u32(
        strings.add(
          (node as RegularExpressionLiteral).text,
          (node as RegularExpressionLiteral).kind,
          (node as RegularExpressionLiteral).pos,
          (node as RegularExpressionLiteral).end,
        ),
      );
      out.u32((node as RegularExpressionLiteral).tokenFlags);
    } else if (node instanceof NoSubstitutionTemplateLiteral) {
      out.u32(
        strings.add(
          (node as NoSubstitutionTemplateLiteral).text,
          (node as NoSubstitutionTemplateLiteral).kind,
          (node as NoSubstitutionTemplateLiteral).pos,
          (node as NoSubstitutionTemplateLiteral).end,
        ),
      );
      out.u32((node as NoSubstitutionTemplateLiteral).templateFlags);
    } else if (node instanceof TemplateHead) {
      out.u32(
        strings.add(
          (node as TemplateHead).text,
          (node as TemplateHead).kind,
          (node as TemplateHead).pos,
          (node as TemplateHead).end,
        ),
      );
      out.u32(
        strings.add(
          (node as TemplateHead).rawText,
          (node as TemplateHead).kind,
          (node as TemplateHead).pos,
          (node as TemplateHead).end,
        ),
      );
      out.u32((node as TemplateHead).templateFlags);
    } else if (node instanceof TemplateMiddle) {
      out.u32(
        strings.add(
          (node as TemplateMiddle).text,
          (node as TemplateMiddle).kind,
          (node as TemplateMiddle).pos,
          (node as TemplateMiddle).end,
        ),
      );
      out.u32(
        strings.add(
          (node as TemplateMiddle).rawText,
          (node as TemplateMiddle).kind,
          (node as TemplateMiddle).pos,
          (node as TemplateMiddle).end,
        ),
      );
      out.u32((node as TemplateMiddle).templateFlags);
    } else if (node instanceof TemplateTail) {
      out.u32(
        strings.add(
          (node as TemplateTail).text,
          (node as TemplateTail).kind,
          (node as TemplateTail).pos,
          (node as TemplateTail).end,
        ),
      );
      out.u32(
        strings.add(
          (node as TemplateTail).rawText,
          (node as TemplateTail).kind,
          (node as TemplateTail).pos,
          (node as TemplateTail).end,
        ),
      );
      out.u32((node as TemplateTail).templateFlags);
    } else if (node instanceof SourceFile) {
      const text = strings.addFileText((node as SourceFile).pos, (node as SourceFile).end);
      out.u32(text);
      out.u32(strings.add((node as SourceFile).fileName, SyntaxKind.Unknown, 0, 0));
      out.u32(strings.add((node as SourceFile).path, SyntaxKind.Unknown, 0, 0));
      out.u32((node as SourceFile).languageVariant);
      out.u32((node as SourceFile).scriptKind);
      out.u32(writeFileReferences(this.structured, (node as SourceFile).referencedFiles));
      out.u32(writeFileReferences(this.structured, (node as SourceFile).typeReferenceDirectives));
      out.u32(writeFileReferences(this.structured, (node as SourceFile).libReferenceDirectives));
      // Imports, module augmentations, ambient module names and the external module
      // indicator are patched in after the walk.
      out.u32(noStructuredData);
      out.u32(noStructuredData);
      out.u32(noStructuredData);
      out.u32(0);
      // The original text is the text, and the content mapper fields (span map, supplemental
      // file names, canonical file name, mapper, virtual file name, diagnostic directives) are
      // empty: tsc-ts maps no file contents.
      out.u32(text);
      for (let i = 0; i < 6; i++) out.u32(noStructuredData);
    } else throw new Error(`no extended data for kind ${node.kind}`);
    return offset;
  }

  writeNodeIndices(nodes: readonly Node[]): number {
    if (nodes.length === 0) return noStructuredData;
    const out = this.structured;
    const offset = out.length;
    writeArrayHeader(out, nodes.length);
    for (const node of nodes) {
      const index = this.tracked.get(node);
      writeUint(out, index === undefined ? 0 : index);
    }
    return offset;
  }

  writeStrings(strings: readonly string[]): number {
    if (strings.length === 0) return noStructuredData;
    const out = this.structured;
    const offset = out.length;
    writeArrayHeader(out, strings.length);
    for (const text of strings) writeString(out, text);
    return offset;
  }
}

/** The UTF-8 offsets of a text's UTF-16 offsets, computed when first needed. */
class Utf8Positions {
  private offsets: Int32Array | undefined = undefined;
  private ascii = false;

  constructor(private readonly text: string) {}

  /** The UTF-8 offset of UTF-16 offset `pos`; a negative position is unchanged. */
  of(pos: number): number {
    if (pos < 0 || this.ascii) return pos;
    let offsets = this.offsets;
    if (offsets === undefined) {
      if (!/[\u0080-\uffff]/.test(this.text)) {
        this.ascii = true;
        return pos;
      }
      offsets = this.offsets = utf8Offsets(this.text);
    }
    return pos >= offsets.length ? pos : offsets[pos]!;
  }
}

/** The API's binary encoding of `file`. */
export function encodeSourceFile(file: SourceFile): Uint8Array {
  const fileText = utf8Encoder.encode(file.text);
  const encoder = new Encoder(file, file.text, fileText, file.nodeCount);
  const tracked = encoder.tracked;
  for (const node of file.imports) encoder.track(node);
  for (const node of file.moduleAugmentations) encoder.track(node);
  const indicator = file.externalModuleIndicator;
  if (indicator !== undefined && indicator !== file) encoder.track(indicator);

  // The root's extended data starts its section.
  encoder.encodeRoot(file);

  const extended = encoder.extended;
  extended.setU32(32, encoder.writeNodeIndices(file.imports));
  extended.setU32(36, encoder.writeNodeIndices(file.moduleAugmentations));
  extended.setU32(40, encoder.writeStrings(file.ambientModuleNames));
  let indicatorIndex = 0;
  if (indicator === file) indicatorIndex = 1;
  else if (indicator !== undefined) {
    const index = tracked.get(indicator);
    if (index !== undefined) indicatorIndex = index;
  }
  extended.setU32(44, indicatorIndex);

  const options = file.externalModuleIndicatorOptions;
  return encoder.finish(fileText, hash128(fileText), (options.jsx ? 1 : 0) | (options.force ? 2 : 0));
}

/**
 * The nodes of a source file by their index in its encoding, which node handles name. Node lists
 * take an index but have no entry.
 */
export class NodeIndexTable extends NodeVisitor {
  /** Index 0 is the nil node and index 1 the file. */
  readonly nodes: (Node | undefined)[];
  private readonly indices = new Map<Node, number>();

  constructor(readonly file: SourceFile) {
    super();
    this.nodes = [undefined];
    this.add(file);
    this.visitChildren(file);
  }

  /** The index of `node`, or 0 if it isn't in the file. */
  indexOf(node: Node): number {
    return this.indices.get(node) ?? 0;
  }

  private add(node: Node): void {
    this.indices.set(node, this.nodes.length);
    this.nodes.push(node);
  }

  visitNode(node: Node): boolean {
    this.add(node);
    this.visitChildren(node);
    return false;
  }

  visitList(list: NodeList): boolean {
    this.nodes.push(undefined);
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) this.visitNode(nodes[i]!);
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    if (list.nodes.length > 0) this.visitList(list);
    return false;
  }

  /** The same order as the encoder's. */
  private visitChildren(node: Node): void {
    if (node instanceof JSDocParameterOrPropertyTag) {
      const tag = node as JSDocParameterOrPropertyTag;
      this.visitNode(tag.tagName);
      this.visitNode(tag.name);
      if (tag.typeExpression !== undefined) this.visitNode(tag.typeExpression);
      if (tag.comment !== undefined) this.visitList(tag.comment);
    } else node.forEachChild(this);
    const jsDoc = getJSDoc(this.file, node);
    for (let i = 0; i < jsDoc.length; i++) this.visitNode(jsDoc[i]!);
  }
}

/**
 * The encoding of a node that isn't part of a parsed file, such as one the node builder created:
 * no hash, parse options or JSDoc, and every string appended to the string data. The positions its
 * nodes have are in `positionsFile`, if given; as in tsgo, they are encoded as UTF-8 offsets in its text.
 */
export function encodeNode(node: Node, positionsFile?: SourceFile): Uint8Array {
  const fileText = new Uint8Array(0);
  const encoder = new Encoder(undefined, '', fileText, 64);
  if (positionsFile !== undefined) encoder.positions = new Utf8Positions(positionsFile.text);
  encoder.encodeRoot(node);
  return encoder.finish(fileText, undefined, 0);
}
