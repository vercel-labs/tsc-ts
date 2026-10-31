// JSDoc comment parsing, a port of tsgo's parser/jsdoc.go.
//
// Comment indentation is measured in UTF-8 bytes, as in tsgo, so comment text matches it exactly.
import {
  ArrayTypeNode,
  ExpressionWithTypeArguments,
  Identifier,
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
  ModuleDeclaration,
  type Node,
  NodeFlags,
  NodeList,
  PropertyAccessExpression,
  QualifiedName,
  TypeParameterDeclaration,
  TypeReferenceNode,
  getTagName,
  getType,
  type EntityName,
  getText,
} from './ast.js';
import { isReservedWord, tokenIsIdentifierOrKeyword } from './ast-utilities.js';
import { CharacterCodes, isWhiteSpaceLike } from './character-codes.js';
import { Diagnostics } from './diagnostic-messages.js';
import { Diagnostic, type DiagnosticMessage } from './diagnostics.js';
import type { Parser } from './parser.js';
import { Reparser } from './reparser.js';
import { getLeadingCommentRanges, getTrailingCommentRanges } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import type { CommentRange } from './types.js';
import { IdentifierName } from './identifier-name.js';

const enum JSDocState {
  BeginningOfLine,
  SawAsterisk,
  SavingComments,
  SavingBackticks,
}

const enum PropertyLikeParse {
  Property = 1 << 0,
  Parameter = 1 << 1,
  CallbackParameter = 1 << 2,
}

/** Comment text collected while parsing, with the indentation it has reached. */
class CommentText {
  parts: string[] = [];
  indent: number;
  margin = -1;

  constructor(indent: number) {
    this.indent = indent;
  }

  push(text: string): number {
    if (this.margin === -1) this.margin = this.indent;
    this.parts.push(text);
    this.indent += utf8Length(text);
    return this.indent;
  }
}

/** The JSDoc comments that may document `node`. */
export function getJSDocCommentRanges(node: Node, text: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  switch (node.kind) {
    case SyntaxKind.Parameter:
    case SyntaxKind.TypeParameter:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.ExportSpecifier:
      addRanges(ranges, getTrailingCommentRanges(text, node.pos));
      addRanges(ranges, getLeadingCommentRanges(text, node.pos));
      break;
    default:
      addRanges(ranges, getLeadingCommentRanges(text, node.pos));
  }
  const result: CommentRange[] = [];
  for (const comment of ranges) {
    const start = comment.pos;
    if (
      comment.end > node.end ||
      comment.end - start < 4 ||
      text.charCodeAt(start + 1) !== CharacterCodes.asterisk ||
      text.charCodeAt(start + 2) !== CharacterCodes.asterisk ||
      text.charCodeAt(start + 3) === CharacterCodes.slash
    )
      continue;
    result.push(comment);
  }
  return result;
}

function addRanges(to: CommentRange[], ranges: CommentRange[] | undefined): void {
  if (ranges !== undefined) for (const range of ranges) to.push(range);
}

function isJSDocLikeText(text: string, start: number): boolean {
  return (
    text.length - start >= 4 &&
    text.charCodeAt(start + 1) === CharacterCodes.asterisk &&
    text.charCodeAt(start + 2) === CharacterCodes.asterisk &&
    text.charCodeAt(start + 3) !== CharacterCodes.slash
  );
}

export class JSDocParser {
  readonly p: Parser;
  private readonly reparser: Reparser;

  constructor(p: Parser) {
    this.p = p;
    this.reparser = new Reparser(p);
  }

  /** Parses the JSDoc comments before `node` and attaches them; returns whether there were any. */
  attachJSDoc(node: Node): boolean {
    const p = this.p;
    const ranges = getJSDocCommentRanges(node, p.sourceText);
    p.hasDeprecatedTag = false;
    const jsDoc: Node[] = [];
    let pos = node.pos;
    for (const comment of ranges) {
      const parsed = this.parseJSDocComment(node, comment.pos, comment.end, pos);
      if (parsed !== undefined) {
        parsed.parent = node;
        jsDoc.push(parsed);
        pos = parsed.end;
      }
    }
    if (jsDoc.length === 0) return false;
    node.flags |= NodeFlags.HasJSDoc;
    if (p.hasDeprecatedTag) {
      p.hasDeprecatedTag = false;
      node.flags |= NodeFlags.PossiblyContainsDeprecatedTag;
    }
    p.setJSDoc(node, jsDoc);
    if (p.isJavaScript()) this.reparser.reparseTags(node, jsDoc);
    return true;
  }

  /** Parses the JSDoc comments before `node` in a file whose JSDoc is parsed on first use. */
  parseJSDocForNode(node: Node): Node[] {
    const ranges = getJSDocCommentRanges(node, this.p.sourceText);
    const jsDoc: Node[] = [];
    let pos = node.pos;
    for (const comment of ranges) {
      const parsed = this.parseJSDocComment(node, comment.pos, comment.end, pos);
      if (parsed !== undefined) {
        parsed.parent = node;
        jsDoc.push(parsed);
        pos = parsed.end;
      }
    }
    return jsDoc;
  }

  parseJSDocTypeExpression(mayOmitBraces: boolean): JSDocTypeExpression {
    const p = this.p;
    const pos = p.nodePos();
    const hasBrace = mayOmitBraces
      ? p.parseOptional(SyntaxKind.OpenBraceToken)
      : p.parseExpected(SyntaxKind.OpenBraceToken);
    const saveContextFlags = p.contextFlags;
    p.setContextFlags(NodeFlags.JSDoc, true);
    const type = p.parseJSDocType();
    p.contextFlags = saveContextFlags;
    if (hasBrace) p.parseExpectedJSDoc(SyntaxKind.CloseBraceToken);
    const result = new JSDocTypeExpression(type);
    p.finishNode(result, pos);
    return result;
  }

  parseJSDocNameReference(): Node {
    const p = this.p;
    const pos = p.nodePos();
    const hasBrace = p.parseOptional(SyntaxKind.OpenBraceToken);
    const entityName = this.parseJSDocLinkName();
    if (hasBrace) p.parseExpectedJSDoc(SyntaxKind.CloseBraceToken);
    p.scanner.resetPos(p.scanner.getTokenFullStart());
    p.nextTokenJSDoc();
    return p.finishNode(new JSDocNameReference(entityName), pos);
  }

