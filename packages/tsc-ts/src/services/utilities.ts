// Syntax and symbol helpers shared by the language services.
import {
  ArrayTypeNode,
  BinaryExpression,
  BindingElement,
  ComputedPropertyName,
  ConditionalTypeNode,
  ElementAccessExpression,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionWithTypeArguments,
  ExternalModuleReference,
  getArguments,
  getElements,
  getExpression,
  getHeritageClauses,
  getLabel,
  getModifiers,
  getName,
  getPropertyName,
  getSymbol,
  getTagName,
  getText,
  getType,
  HeritageClause,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportTypeNode,
  InferTypeNode,
  isDeclarationNode,
  JsxNamespacedName,
  LabeledStatement,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  NodeVisitor,
  PropertyAccessExpression,
  QualifiedName,
  type SourceFile,
  TypeOperatorNode,
  TypeParameterDeclaration,
  TypeReferenceNode,
  VariableDeclarationList,
} from '../compiler/ast.js';
import {
  getHeritageClauseElementName,
  isAmbientModule,
  isImportCall,
  isModifierKind,
  isRequireCall,
  isStringLiteralLike,
} from '../compiler/ast-utilities.js';
import { getTouchingPropertyName } from '../compiler/astnav.js';
import {
  getCombinedModifierFlags,
  getModuleInstanceState,
  getNameOfDeclaration,
  getSourceFileOfNode,
  isClassLike,
  isModuleAugmentationExternal,
  isStringOrNumericLiteralLike,
  isTypeNodeKind,
  ModuleInstanceState,
} from '../compiler/binder-utilities.js';
import { isIdentifierPart } from '../compiler/character-codes.js';
import { type Checker } from '../compiler/checker.js';
import { getContextualType } from '../compiler/checker-contextual.js';
import { getPropertyOfType } from '../compiler/checker-members.js';
import { skipOuterExpressions } from '../compiler/checker-operators.js';
import {
  getExportSpecifierLocalTargetSymbol,
  getReparsedNodeForNode,
  getTypeAtLocation,
  isDeclarationName,
  isExpressionNode,
  isJSDocNameReferenceContext,
  isPartOfTypeNode,
  isRightSideOfQualifiedNameOrPropertyAccess,
} from '../compiler/checker-services.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { type Type } from '../compiler/checker-types.js';
import { getJSDoc } from '../compiler/parser.js';
import { findChildTokenOfKind } from './tokens.js';
import { declarationCount, getDeclarations, type Symbol, SymbolFlags } from '../compiler/symbol.js';

export const enum SemanticMeaning {
  None = 0,
  Value = 1 << 0,
  Type = 1 << 1,
  Namespace = 1 << 2,
  All = Value | Type | Namespace,
}

// ---- Text search

// tsgo searches UTF-8 text. Its search starts at an offset into the container but reports
// positions relative to it, and it tests the bytes next to a match as characters; both are
// kept so that the same candidates are found.
class Utf8Text {
  /** UTF-8 bytes of the file. */
  readonly bytes: Uint8Array;
  /** For each byte, the UTF-16 index of the character it belongs to. */
  readonly utf16: Int32Array;

  constructor(text: string) {
    this.bytes = new TextEncoder().encode(text);
    const map = new Int32Array(this.bytes.length + 1);
    let b = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i)!;
      const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      for (let k = 0; k < size && b < map.length; k++) map[b++] = i;
      if (code >= 0x10000) i++;
    }
    while (b < map.length) map[b++] = text.length;
    this.utf16 = map;
  }

  indexOf(needle: Uint8Array, from: number): number {
    const bytes = this.bytes;
    const last = bytes.length - needle.length;
    outer: for (let i = from; i <= last; i++) {
      for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
      return i;
    }
    return -1;
  }

  /** The UTF-8 offset of a UTF-16 index. */
  offsetOf(index: number): number {
    let low = 0;
    let high = this.utf16.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.utf16[middle] < index) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

const utf8Texts = new Map<SourceFile, Utf8Text>();

function utf8TextOf(file: SourceFile): Utf8Text {
  let text = utf8Texts.get(file);
  if (text === undefined) {
    text = new Utf8Text(file.text);
    utf8Texts.set(file, text);
  }
  return text;
}

