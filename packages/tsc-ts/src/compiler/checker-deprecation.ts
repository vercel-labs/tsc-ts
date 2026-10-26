// Deprecation suggestions: uses of declarations marked `@deprecated` in JSDoc report
// `'X' is deprecated.` with the tag as related information.
import {
  type BinaryExpression,
  type ElementAccessExpression,
  type IndexedAccessTypeNode,
  JSDoc,
  JSDocDeprecatedTag,
  type JsxNamespacedName,
  type Node,
  type SourceFile,
  NodeFlags,
  type QualifiedName,
  type TaggedTemplateExpression,
  type TypeReferenceNode,
  getExpression,
  getName,
  getProperties,
  getTagName,
  getText,
} from './ast.js';
import { isTypeDeclaration } from './ast-utilities.js';
import { isAccessExpression, getCombinedNodeFlags, getSourceFileOfNode, skipParentheses } from './binder-utilities.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { type Signature, SignatureFlags, type Type } from './checker-types.js';
import { type Diagnostic, Diagnostics } from './diagnostics.js';
import { getJSDoc } from './parser.js';
import { SyntaxKind } from './syntax-kind.js';
import { getDeclarationOfAliasSymbol, getParentOfSymbol, resolveAlias } from './checker-symbols.js';
import { getTargetOfAliasDeclaration } from './checker-modules.js';
import { hasMatchingArgument } from './checker-narrowing.js';
import { entityNameToString } from './checker-expressions.js';
import { isErrorType } from './checker-type-factory.js';
import { getPropertyOfType } from './checker-members.js';
import { getApparentTypeOfContextualType } from './checker-contextual.js';
import { signatureToString } from './type-printer.js';
import { declarationAt, declarationCount, getDeclarations, type Symbol, SymbolFlags } from './symbol.js';

/** Whether `declaration`, or the statement it belongs to, has a `@deprecated` JSDoc tag. */
export function isDeprecatedDeclaration(declaration: Node): boolean {
  if ((getCombinedNodeFlags(declaration) & NodeFlags.PossiblyContainsDeprecatedTag) === 0) return false;
  // The JSDoc is on the node with the flag, e.g. the variable statement of a declaration.
  for (let n: Node | undefined = declaration; n !== undefined; n = n.parent)
    if ((n.flags & NodeFlags.PossiblyContainsDeprecatedTag) !== 0) return getJSDocDeprecatedTag(n) !== undefined;
  return false;
}

function getJSDocDeprecatedTag(node: Node): Node | undefined {
  for (const jsDoc of getJSDoc(getSourceFileOfNode(node), node)) {
    if (!(jsDoc instanceof JSDoc) || jsDoc.tags === undefined) continue;
    for (const tag of jsDoc.tags.nodes) if (tag instanceof JSDocDeprecatedTag) return tag;
  }
  return undefined;
}

/**
 * Whether `symbol` is deprecated: an interface member when any declaration is, other merged
 * members when all are.
 */
export function isDeprecatedSymbol(c: Checker, symbol: Symbol): boolean {
  const count = declarationCount(symbol);
  const parentSymbol = getParentOfSymbol(c, symbol);
  if (parentSymbol !== undefined && count > 1)
    return (parentSymbol.flags & SymbolFlags.Interface) !== 0
      ? someDeprecatedDeclaration(symbol)
      : everyDeprecatedDeclaration(symbol);
  return (
    (symbol.valueDeclaration !== undefined && isDeprecatedDeclaration(symbol.valueDeclaration)) ||
    (count !== 0 && everyDeprecatedDeclaration(symbol))
  );
}

function someDeprecatedDeclaration(symbol: Symbol): boolean {
  for (let i = 0; i < declarationCount(symbol); i++) if (isDeprecatedDeclaration(declarationAt(symbol, i))) return true;
  return false;
}

