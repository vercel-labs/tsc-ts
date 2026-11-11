// Finding nodes and tokens at positions of a source file, like tsgo's astnav.
import {
  getComment,
  JSDocParameterOrPropertyTag,
  type JsxText,
  type ModifierList,
  type Node,
  NodeFlags,
  type NodeList,
  NodeVisitor,
  type SourceFile,
  Token,
} from './ast.js';
import { isPropertyNameLiteral } from './binder-utilities.js';
import { nodeIsMissing } from './ast-utilities.js';
import { getJSDoc } from './parser.js';
import { Scanner, skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';

/** The property name or token touching `position`. */
export function getTouchingPropertyName(file: SourceFile, position: number): Node | undefined {
  return findTokenAtPosition(file, position, false, true);
}

/** The token touching `position`. */
export function getTouchingToken(file: SourceFile, position: number): Node | undefined {
  return findTokenAtPosition(file, position, false, false);
}

/** Whether a token ending at a touched position counts as touching it. */
function isTouchingPropertyName(node: Node): boolean {
  return isPropertyNameLiteral(node) || isKeywordKind(node.kind) || node.kind === SyntaxKind.PrivateIdentifier;
}

function isKeywordKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword;
}

function isTokenKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstToken && kind <= SyntaxKind.LastToken;
}

function isJSDocKind(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstJSDocNode && kind <= SyntaxKind.LastJSDocNode;
}

function isReparsed(node: Node): boolean {
  return (node.flags & NodeFlags.Reparsed) !== 0;
}

function isWhitespaceOnlyJsxText(node: Node): boolean {
  return node.kind === SyntaxKind.JsxText && (node as JsxText).containsOnlyTriviaWhiteSpaces;
}

function isNonWhitespaceToken(node: Node): boolean {
  return isTokenKind(node.kind) && !isWhitespaceOnlyJsxText(node);
}

function isJsxChild(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxExpression:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxText:
    case SyntaxKind.JsxFragment:
      return true;
  }
  return false;
}

/** JSDoc nodes whose trivia isn't made of tokens. */
function shouldSkipChild(node: Node): boolean {
  const kind = node.kind;
  return (
    kind === SyntaxKind.JSDoc ||
    kind === SyntaxKind.JSDocText ||
    kind === SyntaxKind.JSDocTypeLiteral ||
    kind === SyntaxKind.JSDocSignature ||
    kind === SyntaxKind.JSDocLink ||
    kind === SyntaxKind.JSDocLinkCode ||
    kind === SyntaxKind.JSDocLinkPlain ||
    (kind >= SyntaxKind.FirstJSDocTagNode && kind <= SyntaxKind.LastJSDocTagNode)
  );
}

/** A lone JSDoc comment node, which navigation treats as part of its parent's text. */
function isSingleCommentList(list: NodeList): boolean {
  if (list.nodes.length !== 1) return false;
  const parent = list.nodes[0].parent;
  return parent !== undefined && isJSDocKind(parent.kind) && getComment(parent) === list;
}

/** The start of a node's first token, optionally including its JSDoc. */
export function getTokenPosOfNode(node: Node, file: SourceFile, includeJSDoc: boolean): number {
  // Missing nodes have no width; skipping trivia would move to the next token.
  if (nodeIsMissing(node)) return node.pos;
  // JSX text can't contain comments, though the scanner would see them.
  if (isJSDocKind(node.kind) || node.kind === SyntaxKind.JsxText)
    return skipTrivia(file.text, node.pos, false, true, false);
  if (includeJSDoc) {
    const jsDoc = getJSDoc(file, node);
    if (jsDoc.length > 0) return getTokenPosOfNode(jsDoc[0], file, false);
  }
  return skipTrivia(file.text, node.pos, false, false, (node.flags & NodeFlags.JSDoc) !== 0);
}

/** Visits the JSDoc and then the children of a node, in the order navigation expects. */
function visitChildrenAndJSDoc(node: Node, file: SourceFile, visitor: NodeVisitor): void {
  const jsDoc = getJSDoc(file, node);
  for (let i = 0; i < jsDoc.length; i++) visitor.visitNode(jsDoc[i]);
  if (node instanceof JSDocParameterOrPropertyTag) {
    // The tag name, the name, then the type, wherever the type is written.
    visitor.visitNode(node.tagName);
    visitor.visitNode(node.name);
    if (node.typeExpression !== undefined) visitor.visitNode(node.typeExpression);
    if (node.comment !== undefined) visitor.visitList(node.comment);
    return;
  }
  node.forEachChild(visitor);
}

