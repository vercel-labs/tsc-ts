// Types of value symbols: variables, parameters, properties, accessors, functions, classes,
// enums, modules and aliases; optionality and widening.
import { checkJsxAttribute } from './checker-jsx.js';
import { getTargetOfAliasDeclaration, resolveExternalModuleSymbol } from './checker-modules.js';
import { CachedTypeKind, cachedTypeKey, CheckMode } from './checker-types.js';
import {
  ModifierFlags,
  type Node,
  NodeFlags,
  getArguments,
  getInitializer,
  getName,
  getParameters,
  getType,
  getBody,
  getSymbol,
  getMembers,
  getDotDotDotToken,
  getElements,
  getExpression,
  getPostfixToken,
  getQuestionToken,
  getText,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  type SourceFile,
} from './ast.js';
import {
  declarationNameToString,
  findConstructorDeclaration,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getNameOfDeclaration,
  getRootDeclaration,
  getSourceFileOfNode,
  hasStaticModifier,
  hasSyntacticModifier,
  isCatchClauseVariableDeclarationOrBindingElement,
  isJsonSourceFile,
  isTypeNodeKind,
} from './binder-utilities.js';
import { identifierToKeywordKind } from './scanner.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  type InterfaceType,
  ObjectFlags,
  type Type,
  TypeFlags,
  type UnionType,
  IndexInfo,
  TypeReference,
} from './checker-types.js';
import {
  UnionReduction,
  createAnonymousType,
  createTypeReference,
  getIntersectionType,
  getUnionType,
  getUnionTypeEx,
  getWidenedLiteralType,
  isArrayOrTupleType,
  isEmptyObjectType,
  newObjectType,
  removeType,
  filterType,
  typesOf,
  getTypeArguments,
} from './checker-type-factory.js';
import {
  getDeclarationOfAliasSymbol,
  getParentOfSymbol,
  getSymbolFlags,
  getSymbolOfDeclaration,
  popTypeResolution,
  pushTypeResolution,
  reportCircularityError,
  resolveAlias,
  TypeSystemPropertyName,
  getGlobalTypeAliasSymbol,
  resolveName,
  getGlobalSymbol,
} from './checker-symbols.js';
import {
  getBaseConstructorTypeOfClass,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfEnumMember,
  getDeclaredTypeOfSymbol,
} from './checker-declared-types.js';
import { getESSymbolLikeTypeForNode, getTypeFromTypeNode, getTypeAliasInstantiation } from './checker-type-nodes.js';
import {
  getFlowTypeInConstructor,
  getFlowTypeInStaticBlocks,
  getTypeOfPropertyInBaseClass,
} from './checker-classes.js';
import { instantiateType } from './instantiation.js';
import {
  getIndexInfosOfType,
  getPropertiesOfObjectType,
  getPropertiesOfType,
  getPropertyOfObjectType,
  isObjectLiteralType,
  keepPropertiesOnly,
  scannedLiteralPropertiesLimit,
} from './checker-members.js';
import { typeToString, symbolToString } from './type-printer.js';
import { getTypeOfMappedSymbol, getIndexType } from './checker-type-operators.js';
import {
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
  getTypeOfParameter as getTypeOfParameterOfSignature,
} from './checker-signatures.js';
import {
  getReturnTypeFromBody,
  getTypeOfObjectLiteralMethod,
  shouldReportErrorsFromWideningWithContextualSignature,
} from './checker-functions.js';
import { getTypeOfReverseMappedSymbol } from './checker-inference.js';
import {
  checkDeclarationInitializer,
  getContextuallyTypedParameterType,
  getContextualThisParameterType,
  checkExpressionCached,
  checkExpressionEx,
} from './checker-expressions.js';
import { checkPropertyAssignment, checkShorthandPropertyAssignment } from './checker-object-literals.js';
import { getTypeForBindingElement, getTypeFromBindingPattern } from './checker-destructuring.js';
import { checkRightHandSideOfForOf } from './checker-statements.js';
import { getTypeWithFacts, TypeFacts, hasTypeFacts, getNonNullableType } from './checker-flow.js';
import { getTypeOfModuleExportsSymbol, getWidenedTypeForAssignmentDeclaration } from './checker-javascript.js';
import {
  CheckFlags,
  copyDeclarations,
  declarationAt,
  declarationCount,
  getDeclarations,
  getSymbolId,
  type Symbol,
  SymbolFlags,
} from './symbol.js';

export function getTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  const checkFlags = symbol.checkFlags;
  if ((checkFlags & CheckFlags.DeferredType) !== 0) return getTypeOfSymbolWithDeferredType(c, symbol);
  if ((checkFlags & CheckFlags.Instantiated) !== 0) return getTypeOfInstantiatedSymbol(c, symbol);
  if ((checkFlags & CheckFlags.Mapped) !== 0) return getTypeOfMappedSymbol(c, symbol);
  if ((checkFlags & CheckFlags.ReverseMapped) !== 0) return getTypeOfReverseMappedSymbol(c, symbol);
  const flags = symbol.flags;
  if ((flags & SymbolFlags.Accessor) !== 0) return getTypeOfAccessors(c, symbol);
  if ((flags & (SymbolFlags.Variable | SymbolFlags.Property)) !== 0)
    return getTypeOfVariableOrParameterOrProperty(c, symbol);
  if (
    (flags &
      (SymbolFlags.Function | SymbolFlags.Method | SymbolFlags.Class | SymbolFlags.Enum | SymbolFlags.ValueModule)) !==
    0
  )
    return getTypeOfFuncClassEnumModule(c, symbol);
  if ((flags & SymbolFlags.EnumMember) !== 0) return getTypeOfEnumMember(c, symbol);
  if ((flags & SymbolFlags.Alias) !== 0) return getTypeOfAlias(c, symbol);
  return c.errorType;
}

export function getTypeOfParameter(c: Checker, symbol: Symbol): Type {
  return getTypeOfParameterOfSignature(c, symbol);
}

export function getNonMissingTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  return removeMissingType(c, getTypeOfSymbol(c, symbol), (symbol.flags & SymbolFlags.Optional) !== 0);
}

function getTypeOfSymbolWithDeferredType(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  const id = symbol.id;
  if (c.symbolTypes.get(id) === undefined) {
    const constituents = links.deferralConstituents!;
    c.symbolTypes.set(
      id,
      (links.deferralParent!.flags & TypeFlags.Union) !== 0
        ? getUnionType(c, constituents)
        : getIntersectionType(c, constituents),
    );
  }
  return c.symbolTypes.get(id)!;
}