/** Positions in `container` where `symbolName` occurs as a whole word. */
export function getPossibleSymbolReferencePositions(
  file: SourceFile,
  symbolName: string,
  container: Node | undefined,
): number[] {
  const positions: number[] = [];
  if (symbolName === '') return positions;
  const scope: Node = container ?? (file as Node);
  if (!file.containsNonASCII) {
    const text = file.text;
    let position = text.substring(scope.pos).indexOf(symbolName);
    const end = scope.end;
    while (position >= 0 && position < end) {
      const endPosition = position + symbolName.length;
      if (
        (position === 0 || !isIdentifierPart(text.charCodeAt(position - 1))) &&
        (endPosition === text.length || !isIdentifierPart(text.charCodeAt(endPosition)))
      )
        positions.push(position);
      const start = position + symbolName.length + 1;
      if (start > text.length) break;
      position = text.indexOf(symbolName, start);
    }
    return positions;
  }
  const text = utf8TextOf(file);
  const bytes = text.bytes;
  const needle = new TextEncoder().encode(symbolName);
  const scopeStart = text.offsetOf(scope.pos);
  let position = text.indexOf(needle, scopeStart);
  if (position >= 0) position -= scopeStart;
  const end = text.offsetOf(scope.end);
  while (position >= 0 && position < end) {
    const endPosition = position + needle.length;
    if (
      (position === 0 || !isIdentifierPart(bytes[position - 1])) &&
      (endPosition === bytes.length || !isIdentifierPart(bytes[endPosition]))
    )
      positions.push(text.utf16[position]);
    const start = position + needle.length + 1;
    if (start > bytes.length) break;
    position = text.indexOf(needle, start);
  }
  return positions;
}

export function getPossibleSymbolReferenceNodes(
  file: SourceFile,
  symbolName: string,
  container: Node | undefined,
): Node[] {
  const nodes: Node[] = [];
  for (const position of getPossibleSymbolReferencePositions(file, symbolName, container)) {
    const node = getTouchingPropertyName(file, position);
    if (node !== undefined && node.kind !== SyntaxKind.SourceFile) nodes.push(node);
  }
  return nodes;
}

const nameTables = new Map<SourceFile, Set<string>>();

/** The identifier and literal names written in a file. */
export function getNameTable(file: SourceFile): Set<string> {
  let table = nameTables.get(file);
  if (table === undefined) {
    table = new Set();
    file.forEachChild(new NameTableBuilder(file, table));
    nameTables.set(file, table);
  }
  return table;
}

class NameTableBuilder extends NodeVisitor {
  constructor(
    readonly file: SourceFile,
    readonly names: Set<string>,
  ) {
    super();
  }

  visitNode(node: Node): boolean {
    if (
      (node instanceof Identifier && !isTagName(node) && node.text !== '') ||
      (isStringOrNumericLiteralLike(node) && literalIsName(node)) ||
      node.kind === SyntaxKind.PrivateIdentifier
    )
      this.names.add(getText(node));
    node.forEachChild(this);
    for (const jsDoc of getJSDocOf(this.file, node)) jsDoc.forEachChild(this);
    return false;
  }
}

function getJSDocOf(file: SourceFile, node: Node): readonly Node[] {
  return getJSDoc(file, node);
}

function isTagName(node: Node): boolean {
  const parent = node.parent;
  return (
    parent !== undefined &&
    parent.kind >= SyntaxKind.FirstJSDocTagNode &&
    parent.kind <= SyntaxKind.LastJSDocTagNode &&
    getTagName(parent) === node
  );
}

function literalIsName(node: Node): boolean {
  const parent = node.parent!;
  return (
    isDeclarationName(node) ||
    parent.kind === SyntaxKind.ExternalModuleReference ||
    (parent instanceof ElementAccessExpression && parent.argumentExpression === node) ||
    isLiteralComputedPropertyDeclarationName(node)
  );
}

export function isLiteralComputedPropertyDeclarationName(node: Node): boolean {
  return (
    (isStringLiteralLike(node) || node.kind === SyntaxKind.NumericLiteral) &&
    node.parent!.kind === SyntaxKind.ComputedPropertyName &&
    isDeclaration(node.parent!.parent!)
  );
}

// ---- Syntax predicates

export function isDeclaration(node: Node): boolean {
  if (node.kind === SyntaxKind.TypeParameter) return node.parent !== undefined;
  return isDeclarationNode(node);
}

export function isTypeNode(node: Node): boolean {
  return isTypeNodeKind(node.kind);
}

export function isTypeElement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.NotEmittedTypeElement:
      return true;
  }
  return false;
}

export function isModuleSpecifierLike(node: Node): boolean {
  if (!isStringLiteralLike(node)) return false;
  const parent = node.parent!;
  if (isRequireCall(parent, false) || isImportCall(parent)) {
    const args = getArguments(parent)!.nodes;
    return args.length > 0 && args[0] === node;
  }
  return (
    parent.kind === SyntaxKind.ExternalModuleReference ||
    parent.kind === SyntaxKind.ImportDeclaration ||
    parent.kind === SyntaxKind.JSImportDeclaration
  );
}

export function isNameOfModuleDeclaration(node: Node): boolean {
  const parent = node.parent!;
  return parent instanceof ModuleDeclaration && parent.name === node;
}

export function isExternalModuleImportEquals(node: Node): boolean {
  return (
    node instanceof ImportEqualsDeclaration &&
    node.moduleReference instanceof ExternalModuleReference &&
    node.moduleReference.expression.kind === SyntaxKind.StringLiteral
  );
}