let navigationScanner: Scanner | undefined;
let navigationScannerFile: SourceFile | undefined;

/** A scanner positioned on the token at `pos`. */
function getScannerAt(file: SourceFile, pos: number): Scanner {
  let scanner = navigationScanner;
  if (scanner === undefined) {
    scanner = new Scanner();
    navigationScanner = scanner;
  }
  if (navigationScannerFile !== file) {
    scanner.setText(file.text);
    scanner.setLanguageVariant(file.languageVariant);
    navigationScannerFile = file;
  }
  scanner.resetTokenState(pos);
  scanner.scan();
  return scanner;
}

function scanNavigationToken(scanner: Scanner, containingNode: Node): SyntaxKind {
  const token = scanner.getToken();
  if (token === SyntaxKind.LessThanLessThanToken && isJsxChild(containingNode)) return scanner.reScanJsxToken(true);
  return token;
}

// Tokens made from the scanner, by parent and range, so repeated lookups in a file give the
// same node. Only the most recently navigated file is cached.
let tokenCacheFile: SourceFile | undefined;
let tokenCache = new Map<Node, Map<number, Node>>();

/** Forgets the file the navigation scanner and token cache last visited. */
export function forgetNavigationFile(): void {
  navigationScanner = undefined;
  navigationScannerFile = undefined;
  tokenCacheFile = undefined;
  tokenCache = new Map<Node, Map<number, Node>>();
}

/** A token the parser doesn't store, made from the scanner's current token. */
function createToken(kind: SyntaxKind, pos: number, end: number, parent: Node): Node {
  const file = navigationScannerFile;
  if (file !== tokenCacheFile) {
    tokenCacheFile = file;
    tokenCache = new Map<Node, Map<number, Node>>();
  }
  let byRange = tokenCache.get(parent);
  if (byRange === undefined) {
    byRange = new Map<number, Node>();
    tokenCache.set(parent, byRange);
  }
  const key = pos * 0x4000000 + (end - pos);
  const cached = byRange.get(key);
  if (cached !== undefined && cached.kind === kind) return cached;
  const token = new Token(kind);
  token.pos = pos | 0;
  token.end = end | 0;
  token.parent = parent;
  byRange.set(key, token);
  return token;
}

// Finds the child of the current node that contains the target position.
class TokenAtPositionVisitor extends NodeVisitor {
  file: SourceFile;
  position: number;
  allowPositionInLeadingTrivia: boolean;
  includePrecedingToken: boolean;
  /** The child to descend into. */
  next: Node | undefined = undefined;
  /** A child ending at the position, whose last token may touch it. */
  prevSubtree: Node | undefined = undefined;
  /** The lower bound of the token to return; where scanning starts. */
  left = 0;
  /** The first child after the one that moved `left`; scanning stops at its start. */
  nodeAfterLeft: Node | undefined = undefined;

  constructor(
    file: SourceFile,
    position: number,
    allowPositionInLeadingTrivia: boolean,
    includePrecedingToken: boolean,
  ) {
    super();
    this.file = file;
    this.position = position;
    this.allowPositionInLeadingTrivia = allowPositionInLeadingTrivia;
    this.includePrecedingToken = includePrecedingToken;
  }

  /** -1 if `node` ends before the position, 1 if it starts after it, 0 if it contains it. */
  testNode(node: Node): number {
    const position = this.position;
    if (node.kind !== SyntaxKind.EndOfFile && node.end === position && this.includePrecedingToken && !isReparsed(node))
      this.prevSubtree = node;
    // Nodes at the end of the file contain their end, since there's nowhere else to look.
    if (
      node.end < position ||
      (node.end === position &&
        node.kind !== SyntaxKind.EndOfFile &&
        (!isJSDocKind(node.kind) || node.end !== this.file.endOfFileToken.end))
    )
      return -1;
    const start = this.allowPositionInLeadingTrivia ? node.pos : getTokenPosOfNode(node, this.file, true);
    return start > this.position ? 1 : 0;
  }

