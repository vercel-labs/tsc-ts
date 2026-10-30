// Text changes to one source file, built from inserted and replaced nodes, as tsgo's ls/change Tracker builds them
// for imports. Inserted nodes are printed and placed with the indentation of where they go; tsgo also runs its
// formatter over each printed node, which leaves the import statements, specifiers and bindings written here as the
// printer writes them.
import { type NamedImports, type Node, type NodeList, type SourceFile, Token } from '../compiler/ast.js';
import { findPrecedingToken, getStartOfNode, getTokenAtPosition } from '../compiler/astnav.js';
import { isDeclarationStatementKind, isPrologueDirective } from '../compiler/binder-utilities.js';
import { isLineBreak, isWhiteSpaceSingleLine } from '../compiler/character-codes.js';
import { EmitContext } from '../compiler/printer/emit-context.js';
import { Printer, PrinterOptions } from '../compiler/printer/printer.js';
import { isPinnedComment, isRecognizedTripleSlashComment } from '../compiler/printer/utilities.js';
import {
  computeLineOfPosition,
  getLeadingCommentRanges,
  getShebang,
  getTrailingCommentRanges,
  skipTrivia,
  tokenToString,
} from '../compiler/scanner.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { isClassOrTypeElement } from './completion-utilities.js';

/** An edit of a file's text: `newText` in place of the UTF-16 range `pos` to `end`. */
export interface TextEdit {
  readonly pos: number;
  readonly end: number;
  readonly newText: string;
}

export const enum LeadingTriviaOption {
  None,
  Exclude,
  IncludeAll,
  JSDoc,
  StartLine,
}

export const enum TrailingTriviaOption {
  None,
  Exclude,
  ExcludeWhitespace,
  Include,
}

/** How an inserted node is written: text before and after it, and the indentation of its first line. */
export class NodeOptions {
  prefix = '';
  suffix = '';
  /** Set to write the node at this indentation; otherwise it takes the indentation of where it goes. */
  indentation: number | undefined = undefined;
  leadingTriviaOption = LeadingTriviaOption.None;
  trailingTriviaOption = TrailingTriviaOption.None;
}

function nodeOptions(prefix: string, suffix: string): NodeOptions {
  const options = new NodeOptions();
  options.prefix = prefix;
  options.suffix = suffix;
  return options;
}

class Change {
  constructor(
    readonly pos: number,
    readonly end: number,
    /** The replacement text, for a text change. */
    readonly text: string | undefined,
    readonly nodes: readonly Node[],
    readonly options: NodeOptions,
  ) {}
}

/** Collects changes to one file and computes their text edits. */
export class ChangeTracker {
  readonly context = new EmitContext();
  private readonly changes: Change[] = [];
  private readonly deleted: Node[] = [];

  constructor(
    readonly file: SourceFile,
    /** The compiler options' new line. */
    readonly newLine: string,
    /** Columns per tab when measuring indentation. */
    readonly tabSize: number,
  ) {}

  get factory(): EmitContext {
    return this.context;
  }

  replaceNode(oldNode: Node, newNode: Node, options?: NodeOptions): void {
    const o = options ?? new NodeOptions();
    if (options === undefined) {
      o.leadingTriviaOption = LeadingTriviaOption.Exclude;
      o.trailingTriviaOption = TrailingTriviaOption.Exclude;
    }
    const start = this.getAdjustedStartPosition(oldNode, o.leadingTriviaOption, false);
    const end = this.getAdjustedEndPosition(oldNode, o.trailingTriviaOption);
    this.replaceRange(start, end, newNode, o);
  }

  replaceRange(pos: number, end: number, newNode: Node, options: NodeOptions): void {
    this.changes.push(new Change(pos, end, undefined, [newNode], options));
  }

  replaceRangeWithText(pos: number, end: number, text: string): void {
    this.changes.push(new Change(pos, end, text, [], new NodeOptions()));
  }

  insertNodeAt(pos: number, newNode: Node, options: NodeOptions): void {
    this.replaceRange(pos, pos, newNode, options);
  }