function getWriteTypeOfSymbolWithDeferredType(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.writeType === undefined) {
    const constituents = links.deferralWriteConstituents;
    if (constituents === undefined) links.writeType = getTypeOfSymbolWithDeferredType(c, symbol);
    else
      links.writeType =
        (links.deferralParent!.flags & TypeFlags.Union) !== 0
          ? getUnionType(c, constituents)
          : getIntersectionType(c, constituents);
  }
  return links.writeType;
}

function getTypeOfInstantiatedSymbol(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type = instantiateType(c, getTypeOfSymbol(c, c.symbolTargets.get(id)!), c.symbolMappers.get(id));
    c.symbolTypes.set(id, type);
  }
  return type;
}

export function getWriteTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  if ((symbol.checkFlags & CheckFlags.SyntheticProperty) !== 0) {
    if ((symbol.checkFlags & CheckFlags.DeferredType) !== 0) return getWriteTypeOfSymbolWithDeferredType(c, symbol);
    const id = getSymbolId(symbol);
    return c.symbolLinkTable.get(id)?.writeType ?? c.symbolTypes.get(id) ?? getTypeOfSymbol(c, symbol);
  }
  if ((symbol.flags & SymbolFlags.Property) !== 0)
    return removeMissingType(c, getTypeOfSymbol(c, symbol), (symbol.flags & SymbolFlags.Optional) !== 0);
  if ((symbol.flags & SymbolFlags.Accessor) !== 0) {
    if ((symbol.checkFlags & CheckFlags.Instantiated) !== 0) {
      const links = c.symbolLinks(symbol);
      const symbolId = symbol.id;
      if (links.writeType === undefined)
        links.writeType = instantiateType(
          c,
          getWriteTypeOfSymbol(c, c.symbolTargets.get(symbolId)!),
          c.symbolMappers.get(symbolId),
        );
      return links.writeType;
    }
    return getWriteTypeOfAccessors(c, symbol);
  }
  return getTypeOfSymbol(c, symbol);
}

// ---- Variables, parameters and properties

function getTypeOfVariableOrParameterOrProperty(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const cached = c.symbolTypes.get(id);
  if (cached !== undefined) return cached;
  const t = getTypeOfVariableOrParameterOrPropertyWorker(c, symbol);
  // Contextually typed parameters may get their type later; don't cache theirs.
  if (c.symbolTypes.get(id) === undefined && !isParameterOfContextSensitiveSignature(c, symbol))
    c.symbolTypes.set(id, t);
  return t;
}

function isParameterOfContextSensitiveSignature(c: Checker, symbol: Symbol): boolean {
  let decl = symbol.valueDeclaration;
  if (decl === undefined) return false;
  if (decl.kind === SyntaxKind.BindingElement) decl = getRootDeclaration(decl);
  return decl.kind === SyntaxKind.Parameter && isContextSensitiveFunctionLikeLazy(c, decl.parent!);
}

import { isContextSensitiveFunctionOrObjectLiteralMethod as isContextSensitiveFunctionLikeLazy } from './checker-expressions.js';

function getTypeOfVariableOrParameterOrPropertyWorker(c: Checker, symbol: Symbol): Type {
  if ((symbol.flags & SymbolFlags.Prototype) !== 0) return getTypeOfPrototypeProperty(c, symbol);
  if (symbol === c.requireSymbol) return c.anyType;
  const declaration = symbol.valueDeclaration;
  if (declaration === undefined) return c.errorType;
  // The `export=` symbol of a JSON file has the type of its value.
  if (declaration.kind === SyntaxKind.SourceFile && isJsonSourceFile(declaration as SourceFile)) {
    const statements = (declaration as SourceFile).statements.nodes;
    if (statements.length === 0) return c.emptyObjectType;
    return getWidenedType(c, getWidenedLiteralType(c, checkExpression(c, getExpression(statements[0]!)!)));
  }
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return reportCircularityError(c, symbol);
  // Like tsgo, the type resolution stays pushed: until popped by an enclosing resolution, its cached
  // type ends cycle detection there, so aliases like `module.exports.b = module.exports.a` resolve.
  if ((symbol.flags & SymbolFlags.ModuleExports) !== 0) return getTypeOfModuleExportsSymbol(c, symbol);
  let result: Type;
  switch (declaration.kind) {
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.BindingElement:
      // A parameter of a context sensitive function may get another type when its context is known, so
      // its widening errors are left to that.
      result = getWidenedTypeForVariableLikeDeclaration(
        c,
        declaration,
        !isParameterOfContextSensitiveSignature(c, symbol),
      );
      break;
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.MethodDeclaration:
      // The declared symbol of an object literal member, as opposed to the checked literal's property.
      if (declaration.kind === SyntaxKind.PropertyAssignment)
        result = checkPropertyAssignment(c, declaration as PropertyAssignment, CheckMode.Normal);
      else if (declaration.kind === SyntaxKind.ShorthandPropertyAssignment)
        result = checkShorthandPropertyAssignment(
          c,
          declaration as ShorthandPropertyAssignment,
          true,
          CheckMode.Normal,
        );
      else result = getTypeOfObjectLiteralMethod(c, declaration, CheckMode.Normal);
      break;
    case SyntaxKind.JsxAttribute:
      result = checkJsxAttribute(c, declaration, CheckMode.Normal);
      break;
    case SyntaxKind.ExportAssignment: {
      const typeNode = getType(declaration);
      result =
        typeNode !== undefined
          ? getTypeFromTypeNode(c, typeNode)
          : widenTypeForVariableLikeDeclaration(
              c,
              checkExpressionCached(c, getExpression(declaration)!),
              declaration,
              false,
            );
      break;
    }
    case SyntaxKind.EnumMember:
      result = getTypeOfEnumMember(c, symbol);
      break;
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.CallExpression:
      result = getWidenedTypeForAssignmentDeclaration(c, symbol);
      break;
    default:
      result = c.anyType;
  }
  if (!popTypeResolution(c)) return reportCircularityError(c, symbol);
  return result;
}

export function getWidenedTypeForVariableLikeDeclaration(c: Checker, declaration: Node, reportErrors: boolean): Type {
  return widenTypeForVariableLikeDeclaration(
    c,
    getTypeForVariableLikeDeclaration(c, declaration, true),
    declaration,
    reportErrors,
  );
}

/** Whether a parameter, property or method is declared with `?`. */
export function isOptionalDeclaration(node: Node): boolean {
  if (getQuestionToken(node) !== undefined) return true;
  // Properties and methods mark optionality with a `?` postfix token.
  const postfix = getPostfixToken(node);
  return postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken;
}