  visitNode(node: Node): boolean {
    if (isReparsed(node) || isSingleCommentNode(node)) return false;
    if (this.nodeAfterLeft === undefined) this.nodeAfterLeft = node;
    if (this.next === undefined) {
      const result = this.testNode(node);
      if (result < 0) {
        // `left` can't move into JSDoc: a token after it is scanned with all its leading trivia.
        if (!isJSDocKind(node.kind)) this.left = node.end;
        this.nodeAfterLeft = undefined;
      } else if (result === 0) this.next = node;
    }
    return false;
  }

  visitList(list: NodeList): boolean {
    const nodes = list.nodes;
    if (nodes.length === 0 || isSingleCommentList(list)) return false;
    if (this.nodeAfterLeft === undefined) {
      for (let i = 0; i < nodes.length; i++)
        if (!isReparsed(nodes[i])) {
          this.nodeAfterLeft = nodes[i];
          break;
        }
    }
    if (this.next !== undefined) return false;
    const position = this.position;
    if (list.end === position && this.includePrecedingToken) {
      this.left = list.end;
      this.nodeAfterLeft = undefined;
      for (let i = nodes.length - 1; i >= 0; i--)
        if (!isReparsed(nodes[i])) {
          this.prevSubtree = nodes[i];
          break;
        }
    } else if (list.end <= position) {
      this.left = list.end;
      this.nodeAfterLeft = undefined;
    } else if (list.pos <= position) {
      let index = this.searchList(nodes, true);
      let candidates = nodes;
      if (index >= 0 && isReparsed(nodes[index])) {
        candidates = nodes.filter((node) => !isReparsed(node));
        index = this.searchList(candidates, false);
      }
      if (index >= 0) this.next = candidates[index];
    }
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    return this.visitList(list);
  }

  /** The index of the node containing the position, or -1. */
  private searchList(nodes: readonly Node[], skipReparsed: boolean): number {
    let low = 0;
    let high = nodes.length - 1;
    while (low <= high) {
      const middle = low + ((high - low) >> 1);
      const node = nodes[middle];
      if (skipReparsed && isReparsed(node)) return middle;
      const cmp = this.testNode(node);
      if (cmp < 0) {
        this.left = node.end;
        this.nodeAfterLeft = undefined;
        for (let i = middle + 1; i < nodes.length; i++)
          if (!skipReparsed || !isReparsed(nodes[i])) {
            this.nodeAfterLeft = nodes[i];
            break;
          }
        low = middle + 1;
      } else if (cmp > 0) high = middle - 1;
      else return middle;
    }
    return -1;
  }
}

/** Whether `node` is the only comment of a JSDoc node. */
function isSingleCommentNode(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined || !isJSDocKind(parent.kind)) return false;
  const comment = getComment(parent);
  return comment !== undefined && comment.nodes.length === 1 && comment.nodes[0] === node;
}

/**
 * The token at `position`: a node of the tree, or a token made from the scanner. Without
 * `allowPositionInLeadingTrivia`, a position in trivia gives the innermost node containing it.
 * With `includePrecedingToken`, a property name or keyword ending at `position` also counts.
 */
