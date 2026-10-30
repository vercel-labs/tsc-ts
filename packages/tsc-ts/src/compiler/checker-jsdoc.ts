// JSDoc semantics: the intended types of JSDoc type references like `String`, `function` and
// `Object<K, V>`, functions typed by a JSDoc `@type` tag, and `@param` tags without parameters.
import {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  type ExpressionWithTypeArguments,
  type JSDoc,
  type JSDocAugmentsTag,
  type JSDocParameterOrPropertyTag,
  MethodDeclaration,
  type Node,
  NodeFlags,
  NodeVisitor,
  type QualifiedName,
  type TypeReferenceNode,
  getBody,
  type VariableDeclarationList,
  getDotDotDotToken,
  getExpression,
  getInitializer,
  getName,
  getParameters,
  getText,
  getType,
} from './ast.js';
import {
  getSourceFileOfNode,
  getSourceTextOfNode,
  isEntityNameExpression,
  isTypeNodeKind,
} from './binder-utilities.js';
import { isTypeAssignableTo, isTypeIdenticalTo } from './relations.js';
import { getAttachedJSDoc, getJSDoc } from './parser.js';
import { isInJSFile } from './ast-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import type { Signature, Type } from './checker-types.js';
import { getGlobalTypeAliasSymbol } from './checker-symbols.js';
import { checkNoTypeArguments, getTypeAliasInstantiation, getTypeFromTypeNode } from './checker-type-nodes.js';
import { createPromiseType } from './checker-iteration.js';
import { isValidIndexKeyType } from './checker-utilities.js';
import {
  getRestTypeAtPosition,
  getReturnTypeOfSignature,
  getSingleCallSignature,
  getTypeAtPosition,
} from './checker-signatures.js';
import { getContextualCallSignature } from './checker-contextual.js';
import { entityNameToString, getResolvedSymbol } from './checker-expressions.js';
import { isArrayType } from './checker-type-factory.js';
import { checkSourceElement } from './checker-source-file.js';

/** The type a JSDoc type reference to a JavaScript-style name means, if it is one. */
export function getIntendedTypeFromJSDocTypeReference(c: Checker, node: Node): Type | undefined {
  if ((node.flags & NodeFlags.JSDoc) === 0 || node.kind !== SyntaxKind.TypeReference) return undefined;
  const reference = node as TypeReferenceNode;
  const typeName = reference.typeName;
  if (typeName.kind !== SyntaxKind.Identifier) return undefined;
  const typeArguments = reference.typeArguments !== undefined ? reference.typeArguments.nodes : [];
  switch (getText(typeName)) {
    case 'String':
      checkNoTypeArguments(c, node, undefined);
      return c.stringType;
    case 'Number':
      checkNoTypeArguments(c, node, undefined);
      return c.numberType;
    case 'BigInt':
      checkNoTypeArguments(c, node, undefined);
      return c.bigintType;
    case 'Boolean':
      checkNoTypeArguments(c, node, undefined);
      return c.booleanType;
    case 'Void':
      checkNoTypeArguments(c, node, undefined);
      return c.voidType;
    case 'Undefined':
      checkNoTypeArguments(c, node, undefined);
      return c.undefinedType;
    case 'Null':
      checkNoTypeArguments(c, node, undefined);
      return c.nullType;
    case 'Function':
    case 'function':
      checkNoTypeArguments(c, node, undefined);
      return c.globalFunctionType;
    case 'array':
      if (typeArguments.length === 0 && !c.noImplicitAny) return c.anyArrayType;
      break;
    case 'promise':
      if (typeArguments.length === 0 && !c.noImplicitAny) return createPromiseType(c, c.anyType);
      break;
    case 'Object':
      if (typeArguments.length === 2) {
        const recordSymbol = getGlobalTypeAliasSymbol(c, 'Record', 2, true);
        if (recordSymbol !== undefined) {
          const indexType = getTypeFromTypeNode(c, typeArguments[0]!);
          if (isValidIndexKeyType(c, indexType))
            return getTypeAliasInstantiation(
              c,
              recordSymbol,
              [indexType, getTypeFromTypeNode(c, typeArguments[1]!)],
              undefined,
            );
        }
        return c.anyType;
      }
      if (!c.noImplicitAny) {
        checkNoTypeArguments(c, node, undefined);
        return c.anyType;
      }
      break;
  }
  return undefined;
}

// ---- Functions typed by `@type`

/** The JSDoc `@type` of a function, method or arrow function in a JavaScript file. */
export function getFullSignatureTypeNode(node: Node): Node | undefined {
  if (!isInJSFile(node)) return undefined;
  if (node instanceof FunctionDeclaration) return (node as FunctionDeclaration).fullSignature;
  if (node instanceof MethodDeclaration) return (node as MethodDeclaration).fullSignature;
  if (node instanceof FunctionExpression) return (node as FunctionExpression).fullSignature;
  if (node instanceof ArrowFunction) return (node as ArrowFunction).fullSignature;
  return undefined;
}