function everyDeprecatedDeclaration(symbol: Symbol): boolean {
  for (let i = 0; i < declarationCount(symbol); i++)
    if (!isDeprecatedDeclaration(declarationAt(symbol, i))) return false;
  return true;
}

export function addDeprecatedSuggestion(
  c: Checker,
  location: Node,
  declarations: readonly Node[],
  deprecatedEntity: string,
): Diagnostic {
  const diagnostic = createDiagnosticForNode(location, Diagnostics.X_0_is_deprecated, [deprecatedEntity]);
  return addDeprecatedSuggestionWorker(c, declarations, diagnostic);
}

function addDeprecatedSuggestionWorker(c: Checker, declarations: readonly Node[], diagnostic: Diagnostic): Diagnostic {
  for (const declaration of declarations) {
    const deprecatedTag = getJSDocDeprecatedTag(declaration);
    if (deprecatedTag !== undefined) {
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(deprecatedTag, Diagnostics.The_declaration_was_marked_as_deprecated_here, []),
      );
      break;
    }
  }
  c.addSuggestion(diagnostic);
  return diagnostic;
}

/** Reports a call, `new`, tagged template, decorator or JSX element resolved to a deprecated signature. */
export function checkDeprecatedSignature(c: Checker, signature: Signature, node: Node): void {
  if ((signature.flags & SignatureFlags.IsSignatureCandidateForOverloadFailure) !== 0) return;
  const declaration = signature.declaration;
  if (declaration === undefined || !isDeprecatedDeclaration(declaration)) return;
  const name = tryGetPropertyAccessOrIdentifierToString(getInvokedExpression(node));
  const signatureString = signatureToString(c, signature);
  const diagnostic =
    name !== ''
      ? createDiagnosticForNode(getDeprecatedSuggestionNode(node), Diagnostics.The_signature_0_of_1_is_deprecated, [
          signatureString,
          name,
        ])
      : createDiagnosticForNode(getDeprecatedSuggestionNode(node), Diagnostics.X_0_is_deprecated, [signatureString]);
  addDeprecatedSuggestionWorker(c, [declaration], diagnostic);
}

function getInvokedExpression(node: Node): Node {
  switch (node.kind) {
    case SyntaxKind.TaggedTemplateExpression:
      return (node as TaggedTemplateExpression).tag;
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
      return getTagName(node)!;
    case SyntaxKind.BinaryExpression:
      return (node as BinaryExpression).right;
    case SyntaxKind.JsxOpeningFragment:
      return node;
  }
  return getExpression(node)!;
}

function tryGetPropertyAccessOrIdentifierToString(expr: Node): string {
  switch (expr.kind) {
    case SyntaxKind.PropertyAccessExpression: {
      const base = tryGetPropertyAccessOrIdentifierToString(getExpression(expr)!);
      return base !== '' ? base + '.' + entityNameToString(getName(expr)!) : '';
    }
    case SyntaxKind.ElementAccessExpression: {
      const base = tryGetPropertyAccessOrIdentifierToString(getExpression(expr)!);
      const argument = (expr as ElementAccessExpression).argumentExpression;
      return base !== '' && isPropertyNameLiteral(argument) ? base + '.' + getText(argument) : '';
    }
    case SyntaxKind.Identifier:
      return getText(expr);
    case SyntaxKind.JsxNamespacedName: {
      const name = expr as JsxNamespacedName;
      return getText(name.namespace) + ':' + getText(name.name);
    }
  }
  return '';
}

function isPropertyNameLiteral(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.BigIntLiteral:
      return true;
  }
  return false;
}