function findTokenAtPosition(
  file: SourceFile,
  position: number,
  allowPositionInLeadingTrivia: boolean,
  includePrecedingToken: boolean,
): Node | undefined {
  let current: Node = file;
  const visitor = new TokenAtPositionVisitor(file, position, allowPositionInLeadingTrivia, includePrecedingToken);
  for (;;) {
    visitChildrenAndJSDoc(current, file, visitor);
    // A subtree ending at the position: its last token may touch it.
    const prevSubtree = visitor.prevSubtree;
    if (prevSubtree !== undefined) {
      const child = findPrecedingTokenIn(file, position, prevSubtree, false);
      if (child !== undefined && child.end === position && isTouchingPropertyName(child)) return child;
      visitor.prevSubtree = undefined;
    }
    const next = visitor.next;
    if (next === undefined) {
      // As deep as the tree goes: either a token, or one the scanner has to make.
      if (isTokenKind(current.kind) || shouldSkipChild(current)) return current;
      let left = visitor.left;
      const scanner = getScannerAt(file, left);
      // Scan only up to the next child, so a position between two children finds nothing.
      const end = visitor.nodeAfterLeft !== undefined ? visitor.nodeAfterLeft.pos : current.end;
      while (left < end) {
        const token = scanNavigationToken(scanner, current);
        const tokenFullStart = scanner.getTokenFullStart();
        const tokenStart = allowPositionInLeadingTrivia ? tokenFullStart : scanner.getTokenStart();
        const tokenEnd = scanner.getTokenEnd();
        if (tokenEnd > end) break;
        if (tokenStart <= position && position < tokenEnd) {
          if (token === SyntaxKind.Identifier || !isTokenKind(token)) {
            if (isJSDocKind(current.kind)) return current;
            throw new Error('did not expect ' + current.kind + ' to have ' + token + ' in its trivia');
          }
          return createToken(token, tokenFullStart, tokenEnd, current);
        }
        if (includePrecedingToken && tokenEnd === position) {
          const prevToken = createToken(token, tokenFullStart, tokenEnd, current);
          if (isTouchingPropertyName(prevToken)) return prevToken;
        }
        left = tokenEnd;
        scanner.scan();
      }
      return current;
    }
    current = next;
    visitor.left = current.pos;
    visitor.nodeAfterLeft = undefined;
    visitor.next = undefined;
  }
}

// Finds the leftmost child ending after the position, and the last child before it.
class PrecedingChildVisitor extends NodeVisitor {
  position: number;
  found: Node | undefined = undefined;
  prev: Node | undefined = undefined;

  constructor(position: number) {
    super();
    this.position = position;
  }

  visitNode(node: Node): boolean {
    if (isReparsed(node) || isSingleCommentNode(node) || this.found !== undefined) return false;
    if (this.position < node.end && (this.prev === undefined || this.prev.end <= this.position)) this.found = node;
    else this.prev = node;
    return false;
  }

  visitList(list: NodeList): boolean {
    const nodes = list.nodes;
    if (this.found !== undefined || nodes.length === 0 || isSingleCommentList(list)) return false;
    const position = this.position;
    let low = 0;
    let high = nodes.length - 1;
    let index = -1;
    while (low <= high) {
      const middle = low + ((high - low) >> 1);
      let cmp: number;
      // Reparsed JSDoc nodes come before the nodes they were made for.
      if (isReparsed(nodes[middle])) cmp = -1;
      else if (position < nodes[middle].end) {
        cmp = middle === 0 || position >= nodes[middle - 1].end ? 0 : 1;
      } else cmp = -1;
      if (cmp < 0) low = middle + 1;
      else if (cmp > 0) high = middle - 1;
      else {
        index = middle;
        break;
      }
    }
    if (index >= 0) this.found = nodes[index];
    const lookup = index >= 0 ? index - 1 : nodes.length - 1;
    for (let i = lookup; i >= 0; i--) {
      if (isReparsed(nodes[i])) continue;
      if (this.prev === undefined) this.prev = nodes[i];
    }
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    return this.visitList(list);
  }
}

/**
 * The leftmost token ending after `position`; if that token is invalid or `position` is in
 * its trivia, the rightmost valid token ending at or before `position`.
 */
export function findPrecedingToken(file: SourceFile, position: number): Node | undefined {
  return findPrecedingTokenIn(file, position, file, false);
}

function findPrecedingTokenIn(
  file: SourceFile,
  position: number,
  startNode: Node,
  excludeJSDoc: boolean,
): Node | undefined {
  let n = startNode;
  for (;;) {
    if (isNonWhitespaceToken(n) && n.kind !== SyntaxKind.EndOfFile) return n;
    const visitor = new PrecedingChildVisitor(position);
    visitChildrenAndJSDoc(n, file, visitor);
    const foundChild = visitor.found;
    if (foundChild !== undefined) {
      // A position before the child's tokens, or a child without tokens, looks in earlier children.
      const start = getTokenPosOfNode(foundChild, file, !excludeJSDoc);
      const lookInPreviousChild = start >= position || !isValidPrecedingNode(foundChild, file);
      if (!lookInPreviousChild) {
        n = foundChild;
        continue;
      }
      if (position >= foundChild.pos) {
        // JSDoc preceding the child.
        let jsDoc: Node | undefined;
        const nodeJSDoc = getJSDoc(file, n);
        for (let i = nodeJSDoc.length - 1; i >= 0; i--)
          if (nodeJSDoc[i].pos >= foundChild.pos) {
            jsDoc = nodeJSDoc[i];
            break;
          }
        if (jsDoc !== undefined) {
          if (!excludeJSDoc && position < jsDoc.end) {
            n = jsDoc;
            continue;
          }
          return findRightmostValidToken(jsDoc.end, file, n, position, excludeJSDoc);
        }
        return findRightmostValidToken(foundChild.pos, file, n, -1, excludeJSDoc);
      }
      // Between two visited children.
      return findRightmostValidToken(foundChild.pos, file, n, position, excludeJSDoc);
    }
    // At the end of the file, or in the unvisited trailing tokens of `n`.
    return findRightmostValidToken(n.end, file, n, position >= n.end ? -1 : position, excludeJSDoc);
  }
}