function isEmptyArrayLiteral(node: Node): boolean {
  return node.kind === SyntaxKind.ArrayLiteralExpression && getElements(node)!.nodes.length === 0;
}

function isNullOrUndefined(node: Node): boolean {
  let n = node;
  while (n.kind === SyntaxKind.ParenthesizedExpression) n = getExpression(n)!;
  return n.kind === SyntaxKind.NullKeyword || (n.kind === SyntaxKind.Identifier && getText(n) === 'undefined');
}

function isBindingPattern(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern)
  );
}

/** The declared or inferred type of a variable-like declaration; undefined when nothing can be inferred. */
export function getTypeForVariableLikeDeclaration(
  c: Checker,
  declaration: Node,
  includeOptionality: boolean,
  checkMode: CheckMode = CheckMode.Normal,
): Type | undefined {
  if (declaration.kind === SyntaxKind.VariableDeclaration) {
    const grandParent = declaration.parent!.parent!;
    if (grandParent.kind === SyntaxKind.ForInStatement) {
      // `for (k in x)` declares k as string, or keyof T for generic x.
      let objectType = checkExpressionEx(c, getExpression(grandParent)!, checkMode);
      if (hasTypeFacts(c, objectType, TypeFacts.IsUndefinedOrNull)) objectType = getNonNullableType(c, objectType);
      const indexType = getIndexType(c, objectType);
      return (indexType.flags & (TypeFlags.TypeParameter | TypeFlags.Index)) !== 0
        ? getExtractStringType(c, indexType)
        : c.stringType;
    }
    if (grandParent.kind === SyntaxKind.ForOfStatement) return checkRightHandSideOfForOf(c, grandParent);
  } else if (declaration.kind === SyntaxKind.BindingElement) return getTypeForBindingElement(c, declaration);
  const isProperty =
    (declaration.kind === SyntaxKind.PropertyDeclaration &&
      (getCombinedModifierFlags(declaration) & ModifierFlags.Accessor) === 0) ||
    declaration.kind === SyntaxKind.PropertySignature;
  const isOptional = includeOptionality && isOptionalDeclaration(declaration);
  const typeNode = getType(declaration);
  const declaredType = typeNode !== undefined ? getTypeFromTypeNode(c, typeNode) : undefined;
  if (isCatchClauseVariableDeclarationOrBindingElement(declaration)) {
    if (declaredType !== undefined)
      return (declaredType.flags & TypeFlags.AnyOrUnknown) !== 0 ? declaredType : c.errorType;
    return c.useUnknownInCatchVariables ? c.unknownType : c.anyType;
  }
  if (declaredType !== undefined) return addOptionality(c, declaredType, isProperty, isOptional);
  if (
    c.noImplicitAny &&
    declaration.kind === SyntaxKind.VariableDeclaration &&
    !isBindingPattern(getName(declaration)) &&
    (getCombinedModifierFlags(declaration) & ModifierFlags.Export) === 0 &&
    (declaration.flags & NodeFlags.Ambient) === 0
  ) {
    // Control-flow typed `any` for uninitialized or null/undefined-initialized let and var.
    const initializer = getInitializer(declaration);
    if (
      (getCombinedNodeFlags(declaration) & NodeFlags.Constant) === 0 &&
      (initializer === undefined || isNullOrUndefined(initializer))
    )
      return c.autoType;
    if (initializer !== undefined && isEmptyArrayLiteral(initializer)) return c.autoArrayType;
  }
  if (declaration.kind === SyntaxKind.Parameter) {
    if (getSymbol(declaration) === undefined) return undefined;
    const fn = declaration.parent!;
    // A set accessor parameter takes the getter's type.
    if (fn.kind === SyntaxKind.SetAccessor) {
      const fnSymbol = getSymbolOfDeclaration(c, fn);
      const getter =
        fnSymbol !== undefined ? getDeclarations(fnSymbol).find((d) => d.kind === SyntaxKind.GetAccessor) : undefined;
      if (getter !== undefined) {
        const getterSignature = getSignatureFromDeclaration(c, getter);
        // An unannotated `this` of a setter takes the getter's `this` type.
        const params = getParameters(fn)!.nodes;
        if (params.length === 2 && params[0] === declaration && getSymbol(declaration)!.name === 'this')
          return getterSignature.thisParameter !== undefined
            ? getTypeOfSymbol(c, getterSignature.thisParameter)
            : c.anyType;
        return getReturnTypeOfSignature(c, getterSignature);
      }
    }
    const fullSignatureType = getParameterTypeOfFullSignature(c, fn, declaration);
    if (fullSignatureType !== undefined) return fullSignatureType;
    const t =
      getSymbol(declaration)!.name === 'this'
        ? getContextualThisParameterType(c, fn)
        : getContextuallyTypedParameterType(c, declaration);
    if (t !== undefined) return addOptionality(c, t, false, isOptional);
  }
  const initializer = getInitializer(declaration);
  if (initializer !== undefined) {
    const t = widenTypeInferredFromInitializer(c, declaration, checkDeclarationInitializer(c, declaration, checkMode));
    return addOptionality(c, t, isProperty, isOptional);
  }
  if (c.noImplicitAny && declaration.kind === SyntaxKind.PropertyDeclaration) {
    // Without an annotation or initializer, the type comes from `this` assignments in the
    // constructor or static blocks.
    const symbol = getSymbol(declaration)!;
    const isAmbient = hasSyntacticModifier(declaration, ModifierFlags.Ambient);
    let t: Type | undefined;
    if (!hasStaticModifier(declaration)) {
      const constructor = findConstructorDeclaration(declaration.parent!);
      if (constructor !== undefined) t = getFlowTypeInConstructor(c, symbol, constructor);
      else if (isAmbient) t = getTypeOfPropertyInBaseClass(c, symbol);
    } else {
      const staticBlocks: Node[] = [];
      for (const member of getMembers(declaration.parent!)!.nodes)
        if (member.kind === SyntaxKind.ClassStaticBlockDeclaration) staticBlocks.push(member);
      if (staticBlocks.length !== 0) t = getFlowTypeInStaticBlocks(c, symbol, staticBlocks);
      else if (isAmbient) t = getTypeOfPropertyInBaseClass(c, symbol);
    }
    return t !== undefined ? addOptionality(c, t, true, isOptional) : undefined;
  }
  if (declaration.kind === SyntaxKind.JsxAttribute) return c.trueType;
  if (isBindingPattern(getName(declaration))) return getTypeFromBindingPattern(c, getName(declaration)!, false, true);
  return undefined;
}

