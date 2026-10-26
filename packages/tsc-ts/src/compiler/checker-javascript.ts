// JavaScript semantics: CommonJS `module.exports`, `exports.x` and `require`, expando assignments
// (`f.x = …`, `o = {}; o.x = …`), `this.x` assignment declarations and auto-typed properties,
// `Object.defineProperty` declarations, and object literals that allow unknown members.
import {
  BinaryExpression,
  type ElementAccessExpression,
  type Node,
  NodeFlags,
  NodeVisitor,
  PropertyAccessExpression,
  getArguments,
  getExpression,
  getInitializer,
  getProperties,
  getSymbol,
  getText,
  getType,
} from './ast.js';
import { isFunctionLike, isInJSFile, isRequireCall } from './ast-utilities.js';
import { getSymbolNameForPrivateIdentifier } from './binder.js';
import {
  JSDeclarationKind,
  getAssignmentDeclarationKind,
  expressionIsAlias,
  getDeclarationOfKind,
  getSourceFileOfNode,
  getThisContainer,
  isAccessExpression,
  isJsonSourceFile,
  isStringOrNumericLiteralLike,
  isVariableDeclarationInitializedToRequire,
} from './binder-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { ObjectFlags, type Type, TypeFlags } from './checker-types.js';
import {
  createAnonymousType,
  filterType,
  getRegularTypeOfLiteralType,
  getUnionType,
  typesOf,
} from './checker-type-factory.js';
import { getExportSymbolOfValueSymbolIfExported, getSymbolOfDeclaration, resolveName } from './checker-symbols.js';
import { resolveExternalModuleName, resolveExternalModuleSymbol } from './checker-modules.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { getPropertyOfType, getResolvedBaseConstraint, getTypeOfPropertyOfType } from './checker-members.js';
import {
  ContextFlags,
  getApparentTypeOfContextualTypeEx,
  getTypeOfPropertyOfContextualType,
} from './checker-contextual.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from './checker-utilities.js';
import { getReturnTypeOfSignature, getSingleCallSignature, getTypeAtPosition } from './checker-signatures.js';
import {
  checkExpressionCached,
  checkExpressionForMutableLocation,
  getResolvedSymbol,
  getTypeOfExpression,
} from './checker-expressions.js';
import { getFlowTypeOfReference, isMatchingReference } from './checker-narrowing.js';
import { isEmptyArrayLiteralType } from './relations.js';
import { getTypeOfSymbol, getWidenedType, reportImplicitAny } from './checker-symbol-types.js';
import {
  getFlowTypeInConstructor,
  getFlowTypeOfProperty,
  getTypeOfPropertyInBaseClass,
  isAutoTypedProperty,
} from './checker-classes.js';
import { declarationCount, getDeclarations, type Symbol, SymbolFlags } from './symbol.js';

/** How the `this.x` assignments declaring a property are typed. */
const enum ThisAssignmentKind {
  /** Not all declarations are `this.x` assignments. */
  None,
  /** A JSDoc type annotates one of them. */
  Typed,
  /** One is in the constructor; its type comes from control flow at the constructor's end. */
  Constructor,
  /** All are in methods; the base class property's type, or the union of all assigned types. */
  Method,
}

/** The type of the CommonJS `module` symbol or its `exports` property. */
export function getTypeOfModuleExportsSymbol(c: Checker, symbol: Symbol): Type {
  if (symbol.name === 'exports') {
    const target = resolveExternalModuleSymbol(c, getSymbolOfDeclaration(c, symbol.valueDeclaration!)!, false);
    return target !== undefined ? getTypeOfSymbol(c, target) : c.errorType;
  }
  return createAnonymousType(c, symbol, symbol.members, [], [], []);
}