/** The signature a JSDoc `@type` tag gives a function. */
export function getSignatureOfFullSignatureType(c: Checker, node: Node): Signature | undefined {
  const typeNode = getFullSignatureTypeNode(node);
  return typeNode !== undefined ? getSingleCallSignature(c, getTypeFromTypeNode(c, typeNode)) : undefined;
}

/** The type of a parameter of a function typed by a JSDoc `@type` tag. */
export function getParameterTypeOfFullSignature(c: Checker, fn: Node, parameter: Node): Type | undefined {
  const signature = getSignatureOfFullSignatureType(c, fn);
  if (signature === undefined) return undefined;
  const pos = getParameters(fn)!.nodes.indexOf(parameter);
  return getDotDotDotToken(parameter) !== undefined
    ? getRestTypeAtPosition(c, signature, pos, false)
    : getTypeAtPosition(c, signature, pos);
}

/** The return type of a function typed by a JSDoc `@type` tag. */
export function getReturnTypeOfFullSignature(c: Checker, fn: Node): Type | undefined {
  const signature = getSignatureOfFullSignatureType(c, fn);
  return signature !== undefined ? getReturnTypeOfSignature(c, signature) : undefined;
}

/** Checks the type of a JSDoc `@type` on a function as a type node. */
export function checkJSDocFullSignatureType(c: Checker, fn: Node): void {
  const typeNode = getFullSignatureTypeNode(fn);
  if (typeNode !== undefined) checkSourceElement(c, typeNode);
}

/** A JSDoc `@type` on a function needs a call signature taking at least its parameters. */
export function checkJSDocFullSignature(c: Checker, fn: Node): void {
  const typeNode = getFullSignatureTypeNode(fn);
  if (typeNode === undefined) return;
  if (getContextualCallSignature(c, getTypeFromTypeNode(c, typeNode), fn) === undefined)
    c.error(
      typeNode,
      Diagnostics.A_JSDoc_type_tag_on_a_function_must_have_a_signature_with_the_correct_number_of_arguments,
    );
}

// ---- `@param` tags

/** The tags of the last JSDoc comment of `node` or of the declaration or statement it heads. */
function getAllJSDocTags(node: Node): readonly Node[] {
  if ((node.flags & NodeFlags.JSDoc) !== 0) return [];
  const file = getSourceFileOfNode(node);
  for (let current: Node | undefined = node; current !== undefined; current = getNextJSDocCommentLocation(current)) {
    const jsDoc = getJSDoc(file, current);
    if (jsDoc.length === 0) continue;
    const tags = (jsDoc[jsDoc.length - 1]! as JSDoc).tags;
    if (tags !== undefined) return tags.nodes;
  }
  return [];
}

function getNextJSDocCommentLocation(node: Node): Node | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ExpressionStatement:
      return parent;
    case SyntaxKind.VariableDeclarationList:
      return (parent as VariableDeclarationList).declarations.nodes[0]! === node ? parent : undefined;
  }
  return undefined;
}

/**
 * Reports `@param` tags of a JavaScript function naming no parameter, and qualified `@param` names
 * without a parent `@param {object}`.
 */
export function checkUnmatchedJSDocParameters(c: Checker, node: Node): void {
  // Only JavaScript files report unmatched tags. In a TypeScript file with `@param` tags, tsgo still resolves the
  // `arguments` references of the body (containsArgumentsReference), which can report errors, such as TS2448 for a
  // `const arguments`. The JSDoc of a TypeScript function is parsed only when its file has an identifier `arguments`.
  const isJs = isInJSFile(node);
  if (!isJs && !fileMentionsArguments(c, node)) return;
  const jsdocParameters: JSDocParameterOrPropertyTag[] = [];
  for (const tag of getAllJSDocTags(node)) {
    if (tag.kind !== SyntaxKind.JSDocParameterTag) continue;
    const name = (tag as JSDocParameterOrPropertyTag).name;
    if (name.kind === SyntaxKind.Identifier && getText(name).length === 0) continue;
    jsdocParameters.push(tag as JSDocParameterOrPropertyTag);
  }
  if (jsdocParameters.length === 0) return;
  const parameters = new Set<string>();
  const excludedParameters = new Set<number>();
  const params = getParameters(node)!.nodes;
  for (let i = 0; i < params.length; i++) {
    const name = getName(params[i]!)!;
    if (name.kind === SyntaxKind.Identifier) parameters.add(getText(name));
    if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
      excludedParameters.add(i);
  }
  if (containsArgumentsReference(c, node)) {
    if (!isJs) return;
    const lastIndex = jsdocParameters.length - 1;
    const last = jsdocParameters[lastIndex]!;
    if (last.name.kind !== SyntaxKind.Identifier) return;
    if (excludedParameters.has(lastIndex) || parameters.has(getText(last.name))) return;
    const typeExpression = last.typeExpression;
    const typeNode = typeExpression !== undefined ? getType(typeExpression) : undefined;
    if (typeNode === undefined || isArrayType(c, getTypeFromTypeNode(c, typeNode))) return;
    c.error(
      last.name,
      Diagnostics.JSDoc_param_tag_has_name_0_but_there_is_no_parameter_with_that_name_It_would_match_arguments_if_it_had_an_array_type,
      getText(last.name),
    );
    return;
  }
  if (!isJs) return;
  for (let index = 0; index < jsdocParameters.length; index++) {
    const tag = jsdocParameters[index]!;
    const name = tag.name;
    if (excludedParameters.has(index) || (name.kind === SyntaxKind.Identifier && parameters.has(getText(name))))
      continue;
    if (name.kind === SyntaxKind.QualifiedName)
      c.error(
        name,
        Diagnostics.Qualified_name_0_is_not_allowed_without_a_leading_param_object_1,
        entityNameToString(name),
        entityNameToString((name as QualifiedName).left),
      );
    else if (!tag.isNameFirst)
      c.error(name, Diagnostics.JSDoc_param_tag_has_name_0_but_there_is_no_parameter_with_that_name, getText(name));
  }
}