export function widenTypeInferredFromInitializer(c: Checker, declaration: Node, t: Type): Type {
  const widened = getWidenedLiteralTypeForInitializer(c, declaration, t);
  // `null`, `undefined` and `[]` initializers in JavaScript are implicitly `any` and `any[]`.
  if (isInJSFile(declaration)) {
    if (widened === (c.strictNullChecks ? c.implicitNeverType : c.undefinedWideningType)) {
      reportImplicitAny(c, declaration, c.anyType);
      return c.anyType;
    }
    if (isEmptyArrayLiteralType(c, widened)) {
      reportImplicitAny(c, declaration, c.anyArrayType);
      return c.anyArrayType;
    }
  }
  return widened;
}

export function getWidenedLiteralTypeForInitializer(c: Checker, declaration: Node, t: Type): Type {
  if ((getCombinedNodeFlags(declaration) & NodeFlags.Constant) !== 0 || isDeclarationReadonly(declaration)) return t;
  return getWidenedLiteralType(c, t);
}

function isDeclarationReadonly(declaration: Node): boolean {
  return (
    (getCombinedModifierFlags(declaration) & ModifierFlags.Readonly) !== 0 && declaration.kind !== SyntaxKind.Parameter
  );
}

function isGlobalSymbolConstructor(c: Checker, node: Node): boolean {
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined && symbol === getGlobalSymbol(c, 'SymbolConstructor', SymbolFlags.Type, undefined);
}

export function widenTypeForVariableLikeDeclaration(
  c: Checker,
  t: Type | undefined,
  declaration: Node,
  reportErrors: boolean,
): Type {
  if (t !== undefined) {
    // `symbol` properties merged into the global SymbolConstructor are unique symbols, as libraries
    // that predate `unique symbol` declare them.
    if ((t.flags & TypeFlags.ESSymbol) !== 0 && isGlobalSymbolConstructor(c, declaration.parent!))
      t = getESSymbolLikeTypeForNode(c, declaration);
    if (reportErrors) reportErrorsFromWidening(c, declaration, t, WideningKind.Normal);
    // A unique symbol type from another declaration widens.
    if (
      (t.flags & TypeFlags.UniqueESSymbol) !== 0 &&
      (declaration.kind === SyntaxKind.BindingElement || getType(declaration) === undefined) &&
      t.symbol !== getSymbolOfDeclaration(c, declaration)
    )
      t = c.esSymbolType;
    return getWidenedType(c, t);
  }
  // Rest parameters default to any[], others to any.
  const isRest = declaration.kind === SyntaxKind.Parameter && getDotDotDotToken(declaration) !== undefined;
  const result = isRest ? c.anyArrayType : c.anyType;
  if (reportErrors && !declarationBelongsToPrivateAmbientMember(declaration)) reportImplicitAny(c, declaration, result);
  return result;
}

export function declarationBelongsToPrivateAmbientMember(declaration: Node): boolean {
  const root = getRootDeclaration(declaration);
  const member = root.kind === SyntaxKind.Parameter ? root.parent! : root;
  return isPrivateWithinAmbient(member);
}

export function isPrivateWithinAmbient(node: Node): boolean {
  return (
    ((getCombinedModifierFlags(node) & ModifierFlags.Private) !== 0 || isPrivateIdentifierClassElement(node)) &&
    (node.flags & NodeFlags.Ambient) !== 0
  );
}

function isPrivateIdentifierClassElement(node: Node): boolean {
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.PrivateIdentifier;
}

/** What a widened type is the type of, for the implicit any messages. */
export const enum WideningKind {
  Normal,
  FunctionReturn,
  GeneratorNext,
  GeneratorYield,
}

/**
 * Implicit-any widening of null/undefined, which strictNullChecks avoids. A function's inferred
 * types report it only without a contextual signature, or when the contextual type is generic.
 */
export function reportErrorsFromWidening(c: Checker, declaration: Node, t: Type, wideningKind: WideningKind): void {
  if (!c.noImplicitAny || (t.objectFlags & ObjectFlags.ContainsWideningType) === 0) return;
  if (
    wideningKind !== WideningKind.Normal &&
    !(
      isFunctionLikeDeclarationKind(declaration.kind) &&
      shouldReportErrorsFromWideningWithContextualSignature(c, declaration, wideningKind)
    )
  )
    return;
  // Implicit any errors are reported within the type where possible, else on the declaration.
  if (!reportWideningErrorsInType(c, t)) reportImplicitAny(c, declaration, t, wideningKind);
}

function reportWideningErrorsInType(c: Checker, t: Type): boolean {
  let errorReported = false;
  if ((t.objectFlags & ObjectFlags.ContainsWideningType) === 0) return false;
  if ((t.flags & TypeFlags.Union) !== 0) {
    if (someEmptyObjectType(c, typesOf(t))) errorReported = true;
    else for (const s of typesOf(t)) errorReported = errorReported || reportWideningErrorsInType(c, s);
  } else if (isArrayOrTupleType(c, t)) {
    for (const s of getTypeArguments(c, t)) errorReported = errorReported || reportWideningErrorsInType(c, s);
  } else if (isObjectLiteralType(t)) {
    for (const p of getPropertiesOfObjectType(c, t)) {
      const s = getTypeOfSymbol(c, p);
      if ((s.objectFlags & ObjectFlags.ContainsWideningType) === 0) continue;
      errorReported = reportWideningErrorsInType(c, s);
      if (errorReported) continue;
      // Property types can come from object literal normalization in unions.
      let valueDeclaration: Node | undefined;
      for (const d of getDeclarations(p)) {
        const v = getSymbol(d)?.valueDeclaration;
        if (v !== undefined && v.parent === t.symbol?.valueDeclaration) {
          valueDeclaration = d;
          break;
        }
      }
      if (valueDeclaration !== undefined) {
        c.error(
          valueDeclaration,
          Diagnostics.Object_literal_s_property_0_implicitly_has_an_1_type,
          symbolToString(c, p),
          typeToString(c, getWidenedType(c, s)),
        );
        errorReported = true;
      }
    }
  }
  return errorReported;
}