/** The type of a symbol declared by JavaScript assignments or `Object.defineProperty` calls. */
export function getWidenedTypeForAssignmentDeclaration(c: Checker, symbol: Symbol): Type {
  let t: Type | undefined;
  const kind = getThisAssignmentKind(c, symbol);
  const location = c.symbolLinks(symbol).thisAssignmentLocation;
  if (kind === ThisAssignmentKind.Typed) t = getTypeFromTypeNode(c, location!);
  else if (kind === ThisAssignmentKind.Constructor) t = getFlowTypeInConstructor(c, symbol, location!);
  else if (kind === ThisAssignmentKind.Method) t = getTypeOfPropertyInBaseClass(c, symbol);
  if (t === undefined) {
    const types: Type[] = [];
    const declarations = getDeclarations(symbol);
    for (let i = 0; i < declarations.length; i++) {
      const declaration = declarations[i]!;
      const declaredType = declaration instanceof BinaryExpression ? (declaration as BinaryExpression).type : undefined;
      if (declaredType !== undefined) {
        t = getTypeFromTypeNode(c, declaredType);
        break;
      }
      const assignedType = getAssignmentDeclarationInitializerType(c, declaration);
      // An initial `exports.x = undefined` is ignored when there are other declarations.
      if (
        assignedType !== undefined &&
        (getAssignmentDeclarationKind(declaration) !== JSDeclarationKind.ExportsProperty ||
          i !== 0 ||
          declarations.length === 1 ||
          (assignedType.flags & TypeFlags.Undefined) === 0) &&
        !types.includes(assignedType)
      )
        types.push(assignedType);
    }
    if (kind === ThisAssignmentKind.Method && types.length > 0 && c.strictNullChecks) {
      if (!types.includes(c.undefinedOrMissingType)) types.push(c.undefinedOrMissingType);
    }
    if (t === undefined) t = types.length !== 0 ? getUnionType(c, types) : c.anyType;
  }
  t = getWidenedType(c, t);
  // An all-nullable or empty union is an implicit any in JS files.
  if (
    symbol.valueDeclaration !== undefined &&
    isInJSFile(symbol.valueDeclaration) &&
    filterType(c, t, isNonNullableType) === c.neverType
  ) {
    reportImplicitAny(c, symbol.valueDeclaration, c.anyType);
    return c.anyType;
  }
  return t;
}

function isNonNullableType(t: Type): boolean {
  return (t.flags & ~TypeFlags.Nullable) !== 0;
}

function getAssignmentDeclarationInitializerType(c: Checker, node: Node): Type | undefined {
  if (node instanceof BinaryExpression) {
    let t: Type;
    switch (getAssignmentDeclarationKind(node)) {
      case JSDeclarationKind.ModuleExports:
      case JSDeclarationKind.ExportsProperty:
        t = getRegularTypeOfLiteralType(c, checkExpressionCached(c, getRightMostAssignedExpression(node)));
        break;
      case JSDeclarationKind.ThisProperty:
        if (containsSameNamedThisProperty(c, node.left, node.right)) return undefined;
        t = checkExpressionForMutableLocation(c, node.right);
        break;
      default:
        t = checkExpressionForMutableLocation(c, node.right);
    }
    if (isEmptyArrayLiteralType(c, t) && !hasParentWithTypeAnnotation(c, node.symbol!)) {
      reportImplicitAny(c, node, c.anyArrayType);
      return c.anyArrayType;
    }
    return t;
  }
  if (node.kind === SyntaxKind.CallExpression) return getTypeFromPropertyDescriptor(c, getArguments(node)!.nodes[2]!);
  return undefined;
}

export function getRightMostAssignedExpression(node: Node): Node {
  let current = node;
  while (current instanceof BinaryExpression && current.operatorToken.kind === SyntaxKind.EqualsToken)
    current = current.right;
  return current;
}

/** Whether the parent of an expando symbol is a function expression whose variable is annotated. */
function hasParentWithTypeAnnotation(c: Checker, symbol: Symbol): boolean {
  const parent = symbol.parent;
  if (parent === undefined || parent.valueDeclaration === undefined) return false;
  const kind = parent.valueDeclaration.kind;
  if (kind !== SyntaxKind.FunctionExpression && kind !== SyntaxKind.ArrowFunction) return false;
  const annotated = getSymbolOfDeclaration(c, parent.valueDeclaration.parent!);
  return (
    annotated !== undefined &&
    annotated.valueDeclaration !== undefined &&
    getType(annotated.valueDeclaration) !== undefined
  );
}

/** Finds a reference to a `this.x` property outside nested functions. */
class SameNamedThisPropertyFinder extends NodeVisitor {
  readonly c: Checker;
  readonly thisProperty: Node;

  constructor(c: Checker, thisProperty: Node) {
    super();
    this.c = c;
    this.thisProperty = thisProperty;
  }

  visitNode(node: Node): boolean {
    if (isMatchingReference(this.c, this.thisProperty, node)) return true;
    if (isFunctionLike(node)) return false;
    return node.forEachChild(this);
  }
}

function containsSameNamedThisProperty(c: Checker, thisProperty: Node, expression: Node): boolean {
  return new SameNamedThisPropertyFinder(c, thisProperty).visitNode(expression);
}