  /** Parses the comment `[start, end)`, saving and restoring the parser state. */
  parseJSDocComment(_parent: Node, start: number, end: number, fullStart: number): Node | undefined {
    const p = this.p;
    const text = p.sourceText;
    if (!isJSDocLikeText(text, start)) return undefined;
    const saveToken = p.currentToken;
    const saveContextFlags = p.contextFlags;
    const saveScannerState = p.scanner.mark();
    const saveDiagnosticsLength = p.diagnostics.length;
    const saveHasParseError = p.hasParseError;
    const saveHasAwaitIdentifier = p.statementHasAwaitIdentifier;
    // The indent of the first line is that of `/** `, measured from the line start.
    const lineStart = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
    const initialIndent = utf8Length(text.substring(lineStart, start)) + 4;
    // Scan the comment without its `*/`, starting after `/**`.
    p.scanner.loadUnits(start, end);
    p.scanner.setTextEnd(end - 2);
    p.scanner.resetPos(start + 3);
    p.setContextFlags(NodeFlags.JSDoc, true);
    const saveParsingContexts = p.enterJSDocCommentContext();

    const comment = this.parseJSDocCommentWorker(start, end, fullStart, initialIndent);
    // JSDoc diagnostics are reported separately, and only for JavaScript files.
    const diagnostics = p.diagnostics;
    if ((p.contextFlags & NodeFlags.JavaScriptFile) !== 0)
      for (let i = saveDiagnosticsLength; i < diagnostics.length; i++) p.jsDocDiagnostics.push(diagnostics[i]!);
    diagnostics.length = saveDiagnosticsLength;

    p.scanner.setTextEnd(text.length);
    p.parsingContexts = saveParsingContexts;
    p.contextFlags = saveContextFlags;
    p.scanner.rewind(saveScannerState);
    p.currentToken = saveToken;
    p.hasParseError = saveHasParseError;
    p.statementHasAwaitIdentifier = saveHasAwaitIdentifier;
    return comment;
  }