export function reportImplicitAny(
  c: Checker,
  declaration: Node,
  t: Type,
  wideningKind: WideningKind = WideningKind.Normal,
): void {
  const file = getSourceFileOfNode(declaration);
  // Only TypeScript files and checked JavaScript files report implicit `any`.
  if (isInJSFile(declaration) && !isCheckJsEnabledForFile(file, c.compilerOptions)) return;
  const typeAsString = typeToString(c, getWidenedType(c, t));
  let message: DiagnosticMessage;
  switch (declaration.kind) {
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      message = c.noImplicitAny
        ? Diagnostics.Member_0_implicitly_has_an_1_type
        : Diagnostics.Member_0_implicitly_has_an_1_type_but_a_better_type_may_be_inferred_from_usage;
      break;
    case SyntaxKind.Parameter: {
      const isRest = getDotDotDotToken(declaration) !== undefined;
      // `(string) => void` most likely meant a parameter of type `string`.
      const name = getName(declaration);
      const parent = declaration.parent!;
      if (
        name !== undefined &&
        name.kind === SyntaxKind.Identifier &&
        (parent.kind === SyntaxKind.CallSignature ||
          parent.kind === SyntaxKind.MethodSignature ||
          parent.kind === SyntaxKind.FunctionType)
      ) {
        const index = getParameters(parent)!.nodes.indexOf(declaration);
        const text = getText(name);
        if (
          index >= 0 &&
          (isTypeNodeKind(identifierToKeywordKind(text)) ||
            resolveName(c, declaration, text, SymbolFlags.Type, undefined, true, false) !== undefined)
        ) {
          c.addErrorOrSuggestion(
            c.noImplicitAny,
            createDiagnosticForNode(declaration, Diagnostics.Parameter_has_a_name_but_no_type_Did_you_mean_0_Colon_1, [
              'arg' + index,
              declarationNameToString(file, name) + (isRest ? '[]' : ''),
            ]),
          );
          return;
        }
      }
      if (isRest)
        message = c.noImplicitAny
          ? Diagnostics.Rest_parameter_0_implicitly_has_an_any_type
          : Diagnostics.Rest_parameter_0_implicitly_has_an_any_type_but_a_better_type_may_be_inferred_from_usage;
      else
        message = c.noImplicitAny
          ? Diagnostics.Parameter_0_implicitly_has_an_1_type
          : Diagnostics.Parameter_0_implicitly_has_an_1_type_but_a_better_type_may_be_inferred_from_usage;
      break;
    }
    case SyntaxKind.BindingElement:
      if (!c.noImplicitAny) return;
      message = Diagnostics.Binding_element_0_implicitly_has_an_1_type;
      break;
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      if (c.noImplicitAny && getName(declaration) === undefined) {
        c.error(
          declaration,
          wideningKind === WideningKind.GeneratorYield
            ? Diagnostics.Generator_implicitly_has_yield_type_0_Consider_supplying_a_return_type_annotation
            : Diagnostics.Function_expression_which_lacks_return_type_annotation_implicitly_has_an_0_return_type,
          typeAsString,
        );
        return;
      }
      if (c.noImplicitAny && (declaration.flags & NodeFlags.Reparsed) !== 0) {
        // A JSDoc `@overload`.
        const nameText = declarationNameToString(file, getNameOfDeclaration(declaration));
        if (nameText !== '')
          c.error(
            declaration,
            Diagnostics.X_0_which_lacks_return_type_annotation_implicitly_has_an_1_return_type,
            nameText,
            typeAsString,
          );
        else
          c.error(
            declaration,
            Diagnostics.This_overload_implicitly_returns_the_type_0_because_it_lacks_a_return_type_annotation,
            typeAsString,
          );
        return;
      }
      if (!c.noImplicitAny)
        message = Diagnostics.X_0_implicitly_has_an_1_return_type_but_a_better_type_may_be_inferred_from_usage;
      else if (wideningKind === WideningKind.GeneratorYield)
        message = Diagnostics.X_0_which_lacks_return_type_annotation_implicitly_has_an_1_yield_type;
      else message = Diagnostics.X_0_which_lacks_return_type_annotation_implicitly_has_an_1_return_type;
      break;
    case SyntaxKind.MappedType:
      if (c.noImplicitAny) c.error(declaration, Diagnostics.Mapped_object_type_implicitly_has_an_any_template_type);
      return;
    default:
      message = c.noImplicitAny
        ? Diagnostics.Variable_0_implicitly_has_an_1_type
        : Diagnostics.Variable_0_implicitly_has_an_1_type_but_a_better_type_may_be_inferred_from_usage;
  }
  const name = getNameOfDeclaration(declaration);
  c.addErrorOrSuggestion(
    c.noImplicitAny,
    createDiagnosticForNode(declaration, message, [declarationNameToString(file, name), typeAsString]),
  );
}

// ---- Widening

export function getWidenedType(c: Checker, t: Type): Type {
  return getWidenedTypeWithContext(c, t, undefined);
}

/** Widening state for the constituents of a union: object literals get each other's missing properties. */
class WideningContext {
  readonly parent: WideningContext | undefined;
  readonly propertyName: string;
  siblings: Type[] | undefined;
  resolvedProperties: Symbol[] | undefined = undefined;
  /** The contexts of the properties, by name, shared by the object literals widened in this one. */
  childContexts: Map<string, WideningContext> | undefined = undefined;
  /** The widened types of the object literals widened in this context, for child contexts. */
  widenedTypes: Map<Type, Type> | undefined = undefined;

  constructor(parent: WideningContext | undefined, propertyName: string, siblings: Type[] | undefined) {
    this.parent = parent;
    this.propertyName = propertyName;
    this.siblings = siblings;
  }

  getChildContext(propertyName: string): WideningContext {
    this.childContexts ??= new Map<string, WideningContext>();
    let result = this.childContexts.get(propertyName);
    if (result === undefined) {
      result = new WideningContext(this, propertyName, undefined);
      this.childContexts.set(propertyName, result);
    }
    return result;
  }
}