function getTypeFromPropertyDescriptor(c: Checker, node: Node): Type | undefined {
  const objectLiteralType = checkExpressionCached(c, node);
  const valueType = getTypeOfPropertyOfType(c, objectLiteralType, 'value');
  if (valueType !== undefined) return valueType;
  const getFunc = getTypeOfPropertyOfType(c, objectLiteralType, 'get');
  if (getFunc !== undefined) {
    const getSig = getSingleCallSignature(c, getFunc);
    if (getSig !== undefined) return getReturnTypeOfSignature(c, getSig);
  }
  const setFunc = getTypeOfPropertyOfType(c, objectLiteralType, 'set');
  if (setFunc !== undefined) {
    const setSig = getSingleCallSignature(c, setFunc);
    if (setSig !== undefined) return getTypeAtPosition(c, setSig, 0);
  }
  return c.anyType;
}

// ---- `this.x` assignment declarations

function getThisAssignmentKind(c: Checker, symbol: Symbol): ThisAssignmentKind {
  if (!(symbol.valueDeclaration instanceof BinaryExpression)) return ThisAssignmentKind.None;
  const links = c.symbolLinks(symbol);
  if (links.thisAssignmentKind !== 0) return (links.thisAssignmentKind - 1) as ThisAssignmentKind;
  let allThis = true;
  let typeAnnotation: Node | undefined;
  for (const declaration of getDeclarations(symbol)) {
    if (!(declaration instanceof BinaryExpression)) {
      allThis = false;
      break;
    }
    const left = declaration.left;
    if (
      getAssignmentDeclarationKind(declaration) === JSDeclarationKind.ThisProperty &&
      (left.kind !== SyntaxKind.ElementAccessExpression || isStringOrNumericLiteralLike(getArgumentExpression(left)))
    ) {
      if (declaration.type !== undefined) typeAnnotation = declaration.type;
    } else {
      allThis = false;
      break;
    }
  }
  let kind = ThisAssignmentKind.None;
  let location: Node | undefined;
  if (allThis) {
    if (typeAnnotation !== undefined) {
      location = typeAnnotation;
      kind = ThisAssignmentKind.Typed;
    } else {
      location = getDeclaringConstructor(symbol);
      kind = location === undefined ? ThisAssignmentKind.Method : ThisAssignmentKind.Constructor;
    }
  }
  links.thisAssignmentKind = kind + 1;
  links.thisAssignmentLocation = location;
  return kind;
}

function getArgumentExpression(node: Node): Node {
  return (node as ElementAccessExpression).argumentExpression;
}

/** Whether a symbol is a property declared by `this.x` assignments in a constructor. */
export function isConstructorDeclaredThisProperty(c: Checker, symbol: Symbol): boolean {
  return getThisAssignmentKind(c, symbol) === ThisAssignmentKind.Constructor;
}

function getDeclaringConstructor(symbol: Symbol): Node | undefined {
  for (const declaration of getDeclarations(symbol)) {
    const container = getThisContainer(declaration, false, false);
    if (container.kind === SyntaxKind.Constructor) return container;
  }
  return undefined;
}

/**
 * Whether `node` is `this.x` in the constructor whose assignments type x: x is declared by `this.x`
 * assignments there, or is an auto-typed property declaration.
 */
export function isThisPropertyAccessInConstructor(c: Checker, node: Node, prop: Symbol): boolean {
  let constructor: Node | undefined;
  if (isConstructorDeclaredThisProperty(c, prop)) constructor = c.symbolLinks(prop).thisAssignmentLocation;
  else if (isThisProperty(node) && isAutoTypedProperty(c, prop)) constructor = getDeclaringConstructor(prop);
  return getThisContainer(node, true, false) === constructor;
}

function isThisProperty(node: Node): boolean {
  return isAccessExpression(node) && getExpression(node)!.kind === SyntaxKind.ThisKeyword;
}

/** The type of `this.x` in a constructor, or of an auto-typed property: the control flow type of its assignments. */
export function getFlowTypeOfAutoTypedProperty(c: Checker, reference: Node, prop: Symbol | undefined): Type {
  if (prop === undefined) return getFlowTypeOfReference(c, reference, c.autoType, c.undefinedType, undefined);
  return getFlowTypeOfProperty(c, reference, prop);
}

// ---- Contextual types

/** The leftmost expression of a property access, element access or call chain. */
function getLeftmostAccessExpression(node: Node): Node {
  let current = node;
  while (isAccessExpression(current) || current.kind === SyntaxKind.CallExpression) current = getExpression(current)!;
  return current;
}