  /** `indent` is the margin: the number of columns before the comment text on lines after the first. */
  parseJSDocCommentWorker(start: number, end: number, fullStart: number, indent: number): Node {
    const p = this.p;
    // A tag can follow the initial asterisk, so `/** * @type */` doesn't parse a tag.
    const tags: Node[] = [];
    let tagsPos = -1;
    let tagsEnd = -1;
    let state = JSDocState.SawAsterisk;
    let backtickCount = 0;
    let inFencedCodeBlock = false;
    const commentParts: Node[] = [];
    let comments = new CommentText(indent);
    let commentsPos = -1;
    let linkEnd = start;

    p.nextTokenJSDoc();
    while (this.parseOptionalJsdoc(SyntaxKind.WhitespaceTrivia)) {
      // Skip leading whitespace.
    }
    if (this.parseOptionalJsdoc(SyntaxKind.NewLineTrivia)) {
      state = JSDocState.BeginningOfLine;
      comments.indent = 0;
    }
    loop: for (;;) {
      // Three or more consecutive backticks toggle a fenced code block.
      if (p.token() !== SyntaxKind.BacktickToken && backtickCount > 0) {
        if (backtickCount >= 3) inFencedCodeBlock = !inFencedCodeBlock;
        backtickCount = 0;
      }
      switch (p.token()) {
        case SyntaxKind.AtToken: {
          if (inFencedCodeBlock || !p.scanner.canFollowJSDocAt()) {
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
            comments.push(p.scanner.getTokenText());
            break;
          }
          removeTrailingWhitespace(comments.parts);
          if (commentsPos === -1) commentsPos = p.nodePos();
          const tag = this.parseTag(tags, comments.indent);
          if (tagsPos === -1) tagsPos = tag.pos;
          tags.push(tag);
          tagsEnd = tag.end;
          // A tag goes to the end of its line, except the last one; malformed comments like
          // `/** @param {string} x @returns {number} the length */` break this.
          state = JSDocState.BeginningOfLine;
          comments.margin = -1;
          break;
        }
        case SyntaxKind.NewLineTrivia:
          comments.parts.push(p.scanner.getTokenText());
          state = JSDocState.BeginningOfLine;
          comments.indent = 0;
          break;
        case SyntaxKind.AsteriskToken: {
          const asterisk = p.scanner.getTokenText();
          if (state === JSDocState.SawAsterisk) {
            // After a second asterisk, no tag can start on this line.
            state = JSDocState.SavingComments;
            comments.push(asterisk);
          } else {
            // Ignore the first asterisk on a line.
            state = JSDocState.SawAsterisk;
            comments.indent += utf8Length(asterisk);
          }
          break;
        }
        case SyntaxKind.WhitespaceTrivia: {
          // Only keep whitespace past the margin.
          const whitespace = p.scanner.getTokenText();
          const length = utf8Length(whitespace);
          if (comments.margin > -1 && comments.indent + length > comments.margin) {
            let existingIndent = comments.margin - comments.indent;
            if (existingIndent < 0) existingIndent += length;
            if (existingIndent < 0) existingIndent = 0;
            comments.parts.push(sliceFromUtf8Offset(whitespace, existingIndent));
          }
          comments.indent += length;
          break;
        }
        case SyntaxKind.EndOfFile:
          break loop;
        case SyntaxKind.JSDocCommentTextToken:
          if (state !== JSDocState.SavingBackticks)
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenValue());
          break;
        case SyntaxKind.BacktickToken:
          backtickCount++;
          state = state === JSDocState.SavingBackticks ? JSDocState.SavingComments : JSDocState.SavingBackticks;
          comments.push(p.scanner.getTokenText());
          break;
        case SyntaxKind.OpenBraceToken: {
          if (inFencedCodeBlock) {
            state = JSDocState.SavingBackticks;
            comments.push(p.scanner.getTokenText());
            break;
          }
          state = JSDocState.SavingComments;
          const commentEnd = p.scanner.getTokenFullStart();
          const linkStart = p.scanner.getTokenEnd() - 1;
          const link = this.parseJSDocLink(linkStart);
          if (link !== undefined) {
            if (linkEnd === start) removeLeadingNewlines(comments.parts);
            const jsdocText = new JSDocText(comments.parts.join(''));
            p.finishNodeWithEnd(jsdocText, linkEnd, commentEnd);
            commentParts.push(jsdocText, link);
            const indent = comments.indent;
            const margin = comments.margin;
            comments = new CommentText(indent);
            comments.margin = margin;
            linkEnd = p.scanner.getTokenEnd();
            break;
          }
          // Not a link: doc comment text.
          state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenText());
          break;
        }
        default:
          // Anything else is comment text; no tag can start on this line until the next line break.
          if (state !== JSDocState.SavingBackticks)
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenText());
      }
      if (state === JSDocState.SavingComments || state === JSDocState.SavingBackticks)
        p.nextJSDocCommentTextToken(state === JSDocState.SavingBackticks);
      else p.nextTokenJSDoc();
    }

    if (commentsPos === -1) commentsPos = p.scanner.getTokenFullStart();
    const parts = comments.parts;
    if (parts.length > 0) {
      parts[parts.length - 1] = trimEndUnicodeSpace(parts[parts.length - 1]!);
      const jsdocText = new JSDocText(parts.join(''));
      p.finishNodeWithEnd(jsdocText, linkEnd, commentsPos);
      commentParts.push(jsdocText);
    }
    const tagsList = tagsPos !== -1 ? p.newNodeList(tagsPos, tagsEnd, tags) : undefined;
    const jsdocComment = new JSDoc(p.newNodeList(start, commentsPos, commentParts), tagsList);
    return p.finishNodeWithEnd(jsdocComment, fullStart, end);
  }

  isNextNonwhitespaceTokenEndOfFile(): boolean {
    // Any number of newlines can follow, so look ahead without limit.
    const p = this.p;
    for (;;) {
      p.nextTokenJSDoc();
      if (p.token() === SyntaxKind.EndOfFile) return true;
      if (!(p.token() === SyntaxKind.WhitespaceTrivia || p.token() === SyntaxKind.NewLineTrivia)) return false;
    }
  }

  /** Skips whitespace, unless only whitespace remains: that shouldn't be in any node's range. */
  skipWhitespace(): boolean {
    const p = this.p;
    if (p.token() === SyntaxKind.WhitespaceTrivia || p.token() === SyntaxKind.NewLineTrivia) {
      if (p.lookAhead(isNextNonwhitespaceTokenEndOfFile)) return false;
    }
    while (p.token() === SyntaxKind.WhitespaceTrivia || p.token() === SyntaxKind.NewLineTrivia) p.nextTokenJSDoc();
    return true;
  }

  /** Skips whitespace and leading asterisks; returns the indentation of the last line if a line break was skipped. */
  skipWhitespaceOrAsterisk(): string {
    const p = this.p;
    if (p.token() === SyntaxKind.WhitespaceTrivia || p.token() === SyntaxKind.NewLineTrivia) {
      if (p.lookAhead(isNextNonwhitespaceTokenEndOfFile)) return '';
    }
    let precedingLineBreak = p.scanner.hasPrecedingLineBreak();
    let seenLineBreak = false;
    let indents: string[] = [];
    while (
      (precedingLineBreak && p.token() === SyntaxKind.AsteriskToken) ||
      p.token() === SyntaxKind.WhitespaceTrivia ||
      p.token() === SyntaxKind.NewLineTrivia
    ) {
      indents.push(p.scanner.getTokenText());
      if (p.token() === SyntaxKind.NewLineTrivia) {
        precedingLineBreak = true;
        seenLineBreak = true;
        indents = [];
      } else if (p.token() === SyntaxKind.AsteriskToken) {
        precedingLineBreak = false;
      }
      p.nextTokenJSDoc();
    }
    return seenLineBreak ? indents.join('') : '';
  }

  parseTag(tags: readonly Node[], margin: number): Node {
    const p = this.p;
    const start = p.scanner.getTokenStart();
    p.nextTokenJSDoc();
    const tagName = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
    const indentText = this.skipWhitespaceOrAsterisk();
    switch (tagName.text) {
      case 'implements':
        return this.parseImplementsTag(start, tagName, margin, indentText);
      case 'augments':
      case 'extends':
        return this.parseAugmentsTag(start, tagName, margin, indentText);
      case 'public':
        return p.finishNode(
          new JSDocPublicTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
          start,
        );
      case 'private':
        return p.finishNode(
          new JSDocPrivateTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
          start,
        );
      case 'protected':
        return p.finishNode(
          new JSDocProtectedTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
          start,
        );
      case 'readonly':
        return p.finishNode(
          new JSDocReadonlyTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
          start,
        );
      case 'override':
        return p.finishNode(
          new JSDocOverrideTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
          start,
        );
      case 'deprecated':
        p.hasDeprecatedTag = true;
        return p.finishNode(
          new JSDocDeprecatedTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
          start,
        );
      case 'this':
        return this.parseThisTag(start, tagName, margin, indentText);
      case 'arg':
      case 'argument':
      case 'param':
        return this.parseParameterOrPropertyTag(start, tagName, PropertyLikeParse.Parameter, margin);
      case 'return':
      case 'returns':
        return this.parseReturnTag(tags, start, tagName, margin, indentText);
      case 'template':
        return this.parseTemplateTag(start, tagName, margin, indentText);
      case 'type':
        return this.parseTypeTag(tags, start, tagName, margin, indentText);
      case 'typedef':
        return this.parseTypedefTag(start, tagName, margin, indentText);
      case 'callback':
        return this.parseCallbackTag(start, tagName, margin, indentText);
      case 'overload':
        return this.parseOverloadTag(start, tagName, margin, indentText);
      case 'satisfies':
        return this.parseSatisfiesTag(start, tagName, margin, indentText);
      case 'see':
        return this.parseSeeTag(start, tagName, margin, indentText);
      case 'exception':
      case 'throws':
        return this.parseThrowsTag(start, tagName, margin, indentText);
      case 'import':
        return this.parseImportTag(start, tagName, margin, indentText);
      default:
        return this.parseUnknownTag(start, tagName, margin, indentText);
    }
  }

  parseTrailingTagComments(pos: number, end: number, margin: number, indentText: string): NodeList | undefined {
    // Tags like @typedef and @callback have already parsed their comments.
    if (indentText.length === 0) margin += utf8Length(this.p.sourceText.substring(pos, end));
    const initialMargin = margin < utf8Length(indentText) ? sliceFromUtf8Offset(indentText, margin) : '';
    return this.parseTagComments(margin, initialMargin);
  }

  /** `initialMargin` is undefined when no indentation precedes the comment. */
  parseTagComments(indent: number, initialMargin: string | undefined): NodeList | undefined {
    const p = this.p;
    const commentsPos = p.nodePos();
    let comments = new CommentText(indent);
    const parts: Node[] = [];
    let linkEnd = -1;
    let state = JSDocState.BeginningOfLine;
    let backtickCount = 0;
    let inFencedCodeBlock = false;
    if (initialMargin !== undefined) {
      // Save comments right away if there's initial indentation.
      if (initialMargin !== '') comments.push(initialMargin);
      state = JSDocState.SawAsterisk;
    }
    let tok = p.token();
    loop: for (;;) {
      // Three or more consecutive backticks toggle a fenced code block.
      if (tok !== SyntaxKind.BacktickToken && backtickCount > 0) {
        if (backtickCount >= 3) inFencedCodeBlock = !inFencedCodeBlock;
        backtickCount = 0;
      }
      switch (tok) {
        case SyntaxKind.NewLineTrivia:
          state = JSDocState.BeginningOfLine;
          // Keep the margin unchanged.
          comments.parts.push(p.scanner.getTokenText());
          comments.indent = 0;
          break;
        case SyntaxKind.AtToken:
          if (!inFencedCodeBlock && p.scanner.canFollowJSDocAt()) {
            p.scanner.resetPos(p.scanner.getTokenEnd() - 1);
            break loop;
          }
          state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenText());
          break;
        case SyntaxKind.EndOfFile:
          break loop;
        case SyntaxKind.WhitespaceTrivia: {
          // Keep only the whitespace past the margin.
          const whitespace = p.scanner.getTokenText();
          const length = utf8Length(whitespace);
          if (comments.margin > -1 && comments.indent + length > comments.margin) {
            comments.parts.push(sliceFromUtf8Offset(whitespace, Math.max(comments.margin - comments.indent, 0)));
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          }
          comments.indent += length;
          break;
        }
        case SyntaxKind.OpenBraceToken: {
          if (inFencedCodeBlock) {
            state = JSDocState.SavingBackticks;
            comments.push(p.scanner.getTokenText());
            break;
          }
          state = JSDocState.SavingComments;
          const commentEnd = p.scanner.getTokenFullStart();
          const linkStart = p.scanner.getTokenEnd() - 1;
          const link = this.parseJSDocLink(linkStart);
          if (link !== undefined) {
            const text = new JSDocText(comments.parts.join(''));
            p.finishNodeWithEnd(text, linkEnd > -1 ? linkEnd : commentsPos, commentEnd);
            parts.push(text, link);
            const indentAfter = comments.indent;
            const margin = comments.margin;
            comments = new CommentText(indentAfter);
            comments.margin = margin;
            linkEnd = p.scanner.getTokenEnd();
          } else {
            comments.push(p.scanner.getTokenText());
          }
          break;
        }
        case SyntaxKind.BacktickToken:
          backtickCount++;
          state = state === JSDocState.SavingBackticks ? JSDocState.SavingComments : JSDocState.SavingBackticks;
          comments.push(p.scanner.getTokenText());
          break;
        case SyntaxKind.JSDocCommentTextToken:
          // Leading identifiers start recording too.
          if (state !== JSDocState.SavingBackticks)
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenValue());
          break;
        case SyntaxKind.AsteriskToken:
          if (state === JSDocState.BeginningOfLine) {
            // Leading asterisks start recording on the next non-whitespace token.
            state = JSDocState.SawAsterisk;
            comments.indent += 1;
            break;
          }
          // Otherwise the `*` is comment text.
          if (state !== JSDocState.SavingBackticks)
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenText());
          break;
        default:
          if (state !== JSDocState.SavingBackticks)
            state = inFencedCodeBlock ? JSDocState.SavingBackticks : JSDocState.SavingComments;
          comments.push(p.scanner.getTokenText());
      }
      if (state === JSDocState.SavingComments || state === JSDocState.SavingBackticks)
        tok = p.nextJSDocCommentTextToken(state === JSDocState.SavingBackticks);
      else tok = p.nextTokenJSDoc();
    }
    const texts = comments.parts;
    removeLeadingNewlines(texts);
    removeTrailingWhitespace(texts);
    if (texts.length > 0) {
      const text = new JSDocText(texts.join(''));
      p.finishNode(text, linkEnd > -1 ? linkEnd : commentsPos);
      parts.push(text);
    }
    return parts.length > 0 ? p.newNodeList(commentsPos, p.scanner.getTokenEnd(), parts) : undefined;
  }

  parseJSDocLink(start: number): Node | undefined {
    const p = this.p;
    const state = p.mark();
    const linkType = this.parseJSDocLinkPrefix();
    if (linkType === undefined) {
      p.rewind(state);
      return undefined;
    }
    p.nextTokenJSDoc();
    // Skip whitespace after the link tag.
    this.skipWhitespace();
    const name = this.parseJSDocLinkName();
    let text = '';
    while (
      p.token() !== SyntaxKind.CloseBraceToken &&
      p.token() !== SyntaxKind.NewLineTrivia &&
      p.token() !== SyntaxKind.EndOfFile
    ) {
      text += p.scanner.getTokenText();
      p.nextTokenJSDoc();
    }
    const link: Node =
      linkType === 'link'
        ? new JSDocLink(name, text)
        : linkType === 'linkcode'
          ? new JSDocLinkCode(name, text)
          : new JSDocLinkPlain(name, text);
    return p.finishNodeWithEnd(link, start | 0, p.scanner.getTokenEnd());
  }

  parseJSDocLinkName(): EntityName | undefined {
    const p = this.p;
    if (!tokenIsIdentifierOrKeyword(p.token())) return undefined;
    const pos = p.nodePos();
    let name: Node = p.parseIdentifierName();
    while (p.parseOptional(SyntaxKind.DotToken)) {
      const right = p.token() === SyntaxKind.PrivateIdentifier ? p.createMissingIdentifier() : p.parseIdentifierName();
      name = p.finishNode(new QualifiedName(name, right), pos);
    }
    while (p.token() === SyntaxKind.PrivateIdentifier) {
      p.scanner.reScanHashToken();
      p.nextTokenJSDoc();
      name = p.finishNode(new QualifiedName(name, p.parseIdentifier()), pos);
    }
    return name;
  }

  /** The kind of link (`link`, `linkcode` or `linkplain`) after `{@`, or undefined. */
  parseJSDocLinkPrefix(): string | undefined {
    const p = this.p;
    this.skipWhitespaceOrAsterisk();
    if (
      p.token() === SyntaxKind.OpenBraceToken &&
      p.nextTokenJSDoc() === SyntaxKind.AtToken &&
      tokenIsIdentifierOrKeyword(p.nextTokenJSDoc())
    ) {
      const kind = p.scanner.getTokenValue();
      if (kind === 'link' || kind === 'linkcode' || kind === 'linkplain') return kind;
    }
    return undefined;
  }

  parseUnknownTag(start: number, tagName: Identifier, indent: number, indentText: string): Node {
    const p = this.p;
    return p.finishNode(
      new JSDocUnknownTag(tagName, this.parseTrailingTagComments(start, p.nodePos(), indent, indentText)),
      start,
    );
  }

  tryParseTypeExpression(): JSDocTypeExpression | undefined {
    this.skipWhitespaceOrAsterisk();
    return this.p.token() === SyntaxKind.OpenBraceToken ? this.parseJSDocTypeExpression(false) : undefined;
  }

  /** A name like `foo`, `[foo]`, `foo.bar` or `[foo.bar = 42]`; the caller has parsed an opening `[`. */
  parseBracketNameInPropertyAndParamTag(target: PropertyLikeParse, isBracketed: boolean): EntityName {
    const p = this.p;
    if (isBracketed) this.skipWhitespace();
    // A markdown-quoted name, `arg`, isn't legal JSDoc but occurs in the wild.
    const isBackquoted = this.parseOptionalJsdoc(SyntaxKind.BacktickToken);
    const name = this.parseJSDocEntityName(
      target === PropertyLikeParse.Parameter ? undefined : Diagnostics.Identifier_expected,
    );
    if (isBackquoted) p.parseExpectedTokenJSDoc(SyntaxKind.BacktickToken);
    if (isBracketed) {
      this.skipWhitespace();
      // An optional default, as in `[foo = 42]`.
      if (p.parseOptionalToken(SyntaxKind.EqualsToken) !== undefined) p.parseExpression();
      p.parseExpected(SyntaxKind.CloseBracketToken);
    }
    return name;
  }

  parseParameterOrPropertyTag(start: number, tagName: Identifier, target: PropertyLikeParse, indent: number): Node {
    const p = this.p;
    let typeExpression: Node | undefined = this.tryParseTypeExpression();
    let isNameFirst = typeExpression === undefined;
    this.skipWhitespaceOrAsterisk();
    const isBracketed = this.parseOptionalJsdoc(SyntaxKind.OpenBracketToken);
    const name = this.parseBracketNameInPropertyAndParamTag(target, isBracketed);
    const indentText = this.skipWhitespaceOrAsterisk();
    if (isNameFirst && p.lookAhead(isNotJSDocLinkPrefix)) typeExpression = this.tryParseTypeExpression();
    const comment = this.parseTrailingTagComments(start, p.nodePos(), indent, indentText);
    const nestedTypeLiteral = this.parseNestedTypeLiteral(typeExpression, name, target, indent);
    if (nestedTypeLiteral !== undefined) {
      typeExpression = nestedTypeLiteral;
      isNameFirst = true;
    }
    const kind = target === PropertyLikeParse.Property ? SyntaxKind.JSDocPropertyTag : SyntaxKind.JSDocParameterTag;
    return p.finishNode(
      new JSDocParameterOrPropertyTag(kind, tagName, name, isBracketed, typeExpression, isNameFirst, comment),
      start,
    );
  }

  parseNestedTypeLiteral(
    typeExpression: Node | undefined,
    name: EntityName,
    target: PropertyLikeParse,
    indent: number,
  ): Node | undefined {
    const p = this.p;
    if (typeExpression === undefined) return undefined;
    const type = getType(typeExpression);
    if (type === undefined || !isObjectOrObjectArrayTypeReference(type)) return undefined;
    const pos = p.nodePos();
    const children: Node[] = [];
    for (;;) {
      const state = p.mark();
      const child = this.parseChildParameterOrPropertyTag(target, indent, name);
      if (child === undefined) {
        p.rewind(state);
        break;
      }
      if (child.kind === SyntaxKind.JSDocParameterTag || child.kind === SyntaxKind.JSDocPropertyTag)
        children.push(child);
      else if (child.kind === SyntaxKind.JSDocTemplateTag) this.reportTemplateAfterTypedef(child);
    }
    if (children.length === 0) return undefined;
    const literal = p.finishNode(new JSDocTypeLiteral(children, type.kind === SyntaxKind.ArrayType), pos);
    return p.finishNode(new JSDocTypeExpression(literal), pos);
  }

  reportTemplateAfterTypedef(tag: Node): boolean {
    const tagName = getTagName(tag)!;
    this.p.parseErrorAt(
      tagName.pos,
      tagName.end,
      Diagnostics.A_JSDoc_template_tag_may_not_follow_a_typedef_callback_or_overload_tag,
    );
    return true;
  }

  parseReturnTag(
    previousTags: readonly Node[],
    start: number,
    tagName: Identifier,
    indent: number,
    indentText: string,
  ): Node {
    const p = this.p;
    if (hasTagOfKind(previousTags, SyntaxKind.JSDocReturnTag))
      p.parseErrorAt(tagName.pos, p.scanner.getTokenStart(), Diagnostics.X_0_tag_already_specified, [tagName.text]);
    const typeExpression = this.tryParseTypeExpression();
    return p.finishNode(
      new JSDocReturnTag(
        tagName,
        typeExpression,
        this.parseTrailingTagComments(start, p.nodePos(), indent, indentText),
      ),
      start,
    );
  }

  /** `indent` -1 skips trailing comments, as for a type tag nested in a typedef. */
  parseTypeTag(
    previousTags: readonly Node[],
    start: number,
    tagName: Identifier,
    indent: number,
    indentText: string,
  ): JSDocTypeTag {
    const p = this.p;
    if (hasTagOfKind(previousTags, SyntaxKind.JSDocTypeTag))
      p.parseErrorAt(tagName.pos, p.scanner.getTokenStart(), Diagnostics.X_0_tag_already_specified, [tagName.text]);
    const typeExpression = this.parseJSDocTypeExpression(true);
    const comments = indent !== -1 ? this.parseTrailingTagComments(start, p.nodePos(), indent, indentText) : undefined;
    const result = new JSDocTypeTag(tagName, typeExpression, comments);
    p.finishNode(result, start);
    return result;
  }

  parseSeeTag(start: number, tagName: Identifier, indent: number, indentText: string): Node {
    const p = this.p;
    const hasNameReference =
      (p.isIdentifier() && !p.sourceText.startsWith('://', p.scanner.getTokenEnd())) ||
      (p.token() === SyntaxKind.OpenBraceToken && p.lookAhead(nextTokenIsIdentifierOrKeyword));
    const nameExpression = hasNameReference ? this.parseJSDocNameReference() : undefined;
    const comments = this.parseTrailingTagComments(start, p.nodePos(), indent, indentText);
    return p.finishNode(new JSDocSeeTag(tagName, nameExpression, comments), start);
  }

  parseImplementsTag(start: number, tagName: Identifier, margin: number, indentText: string): Node {
    const p = this.p;
    const className = this.parseExpressionWithTypeArgumentsForAugments();
    return p.finishNode(
      new JSDocImplementsTag(tagName, className, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
      start,
    );
  }

  parseAugmentsTag(start: number, tagName: Identifier, margin: number, indentText: string): Node {
    const p = this.p;
    const className = this.parseExpressionWithTypeArgumentsForAugments();
    return p.finishNode(
      new JSDocAugmentsTag(tagName, className, this.parseTrailingTagComments(start, p.nodePos(), margin, indentText)),
      start,
    );
  }

  parseSatisfiesTag(start: number, tagName: Identifier, margin: number, indentText: string): Node {
    const p = this.p;
    const typeExpression = this.parseJSDocTypeExpression(false);
    const comments = this.parseTrailingTagComments(start, p.nodePos(), margin, indentText);
    return p.finishNode(new JSDocSatisfiesTag(tagName, typeExpression, comments), start);
  }

  parseThrowsTag(start: number, tagName: Identifier, margin: number, indentText: string): Node {
    const p = this.p;
    const typeExpression = this.tryParseTypeExpression();
    const comment = this.parseTrailingTagComments(start, p.nodePos(), margin, indentText);
    return p.finishNode(new JSDocThrowsTag(tagName, typeExpression, comment), start);
  }

  parseImportTag(start: number, tagName: Identifier, margin: number, indentText: string): Node {
    const p = this.p;
    const afterImportTagPos = p.scanner.getTokenFullStart();
    const identifier = p.isIdentifier() ? p.parseIdentifier() : undefined;
    const importClause = p.tryParseImportClause(identifier, afterImportTagPos, SyntaxKind.TypeKeyword, true);
    const moduleSpecifier = p.parseModuleSpecifier();
    const attributes = p.tryParseImportAttributes();
    const comments = this.parseTrailingTagComments(start, p.nodePos(), margin, indentText);
    return p.finishNode(new JSDocImportTag(tagName, importClause, moduleSpecifier, attributes, comments), start);
  }

  parseExpressionWithTypeArgumentsForAugments(): ExpressionWithTypeArguments {
    const p = this.p;
    const usedBrace = p.parseOptional(SyntaxKind.OpenBraceToken);
    const pos = p.nodePos();
    const expression = this.parsePropertyAccessEntityNameExpression();
    p.scanner.setSkipJSDocLeadingAsterisks(true);
    const typeArguments = p.parseTypeArguments();
    p.scanner.setSkipJSDocLeadingAsterisks(false);
    const node = new ExpressionWithTypeArguments(expression, typeArguments);
    p.finishNode(node, pos);
    if (usedBrace) {
      this.skipWhitespace();
      p.parseExpected(SyntaxKind.CloseBraceToken);
    }
    return node;
  }

  parsePropertyAccessEntityNameExpression(): Node {
    const p = this.p;
    const pos = p.nodePos();
    let node: Node = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
    while (p.parseOptional(SyntaxKind.DotToken)) {
      const name = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
      node = p.finishNode(new PropertyAccessExpression(node, undefined, name, NodeFlags.None), pos);
    }
    return node;
  }

  parseThisTag(start: number, tagName: Identifier, margin: number, indentText: string): Node {
    const p = this.p;
    const typeExpression = this.parseJSDocTypeExpression(true);
    this.skipWhitespace();
    const result = new JSDocThisTag(
      tagName,
      typeExpression,
      this.parseTrailingTagComments(start, p.nodePos(), margin, indentText),
    );
    return p.finishNode(result, start);
  }

  /** A typedef or callback name, possibly dotted (`A.B.C`) into nested namespace declarations. */
  parseJSDocTypeNameWithNamespace(nested: boolean): Node | undefined {
    const p = this.p;
    const start = p.scanner.getTokenStart();
    if (!tokenIsIdentifierOrKeyword(p.token())) return undefined;
    const typeNameOrNamespaceName = this.parseJSDocIdentifierName(undefined);
    if (this.parseOptionalJsdoc(SyntaxKind.DotToken)) {
      const body = this.parseJSDocTypeNameWithNamespace(true);
      const jsDocNamespaceNode = new ModuleDeclaration(
        undefined,
        SyntaxKind.NamespaceKeyword,
        typeNameOrNamespaceName,
        undefined,
        body,
      );
      if (nested) jsDocNamespaceNode.flags |= NodeFlags.NestedNamespace;
      return p.finishNode(jsDocNamespaceNode, start);
    }
    if (nested) typeNameOrNamespaceName.flags |= NodeFlags.IdentifierIsInJSDocNamespace;
    return typeNameOrNamespaceName;
  }

  parseTypedefTag(start: number, tagName: Identifier, indent: number, indentText: string): Node {
    const p = this.p;
    let typeExpression: Node | undefined = this.tryParseTypeExpression();
    this.skipWhitespaceOrAsterisk();
    let fullName = this.parseJSDocTypeNameWithNamespace(false);
    if (fullName === undefined) fullName = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
    this.skipWhitespace();
    let comment = this.parseTagComments(indent, undefined);
    let end = -1;
    let hasChildren = false;
    const typeExpressionType = typeExpression === undefined ? undefined : getType(typeExpression);
    if (
      typeExpression === undefined ||
      (typeExpressionType !== undefined && isObjectOrObjectArrayTypeReference(typeExpressionType))
    ) {
      let childTypeTag: JSDocTypeTag | undefined;
      const jsdocPropertyTags: Node[] = [];
      for (;;) {
        const state = p.mark();
        const child = this.parseChildParameterOrPropertyTag(PropertyLikeParse.Property, indent, undefined);
        if (child === undefined) {
          p.rewind(state);
          break;
        }
        hasChildren = true;
        if (child.kind === SyntaxKind.JSDocTemplateTag) {
          this.reportTemplateAfterTypedef(child);
        } else if (child instanceof JSDocTypeTag) {
          if (childTypeTag === undefined) {
            childTypeTag = child;
          } else {
            const lastError = p.parseErrorAtCurrentToken(
              Diagnostics.A_JSDoc_typedef_comment_may_not_contain_multiple_type_tags,
            );
            if (lastError !== undefined)
              lastError.addRelatedInfo(newDiagnosticAtStart(Diagnostics.The_tag_was_first_specified_here));
          }
        } else {
          jsdocPropertyTags.push(child);
        }
      }
      if (hasChildren) {
        const isArrayType = typeExpressionType !== undefined && typeExpressionType.kind === SyntaxKind.ArrayType;
        const jsdocTypeLiteral = new JSDocTypeLiteral(jsdocPropertyTags, isArrayType);
        const childType =
          childTypeTag !== undefined && childTypeTag.typeExpression !== undefined
            ? getType(childTypeTag.typeExpression)
            : undefined;
        if (childTypeTag !== undefined && childType !== undefined && !isObjectOrObjectArrayTypeReference(childType)) {
          typeExpression = childTypeTag.typeExpression;
        } else {
          // This differs from Strada but prevents a crash.
          const pos = jsdocPropertyTags.length > 0 ? jsdocPropertyTags[0]!.pos : start;
          typeExpression = p.finishNode(jsdocTypeLiteral, pos);
        }
        end = typeExpression!.end;
      }
    }
    // Only include the text between the name and the next token if it's a comment, not just whitespace.
    if (end === -1) {
      if (hasChildren && typeExpression !== undefined) end = typeExpression.end;
      else if (comment !== undefined) end = p.nodePos();
      else if (fullName !== undefined) end = fullName.end;
      else if (typeExpression !== undefined) end = typeExpression.end;
      else end = tagName.end;
    }
    if (comment === undefined) comment = this.parseTrailingTagComments(start, end, indent, indentText);
    const typedefTag = p.finishNodeWithEnd(new JSDocTypedefTag(tagName, typeExpression, fullName, comment), start, end);
    // Overwrite the parent possibly set by the inner type expression parse.
    if (typeExpression !== undefined) typeExpression.parent = typedefTag;
    return typedefTag;
  }

  parseCallbackTagParameters(indent: number): NodeList {
    const p = this.p;
    const parameters: Node[] = [];
    const pos = p.nodePos();
    for (;;) {
      const state = p.mark();
      const child = this.parseChildParameterOrPropertyTag(PropertyLikeParse.CallbackParameter, indent, undefined);
      if (child === undefined) {
        p.rewind(state);
        break;
      }
      if (child.kind === SyntaxKind.JSDocTemplateTag) this.reportTemplateAfterTypedef(child);
      else parameters.push(child);
    }
    return p.newNodeList(pos, p.nodePos(), parameters);
  }

  parseJSDocSignature(start: number, indent: number): JSDocSignature {
    const p = this.p;
    const parameters = this.parseCallbackTagParameters(indent);
    let returnTag: Node | undefined;
    const state = p.mark();
    if (this.parseOptionalJsdoc(SyntaxKind.AtToken)) {
      const tag = this.parseTag([], indent);
      if (tag.kind === SyntaxKind.JSDocReturnTag) returnTag = tag;
    }
    if (returnTag === undefined) p.rewind(state);
    const result = new JSDocSignature(undefined, parameters, returnTag);
    p.finishNode(result, start);
    return result;
  }

  parseCallbackTag(start: number, tagName: Identifier, indent: number, indentText: string): Node {
    const p = this.p;
    let fullName = this.parseJSDocTypeNameWithNamespace(false);
    if (fullName === undefined) fullName = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
    this.skipWhitespace();
    let comment = this.parseTagComments(indent, undefined);
    const typeExpression = this.parseJSDocSignature(p.nodePos(), indent);
    if (comment === undefined) comment = this.parseTrailingTagComments(start, p.nodePos(), indent, indentText);
    const end = comment !== undefined ? p.nodePos() : typeExpression.end;
    return p.finishNodeWithEnd(new JSDocCallbackTag(tagName, typeExpression, fullName, comment), start, end);
  }

  parseOverloadTag(start: number, tagName: Identifier, indent: number, indentText: string): Node {
    const p = this.p;
    this.skipWhitespace();
    let comment = this.parseTagComments(indent, undefined);
    const typeExpression = this.parseJSDocSignature(start, indent);
    if (comment === undefined) comment = this.parseTrailingTagComments(start, p.nodePos(), indent, indentText);
    const end = comment !== undefined ? p.nodePos() : typeExpression.end;
    return p.finishNodeWithEnd(new JSDocOverloadTag(tagName, typeExpression, comment), start, end);
  }

  parseChildParameterOrPropertyTag(
    target: PropertyLikeParse,
    indent: number,
    name: EntityName | undefined,
  ): Node | undefined {
    const p = this.p;
    let canParseTag = true;
    let seenAsterisk = false;
    for (;;) {
      switch (p.nextTokenJSDoc()) {
        case SyntaxKind.AtToken:
          if (canParseTag && p.scanner.canFollowJSDocAt()) {
            const child = this.tryParseChildTag(target, indent);
            if (child instanceof JSDocParameterOrPropertyTag && name !== undefined) {
              const childName = (child as JSDocParameterOrPropertyTag).name;
              if (
                childName instanceof Identifier ||
                !(childName instanceof QualifiedName) ||
                !textsEqual(name, (childName as QualifiedName).left)
              )
                return undefined;
            }
            return child;
          }
          seenAsterisk = false;
          break;
        case SyntaxKind.NewLineTrivia:
          canParseTag = true;
          seenAsterisk = false;
          break;
        case SyntaxKind.AsteriskToken:
          if (seenAsterisk) canParseTag = false;
          seenAsterisk = true;
          break;
        case SyntaxKind.Identifier:
          canParseTag = false;
          break;
        case SyntaxKind.EndOfFile:
          return undefined;
      }
    }
  }

  tryParseChildTag(target: PropertyLikeParse, indent: number): Node | undefined {
    const p = this.p;
    const start = p.scanner.getTokenFullStart();
    p.nextTokenJSDoc();
    const tagName = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
    const indentText = this.skipWhitespaceOrAsterisk();
    let t: PropertyLikeParse;
    switch (tagName.text) {
      case 'type':
        if (target === PropertyLikeParse.Property) return this.parseTypeTag([], start, tagName, -1, '');
        return undefined;
      case 'prop':
      case 'property':
        t = PropertyLikeParse.Property;
        break;
      case 'arg':
      case 'argument':
      case 'param':
        t = PropertyLikeParse.Parameter | PropertyLikeParse.CallbackParameter;
        break;
      case 'template':
        return this.parseTemplateTag(start, tagName, indent, indentText);
      case 'this':
        return this.parseThisTag(start, tagName, indent, indentText);
      default:
        return undefined;
    }
    if ((target & t) === 0) return undefined;
    return this.parseParameterOrPropertyTag(start, tagName, target, indent);
  }

  parseTemplateTagTypeParameter(): Node | undefined {
    const p = this.p;
    const typeParameterPos = p.nodePos();
    const isBracketed = this.parseOptionalJsdoc(SyntaxKind.OpenBracketToken);
    if (isBracketed) this.skipWhitespace();
    const modifiers = p.parseModifiersEx(false, true, false);
    const name = this.parseJSDocIdentifierName(
      Diagnostics.Unexpected_token_A_type_parameter_name_was_expected_without_curly_braces,
    );
    let defaultType: Node | undefined;
    if (isBracketed) {
      this.skipWhitespace();
      p.parseExpected(SyntaxKind.EqualsToken);
      const saveContextFlags = p.contextFlags;
      p.setContextFlags(NodeFlags.JSDoc, true);
      defaultType = p.parseJSDocType();
      p.contextFlags = saveContextFlags;
      p.parseExpected(SyntaxKind.CloseBracketToken);
    }
    if (name.pos === name.end && name.pos >= 0) return undefined;
    return p.finishNode(
      new TypeParameterDeclaration(modifiers, name, undefined, undefined, defaultType),
      typeParameterPos,
    );
  }

  parseTemplateTagTypeParameters(): NodeList {
    // tsgo builds this list without a text range.
    const typeParameters: Node[] = [];
    do {
      this.skipWhitespace();
      const node = this.parseTemplateTagTypeParameter();
      if (node !== undefined) typeParameters.push(node);
      this.skipWhitespaceOrAsterisk();
    } while (this.parseOptionalJsdoc(SyntaxKind.CommaToken));
    return new NodeList(0, 0, typeParameters);
  }

  parseTemplateTag(start: number, tagName: Identifier, indent: number, indentText: string): Node {
    // `@template T,U,V` or `@template {Constraint} T`.
    const p = this.p;
    const constraint = p.token() === SyntaxKind.OpenBraceToken ? this.parseJSDocTypeExpression(false) : undefined;
    const typeParameters = this.parseTemplateTagTypeParameters();
    const result = new JSDocTemplateTag(
      tagName,
      constraint,
      typeParameters,
      this.parseTrailingTagComments(start, p.nodePos(), indent, indentText),
    );
    return p.finishNode(result, start);
  }

  parseOptionalJsdoc(t: SyntaxKind): boolean {
    if (this.p.token() === t) {
      this.p.nextTokenJSDoc();
      return true;
    }
    return false;
  }

  parseJSDocEntityName(diagnosticMessage: DiagnosticMessage | undefined): EntityName {
    const p = this.p;
    let entity: Node = this.parseJSDocIdentifierName(diagnosticMessage);
    // `y[]` is accepted as an entity name; the brackets aren't kept.
    if (p.parseOptional(SyntaxKind.OpenBracketToken)) p.parseExpected(SyntaxKind.CloseBracketToken);
    while (p.parseOptional(SyntaxKind.DotToken)) {
      const name = this.parseJSDocIdentifierName(Diagnostics.Identifier_expected);
      if (p.parseOptional(SyntaxKind.OpenBracketToken)) p.parseExpected(SyntaxKind.CloseBracketToken);
      entity = p.finishNode(new QualifiedName(entity, name), entity.pos);
    }
    return entity;
  }

  parseJSDocIdentifierName(diagnosticMessage: DiagnosticMessage | undefined): Identifier {
    const p = this.p;
    if (!tokenIsIdentifierOrKeyword(p.token())) {
      if (diagnosticMessage !== undefined) p.parseErrorAtCurrentToken(diagnosticMessage);
      else if (isReservedWord(p.token()))
        p.parseErrorAtCurrentToken(Diagnostics.Identifier_expected_0_is_a_reserved_word_that_cannot_be_used_here, [
          p.scanner.getTokenText(),
        ]);
      const missing = p.newIdentifier(new IdentifierName(''));
      p.finishNode(missing, p.nodePos());
      return missing;
    }
    const pos = p.scanner.getTokenStart();
    const end = p.scanner.getTokenEnd();
    const text = p.scanner.getIdentifierValue();
    const name = p.scanner.getIdentifierName();
    p.internIdentifier(text);
    p.nextTokenJSDoc();
    const result = p.newIdentifier(name);
    p.finishNodeWithEnd(result, pos, end);
    return result;
  }
}