/** Finds a reference to `arguments` outside nested functions and types. */
class ArgumentsReferenceFinder extends NodeVisitor {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.Identifier:
        return getText(node) === 'arguments' && getResolvedSymbol(this.c, node) === this.c.argumentsSymbol;
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor: {
        const name = getName(node);
        if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) return this.visitNode(name);
        break;
      }
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        return this.visitNode(getExpression(node)!);
      case SyntaxKind.PropertyAssignment:
        return this.visitNode(getInitializer(node)!);
    }
    if (startsNewLexicalEnvironment(node) || isTypeNodeKind(node.kind)) return false;
    return node.forEachChild(this);
  }
}

function startsNewLexicalEnvironment(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Constructor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.SourceFile:
      return true;
  }
  return false;
}

/** Whether the file of `node` has an identifier `arguments`; cached in the links of the source file. */
function fileMentionsArguments(c: Checker, node: Node): boolean {
  const file = getSourceFileOfNode(node);
  const links = c.nodeLinks(file);
  if (links.mentionsArguments === 0) links.mentionsArguments = file.identifierTexts.includes('arguments') ? 2 : 1;
  return links.mentionsArguments === 2;
}

function containsArgumentsReference(c: Checker, node: Node): boolean {
  const body = getBody(node);
  if (body === undefined) return false;
  const links = c.nodeLinks(node);
  if (links.containsArgumentsReference === 0)
    links.containsArgumentsReference = new ArgumentsReferenceFinder(c).visitNode(body) ? 2 : 1;
  return links.containsArgumentsReference === 2;
}

// ---- `@augments`

/** The rightmost identifier of `a.b.c`, or `a` itself. */
function getIdentifierFromEntityNameExpression(node: Node): Node | undefined {
  if (node.kind === SyntaxKind.Identifier) return node;
  if (node.kind === SyntaxKind.PropertyAccessExpression) return getName(node);
  return undefined;
}

/**
 * Reports an `@augments` or `@extends` tag of a JavaScript class whose class doesn't match the
 * `extends` clause: for an entity name, a different type; for another expression, a type the base
 * type isn't assignable to.
 */
export function checkJSDocAugmentsTagMatchesExtends(
  c: Checker,
  node: Node,
  baseTypeNode: ExpressionWithTypeArguments,
  baseType: Type,
): void {
  if (!isInJSFile(node)) return;
  const jsDoc = getAttachedJSDoc(node);
  if (jsDoc === undefined) return;
  for (const j of jsDoc) {
    const tags = (j as JSDoc).tags;
    if (tags === undefined) continue;
    for (const tag of tags.nodes) {
      if (tag.kind !== SyntaxKind.JSDocAugmentsTag) continue;
      const augments = tag as JSDocAugmentsTag;
      const sourceType = getTypeFromTypeNode(c, augments.className);
      const sourceName = getIdentifierFromEntityNameExpression(augments.className.expression);
      if (isEntityNameExpression(baseTypeNode.expression, false)) {
        if (isTypeIdenticalTo(c, sourceType, baseType)) continue;
        const targetName = getIdentifierFromEntityNameExpression(baseTypeNode.expression);
        if (targetName !== undefined && sourceName !== undefined)
          c.error(
            sourceName,
            Diagnostics.JSDoc_0_1_does_not_match_the_extends_2_clause,
            getText(augments.tagName),
            getText(sourceName),
            getText(targetName),
          );
      } else if (sourceName !== undefined && !isTypeAssignableTo(c, baseType, sourceType)) {
        const expression = baseTypeNode.expression;
        c.error(
          sourceName,
          Diagnostics.JSDoc_0_1_does_not_match_the_extends_2_clause,
          getText(augments.tagName),
          getText(sourceName),
          getSourceTextOfNode(getSourceFileOfNode(expression), expression),
        );
      }
    }
  }
}