function isExternalModuleImportEqualsDeclaration(node: Node): boolean {
  return node instanceof ImportEqualsDeclaration && node.moduleReference.kind === SyntaxKind.ExternalModuleReference;
}

export function isExpressionOfExternalModuleImportEqualsDeclaration(node: Node): boolean {
  const declaration = node.parent!.parent!;
  return (
    isExternalModuleImportEqualsDeclaration(declaration) &&
    ((declaration as ImportEqualsDeclaration).moduleReference as ExternalModuleReference).expression === node
  );
}

export function isThis(node: Node): boolean {
  if (node.kind === SyntaxKind.ThisKeyword) return true;
  return node instanceof Identifier && node.text === 'this' && node.parent!.kind === SyntaxKind.Parameter;
}

const typeKeywords = new Set<SyntaxKind>([
  SyntaxKind.AnyKeyword,
  SyntaxKind.AssertsKeyword,
  SyntaxKind.BigIntKeyword,
  SyntaxKind.BooleanKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.InferKeyword,
  SyntaxKind.KeyOfKeyword,
  SyntaxKind.NeverKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumberKeyword,
  SyntaxKind.ObjectKeyword,
  SyntaxKind.ReadonlyKeyword,
  SyntaxKind.StringKeyword,
  SyntaxKind.SymbolKeyword,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.UndefinedKeyword,
  SyntaxKind.UniqueKeyword,
  SyntaxKind.UnknownKeyword,
]);

export function isTypeKeyword(kind: SyntaxKind): boolean {
  return typeKeywords.has(kind);
}

export function isLiteralNameOfPropertyDeclarationOrIndexAccess(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.EnumMember:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.ModuleDeclaration:
      return getNameOfDeclaration(parent) === node;
    case SyntaxKind.ElementAccessExpression:
      return (parent as ElementAccessExpression).argumentExpression === node;
    case SyntaxKind.ComputedPropertyName:
      return true;
    case SyntaxKind.LiteralType:
      return parent.parent!.kind === SyntaxKind.IndexedAccessType;
  }
  return false;
}

export function isObjectBindingElementWithoutPropertyName(node: Node): boolean {
  return (
    node instanceof BindingElement &&
    node.parent!.kind === SyntaxKind.ObjectBindingPattern &&
    node.name !== undefined &&
    node.name.kind === SyntaxKind.Identifier &&
    node.propertyName === undefined
  );
}

export function isRightSideOfPropertyAccess(node: Node): boolean {
  const parent = node.parent;
  return parent instanceof PropertyAccessExpression && parent.name === node;
}

export function climbPastPropertyAccess(node: Node): Node {
  return isRightSideOfPropertyAccess(node) ? node.parent! : node;
}

function isCallee(node: Node, kind: SyntaxKind): boolean {
  const target = climbPastPropertyAccess(node);
  const parent = target.parent;
  return parent !== undefined && parent.kind === kind && getExpression(parent) === target;
}

export function isCallExpressionTarget(node: Node): boolean {
  return isCallee(node, SyntaxKind.CallExpression);
}

export function isNewExpressionTarget(node: Node): boolean {
  return isCallee(node, SyntaxKind.NewExpression);
}

export function isStaticSymbol(symbol: Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return declaration !== undefined && (getModifierFlagsOf(declaration) & ModifierFlags.Static) !== 0;
}

function getModifierFlagsOf(node: Node): ModifierFlags {
  return getModifiers(node)?.modifierFlags ?? ModifierFlags.None;
}

export function hasModifier(node: Node, flags: ModifierFlags): boolean {
  return (getCombinedModifierFlagsOrNone(node) & flags) !== 0;
}

function getCombinedModifierFlagsOrNone(node: Node): ModifierFlags {
  return getCombinedModifierFlags(node);
}

export function isReadonlyTypeOperator(node: Node): boolean {
  const parent = node.parent!;
  return (
    node.kind === SyntaxKind.ReadonlyKeyword &&
    parent instanceof TypeOperatorNode &&
    parent.operator === SyntaxKind.ReadonlyKeyword
  );
}

export function isJumpStatementTarget(node: Node): boolean {
  const parent = node.parent!;
  return (
    node.kind === SyntaxKind.Identifier &&
    (parent.kind === SyntaxKind.BreakStatement || parent.kind === SyntaxKind.ContinueStatement) &&
    getLabel(parent) === node
  );
}

export function isLabelOfLabeledStatement(node: Node): boolean {
  const parent = node.parent!;
  return node.kind === SyntaxKind.Identifier && parent instanceof LabeledStatement && parent.label === node;
}

export function getTargetLabel(referenceNode: Node | undefined, labelName: string): Node | undefined {
  for (let node = referenceNode; node !== undefined; node = node.parent)
    if (node instanceof LabeledStatement && node.label.text === labelName) return node.label;
  return undefined;
}

export function getContainerNode(node: Node): Node | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    switch (parent.kind) {
      case SyntaxKind.SourceFile:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.ModuleDeclaration:
        return parent;
    }
  }
  return undefined;
}