  insertNodesAt(pos: number, newNodes: readonly Node[], options: NodeOptions): void {
    if (newNodes.length === 1) this.replaceRange(pos, pos, newNodes[0]!, options);
    else this.changes.push(new Change(pos, pos, undefined, newNodes, options));
  }

  insertNodeAfter(after: Node, newNode: Node): void {
    const end = this.endPosForInsertNodeAfter(after, newNode);
    this.insertNodeAt(end, newNode, this.getInsertNodeAfterOptions(after));
  }

  insertNodesAfter(after: Node, newNodes: readonly Node[]): void {
    const end = this.endPosForInsertNodeAfter(after, newNodes[0]!);
    this.insertNodesAt(end, newNodes, this.getInsertNodeAfterOptions(after));
  }

  insertNodeBefore(
    before: Node,
    newNode: Node,
    blankLineBetween: boolean,
    leadingTriviaOption: LeadingTriviaOption,
  ): void {
    const pos = this.getAdjustedStartPosition(before, leadingTriviaOption, false);
    this.insertNodeAt(pos, newNode, this.getOptionsForInsertNodeBefore(before, newNode, blankLineBetween));
  }

  /** Inserts a modifier keyword and a space before a node. */
  insertModifierBefore(modifier: SyntaxKind, before: Node): void {
    const pos = getStartOfNode(before, this.file, false);
    const token = this.context.created(new Token(modifier));
    this.insertNodeAt(pos, token, nodeOptions('', ' '));
  }

  /** Deletes a node when the changes are computed; only `type` keywords are deleted for imports. */
  delete(node: Node): void {
    this.deleted.push(node);
  }

  /**
   * Inserts a node after a list element. Separators are not part of list elements here (unlike statements), so
   * the separator is written too, on one line or, in a list that spans lines, on a line of its own.
   */
  insertNodeInListAfter(after: Node, newNode: Node, containingList: NodeList): void {
    const file = this.file;
    const text = file.text;
    const elements = containingList.nodes;
    const index = elements.indexOf(after);
    if (index < 0) return;
    const end = after.end;
    if (index !== elements.length - 1) {
      // Before the next element, with the separator and the next element's leading trivia after it.
      const nextToken = getTokenAtPosition(file, after.end);
      if (nextToken !== undefined && isSeparator(after, nextToken)) {
        const nextNode = elements[index + 1]!;
        const startPos = skipTrivia(text, nextNode.pos, false, true);
        const suffix = tokenToString(nextToken.kind)! + text.slice(nextToken.end, startPos);
        this.insertNodesAt(startPos, [newNode], nodeOptions('', suffix));
      }
      return;
    }

    const afterStart = getStartOfNode(after, file, false);
    const afterStartLinePosition = this.lineStartOf(afterStart);
    let multilineList = false;
    let separator = SyntaxKind.CommaToken;
    if (elements.length !== 1) {
      const tokenBeforeInsertPosition = findPrecedingToken(file, after.pos);
      separator =
        tokenBeforeInsertPosition !== undefined && isSeparator(after, tokenBeforeInsertPosition)
          ? tokenBeforeInsertPosition.kind
          : SyntaxKind.CommaToken;
      const previousStart = getStartOfNode(elements[index - 1]!, file, false);
      multilineList = this.lineStartOf(previousStart) !== afterStartLinePosition;
    }
    if (hasCommentsBeforeLineBreak(text, after.end) || !this.onSameLine(containingList.pos, containingList.end)) {
      multilineList = true;
    }
    const separatorString = tokenToString(separator)!;
    if (multilineList) {
      // The separator right after the element, then the new element on its own line with the element's
      // indentation. The separator takes the source position after the element, so the printer writes the
      // element's trailing comment after it, as tsc does.
      const separatorToken = this.context.created(new Token(separator));
      separatorToken.pos = end;
      // `| 0`: an int32 position, so the native build keeps node positions as 32-bit integers.
      separatorToken.end = (end + separatorString.length) | 0;
      separatorToken.parent = after.parent;
      this.replaceRange(end, end, separatorToken, new NodeOptions());
      const indentation = this.findFirstNonWhitespaceColumn(afterStartLinePosition, afterStart);
      let insertPos = skipTrivia(text, end, true, false);
      while (insertPos !== end && isLineBreak(text.charCodeAt(insertPos - 1))) insertPos--;
      const options = nodeOptions(this.newLine, '');
      options.indentation = indentation;
      this.replaceRange(insertPos, insertPos, newNode, options);
    } else {
      this.replaceRange(end, end, newNode, nodeOptions(separatorString + ' ', ''));
    }
  }