/**
 * The contextual type of the right operand of `left = right`: the type of `left`, except for
 * `module.exports = …` and assignment declarations, which would be circular.
 */
export function getContextualTypeForAssignmentExpression(c: Checker, binary: BinaryExpression): Type | undefined {
  const left = binary.left;
  const target = getLeftmostAccessExpression(left);
  if (target.kind === SyntaxKind.Identifier && (getResolvedSymbol(c, target).flags & SymbolFlags.ModuleExports) !== 0)
    return undefined;
  if (isAccessExpression(left)) {
    const expr = getExpression(left)!;
    switch (expr.kind) {
      case SyntaxKind.Identifier: {
        const symbol = getExportSymbolOfValueSymbolIfExported(c, getResolvedSymbol(c, expr));
        if ((symbol.flags & SymbolFlags.ModuleExports) !== 0) return undefined;
        if (binary.symbol === undefined) break;
        // `F.id = expr` takes a contextual type only from an annotated variable F.
        const declaration = symbol.valueDeclaration;
        if (declaration === undefined || declaration.kind !== SyntaxKind.VariableDeclaration) return undefined;
        const typeNode = getType(declaration);
        if (typeNode === undefined) return undefined;
        if (left instanceof PropertyAccessExpression)
          return getTypeOfPropertyOfContextualType(c, getTypeFromTypeNode(c, typeNode), getText(left.name));
        const nameType = checkExpressionCached(c, getArgumentExpression(left));
        if (isTypeUsableAsPropertyName(nameType))
          return getTypeOfPropertyOfContextualType(
            c,
            getTypeFromTypeNode(c, typeNode),
            getPropertyNameFromType(nameType),
          );
        return getTypeOfExpression(c, left);
      }
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        if (binary.symbol !== undefined) return undefined;
        break;
      case SyntaxKind.ThisKeyword: {
        const thisType = getTypeOfExpression(c, expr);
        let symbol: Symbol | undefined;
        if (left instanceof PropertyAccessExpression) {
          const name = left.name;
          if (name.kind === SyntaxKind.PrivateIdentifier) {
            if (thisType.symbol !== undefined)
              symbol = getPropertyOfType(
                c,
                thisType,
                getSymbolNameForPrivateIdentifier(thisType.symbol, getText(name)),
              );
          } else symbol = getPropertyOfType(c, thisType, getText(name));
        } else {
          const propType = checkExpressionCached(c, getArgumentExpression(left));
          if (isTypeUsableAsPropertyName(propType))
            symbol = getPropertyOfType(c, thisType, getPropertyNameFromType(propType));
        }
        const d = symbol?.valueDeclaration;
        // `this.x = expr` where x is a property with no type annotation or initializer.
        if (
          d !== undefined &&
          (d.kind === SyntaxKind.PropertyDeclaration || d.kind === SyntaxKind.PropertySignature) &&
          getType(d) === undefined &&
          getInitializer(d) === undefined
        )
          return undefined;
        // An assignment declaration `this.x = expr` without a JSDoc type.
        const declaration = binary.symbol?.valueDeclaration;
        if (declaration !== undefined && getType(declaration) === undefined) return undefined;
        break;
      }
    }
  }
  return getTypeOfExpression(c, left);
}

// ---- CommonJS `require`

/** Whether `node` is `require("m")` with the CommonJS `require`, not a local function of that name. */
export function isCommonJSRequire(c: Checker, node: Node): boolean {
  if (!isRequireCall(node, true)) return false;
  const callee = getExpression(node)!;
  const resolved = resolveName(c, callee, getText(callee), SymbolFlags.Value, undefined, true, false);
  if (resolved === c.requireSymbol) return true;
  // A declared `require` must be an ambient function or variable.
  if (resolved === undefined || (resolved.flags & SymbolFlags.Alias) !== 0) return false;
  let kind = SyntaxKind.Unknown;
  if ((resolved.flags & SymbolFlags.Function) !== 0) kind = SyntaxKind.FunctionDeclaration;
  else if ((resolved.flags & SymbolFlags.Variable) !== 0) kind = SyntaxKind.VariableDeclaration;
  if (kind === SyntaxKind.Unknown) return false;
  const declaration = getDeclarationOfKind(resolved, kind);
  return declaration !== undefined && (declaration.flags & NodeFlags.Ambient) !== 0;
}