export function isSourceFileWithGlobalExports(node: Node | undefined): boolean {
  return node !== undefined && node.kind === SyntaxKind.SourceFile && (node as SourceFile).globalExports !== undefined;
}

export function isAmbientModuleDeclaration(node: Node): boolean {
  return node instanceof ModuleDeclaration && node.name.kind === SyntaxKind.StringLiteral;
}

export function isExternalModuleAugmentation(node: Node): boolean {
  return isAmbientModule(node) && isModuleAugmentationExternal(node);
}

export function getNonModuleSymbolOfMergedModuleSymbol(symbol: Symbol): Symbol | undefined {
  if (declarationCount(symbol) === 0 || (symbol.flags & (SymbolFlags.Module | SymbolFlags.Transient)) === 0)
    return undefined;
  const declaration = getDeclarations(symbol).find(
    (d) => d.kind !== SyntaxKind.SourceFile && d.kind !== SyntaxKind.ModuleDeclaration,
  );
  return declaration === undefined ? undefined : getSymbol(declaration);
}

export function getLocalSymbolForExportSpecifier(
  c: Checker,
  referenceLocation: Node,
  referenceSymbol: Symbol,
  exportSpecifier: ExportSpecifier,
): Symbol {
  if (isExportSpecifierAlias(referenceLocation, exportSpecifier))
    return getExportSpecifierLocalTargetSymbol(c, exportSpecifier) ?? referenceSymbol;
  return referenceSymbol;
}

function isExportSpecifierAlias(referenceLocation: Node, exportSpecifier: ExportSpecifier): boolean {
  // At `foo` in `export { foo as bar }` it's an alias; at `bar` it's a new symbol.
  if (exportSpecifier.propertyName !== undefined) return exportSpecifier.propertyName === referenceLocation;
  // `export { foo } from "foo"` is a re-export; `export { foo }` aliases a local.
  return (exportSpecifier.parent!.parent as ExportDeclaration).moduleSpecifier === undefined;
}

export function getTextOfPropertyName(name: Node): string | undefined {
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getText(name);
    case SyntaxKind.ComputedPropertyName: {
      const expression = (name as ComputedPropertyName).expression;
      return isStringOrNumericLiteralLike(expression) ? getText(expression) : undefined;
    }
    case SyntaxKind.JsxNamespacedName: {
      const jsxName = name as JsxNamespacedName;
      return jsxName.namespace.text + ':' + jsxName.name.text;
    }
  }
  return undefined;
}

export function getDeclarationOfKind(symbol: Symbol, kind: SyntaxKind): Node | undefined {
  return getDeclarations(symbol).find((d) => d.kind === kind);
}

export function walkUpBindingElementsAndPatterns(node: Node): Node {
  let current = node.parent!;
  while (
    current.kind === SyntaxKind.BindingElement ||
    current.kind === SyntaxKind.ObjectBindingPattern ||
    current.kind === SyntaxKind.ArrayBindingPattern
  )
    current = current.parent!;
  return current;
}

export function findAncestor(node: Node | undefined, test: (node: Node) => boolean): Node | undefined {
  for (let current = node; current !== undefined; current = current.parent) if (test(current)) return current;
  return undefined;
}

// ---- Adjusted locations