/** The part of a use that a deprecation suggestion underlines. */
export function getDeprecatedSuggestionNode(node: Node): Node {
  const current = skipParentheses(node);
  switch (current.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.Decorator:
    case SyntaxKind.NewExpression:
      return getDeprecatedSuggestionNode(getExpression(current)!);
    case SyntaxKind.TaggedTemplateExpression:
      return getDeprecatedSuggestionNode((current as TaggedTemplateExpression).tag);
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
      return getDeprecatedSuggestionNode(getTagName(current)!);
    case SyntaxKind.ElementAccessExpression:
      return (current as ElementAccessExpression).argumentExpression;
    case SyntaxKind.PropertyAccessExpression:
      return getName(current)!;
    case SyntaxKind.TypeReference: {
      const typeName = (current as TypeReferenceNode).typeName;
      if (typeName.kind === SyntaxKind.QualifiedName) return (typeName as QualifiedName).right;
    }
  }
  return current;
}

/**
 * Whether a use of a deprecated function or method counts: calls are reported through their
 * signature, unless the reference is also an argument.
 */
function isUncalledFunctionReference(c: Checker, node: Node, symbol: Symbol): boolean {
  if ((symbol.flags & (SymbolFlags.Function | SymbolFlags.Method)) === 0) return true;
  let parent = node.parent;
  while (parent !== undefined && isAccessExpression(parent)) parent = parent.parent;
  if (parent === undefined) parent = node.parent!;
  if (isCallLikeExpression(parent))
    return (
      (parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) &&
      node.kind === SyntaxKind.Identifier &&
      hasMatchingArgument(c, parent, node)
    );
  for (const d of getDeclarations(symbol)) if (isFunctionLikeKind(d.kind) && !isDeprecatedDeclaration(d)) return false;
  return true;
}

function isCallLikeExpression(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxOpeningFragment:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.Decorator:
      return true;
    case SyntaxKind.BinaryExpression:
      return (node as BinaryExpression).operatorToken.kind === SyntaxKind.InstanceOfKeyword;
  }
  return false;
}

function isFunctionLikeKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.JSDocSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return true;
  }
  return false;
}

/** Resolves an alias, reporting the first deprecated alias along the way to its target. */
export function resolveAliasWithDeprecationCheck(c: Checker, symbol: Symbol, location: Node): Symbol {
  if (
    (symbol.flags & SymbolFlags.Alias) === 0 ||
    isDeprecatedSymbol(c, symbol) ||
    getDeclarationOfAliasSymbol(symbol) === undefined
  )
    return symbol;
  const targetSymbol = resolveAlias(c, symbol);
  if (targetSymbol === c.unknownSymbol) return targetSymbol;
  let current = symbol;
  while ((current.flags & SymbolFlags.Alias) !== 0) {
    const target = getImmediateAliasedSymbol(c, current);
    if (target === undefined || target === targetSymbol) break;
    if (declarationCount(target) !== 0) {
      if (isDeprecatedSymbol(c, target)) {
        addDeprecatedSuggestion(c, location, getDeclarations(target), target.name);
        break;
      }
      if (current === targetSymbol) break;
      current = target;
    }
  }
  return targetSymbol;
}

function getImmediateAliasedSymbol(c: Checker, symbol: Symbol): Symbol | undefined {
  const links = c.symbolLinks(symbol);
  if (links.immediateTarget === undefined)
    links.immediateTarget = getTargetOfAliasDeclaration(c, getDeclarationOfAliasSymbol(symbol));
  return links.immediateTarget;
}

// ---- Uses

/** Resolves the alias an identifier refers to and reports a deprecated target. */
export function checkDeprecatedIdentifier(c: Checker, node: Node, localOrExportSymbol: Symbol): void {
  const targetSymbol = resolveAliasWithDeprecationCheck(c, localOrExportSymbol, node);
  if (
    declarationCount(targetSymbol) !== 0 &&
    isDeprecatedSymbol(c, targetSymbol) &&
    isUncalledFunctionReference(c, node, targetSymbol)
  )
    addDeprecatedSuggestion(c, node, getDeclarations(targetSymbol), getText(node));
}