function getWidenedTypeWithContext(c: Checker, t: Type, context: WideningContext | undefined): Type {
  if ((t.objectFlags & ObjectFlags.RequiresWidening) === 0) return t;
  const key = cachedTypeKey(CachedTypeKind.Widened, t.id);
  if (context === undefined) {
    const cached = c.cachedTypesById.get(key);
    if (cached !== undefined) return cached;
  }
  let result: Type | undefined;
  if ((t.flags & (TypeFlags.Any | TypeFlags.Nullable)) !== 0) result = c.anyType;
  else if ((t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 && (t.flags & TypeFlags.Object) !== 0)
    result = getWidenedTypeOfObjectLiteral(c, t, context);
  else if ((t.flags & TypeFlags.Union) !== 0) {
    const unionContext = context ?? new WideningContext(undefined, '', typesOf(t));
    const widened: Type[] = [];
    for (const u of typesOf(t))
      widened.push((u.flags & TypeFlags.Nullable) !== 0 ? u : getWidenedTypeWithContext(c, u, unionContext));
    // Widened empty object literals reduce subtypes, e.g. {} | string to {}.
    result = getUnionTypeEx(
      c,
      widened,
      someEmptyObjectType(c, widened) ? UnionReduction.Subtype : UnionReduction.Literal,
      undefined,
      undefined,
    );
  } else if ((t.flags & TypeFlags.Intersection) !== 0) result = getIntersectionType(c, getWidenedTypes(c, typesOf(t)));
  else if (isArrayOrTupleType(c, t))
    result = createTypeReference(c, (t as TypeReference).target!, getWidenedTypes(c, getTypeArguments(c, t)));
  if (result !== undefined && context === undefined) c.cachedTypesById.set(key, result);
  return result ?? t;
}

function getWidenedTypes(c: Checker, types: Type[]): Type[] {
  const result: Type[] = [];
  for (const t of types) result.push(getWidenedType(c, t));
  return result;
}

function someEmptyObjectType(c: Checker, types: Type[]): boolean {
  for (const t of types) if (isEmptyObjectType(c, t)) return true;
  return false;
}

function getWidenedTypeOfObjectLiteral(c: Checker, t: Type, context: WideningContext | undefined): Type {
  const cached = context?.widenedTypes?.get(t);
  if (cached !== undefined) return cached;
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfObjectType(c, t)) members.set(prop.name, getWidenedProperty(c, prop, context));
  if (context !== undefined)
    for (const prop of getPropertiesOfContext(c, context))
      if (!members.has(prop.name)) members.set(prop.name, getUndefinedProperty(c, prop));
  const infos = getIndexInfosOfType(c, t).map(
    (info) =>
      new IndexInfo(
        info.keyType,
        getWidenedType(c, info.valueType),
        info.isReadonly,
        info.declaration,
        info.components,
      ),
  );
  const result = createAnonymousType(c, t.symbol, members, [], [], infos);
  keepPropertiesOnly(c, result, members, scannedLiteralPropertiesLimit);
  result.objectFlags |= t.objectFlags & (ObjectFlags.JSLiteral | ObjectFlags.NonInferrableType);
  // The root context widens each object literal once; a property's context may widen one literal
  // for several siblings.
  if (context !== undefined && context.parent !== undefined) {
    context.widenedTypes ??= new Map<Type, Type>();
    context.widenedTypes.set(t, result);
  }
  return result;
}

function getWidenedProperty(c: Checker, prop: Symbol, context: WideningContext | undefined): Symbol {
  if ((prop.flags & SymbolFlags.Property) === 0) return prop;
  const original = getTypeOfSymbol(c, prop);
  const propContext = context?.getChildContext(prop.name);
  const widened = getWidenedTypeWithContext(c, original, propContext);
  if (widened === original) return prop;
  return createSymbolWithWidenedType(c, prop, widened);
}

function createSymbolWithWidenedType(c: Checker, prop: Symbol, t: Type): Symbol {
  const result = c.newSymbolWithCheckFlags(prop.flags, prop.name, prop.checkFlags & CheckFlags.Readonly);
  copyDeclarations(result, prop);
  result.parent = prop.parent;
  result.valueDeclaration = prop.valueDeclaration;
  const id = getSymbolId(result);
  c.symbolTypes.set(id, t);
  c.symbolTargets.set(id, prop);
  c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(prop)));
  return result;
}

/**
 * An optional `undefined` property standing in for `prop`, a property of a sibling object literal
 * (getPropertiesOfContext), one per property. It carries the declarations of `prop`, which order it
 * among the members when they are printed.
 */
function getUndefinedProperty(c: Checker, prop: Symbol): Symbol {
  const key = getSymbolId(prop);
  const cached = c.undefinedProperties.get(key);
  if (cached !== undefined) return cached;
  const result = createSymbolWithWidenedType(c, prop, c.undefinedOrMissingType);
  result.flags |= SymbolFlags.Optional;
  c.undefinedProperties.set(key, result);
  return result;
}