/** The node a keyword or modifier at `node` stands for: `function f`'s name for `function`, and so on. */
export function getAdjustedLocation(node: Node, forRename: boolean, file: SourceFile | undefined): Node {
  const parent = node.parent;
  if (parent === undefined) return node;
  if (isAdjustableModifier(node, parent, forRename)) {
    const location = getAdjustedLocationForDeclaration(parent, forRename, file ?? getSourceFileOfNode(node));
    if (location !== undefined) return location;
  }
  // var, let or const of a single declaration
  if (
    (node.kind === SyntaxKind.VarKeyword ||
      node.kind === SyntaxKind.ConstKeyword ||
      node.kind === SyntaxKind.LetKeyword) &&
    parent instanceof VariableDeclarationList &&
    parent.declarations.nodes.length === 1
  ) {
    const name = getName(parent.declarations.nodes[0]);
    if (name instanceof Identifier) return name;
  }
  if (node.kind === SyntaxKind.TypeKeyword) {
    if (parent instanceof ImportClause && parent.phaseModifier === SyntaxKind.TypeKeyword) {
      const location = getAdjustedLocationForImportDeclaration(parent.parent as ImportDeclaration, forRename);
      if (location !== undefined) return location;
    }
    if (parent instanceof ExportDeclaration && parent.isTypeOnly) {
      const location = getAdjustedLocationForExportDeclaration(parent, forRename);
      if (location !== undefined) return location;
    }
  }
  if (node.kind === SyntaxKind.AsKeyword) {
    if (
      ((parent.kind === SyntaxKind.ImportSpecifier || parent.kind === SyntaxKind.ExportSpecifier) &&
        getPropertyName(parent) !== undefined) ||
      parent.kind === SyntaxKind.NamespaceImport ||
      parent.kind === SyntaxKind.NamespaceExport
    )
      return getName(parent)!;
    if (parent instanceof ExportDeclaration) {
      const exportClause = parent.exportClause;
      if (exportClause !== undefined && exportClause.kind === SyntaxKind.NamespaceExport) return getName(exportClause)!;
    }
  }
  if (node.kind === SyntaxKind.ImportKeyword && parent instanceof ImportDeclaration) {
    const location = getAdjustedLocationForImportDeclaration(parent, forRename);
    if (location !== undefined) return location;
  }
  if (node.kind === SyntaxKind.ExportKeyword) {
    if (parent instanceof ExportDeclaration) {
      const location = getAdjustedLocationForExportDeclaration(parent, forRename);
      if (location !== undefined) return location;
    }
    if (parent instanceof ExportAssignment) return skipOuterExpressions(parent.expression);
  }
  if (node.kind === SyntaxKind.RequireKeyword && parent instanceof ExternalModuleReference) return parent.expression;
  if (node.kind === SyntaxKind.FromKeyword) {
    if (parent instanceof ImportDeclaration) return parent.moduleSpecifier;
    if (parent instanceof ExportDeclaration && parent.moduleSpecifier !== undefined) return parent.moduleSpecifier;
  }
  if (
    (node.kind === SyntaxKind.ExtendsKeyword || node.kind === SyntaxKind.ImplementsKeyword) &&
    parent instanceof HeritageClause &&
    parent.token === node.kind &&
    parent.types.nodes.length === 1
  )
    return getHeritageClauseElementName(parent.types.nodes[0]!);
  if (node.kind === SyntaxKind.ExtendsKeyword) {
    if (parent instanceof TypeParameterDeclaration) {
      const constraint = parent.constraint;
      if (constraint instanceof TypeReferenceNode) return constraint.typeName;
    }
    if (parent instanceof ConditionalTypeNode) {
      const extendsType = parent.extendsType;
      if (extendsType instanceof TypeReferenceNode) return extendsType.typeName;
    }
  }
  if (node.kind === SyntaxKind.InferKeyword && parent instanceof InferTypeNode) return parent.typeParameter.name;
  if (
    node.kind === SyntaxKind.InKeyword &&
    parent.kind === SyntaxKind.TypeParameter &&
    parent.parent!.kind === SyntaxKind.MappedType
  )
    return getName(parent)!;
  if (node.kind === SyntaxKind.KeyOfKeyword && parent instanceof TypeOperatorNode) {
    if (parent.operator === SyntaxKind.KeyOfKeyword && parent.type instanceof TypeReferenceNode)
      return parent.type.typeName;
  }
  if (node.kind === SyntaxKind.ReadonlyKeyword && parent instanceof TypeOperatorNode) {
    const type = parent.type;
    if (
      parent.operator === SyntaxKind.ReadonlyKeyword &&
      type instanceof ArrayTypeNode &&
      type.elementType instanceof TypeReferenceNode
    )
      return type.elementType.typeName;
  }
  if (!forRename) {
    if (
      (node.kind === SyntaxKind.NewKeyword && parent.kind === SyntaxKind.NewExpression) ||
      (node.kind === SyntaxKind.VoidKeyword && parent.kind === SyntaxKind.VoidExpression) ||
      (node.kind === SyntaxKind.TypeOfKeyword && parent.kind === SyntaxKind.TypeOfExpression) ||
      (node.kind === SyntaxKind.AwaitKeyword && parent.kind === SyntaxKind.AwaitExpression) ||
      (node.kind === SyntaxKind.YieldKeyword && parent.kind === SyntaxKind.YieldExpression) ||
      (node.kind === SyntaxKind.DeleteKeyword && parent.kind === SyntaxKind.DeleteExpression)
    ) {
      const expression = getExpression(parent);
      if (expression !== undefined) return skipOuterExpressions(expression);
    }
    if (
      (node.kind === SyntaxKind.InKeyword || node.kind === SyntaxKind.InstanceOfKeyword) &&
      parent instanceof BinaryExpression &&
      parent.operatorToken === node
    )
      return skipOuterExpressions(parent.right);
    if (node.kind === SyntaxKind.AsKeyword && parent.kind === SyntaxKind.AsExpression) {
      const type = getType(parent);
      if (type instanceof TypeReferenceNode) return type.typeName;
    }
    if (
      (node.kind === SyntaxKind.InKeyword && parent.kind === SyntaxKind.ForInStatement) ||
      (node.kind === SyntaxKind.OfKeyword && parent.kind === SyntaxKind.ForOfStatement)
    )
      return skipOuterExpressions(getExpression(parent)!);
  }
  return node;
}