function isValidPrecedingNode(node: Node, file: SourceFile): boolean {
  if (node.kind === SyntaxKind.EndOfFile) return getJSDoc(file, node).length > 0;
  const start = getTokenPosOfNode(node, file, false);
  return !(isWhitespaceOnlyJsxText(node) || node.end - start === 0);
}

// Collects the rightmost valid child and the children visited after it.
class RightmostChildVisitor extends NodeVisitor {
  file: SourceFile;
  endPos: number;
  position: number;
  excludeJSDoc: boolean;
  rightmostValid: Node | undefined = undefined;
  /** Children after the rightmost valid one. */
  rightmostVisited: Node[] = [];
  hasChildren = false;

  constructor(file: SourceFile, endPos: number, position: number, excludeJSDoc: boolean) {
    super();
    this.file = file;
    this.endPos = endPos;
    this.position = position;
    this.excludeJSDoc = excludeJSDoc;
  }

  /** Whether `node` is in the searched range. */
  shouldVisit(node: Node): boolean {
    return !(
      isReparsed(node) ||
      node.end > this.endPos ||
      getTokenPosOfNode(node, this.file, !this.excludeJSDoc) >= this.position
    );
  }

  visitNode(node: Node): boolean {
    if (isReparsed(node) || isSingleCommentNode(node)) return false;
    this.hasChildren = true;
    if (!this.shouldVisit(node)) return false;
    this.rightmostVisited.push(node);
    if (isValidPrecedingNode(node, this.file)) {
      this.rightmostValid = node;
      this.rightmostVisited = [];
    }
    return false;
  }

  visitList(list: NodeList): boolean {
    const nodes = list.nodes;
    if (nodes.length === 0 || isSingleCommentList(list)) return false;
    this.hasChildren = true;
    // The first node ending after `endPos`.
    let low = 0;
    let high = nodes.length - 1;
    while (low <= high) {
      const middle = low + ((high - low) >> 1);
      if (nodes[middle].end > this.endPos) high = middle - 1;
      else low = middle + 1;
    }
    const index = low;
    let validIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (!this.shouldVisit(nodes[i])) continue;
      if (isValidPrecedingNode(nodes[i], this.file)) {
        validIndex = i;
        this.rightmostValid = nodes[i];
        break;
      }
    }
    for (let i = validIndex + 1; i < index; i++) if (this.shouldVisit(nodes[i])) this.rightmostVisited.push(nodes[i]);
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    return this.visitList(list);
  }
}

/**
 * The rightmost valid token in `[containingNode.pos, endPos)`; with `position` >= 0, the
 * rightmost one that precedes or touches it.
 */