/** Reports a property access to a deprecated property. */
export function checkDeprecatedProperty(c: Checker, node: Node, right: Node, prop: Symbol): void {
  const targetPropSymbol = resolveAliasWithDeprecationCheck(c, prop, right);
  if (
    isDeprecatedSymbol(c, targetPropSymbol) &&
    isUncalledFunctionReference(c, node, targetPropSymbol) &&
    declarationCount(targetPropSymbol) !== 0
  )
    addDeprecatedSuggestion(c, right, getDeclarations(targetPropSymbol), getText(right));
}

/** Reports a property access resolved through a deprecated index signature. */
export function checkDeprecatedIndexSignature(c: Checker, right: Node, declaration: Node | undefined): void {
  if (declaration !== undefined && isDeprecatedDeclaration(declaration))
    addDeprecatedSuggestion(c, right, [declaration], getText(right));
}

/** Reports an element access or indexed access type selecting a deprecated property. */
export function checkDeprecatedIndexedAccess(c: Checker, accessNode: Node, prop: Symbol, propName: string): void {
  if (declarationCount(prop) === 0 || !isDeprecatedSymbol(c, prop) || !isUncalledFunctionReference(c, accessNode, prop))
    return;
  const deprecatedNode =
    accessNode.kind === SyntaxKind.ElementAccessExpression
      ? (accessNode as ElementAccessExpression).argumentExpression
      : accessNode.kind === SyntaxKind.IndexedAccessType
        ? (accessNode as IndexedAccessTypeNode).indexType
        : accessNode;
  addDeprecatedSuggestion(c, deprecatedNode, getDeclarations(prop), propName);
}

/** Reports a type reference or import type naming a deprecated type. */
export function checkDeprecatedTypeReference(c: Checker, node: Node, type: Type): void {
  if (isErrorType(c, type)) return;
  const symbol = c.resolvedSymbols.get(node.id);
  if (symbol === undefined) return;
  for (let i = 0; i < declarationCount(symbol); i++) {
    const d = declarationAt(symbol, i);
    if (isTypeDeclaration(d) && isDeprecatedDeclaration(d)) {
      addDeprecatedSuggestion(c, getDeprecatedSuggestionNode(node), getDeclarations(symbol), symbol.name);
      return;
    }
  }
}

/** Reports an import specifier importing a deprecated declaration. */
export function checkDeprecatedImportSpecifier(c: Checker, node: Node, symbol: Symbol): void {
  const targetSymbol = resolveAliasWithDeprecationCheck(c, symbol, node);
  if (isDeprecatedSymbol(c, targetSymbol) && declarationCount(targetSymbol) !== 0)
    addDeprecatedSuggestion(c, node, getDeclarations(targetSymbol), targetSymbol.name);
}

/** Reports the deprecated properties the checked object literals of `file` set (`checkContextualDeprecations`). */
export function checkObjectLiteralDeprecations(c: Checker, file: SourceFile): void {
  const pending = c.objectLiteralsForDeprecations.get(file);
  if (pending === undefined) return;
  c.objectLiteralsForDeprecations.delete(file);
  for (const node of pending) checkContextualDeprecations(c, node);
}

/**
 * Reports the members of an object literal or the attributes of a JSX element that set a deprecated
 * property of its contextual type. Deferred, so the contextual type of the final check is used.
 */
export function checkContextualDeprecations(c: Checker, node: Node): void {
  const contextualType = getApparentTypeOfContextualType(c, node);
  if (contextualType === undefined) return;
  for (const property of getProperties(node)!.nodes) {
    const name = getName(property);
    if (name === undefined || name.kind === SyntaxKind.ComputedPropertyName) continue;
    const text =
      name.kind === SyntaxKind.JsxNamespacedName
        ? (name as JsxNamespacedName).namespace.text + ':' + (name as JsxNamespacedName).name.text
        : getText(name);
    const prop = getPropertyOfType(c, contextualType, text);
    if (prop !== undefined && declarationCount(prop) !== 0 && isDeprecatedSymbol(c, prop))
      addDeprecatedSuggestion(c, name, getDeclarations(prop), text);
  }
}