function isAdjustableModifier(node: Node, parent: Node, forRename: boolean): boolean {
  if (isModifierKind(node.kind) && (forRename || node.kind !== SyntaxKind.DefaultKeyword)) {
    const modifiers = getModifiers(parent);
    return modifiers !== undefined && modifiers.nodes.includes(node);
  }
  switch (node.kind) {
    case SyntaxKind.ClassKeyword:
      return parent.kind === SyntaxKind.ClassDeclaration;
    case SyntaxKind.FunctionKeyword:
      return parent.kind === SyntaxKind.FunctionDeclaration;
    case SyntaxKind.InterfaceKeyword:
      return parent.kind === SyntaxKind.InterfaceDeclaration;
    case SyntaxKind.EnumKeyword:
      return parent.kind === SyntaxKind.EnumDeclaration;
    case SyntaxKind.TypeKeyword:
      return parent.kind === SyntaxKind.TypeAliasDeclaration;
    case SyntaxKind.NamespaceKeyword:
    case SyntaxKind.ModuleKeyword:
      return parent.kind === SyntaxKind.ModuleDeclaration;
    case SyntaxKind.ImportKeyword:
      return parent.kind === SyntaxKind.ImportEqualsDeclaration;
    case SyntaxKind.GetKeyword:
      return parent.kind === SyntaxKind.GetAccessor;
    case SyntaxKind.SetKeyword:
      return parent.kind === SyntaxKind.SetAccessor;
  }
  return false;
}

function getAdjustedLocationForDeclaration(node: Node, forRename: boolean, file: SourceFile): Node | undefined {
  const name = getName(node);
  if (name !== undefined) return name;
  if (forRename) return undefined;
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.FunctionDeclaration: {
      // tsgo tests the declaration's kind here, so this finds no modifier.
      const modifiers = getModifiers(node);
      return modifiers === undefined ? undefined : modifiers.nodes.find(() => node.kind === SyntaxKind.DefaultKeyword);
    }
    case SyntaxKind.ClassExpression:
      return findChildOfKind(node, SyntaxKind.ClassKeyword, file);
    case SyntaxKind.FunctionExpression:
      return findChildOfKind(node, SyntaxKind.FunctionKeyword, file);
    case SyntaxKind.Constructor:
      return node;
  }
  return undefined;
}

function getAdjustedLocationForImportDeclaration(node: ImportDeclaration, forRename: boolean): Node | undefined {
  const importClause = node.importClause;
  if (importClause !== undefined) {
    if (importClause.name !== undefined) {
      if (importClause.namedBindings !== undefined) return undefined;
      return importClause.name;
    }
    const namedBindings = importClause.namedBindings;
    if (namedBindings !== undefined) {
      if (namedBindings.kind === SyntaxKind.NamedImports) {
        const elements = getElements(namedBindings)!.nodes;
        return elements.length === 1 ? getName(elements[0]) : undefined;
      }
      if (namedBindings.kind === SyntaxKind.NamespaceImport) return getName(namedBindings);
    }
  }
  return forRename ? undefined : node.moduleSpecifier;
}

function getAdjustedLocationForExportDeclaration(node: ExportDeclaration, forRename: boolean): Node | undefined {
  const exportClause = node.exportClause;
  if (exportClause !== undefined) {
    if (exportClause.kind === SyntaxKind.NamedExports) {
      const elements = getElements(exportClause)!.nodes;
      return elements.length === 1 ? getName(elements[0]) : undefined;
    }
    if (exportClause.kind === SyntaxKind.NamespaceExport) return getName(exportClause);
  }
  return forRename ? undefined : node.moduleSpecifier;
}

/** The token of `kind` among the children of `node`, scanning the text between child nodes. */
export function findChildOfKind(node: Node, kind: SyntaxKind, file: SourceFile): Node | undefined {
  return findChildTokenOfKind(node, kind, file);
}

// ---- Meaning

export function getMeaningFromLocation(nodeIn: Node): SemanticMeaning {
  const node = getAdjustedLocation(getReparsedNodeForNode(nodeIn), false, undefined);
  const parent = node.parent;
  if (node.kind === SyntaxKind.SourceFile) return SemanticMeaning.Value;
  switch (parent!.kind) {
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.ExternalModuleReference:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportClause:
      return SemanticMeaning.All;
  }
  if (parent instanceof ImportEqualsDeclaration && node === parent.name) return SemanticMeaning.All;
  if (isInRightSideOfInternalImportEqualsDeclaration(node)) {
    // import a = |b|; is a namespace; import a = |b.c|; is all meanings.
    let name: Node | undefined = node;
    if (node.kind !== SyntaxKind.QualifiedName)
      name = parent instanceof QualifiedName && parent.right === node ? parent : undefined;
    if (name !== undefined && name.parent!.kind === SyntaxKind.ImportEqualsDeclaration) return SemanticMeaning.All;
    return SemanticMeaning.Namespace;
  }
  if (isDeclarationName(node)) return getMeaningFromDeclaration(parent!);
  if (
    (node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName) &&
    isJSDocNameReferenceContext(node)
  )
    return SemanticMeaning.All;
  if (isTypeReference(node)) return SemanticMeaning.Type;
  if (isNamespaceReference(node)) return SemanticMeaning.Namespace;
  if (parent!.kind === SyntaxKind.TypeParameter) return SemanticMeaning.Type;
  if (parent!.kind === SyntaxKind.LiteralType) return SemanticMeaning.Type | SemanticMeaning.Value;
  return SemanticMeaning.Value;
}