function findRightmostValidToken(
  endPos: number,
  file: SourceFile,
  containingNode: Node,
  position: number,
  excludeJSDoc: boolean,
): Node | undefined {
  if (position === -1) position = containingNode.end;
  let n: Node | undefined = containingNode;
  while (n !== undefined) {
    if (isNonWhitespaceToken(n)) return n;
    const visitor = new RightmostChildVisitor(file, endPos, position, excludeJSDoc);
    visitChildrenAndJSDoc(n, file, visitor);
    const rightmostValid = visitor.rightmostValid;
    // The answer may be an unvisited token after the rightmost valid child. JSDoc nodes
    // don't have trivia tokens.
    if (!shouldSkipChild(n)) {
      let startPos = rightmostValid !== undefined ? rightmostValid.end : n.pos;
      const scanner = getScannerAt(file, startPos);
      const tokens: Node[] = [];
      const visited = visitor.rightmostVisited;
      for (let i = 0; i < visited.length; i++) {
        const visitedNode = visited[i];
        // Tokens before this child.
        while (startPos < Math.min(visitedNode.pos, position)) {
          const token = scanNavigationToken(scanner, n);
          if (scanner.getTokenStart() >= position) break;
          const tokenEnd = scanner.getTokenEnd();
          tokens.push(createToken(token, scanner.getTokenFullStart(), tokenEnd, n));
          startPos = tokenEnd;
          scanner.scan();
        }
        startPos = visitedNode.end;
        scanner.resetPos(startPos);
        scanner.scan();
      }
      // Tokens after the last visited child.
      while (startPos < Math.min(endPos, position)) {
        const token = scanNavigationToken(scanner, n);
        if (scanner.getTokenStart() >= position) break;
        const tokenEnd = scanner.getTokenEnd();
        tokens.push(createToken(token, scanner.getTokenFullStart(), tokenEnd, n));
        startPos = tokenEnd;
        scanner.scan();
      }
      for (let i = tokens.length - 1; i >= 0; i--) if (!isWhitespaceOnlyJsxText(tokens[i])) return tokens[i];
    }
    // A childless node without tokens is the answer itself.
    if (!visitor.hasChildren) return n !== containingNode ? n : undefined;
    // Otherwise the answer is in the rightmost valid child.
    if (rightmostValid !== undefined) endPos = rightmostValid.end;
    n = rightmostValid;
  }
  return undefined;
}

/** The token at `position`, counting leading trivia as part of the token that follows it. */
export function getTokenAtPosition(file: SourceFile, position: number): Node | undefined {
  return findTokenAtPosition(file, position, true, false);
}

/** Like `findPrecedingToken`, searching from `startNode`. */
export function findPrecedingTokenEx(
  file: SourceFile,
  position: number,
  startNode: Node | undefined,
  excludeJSDoc: boolean,
): Node | undefined {
  return findPrecedingTokenIn(file, position, startNode ?? file, excludeJSDoc);
}

/** The start of a node's first token. */
export function getStartOfNode(node: Node, file: SourceFile, includeJSDoc: boolean): number {
  return getTokenPosOfNode(node, file, includeJSDoc);
}

// Collects the children of a node, skipping reparsed nodes and lone JSDoc comments.
class ChildListVisitor extends NodeVisitor {
  readonly children: Node[] = [];

  visitNode(node: Node): boolean {
    if (!isReparsed(node) && !isSingleCommentNode(node)) this.children.push(node);
    return false;
  }

  visitList(list: NodeList): boolean {
    if (isSingleCommentList(list)) return false;
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) if (!isReparsed(nodes[i])) this.children.push(nodes[i]);
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    return this.visitList(list);
  }
}

/** The JSDoc and children of a node that navigation visits, in order. */
export function getVisitedChildren(node: Node, file: SourceFile): Node[] {
  const visitor = new ChildListVisitor();
  visitChildrenAndJSDoc(node, file, visitor);
  return visitor.children;
}

/** The last visited child of a node; tokens the parser doesn't store aren't included. */
export function getLastVisitedChild(node: Node, file: SourceFile): Node | undefined {
  const children = getVisitedChildren(node, file);
  return children.length > 0 ? children[children.length - 1] : undefined;
}

/** The last child of a node, including tokens the parser doesn't store. */
export function getLastChild(node: Node, file: SourceFile): Node | undefined {
  const lastChildNode = getLastVisitedChild(node, file);
  if (lastChildNode === undefined && isSingleCommentNode(node)) return undefined;
  const tokenStartPos = lastChildNode !== undefined ? lastChildNode.end : node.pos;
  let lastToken: Node | undefined;
  if (tokenStartPos < node.end) {
    const scanner = getScannerAt(file, tokenStartPos);
    for (let startPos = tokenStartPos; startPos < node.end;) {
      const tokenEnd = scanner.getTokenEnd();
      lastToken = createToken(scanner.getToken(), scanner.getTokenFullStart(), tokenEnd, node);
      startPos = tokenEnd;
      scanner.scan();
    }
  }
  return lastToken ?? lastChildNode;
}