  /** Inserts a specifier at an index of named imports. */
  insertImportSpecifierAtIndex(newSpecifier: Node, namedImports: NamedImports, index: number): void {
    const elements = namedImports.elements.nodes;
    const previous = index > 0 && index - 1 < elements.length ? elements[index - 1] : undefined;
    if (previous !== undefined) this.insertNodeInListAfter(previous, newSpecifier, namedImports.elements);
    else {
      const first = elements[0]!;
      const importDeclaration = namedImports.parent!.parent!;
      this.insertNodeBefore(
        first,
        newSpecifier,
        !this.onSameLine(getStartOfNode(first, this.file, false), getStartOfNode(importDeclaration, this.file, false)),
        LeadingTriviaOption.None,
      );
    }
  }

  /** Inserts statements at the top of the file: after prologue directives, a shebang and header comments. */
  insertAtTopOfFile(statements: readonly Node[], blankLineBetween: boolean): void {
    if (statements.length === 0) return;
    const pos = this.getInsertionPositionAtSourceFileTop();
    const text = this.file.text;
    const options = new NodeOptions();
    if (pos !== 0) options.prefix = this.newLine;
    if (text.length === 0 || !isLineBreak(text.charCodeAt(pos))) options.suffix = this.newLine;
    if (blankLineBetween) options.suffix += this.newLine;
    this.insertNodesAt(pos, statements, options);
  }