export function getMeaningFromDeclaration(node: Node): SemanticMeaning {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.BindingElement:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.CatchClause:
    case SyntaxKind.JsxAttribute:
      return SemanticMeaning.Value;
    case SyntaxKind.TypeParameter:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.TypeLiteral:
      return SemanticMeaning.Type;
    case SyntaxKind.EnumMember:
    case SyntaxKind.ClassDeclaration:
      return SemanticMeaning.Value | SemanticMeaning.Type;
    case SyntaxKind.ModuleDeclaration:
      if (isAmbientModule(node) || getModuleInstanceState(node) === ModuleInstanceState.Instantiated)
        return SemanticMeaning.Namespace | SemanticMeaning.Value;
      return SemanticMeaning.Namespace;
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.NamedImports:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.ExportDeclaration:
      return SemanticMeaning.All;
    case SyntaxKind.SourceFile:
      return SemanticMeaning.Namespace | SemanticMeaning.Value;
  }
  return SemanticMeaning.All;
}

export function getIntersectingMeaningFromDeclarations(
  node: Node | undefined,
  symbol: Symbol,
  defaultMeaning: SemanticMeaning,
): SemanticMeaning {
  if (node === undefined) return defaultMeaning;
  let meaning = getMeaningFromLocation(node);
  const declarations = getDeclarations(symbol);
  if (declarations.length === 0) return meaning;
  // Repeat until stable: a namespace meaning can reach a class through an instantiated module.
  for (;;) {
    const last = meaning;
    for (const declaration of declarations) {
      const declarationMeaning = getMeaningFromDeclaration(declaration);
      if ((declarationMeaning & meaning) !== 0) meaning |= declarationMeaning;
    }
    if (meaning === last) return meaning;
  }
}

function isInRightSideOfInternalImportEqualsDeclaration(nodeIn: Node): boolean {
  let node = nodeIn;
  if (node.parent === undefined) return false;
  while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
  const parent = node.parent!;
  return (
    parent instanceof ImportEqualsDeclaration &&
    parent.moduleReference.kind !== SyntaxKind.ExternalModuleReference &&
    parent.moduleReference === node
  );
}

function isTypeReference(nodeIn: Node): boolean {
  let node = nodeIn;
  if (isRightSideOfQualifiedNameOrPropertyAccess(node)) node = node.parent!;
  if (node.kind === SyntaxKind.ThisKeyword) return !isExpressionNode(node);
  if (node.kind === SyntaxKind.ThisType) return true;
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.TypeReference:
      return true;
    case SyntaxKind.ImportType:
      return !(parent as ImportTypeNode).isTypeOf;
    case SyntaxKind.ExpressionWithTypeArguments:
      return isPartOfTypeNode(parent);
  }
  return false;
}

function isNamespaceReference(node: Node): boolean {
  return isQualifiedNameNamespaceReference(node) || isPropertyAccessNamespaceReference(node);
}

function isQualifiedNameNamespaceReference(node: Node): boolean {
  let root = node;
  let isLastClause = true;
  if (root.parent!.kind === SyntaxKind.QualifiedName) {
    while (root.parent !== undefined && root.parent.kind === SyntaxKind.QualifiedName) root = root.parent;
    isLastClause = (root as QualifiedName).right === node;
  }
  return root.parent!.kind === SyntaxKind.TypeReference && !isLastClause;
}

function isPropertyAccessNamespaceReference(node: Node): boolean {
  let root = node;
  let isLastClause = true;
  if (root.parent!.kind === SyntaxKind.PropertyAccessExpression) {
    while (root.parent !== undefined && root.parent.kind === SyntaxKind.PropertyAccessExpression) root = root.parent;
    isLastClause = getName(root) === node;
  }
  const parent = root.parent!;
  if (!isLastClause && parent instanceof ExpressionWithTypeArguments && parent.parent instanceof HeritageClause) {
    const clause = parent.parent;
    const declaration = clause.parent!;
    return (
      (declaration.kind === SyntaxKind.ClassDeclaration && clause.token === SyntaxKind.ImplementsKeyword) ||
      (declaration.kind === SyntaxKind.InterfaceDeclaration && clause.token === SyntaxKind.ExtendsKeyword)
    );
  }
  return false;
}

// ---- Symbols