/** The last token of a node; undefined for tokens and identifiers. */
export function getLastToken(node: Node | undefined, file: SourceFile): Node | undefined {
  if (node === undefined || isTokenKind(node.kind)) return undefined;
  const lastChild = getLastChild(node, file);
  if (lastChild === undefined) return undefined;
  return isTokenKind(lastChild.kind) ? lastChild : getLastToken(lastChild, file);
}

// Finds the first child of a node.
class FirstChildVisitor extends NodeVisitor {
  first: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    this.first = node;
    return true;
  }
}

/** The first token of a node; undefined for tokens and identifiers. */
export function getFirstToken(node: Node, file: SourceFile): Node | undefined {
  if (isTokenKind(node.kind)) return undefined;
  const visitor = new FirstChildVisitor();
  if ((node.flags & NodeFlags.Reparsed) === 0) node.forEachChild(visitor);
  const firstChild = visitor.first;
  const tokenEndPosition = firstChild !== undefined ? firstChild.pos : node.end;
  if (node.pos < tokenEndPosition) {
    const scanner = getScannerAt(file, node.pos);
    return createToken(scanner.getToken(), scanner.getTokenFullStart(), scanner.getTokenEnd(), node);
  }
  if (firstChild === undefined) return undefined;
  return isTokenKind(firstChild.kind) ? firstChild : getFirstToken(firstChild, file);
}

// Collects a node's children without filtering, for scanning the tokens between them.
class AllChildrenVisitor extends NodeVisitor {
  readonly children: Node[] = [];

  visitNode(node: Node): boolean {
    this.children.push(node);
    return false;
  }
}

/** The first child or token of `kind` in a node. */
export function findChildOfKind(containingNode: Node, kind: SyntaxKind, file: SourceFile): Node | undefined {
  let lastNodePos = containingNode.pos;
  const scanner = getScannerAt(file, lastNodePos);
  const visitor = new AllChildrenVisitor();
  const jsDoc = getJSDoc(file, containingNode);
  for (let i = 0; i < jsDoc.length; i++) visitor.children.push(jsDoc[i]);
  containingNode.forEachChild(visitor);
  const children = visitor.children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (isReparsed(node)) continue;
    for (let startPos = lastNodePos; startPos < node.pos;) {
      const tokenEnd = scanner.getTokenEnd();
      if (scanner.getToken() === kind) return createToken(kind, scanner.getTokenFullStart(), tokenEnd, containingNode);
      startPos = tokenEnd;
      scanner.scan();
    }
    if (node.kind === kind) return node;
    lastNodePos = node.end;
    scanner.resetTokenState(lastNodePos);
    scanner.scan();
  }
  for (let startPos = lastNodePos; startPos < containingNode.end;) {
    const tokenEnd = scanner.getTokenEnd();
    if (scanner.getToken() === kind) return createToken(kind, scanner.getTokenFullStart(), tokenEnd, containingNode);
    startPos = tokenEnd;
    scanner.scan();
  }
  return undefined;
}

/** The nodes of a list and the tokens between them, such as separating commas. */
export function getTokensOfNodeList(list: NodeList, parent: Node, file: SourceFile): Node[] {
  const tokens: Node[] = [];
  const nodes = list.nodes;
  let left = list.pos;
  let index = 0;
  while (left < list.end) {
    if (index < nodes.length && left === nodes[index].pos) {
      tokens.push(nodes[index]);
      left = nodes[index].end;
      index++;
    } else {
      const scanner = getScannerAt(file, left);
      const tokenEnd = scanner.getTokenEnd();
      tokens.push(createToken(scanner.getToken(), scanner.getTokenFullStart(), tokenEnd, parent));
      left = tokenEnd;
    }
  }
  return tokens;
}

/** The tokens in `[startPos, endPos)` of `parent`'s text, made from the scanner. */
export function scanTokens(parent: Node, startPos: number, endPos: number, file: SourceFile): Node[] {
  const tokens: Node[] = [];
  if (startPos >= endPos) return tokens;
  const scanner = getScannerAt(file, startPos);
  for (let pos = startPos; pos < endPos;) {
    const tokenEnd = scanner.getTokenEnd();
    tokens.push(createToken(scanner.getToken(), scanner.getTokenFullStart(), tokenEnd, parent));
    pos = tokenEnd;
    scanner.scan();
  }
  return tokens;
}