function newDiagnosticAtStart(message: DiagnosticMessage): Diagnostic {
  return new Diagnostic(undefined, 0, 0, message, []);
}

function hasTagOfKind(tags: readonly Node[], kind: SyntaxKind): boolean {
  for (const tag of tags) if (tag.kind === kind) return true;
  return false;
}

function isObjectOrObjectArrayTypeReference(node: Node): boolean {
  if (node.kind === SyntaxKind.ObjectKeyword) return true;
  if (node instanceof ArrayTypeNode) return isObjectOrObjectArrayTypeReference((node as ArrayTypeNode).elementType);
  if (!(node instanceof TypeReferenceNode)) return false;
  const typeName = (node as TypeReferenceNode).typeName;
  return (
    typeName instanceof Identifier &&
    (typeName as Identifier).text === 'Object' &&
    (node as TypeReferenceNode).typeArguments === undefined
  );
}

/** Whether two entity names are the same dotted name. */
function textsEqual(a: Node, b: Node): boolean {
  while (!(a instanceof Identifier) || !(b instanceof Identifier)) {
    if (
      a instanceof QualifiedName &&
      b instanceof QualifiedName &&
      getText((a as QualifiedName).right) === getText((b as QualifiedName).right)
    ) {
      a = (a as QualifiedName).left;
      b = (b as QualifiedName).left;
    } else {
      return false;
    }
  }
  return (a as Identifier).text === (b as Identifier).text;
}