  /** The text edits, ordered by position. */
  getChanges(): TextEdit[] {
    for (const node of this.deleted) {
      // A `type` keyword goes with the space after it.
      const start = this.getAdjustedStartPosition(node, LeadingTriviaOption.Exclude, false);
      const end = this.getAdjustedEndPosition(node, TrailingTriviaOption.Include);
      this.replaceRangeWithText(start, end, '');
    }
    const edits = this.changes.map((change) => ({
      pos: change.pos,
      end: change.end,
      newText: this.computeNewText(change),
    }));
    // By start, and an empty range before a longer one at the same start; stable otherwise.
    const order = edits.map((_, i) => i);
    order.sort((a, b) => edits[a]!.pos - edits[b]!.pos || edits[a]!.end - edits[b]!.end || a - b);
    const sorted = order.map((i) => edits[i]!);
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (sorted[i]!.end > sorted[i + 1]!.pos) throw new Error('text changes overlap');
    }
    return sorted;
  }

  private computeNewText(change: Change): string {
    if (change.text !== undefined) return change.text;
    const options = change.options;
    const pos = change.pos;
    const atLineStart = this.lineStartOf(pos) === pos;
    const indentation =
      options.indentation ?? (options.prefix === this.newLine || atLineStart ? this.indentationAt(pos) : 0);
    const texts = change.nodes.map((node) => indent(this.print(node), indentation));
    let text = change.nodes.length === 1 ? texts[0]! : texts.map((t) => trimSuffix(t, this.newLine)).join(this.newLine);
    // Inserted in the middle of a line, the text starts where the line is.
    if (!(options.indentation !== undefined || atLineStart)) text = text.trimStart();
    const result = options.prefix + text + (text.endsWith(options.suffix) ? '' : options.suffix);
    return this.reindentInsertedLines(change, result);
  }

  private print(node: Node): string {
    const printerOptions = new PrinterOptions();
    printerOptions.newLine = this.newLine;
    printerOptions.neverAsciiEscape = true;
    printerOptions.preserveSourceNewlines = true;
    printerOptions.terminateUnterminatedLiterals = true;
    const printer = new Printer(printerOptions, this.context);
    return trimSuffix(printer.emit(node, this.file), this.newLine);
  }

  /**
   * The indentation of the line an inserted line starts: inside a list, of the list's elements, else of the
   * statement level, where imports go.
   */
  private indentationAt(pos: number): number {
    const lineStart = this.lineStartOf(pos);
    const text = this.file.text;
    let end = lineStart;
    while (end < text.length && isWhiteSpaceSingleLine(text.charCodeAt(end))) end++;
    const token = getTokenAtPosition(this.file, end);
    const parent = token?.parent;
    if (
      parent !== undefined &&
      (parent.kind === SyntaxKind.ImportSpecifier || parent.kind === SyntaxKind.BindingElement) &&
      getStartOfNode(parent, this.file, false) === end
    ) {
      return this.findFirstNonWhitespaceColumn(lineStart, end);
    }
    return 0;
  }

  /**
   * Indentation for a line the insertion adds: text inserted just after a line's indentation pushes the rest of
   * the line down, which gets the indentation back; text inserted at a line's start takes the line's indentation.
   */
  private reindentInsertedLines(change: Change, text: string): string {
    if (text === '' || change.pos !== change.end || change.options.indentation !== undefined) return text;
    if (!text.endsWith(this.newLine)) return text;
    const original = this.file.text;
    const pos = change.pos;
    const lineStart = Math.max(original.lastIndexOf('\n', pos - 1), original.lastIndexOf('\r', pos - 1)) + 1;
    const beforePoint = original.slice(lineStart, pos);
    if (beforePoint === '') {
      if (leadingIndentation(text) !== '') return text;
      return leadingIndentation(original.slice(lineStart)) + text;
    }
    if (leadingIndentation(beforePoint) !== beforePoint) return text;
    return text + beforePoint;
  }

  private lineStartOf(pos: number): number {
    const lineStarts = this.file.lineStarts();
    return lineStarts[computeLineOfPosition(lineStarts, pos)]!;
  }

  private onSameLine(a: number, b: number): boolean {
    const lineStarts = this.file.lineStarts();
    return computeLineOfPosition(lineStarts, a) === computeLineOfPosition(lineStarts, b);
  }

  // The column of the first non-whitespace character from `lineStart` up to `pos`, with tabs to the next stop.
  private findFirstNonWhitespaceColumn(lineStart: number, pos: number): number {
    const text = this.file.text;
    let column = 0;
    for (let i = lineStart; i < pos; i++) {
      const ch = text.charCodeAt(i);
      if (!isWhiteSpaceSingleLine(ch)) break;
      column = ch === 0x09 ? column + this.tabSize - (column % this.tabSize) : column + 1;
    }
    return column;
  }

  private endPosForInsertNodeAfter(after: Node, newNode: Node): number {
    if (needSemicolonBetween(after, newNode) && this.file.text.charCodeAt(after.end - 1) !== 0x3b) {
      // Keeps the code's meaning against automatic semicolon insertion.
      this.replaceRange(
        after.end,
        after.end,
        this.context.created(new Token(SyntaxKind.SemicolonToken)),
        new NodeOptions(),
      );
    }
    return this.getAdjustedEndPosition(after, TrailingTriviaOption.None);
  }

  private getInsertNodeAfterOptions(node: Node): NodeOptions {
    let options: NodeOptions;
    switch (node.kind) {
      case SyntaxKind.Parameter:
        options = new NodeOptions();
        break;
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ModuleDeclaration:
        options = nodeOptions(this.newLine, this.newLine);
        break;
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.Identifier:
        options = nodeOptions(', ', '');
        break;
      case SyntaxKind.PropertyAssignment:
        options = nodeOptions('', ',' + this.newLine);
        break;
      case SyntaxKind.ExportKeyword:
        options = nodeOptions(' ', '');
        break;
      default:
        if (!(isStatement(node) || isClassOrTypeElement(node)))
          throw new Error(`unimplemented node kind ${node.kind} in getInsertNodeAfterOptions`);
        options = nodeOptions('', this.newLine);
    }
    if (node.end === this.file.end && isStatement(node)) options.prefix = this.newLine + options.prefix;
    return options;
  }

  private getOptionsForInsertNodeBefore(before: Node, inserted: Node, blankLineBetween: boolean): NodeOptions {
    if (isStatement(before) || isClassOrTypeElement(before)) {
      return nodeOptions('', blankLineBetween ? this.newLine + this.newLine : this.newLine);
    }
    switch (before.kind) {
      case SyntaxKind.VariableDeclaration:
        return nodeOptions('', ', ');
      case SyntaxKind.Parameter:
        return inserted.kind === SyntaxKind.Parameter ? nodeOptions('', ', ') : new NodeOptions();
      case SyntaxKind.NamedImports:
        return nodeOptions('', ', ');
      case SyntaxKind.ImportSpecifier:
        return nodeOptions('', ',' + (blankLineBetween ? this.newLine : ' '));
    }
    if (before.kind === SyntaxKind.StringLiteral && before.parent?.kind === SyntaxKind.ImportDeclaration)
      return nodeOptions('', ', ');
    throw new Error(`unimplemented node kind ${before.kind} in getOptionsForInsertNodeBefore`);
  }

  private getAdjustedStartPosition(
    node: Node,
    leadingOption: LeadingTriviaOption,
    hasTrailingComment: boolean,
  ): number {
    const file = this.file;
    const text = file.text;
    const start = getStartOfNode(node, file, false);
    const startOfLinePos = this.lineStartOf(start);
    switch (leadingOption) {
      case LeadingTriviaOption.Exclude:
        return start;
      case LeadingTriviaOption.StartLine:
        return node.pos <= startOfLinePos && startOfLinePos <= node.end ? startOfLinePos : start;
    }
    const fullStart = node.pos;
    if (fullStart === start) return start;
    const lineStarts = file.lineStarts();
    const fullStartLineIndex = computeLineOfPosition(lineStarts, fullStart);
    const fullStartLinePos = lineStarts[fullStartLineIndex]!;
    if (startOfLinePos === fullStartLinePos) {
      // The leading trivia is on the node's own line: kept unless all of it is wanted.
      return leadingOption === LeadingTriviaOption.IncludeAll ? fullStart : start;
    }
    if (hasTrailingComment) {
      const comments = getLeadingCommentRanges(text, fullStart) ?? getTrailingCommentRanges(text, fullStart) ?? [];
      if (comments.length > 0) return skipTrivia(text, comments[0]!.end, true, true);
    }
    // The start of the line after the full start's line (unless the full start is the file's start), past blank
    // lines.
    const nextLineStart = fullStart > 0 ? 1 : 0;
    let adjusted = lineStarts[fullStartLineIndex + nextLineStart]!;
    adjusted = skipTrivia(text, adjusted, false, true);
    return lineStarts[computeLineOfPosition(lineStarts, adjusted)]!;
  }

  private getAdjustedEndPosition(node: Node, trailingOption: TrailingTriviaOption): number {
    const text = this.file.text;
    if (trailingOption === TrailingTriviaOption.Exclude) return node.end;
    if (trailingOption === TrailingTriviaOption.ExcludeWhitespace) {
      const comments = [
        ...(getTrailingCommentRanges(text, node.end) ?? []),
        ...(getLeadingCommentRanges(text, node.end) ?? []),
      ];
      const last = comments[comments.length - 1];
      return last !== undefined && last.end !== 0 ? last.end : node.end;
    }
    const multilineEnd = this.getEndPositionOfMultilineTrailingComment(node, trailingOption);
    if (multilineEnd !== 0) return multilineEnd;
    const newEnd = skipTrivia(text, node.end, true, false);
    if (
      newEnd !== node.end &&
      (trailingOption === TrailingTriviaOption.Include || isLineBreak(text.charCodeAt(newEnd - 1)))
    ) {
      return newEnd;
    }
    return node.end;
  }

  // The end of a multiline comment after the node that reaches past the node's line, for `Include`.
  private getEndPositionOfMultilineTrailingComment(node: Node, trailingOption: TrailingTriviaOption): number {
    if (trailingOption !== TrailingTriviaOption.Include) return 0;
    const text = this.file.text;
    const lineStarts = this.file.lineStarts();
    const nodeEndLine = computeLineOfPosition(lineStarts, node.end);
    for (const comment of getTrailingCommentRanges(text, node.end) ?? []) {
      if (
        comment.kind === SyntaxKind.SingleLineCommentTrivia ||
        computeLineOfPosition(lineStarts, comment.pos) > nodeEndLine
      ) {
        break;
      }
      if (computeLineOfPosition(lineStarts, comment.end) > nodeEndLine)
        return skipTrivia(text, comment.end, true, true);
    }
    return 0;
  }

  // After the prologue directives, else after a shebang and the header comments: pinned and triple-slash comments,
  // and comments not attached to the first statement.
  private getInsertionPositionAtSourceFileTop(): number {
    const file = this.file;
    const text = file.text;
    let lastPrologue: Node | undefined;
    for (const statement of file.statements.nodes) {
      if (isPrologueDirective(statement)) lastPrologue = statement;
      else break;
    }
    let position = 0;
    const advancePastLineBreak = (): void => {
      if (position >= text.length) return;
      const ch = text.charCodeAt(position);
      if (isLineBreak(ch)) {
        position++;
        if (position < text.length && ch === 0x0d && text.charCodeAt(position) === 0x0a) position++;
      }
    };
    if (lastPrologue !== undefined) {
      position = lastPrologue.end;
      advancePastLineBreak();
      return position;
    }
    const shebang = getShebang(text);
    if (shebang !== '') {
      position = shebang.length;
      advancePastLineBreak();
    }
    const ranges = getLeadingCommentRanges(text, position) ?? [];
    if (ranges.length === 0) return position;
    const lineStarts = file.lineStarts();
    let lastComment: { pos: number; end: number } | undefined;
    let pinnedOrTripleSlash = false;
    let firstNodeLine = -1;
    for (const range of ranges) {
      if (range.kind === SyntaxKind.MultiLineCommentTrivia) {
        if (isPinnedComment(text, range)) {
          lastComment = range;
          pinnedOrTripleSlash = true;
          continue;
        }
      } else if (isRecognizedTripleSlashComment(text, range)) {
        lastComment = range;
        pinnedOrTripleSlash = true;
        continue;
      }
      if (lastComment !== undefined) {
        if (pinnedOrTripleSlash) break;
        // A blank line after the last comment ends the header.
        if (computeLineOfPosition(lineStarts, range.pos) >= computeLineOfPosition(lineStarts, lastComment.end) + 2)
          break;
      }
      if (file.statements.nodes.length > 0) {
        if (firstNodeLine === -1)
          firstNodeLine = computeLineOfPosition(lineStarts, getStartOfNode(file.statements.nodes[0]!, file, false));
        if (firstNodeLine < computeLineOfPosition(lineStarts, range.end) + 2) break;
      }
      lastComment = range;
      pinnedOrTripleSlash = false;
    }
    if (lastComment !== undefined) {
      position = lastComment.end;
      advancePastLineBreak();
    }
    return position;
  }
}