function getPropertiesOfContext(c: Checker, context: WideningContext): Symbol[] {
  if (context.resolvedProperties === undefined) {
    const names = new Map<string, Symbol>();
    for (const t of getSiblingsOfContext(c, context))
      if (
        (t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 &&
        (t.flags & TypeFlags.Object) !== 0 &&
        (t.objectFlags & ObjectFlags.ContainsSpread) === 0
      )
        for (const prop of getPropertiesOfType(c, t)) names.set(prop.name, prop);
    context.resolvedProperties = [...names.values()];
  }
  return context.resolvedProperties;
}

function getSiblingsOfContext(c: Checker, context: WideningContext): Type[] {
  if (context.siblings === undefined) {
    const siblings: Type[] = [];
    for (const t of getSiblingsOfContext(c, context.parent!))
      if ((t.objectFlags & ObjectFlags.ObjectLiteral) !== 0 && (t.flags & TypeFlags.Object) !== 0) {
        const prop = getPropertyOfObjectType(c, t, context.propertyName);
        if (prop !== undefined) {
          const propType = getTypeOfSymbol(c, prop);
          if ((propType.flags & TypeFlags.Union) !== 0) for (const u of typesOf(propType)) siblings.push(u);
          else siblings.push(propType);
        }
      }
    context.siblings = siblings;
  }
  return context.siblings;
}

// ---- Optionality

export function addOptionality(c: Checker, t: Type, isProperty: boolean, isOptional: boolean): Type {
  return c.strictNullChecks && isOptional ? getOptionalType(c, t, isProperty) : t;
}

export function getOptionalType(c: Checker, t: Type, isProperty: boolean): Type {
  const missingOrUndefined = isProperty ? c.undefinedOrMissingType : c.undefinedType;
  if (t === missingOrUndefined || ((t.flags & TypeFlags.Union) !== 0 && typesOf(t)[0]! === missingOrUndefined))
    return t;
  const key = cachedTypeKey(isProperty ? CachedTypeKind.OptionalProperty : CachedTypeKind.Optional, t.id);
  let result = c.cachedTypesById.get(key);
  if (result === undefined) {
    result = getUnionType(c, [t, missingOrUndefined]);
    c.cachedTypesById.set(key, result);
  }
  return result;
}

export function addOptionalTypeMarker(c: Checker, t: Type): Type {
  return c.strictNullChecks ? getUnionType(c, [t, c.optionalType]) : t;
}

export function removeOptionalTypeMarker(c: Checker, t: Type): Type {
  return c.strictNullChecks ? removeType(c, t, c.optionalType) : t;
}

export function removeMissingType(c: Checker, t: Type, isOptional: boolean): Type {
  return c.exactOptionalPropertyTypes && isOptional ? removeType(c, t, c.missingType) : t;
}

export function removeMissingOrUndefinedType(c: Checker, t: Type): Type {
  return c.exactOptionalPropertyTypes ? removeType(c, t, c.missingType) : getTypeWithFacts(c, t, TypeFacts.NEUndefined);
}

export function getNullableType(c: Checker, t: Type, flags: TypeFlags): Type {
  const missing = flags & ~t.flags & (TypeFlags.Undefined | TypeFlags.Null);
  if (missing === 0) return t;
  if (missing === TypeFlags.Undefined) return getUnionType(c, [t, c.undefinedType]);
  if (missing === TypeFlags.Null) return getUnionType(c, [t, c.nullType]);
  return getUnionType(c, [t, c.undefinedType, c.nullType]);
}

// ---- Readonly

export function isReadonlySymbol(c: Checker, symbol: Symbol): boolean {
  // Readonly properties, const variables, getters without setters and enum members.
  return (
    (symbol.checkFlags & CheckFlags.Readonly) !== 0 ||
    ((symbol.flags & SymbolFlags.Property) !== 0 &&
      (getDeclarationModifierFlags(c, symbol) & ModifierFlags.Readonly) !== 0) ||
    ((symbol.flags & SymbolFlags.Variable) !== 0 &&
      (getDeclarationNodeFlagsFromSymbol(symbol) & NodeFlags.Constant) !== 0) ||
    ((symbol.flags & SymbolFlags.Accessor) !== 0 && (symbol.flags & SymbolFlags.SetAccessor) === 0) ||
    (symbol.flags & SymbolFlags.EnumMember) !== 0 ||
    someReadonlyAssignmentDeclaration(c, symbol)
  );
}

function someReadonlyAssignmentDeclaration(c: Checker, symbol: Symbol): boolean {
  for (let i = 0; i < declarationCount(symbol); i++)
    if (isReadonlyAssignmentDeclaration(c, declarationAt(symbol, i))) return true;
  return false;
}

/** An `Object.defineProperty` call with a value and no `writable: true`, or without a setter. */
function isReadonlyAssignmentDeclaration(c: Checker, node: Node): boolean {
  if (node.kind !== SyntaxKind.CallExpression) return false;
  const args = getArguments(node);
  if (args === undefined || args.nodes.length < 3) return false;
  const descriptorType = checkExpressionCached(c, args.nodes[2]!);
  if (getTypeOfPropertyOfType(c, descriptorType, 'value') !== undefined) {
    const writable = getPropertyOfType(c, descriptorType, 'writable');
    if (writable === undefined) return true;
    const declaration = writable.valueDeclaration;
    const writableType =
      declaration !== undefined && declaration.kind === SyntaxKind.PropertyAssignment
        ? checkExpression(c, getInitializer(declaration)!)
        : getTypeOfSymbol(c, writable);
    return writableType === c.falseType || writableType === c.regularFalseType;
  }
  return getTypeOfPropertyOfType(c, descriptorType, 'set') === undefined;
}

import {
  getDeclarationModifierFlagsFromSymbol,
  getPropertyOfType,
  getTypeOfPropertyOfType,
} from './checker-members.js';
import { checkExpression } from './checker-expressions.js';
import { getParameterTypeOfFullSignature } from './checker-jsdoc.js';
import { isFunctionLikeDeclarationKind, isInJSFile } from './ast-utilities.js';
import { isEmptyArrayLiteralType } from './relations.js';
import { isCheckJsEnabledForFile } from './program-utilities.js';

function getDeclarationModifierFlags(c: Checker, symbol: Symbol): ModifierFlags {
  return getDeclarationModifierFlagsFromSymbol(c, symbol, false);
}

function getDeclarationNodeFlagsFromSymbol(symbol: Symbol): NodeFlags {
  return symbol.valueDeclaration !== undefined ? getCombinedNodeFlags(symbol.valueDeclaration) : 0;
}

// ---- Accessors

export function getAnnotatedAccessorTypeNode(accessor: Node | undefined): Node | undefined {
  if (accessor === undefined) return undefined;
  if (accessor.kind === SyntaxKind.GetAccessor || accessor.kind === SyntaxKind.PropertyDeclaration)
    return getType(accessor);
  if (accessor.kind === SyntaxKind.SetAccessor) {
    const params = getParameters(accessor)?.nodes ?? [];
    if (params.length === 0) return undefined;
    return getType(params.length === 2 ? params[1]! : params[0]!);
  }
  return undefined;
}

function getAnnotatedAccessorType(c: Checker, accessor: Node | undefined): Type | undefined {
  const node = getAnnotatedAccessorTypeNode(accessor);
  return node !== undefined ? getTypeFromTypeNode(c, node) : undefined;
}

/** The `accessor` property declaration of `symbol`, if any. */
function getAutoAccessorDeclaration(symbol: Symbol): Node | undefined {
  for (const d of getDeclarations(symbol))
    if (d.kind === SyntaxKind.PropertyDeclaration && (getCombinedModifierFlags(d) & ModifierFlags.Accessor) !== 0)
      return d;
  return undefined;
}

function getTypeOfAccessors(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const type = c.symbolTypes.get(id);
  if (type !== undefined) return type;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return c.errorType;
  const getter = getDeclarations(symbol).find((d) => d.kind === SyntaxKind.GetAccessor);
  const setter = getDeclarations(symbol).find((d) => d.kind === SyntaxKind.SetAccessor);
  const accessor = getAutoAccessorDeclaration(symbol);
  // Getter annotation, setter annotation, accessor annotation, then getter body.
  let t =
    getAnnotatedAccessorType(c, getter) ?? getAnnotatedAccessorType(c, setter) ?? getAnnotatedAccessorType(c, accessor);
  if (t === undefined && getter !== undefined && getBody(getter) !== undefined) t = getReturnTypeFromBody(c, getter);
  if (t === undefined && accessor !== undefined) t = getWidenedTypeForVariableLikeDeclaration(c, accessor, true);
  if (t === undefined) {
    if (setter !== undefined && !isPrivateWithinAmbient(setter))
      c.addErrorOrSuggestion(
        c.noImplicitAny,
        createDiagnosticForNode(
          setter,
          Diagnostics.Property_0_implicitly_has_type_any_because_its_set_accessor_lacks_a_parameter_type_annotation,
          [symbolToString(c, symbol)],
        ),
      );
    else if (getter !== undefined && !isPrivateWithinAmbient(getter))
      c.addErrorOrSuggestion(
        c.noImplicitAny,
        createDiagnosticForNode(
          getter,
          Diagnostics.Property_0_implicitly_has_type_any_because_its_get_accessor_lacks_a_return_type_annotation,
          [symbolToString(c, symbol)],
        ),
      );
    t = c.anyType;
  }
  if (!popTypeResolution(c)) {
    if (getAnnotatedAccessorTypeNode(getter) !== undefined)
      c.error(
        getter,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
    else if (getAnnotatedAccessorTypeNode(setter) !== undefined)
      c.error(
        setter,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
    else if (getter !== undefined && c.noImplicitAny)
      c.error(
        getter,
        Diagnostics.X_0_implicitly_has_return_type_any_because_it_does_not_have_a_return_type_annotation_and_is_referenced_directly_or_indirectly_in_one_of_its_return_expressions,
        symbolToString(c, symbol),
      );
    t = c.anyType;
  }
  let cached = c.symbolTypes.get(id);
  if (cached === undefined) {
    cached = t;
    c.symbolTypes.set(id, cached);
  }
  return cached;
}

export function getWriteTypeOfAccessors(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.writeType !== undefined) return links.writeType;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.WriteType)) return c.errorType;
  const setter =
    getDeclarations(symbol).find((d) => d.kind === SyntaxKind.SetAccessor) ?? getAutoAccessorDeclaration(symbol);
  let writeType = getAnnotatedAccessorType(c, setter);
  if (!popTypeResolution(c)) {
    if (getAnnotatedAccessorTypeNode(setter) !== undefined)
      c.error(
        setter,
        Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_type_annotation,
        symbolToString(c, symbol),
      );
    writeType = c.anyType;
  }
  // Without a setter annotation, the write type is the read type.
  if (links.writeType === undefined) links.writeType = writeType ?? getTypeOfAccessors(c, symbol);
  return links.writeType;
}