function isNextNonwhitespaceTokenEndOfFile(p: Parser): boolean {
  return p.jsdoc.isNextNonwhitespaceTokenEndOfFile();
}

function isNotJSDocLinkPrefix(p: Parser): boolean {
  return p.jsdoc.parseJSDocLinkPrefix() === undefined;
}

function nextTokenIsIdentifierOrKeyword(p: Parser): boolean {
  return tokenIsIdentifierOrKeyword(p.nextToken());
}

/** Removes leading strings made only of line breaks. */
function removeLeadingNewlines(comments: string[]): void {
  let i = 0;
  while (i < comments.length && isOnlyLineBreaks(comments[i]!)) i++;
  if (i > 0) comments.splice(0, i);
}

function isOnlyLineBreaks(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch !== CharacterCodes.carriageReturn && ch !== CharacterCodes.lineFeed) return false;
  }
  return true;
}

/** Trims trailing whitespace, dropping strings that become empty. */
function removeTrailingWhitespace(comments: string[]): void {
  let end = comments.length;
  for (let i = comments.length - 1; i >= 0; i--) {
    const trimmed = trimEndWhiteSpaceLike(comments[i]!);
    if (trimmed === '') {
      end = i;
    } else {
      comments[i] = trimmed;
      break;
    }
  }
  comments.length = end;
}

function trimEndWhiteSpaceLike(s: string): string {
  let end = s.length;
  while (end > 0 && isWhiteSpaceLike(s.charCodeAt(end - 1))) end--;
  return s.substring(0, end);
}

/** Go's unicode.IsSpace. */
function isUnicodeSpace(ch: number): boolean {
  switch (ch) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return ch >= 0x2000 && ch <= 0x200a;
}

function trimEndUnicodeSpace(s: string): string {
  let end = s.length;
  while (end > 0 && isUnicodeSpace(s.charCodeAt(end - 1))) end--;
  return s.substring(0, end);
}

/** The UTF-8 length of `s`, as tsgo measures text (a lone surrogate counts as U+FFFD). */
function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** `s` from the UTF-8 byte offset `offset` on (rounded up to a character boundary). */
function sliceFromUtf8Offset(s: string, offset: number): string {
  let bytes = 0;
  let i = 0;
  while (i < s.length && bytes < offset) {
    const ch = s.charCodeAt(i);
    if (ch < 0x80) bytes += 1;
    else if (ch < 0x800) bytes += 2;
    else if (
      ch >= 0xd800 &&
      ch <= 0xdbff &&
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
    i++;
  }
  return s.substring(i);
}