/** The type of the module a `require("m")` call names. */
export function resolveExternalModuleTypeByLiteral(c: Checker, name: Node): Type {
  const moduleSymbol = resolveExternalModuleName(c, name, name, false, undefined);
  if (moduleSymbol !== undefined) {
    const resolved = resolveExternalModuleSymbol(c, moduleSymbol, false);
    if (resolved !== undefined) return getTypeOfSymbol(c, resolved);
  }
  return c.anyType;
}

/** Whether a JavaScript declaration declares an alias: a `require` or an exported entity name. */
export function isJSAliasDeclaration(node: Node): boolean {
  if (node.kind !== SyntaxKind.BinaryExpression) return isVariableDeclarationInitializedToRequire(node);
  const kind = getAssignmentDeclarationKind(node);
  return (
    (kind === JSDeclarationKind.ModuleExports || kind === JSDeclarationKind.ExportsProperty) &&
    expressionIsAlias((node as BinaryExpression).right)
  );
}

/** `this` in `obj.x = function () {}` is `obj`, except for CommonJS `exports.x = function () {}`. */
export function getThisTypeOfAssignedFunction(c: Checker, func: Node): Type | undefined {
  let parent = func.parent!;
  while (parent.kind === SyntaxKind.ParenthesizedExpression) parent = parent.parent!;
  // Compound assignments like `??=` count too.
  if (
    !(parent instanceof BinaryExpression) ||
    parent.operatorToken.kind < SyntaxKind.FirstAssignment ||
    parent.operatorToken.kind > SyntaxKind.LastAssignment
  )
    return undefined;
  const target = parent.left;
  if (!isAccessExpression(target)) return undefined;
  const expression = getExpression(target)!;
  if (
    isInJSFile(func) &&
    expression.kind === SyntaxKind.Identifier &&
    getSourceFileOfNode(parent).commonJSModuleIndicator !== undefined &&
    (getResolvedSymbol(c, expression).flags & SymbolFlags.ModuleExports) !== 0
  )
    return undefined;
  return getWidenedType(c, checkExpressionCached(c, expression));
}

// ---- Object literals

/** The type of an empty object literal with expando members, `const o = {}; o.x = 1`. */
export function getTypeOfExpandoObjectLiteral(c: Checker, node: Node): Type | undefined {
  const symbol = getSymbol(node);
  if (getProperties(node)!.nodes.length !== 0 || symbol === undefined) return undefined;
  const exports = symbol.exports;
  if (exports === undefined || exports.size === 0) return undefined;
  const result = createAnonymousType(c, symbol, exports, [], [], []);
  if (isInJSFile(node) && !isJsonSourceFile(getSourceFileOfNode(node))) result.objectFlags |= ObjectFlags.JSLiteral;
  return result;
}

/** Whether an object literal is in a JavaScript file and has no contextual type. */
export function isJSObjectLiteral(c: Checker, node: Node): boolean {
  if (!isInJSFile(node) || isJsonSourceFile(getSourceFileOfNode(node))) return false;
  return getApparentTypeOfContextualTypeEx(c, node, ContextFlags.None) === undefined;
}

/**
 * Whether reading or writing unknown members of `t` is allowed: a JavaScript object literal, a union of
 * them, an intersection with one, or a type variable constrained to one. Not under noImplicitAny.
 */
export function isJSLiteralType(c: Checker, t: Type): boolean {
  if (c.noImplicitAny) return false;
  if ((t.objectFlags & ObjectFlags.JSLiteral) !== 0) return true;
  if ((t.flags & TypeFlags.Union) !== 0) {
    for (const u of typesOf(t)) if (!isJSLiteralType(c, u)) return false;
    return true;
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (isJSLiteralType(c, u)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.Instantiable) !== 0) {
    const constraint = getResolvedBaseConstraint(c, t);
    return constraint !== t && isJSLiteralType(c, constraint);
  }
  return false;
}

/** `exports.x = undefined` is ignored when x has other assignment declarations. */
export function isUndefinedAssignmentToCommonJSExport(c: Checker, left: Node, rightType: Type): boolean {
  const parent = left.parent!;
  if (!(parent instanceof BinaryExpression)) return false;
  // Typed locals keep scriptc's field reads static after `instanceof`.
  const assignment: BinaryExpression = parent;
  if (assignment.symbol === undefined) return false;
  if (getAssignmentDeclarationKind(assignment) !== JSDeclarationKind.ExportsProperty) return false;
  const symbol = c.resolvedSymbols.get(left.id);
  return symbol !== undefined && declarationCount(symbol) > 1 && (rightType.flags & TypeFlags.Undefined) !== 0;
}