/** The `extends` and `implements` types of a class or interface. */
export function getAllSuperTypeNodes(node: Node): Node[] {
  const result: Node[] = [];
  if (node.kind === SyntaxKind.InterfaceDeclaration) {
    for (const clause of getHeritageClauses(node)?.nodes ?? [])
      if ((clause as HeritageClause).token === SyntaxKind.ExtendsKeyword)
        for (const t of (clause as HeritageClause).types.nodes) result.push(t);
    return result;
  }
  if (isClassLike(node)) {
    const clauses = getHeritageClauses(node)?.nodes ?? [];
    for (const clause of clauses)
      if ((clause as HeritageClause).token === SyntaxKind.ExtendsKeyword) {
        const types = (clause as HeritageClause).types.nodes;
        if (types.length > 0) result.push(types[0]);
        break;
      }
    for (const clause of clauses)
      if ((clause as HeritageClause).token === SyntaxKind.ImplementsKeyword)
        for (const t of (clause as HeritageClause).types.nodes) result.push(t);
  }
  return result;
}

export function getPropertySymbolFromBindingElement(c: Checker, bindingElement: Node): Symbol | undefined {
  return getPropertyOfType(c, getTypeAtLocation(c, bindingElement.parent!), getText(getName(bindingElement)!));
}

export function getPropertySymbolOfObjectBindingPatternWithoutPropertyName(
  c: Checker,
  symbol: Symbol,
): Symbol | undefined {
  const bindingElement = getDeclarationOfKind(symbol, SyntaxKind.BindingElement);
  if (bindingElement !== undefined && isObjectBindingElementWithoutPropertyName(bindingElement))
    return getPropertySymbolFromBindingElement(c, bindingElement);
  return undefined;
}

/** The object literal property or JSX attribute named by `node`. */
export function getContainingObjectLiteralElement(node: Node): Node | undefined {
  const element = getContainingObjectLiteralElementWorker(node);
  if (
    element !== undefined &&
    (element.parent!.kind === SyntaxKind.ObjectLiteralExpression || element.parent!.kind === SyntaxKind.JsxAttributes)
  )
    return element;
  return undefined;
}

function getContainingObjectLiteralElementWorker(node: Node): Node | undefined {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
      if (node.parent!.kind === SyntaxKind.ComputedPropertyName)
        return isObjectLiteralOrJsxElement(node.parent!.parent!) ? node.parent!.parent : undefined;
    // falls through
    case SyntaxKind.Identifier:
    case SyntaxKind.JsxNamespacedName: {
      const parent = node.parent!;
      if (
        isObjectLiteralOrJsxElement(parent) &&
        (parent.parent!.kind === SyntaxKind.ObjectLiteralExpression ||
          parent.parent!.kind === SyntaxKind.JsxAttributes) &&
        getName(parent) === node
      )
        return parent;
    }
  }
  return undefined;
}

function isObjectLiteralOrJsxElement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.SpreadAssignment:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxSpreadAttribute:
      return true;
  }
  return false;
}

// ---- Contextual types

function isEqualityOperatorKind(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.EqualsEqualsToken ||
    kind === SyntaxKind.EqualsEqualsEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsToken ||
    kind === SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function walkUpParenthesizedExpressions(nodeIn: Node): Node {
  let node = nodeIn;
  while (node.kind === SyntaxKind.ParenthesizedExpression) node = node.parent!;
  return node;
}

export function getContextualTypeFromParent(c: Checker, node: Node): Type | undefined {
  const parent = walkUpParenthesizedExpressions(node.parent!);
  switch (parent.kind) {
    case SyntaxKind.NewExpression:
      return getContextualType(c, parent);
    case SyntaxKind.BinaryExpression: {
      const binary = parent as BinaryExpression;
      if (isEqualityOperatorKind(binary.operatorToken.kind))
        return getTypeAtLocation(c, node === binary.right ? binary.left : binary.right);
      return getContextualType(c, node);
    }
    case SyntaxKind.CaseClause:
      return getSwitchedType(c, parent);
  }
  return getContextualType(c, node);
}

function getSwitchedType(c: Checker, caseClause: Node): Type | undefined {
  return getTypeAtLocation(c, getExpression(caseClause.parent!.parent!)!);
}

export function getContextualTypeFromParentOrAncestorTypeNode(c: Checker, node: Node): Type | undefined {
  if ((node.flags & NodeFlags.JSDoc) !== 0 && (node.flags & NodeFlags.JavaScriptFile) === 0) return undefined;
  const contextualType = getContextualTypeFromParent(c, node);
  if (contextualType !== undefined) return contextualType;
  const ancestorTypeNode = getAncestorTypeNode(node);
  return ancestorTypeNode === undefined ? undefined : getTypeAtLocation(c, ancestorTypeNode);
}

function getAncestorTypeNode(node: Node): Node | undefined {
  let lastTypeNode: Node | undefined;
  findAncestor(node, (n) => {
    if (isTypeNode(n)) lastTypeNode = n;
    const parent = n.parent!;
    return parent.kind !== SyntaxKind.QualifiedName && !isTypeNode(parent) && !isTypeElement(parent);
  });
  return lastTypeNode;
}