function indent(text: string, indentation: number): string {
  return indentation > 0 ? ' '.repeat(indentation) + text : text;
}

function trimSuffix(text: string, suffix: string): string {
  return text.endsWith(suffix) ? text.slice(0, text.length - suffix.length) : text;
}

function leadingIndentation(text: string): string {
  let end = 0;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  return text.slice(0, end);
}

function hasCommentsBeforeLineBreak(text: string, start: number): boolean {
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (!isWhiteSpaceSingleLine(ch)) return ch === 0x2f;
  }
  return false;
}

function isSeparator(node: Node, candidate: Node): boolean {
  return (
    node.parent !== undefined &&
    (candidate.kind === SyntaxKind.CommaToken ||
      (candidate.kind === SyntaxKind.SemicolonToken && node.parent.kind === SyntaxKind.ObjectLiteralExpression))
  );
}

function isStatementButNotDeclaration(node: Node): boolean {
  return node.kind >= SyntaxKind.FirstStatement && node.kind <= SyntaxKind.LastStatement;
}

function isStatement(node: Node): boolean {
  return isStatementButNotDeclaration(node) || isDeclarationStatementKind(node.kind) || node.kind === SyntaxKind.Block;
}

function needSemicolonBetween(a: Node, b: Node): boolean {
  return isStatementButNotDeclaration(a) && isStatementButNotDeclaration(b);
}