// ---- Functions, classes, enums, modules and aliases

function getTypeOfFuncClassEnumModule(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type = getTypeOfFuncClassEnumModuleWorker(c, symbol);
    c.symbolTypes.set(id, type);
  }
  return type;
}

function getTypeOfFuncClassEnumModuleWorker(c: Checker, symbol: Symbol): Type {
  if ((symbol.flags & SymbolFlags.Module) !== 0 && isShorthandAmbientModuleSymbol(symbol)) return c.anyType;
  if (
    (symbol.flags & SymbolFlags.ValueModule) !== 0 &&
    symbol.valueDeclaration !== undefined &&
    symbol.valueDeclaration.kind === SyntaxKind.SourceFile
  ) {
    const resolvedModule = resolveExternalModuleSymbol(c, symbol, false);
    if (resolvedModule !== undefined && resolvedModule !== symbol) return getTypeOfSymbol(c, resolvedModule);
  }
  const t = newObjectType(c, ObjectFlags.Anonymous, symbol);
  if ((symbol.flags & SymbolFlags.Class) !== 0) {
    const baseTypeVariable = getBaseTypeVariableOfClass(c, symbol);
    return baseTypeVariable !== undefined ? getIntersectionType(c, [t, baseTypeVariable]) : t;
  }
  if (c.strictNullChecks && (symbol.flags & SymbolFlags.Optional) !== 0) return getOptionalType(c, t, true);
  return t;
}

function isShorthandAmbientModuleSymbol(symbol: Symbol): boolean {
  const d = symbol.valueDeclaration;
  return d !== undefined && d.kind === SyntaxKind.ModuleDeclaration && getBody(d) === undefined;
}

export function getBaseTypeVariableOfClass(c: Checker, symbol: Symbol): Type | undefined {
  const baseConstructorType = getBaseConstructorTypeOfClass(c, getDeclaredTypeOfClassOrInterface(c, symbol));
  if ((baseConstructorType.flags & TypeFlags.TypeVariable) !== 0) return baseConstructorType;
  if ((baseConstructorType.flags & TypeFlags.Intersection) !== 0)
    return typesOf(baseConstructorType).find((t) => (t.flags & TypeFlags.TypeVariable) !== 0);
  return undefined;
}

function getTypeOfEnumMember(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  let type = c.symbolTypes.get(id);
  if (type === undefined) {
    type = getDeclaredTypeOfEnumMember(c, symbol);
    c.symbolTypes.set(id, type);
  }
  return type;
}

function getTypeOfAlias(c: Checker, symbol: Symbol): Type {
  const id = getSymbolId(symbol);
  const type = c.symbolTypes.get(id);
  if (type !== undefined) return type;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.Type)) return c.errorType;
  const targetSymbol = resolveAlias(c, symbol);
  const exportSymbol = getTargetOfAliasDeclaration(c, getDeclarationOfAliasSymbol(symbol));
  // Only values have types.
  if (c.symbolTypes.get(id) === undefined)
    c.symbolTypes.set(
      id,
      (getSymbolFlags(c, targetSymbol) & SymbolFlags.Value) !== 0 ? getTypeOfSymbol(c, targetSymbol) : c.errorType,
    );
  if (!popTypeResolution(c)) {
    reportCircularityError(c, exportSymbol ?? symbol);
    if (c.symbolTypes.get(id) === undefined) c.symbolTypes.set(id, c.errorType);
  }
  return c.symbolTypes.get(id)!;
}

function getTypeOfPrototypeProperty(c: Checker, prototype: Symbol): Type {
  // Every class has a `prototype` of its instance type with `any` type arguments.
  const classType = getDeclaredTypeOfSymbol(c, getParentOfSymbol(c, prototype)!) as InterfaceType;
  const typeParameters = classType.typeParameters();
  return typeParameters.length !== 0
    ? createTypeReference(
        c,
        classType,
        typeParameters.map(() => c.anyType),
      )
    : classType;
}

export { getDeclarationOfAliasSymbol, filterType, hasStaticModifier };
export type { UnionType };

/** `Extract<t, string>`, or string without the global `Extract`. */
export function getExtractStringType(c: Checker, t: Type): Type {
  const extract = getGlobalTypeAliasSymbol(c, 'Extract', 2, true);
  return extract !== undefined ? getTypeAliasInstantiation(c, extract, [t, c.stringType], undefined) : c.stringType;
}
