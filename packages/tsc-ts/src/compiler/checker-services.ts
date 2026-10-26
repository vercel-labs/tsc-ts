// Checker queries for language services and the API: the symbol or type at a node, constant
// values, alias targets and module exports, like tsgo's checker services. These answer *some*
// symbol or type for any node; the checker itself uses the precise functions they call.
import {
  type BinaryExpression,
  type ElementAccessExpression,
  type ExportSpecifier,
  type ExternalModuleReference,
  type ForInOrOfStatement,
  type ForStatement,
  getArguments,
  getExpression,
  getInitializer,
  getName,
  getParameters,
  getPropertyName,
  getSymbol,
  getTagName,
  getText,
  getType,
  getTypeArguments,
  type HeritageClause,
  type ImportEqualsDeclaration,
  type ImportTypeNode,
  type IndexedAccessTypeNode,
  isDeclarationNode,
  type LiteralTypeNode,
  type MetaProperty,
  type Node,
  NodeFlags,
  NodeVisitor,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  type QualifiedName,
  type ShorthandPropertyAssignment,
  type SourceFile,
  type TypeParameterDeclaration,
} from './ast.js';
import {
  compareNodePositions,
  getExternalModuleName,
  isAssignmentOperator,
  isFunctionLike,
  isImportCall,
  isLiteralImportTypeNode,
  isStringLiteralLike,
  isTypeDeclaration,
  nodeIsMissing,
} from './ast-utilities.js';
import {
  getNameOfDeclaration,
  getSourceFileOfNode,
  getThisContainer,
  isAssignmentTarget,
  isBindableObjectDefinePropertyCall,
  isClassLike,
  isEnumConst,
  isExternalOrCommonJSModule,
  isVariableDeclarationInitializedToRequire,
} from './binder-utilities.js';
import type { Checker } from './checker.js';
import { getResolvedSignature, tryGetRestTypeOfSignature } from './checker-calls.js';
import { getContextualType } from './checker-contextual.js';
import {
  computeEnumMemberValues,
  getBaseTypes,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  isEntityNameExpression,
} from './checker-declared-types.js';
import { EvaluatedKind } from './checker-evaluator.js';
import {
  checkExpression,
  checkExpressionCached,
  checkPropertyAccessExpression,
  checkQualifiedName,
  isThisInTypeQuery,
} from './checker-expressions.js';
import { getIntrinsicTagSymbol, isJsxIntrinsicTagName } from './checker-jsx.js';
import {
  getApplicableIndexInfo,
  getIndexInfosOfType,
  getPropertyOfType,
  getTypeWithThisArgument,
  isApplicableIndexType,
} from './checker-members.js';
import {
  checkNewTargetMetaProperty,
  getExternalModuleMember,
  getHostSignatureFromJSDoc,
  getSymbolOfPartOfRightHandSideOfImportEquals,
  getTargetOfAliasDeclaration,
  resolveExternalModuleName,
  resolveJSDocMemberName,
} from './checker-modules.js';
import { getSymbolHasInstanceMethodOfObjectType } from './checker-operators.js';
import { getSymbolForPrivateIdentifierExpression } from './checker-property-access.js';
import { getSignatureFromDeclaration } from './checker-signatures.js';
import {
  getAnnotatedAccessorTypeNode,
  getNonMissingTypeOfSymbol,
  getTypeForVariableLikeDeclaration,
  getTypeOfSymbol,
  getWriteTypeOfAccessors,
  getWriteTypeOfSymbol,
  removeOptionalTypeMarker,
} from './checker-symbol-types.js';
import {
  getCachedGlobalType,
  getDeclarationOfAliasSymbol,
  getExportsOfModule,
  getExportsOfSymbol,
  getExportSymbolOfValueSymbolIfExported,
  getMergedSymbol,
  getSymbolOfDeclaration,
  isReservedMemberName,
  resolveEntityName,
} from './checker-symbols.js';
import { createAnonymousType, getRegularTypeOfLiteralType, isErrorType } from './checker-type-factory.js';
import { getLiteralTypeFromPropertyName } from './checker-type-operators.js';
import {
  getTypeFromThisTypeNode,
  getTypeFromTypeNode,
  getUnresolvedSymbolForEntityName,
} from './checker-type-nodes.js';
import { CheckMode, type Signature, type Type } from './checker-types.js';
import { getNodeAtPosition } from './parser.js';
import { CheckFlags, getSymbolId, InternalSymbolName, setDeclarations, type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';

// ---- Symbols at locations

/** The symbol a name, keyword or literal at `node` refers to. */
export function getSymbolAtLocation(c: Checker, node: Node): Symbol | undefined {
  // API lookups shouldn't report errors.
  return getSymbolAtLocationWorker(c, getReparsedNodeForNode(node), true);
}

/** The symbol a node refers to, reporting resolution errors unless `ignoreErrors`. */
export function getSymbolAtLocationWorker(c: Checker, node: Node, ignoreErrors: boolean): Symbol | undefined {
  if (node.kind === SyntaxKind.SourceFile)
    return isExternalOrCommonJSModule(node as SourceFile) ? getSymbolOfDeclaration(c, node) : undefined;
  const parent = node.parent!;
  const grandParent = parent.parent;
  // Semantic questions inside `with` blocks have no answer.
  if ((node.flags & NodeFlags.InWithStatement) !== 0) return undefined;
  if (isDeclarationNameOrImportPropertyName(node)) {
    const parentSymbol = getSymbolOfDeclaration(c, parent);
    if (isImportOrExportSpecifier(parent) && getPropertyName(parent) === node)
      return parentSymbol !== undefined ? getImmediateAliasedSymbol(c, parentSymbol) : undefined;
    return parentSymbol;
  }
  if (isLiteralComputedPropertyDeclarationName(node)) return getSymbolOfDeclaration(c, grandParent!);
  if (node.kind === SyntaxKind.Identifier) {
    if (isInRightSideOfImportOrExportAssignment(node)) return getSymbolOfNameOrPropertyAccessExpression(c, node);
    if (
      parent.kind === SyntaxKind.BindingElement &&
      grandParent!.kind === SyntaxKind.ObjectBindingPattern &&
      node === getPropertyName(parent)
    ) {
      const property = getPropertyOfType(c, getTypeOfNode(c, grandParent!), getText(node));
      if (property !== undefined) return property;
    } else if (parent.kind === SyntaxKind.MetaProperty && (parent as MetaProperty).name === node) {
      const meta = parent as MetaProperty;
      // `target` in `new.target`.
      if (meta.keywordToken === SyntaxKind.NewKeyword && getText(node) === 'target')
        return checkNewTargetMetaProperty(c, parent).symbol;
      // `meta` in `import.meta` is the declarationless `meta` member of a synthetic type.
      if (meta.keywordToken === SyntaxKind.ImportKeyword && getText(node) === 'meta')
        return getGlobalImportMetaExpressionType(c).symbol!.members!.get('meta');
      // Other meta properties are invalid syntax.
      return undefined;
    } else if (parent.kind === SyntaxKind.JSDocParameterTag && getName(parent) === node) {
      const fn = getNodeAtPosition(getSourceFileOfNode(node), node.pos, false);
      if (isFunctionLike(fn)) {
        for (const param of getParameters(fn)!.nodes) {
          const name = getName(param);
          if (name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === getText(node))
            return getSymbolOfDeclaration(c, param);
        }
      }
    }
  }
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.QualifiedName:
      if (!isThisInTypeQuery(node)) return getSymbolOfNameOrPropertyAccessExpression(c, node);
      return getSymbolOfThis(c, node);
    case SyntaxKind.ThisKeyword:
      return getSymbolOfThis(c, node);
    case SyntaxKind.ThisType:
      return getTypeFromThisTypeNode(c, node).symbol;
    case SyntaxKind.SuperKeyword:
      return checkExpression(c, node).symbol;
    case SyntaxKind.ConstructorKeyword:
      // The keyword of a constructor overload.
      return parent.kind === SyntaxKind.Constructor ? getSymbol(parent.parent!) : undefined;
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      // Module names: `import x = require("m")`, import and export declarations, `require("m")`,
      // `import("m")` and `import("m")` types.
      if (
        (grandParent !== undefined &&
          isExternalModuleImportEqualsDeclaration(grandParent) &&
          ((grandParent as ImportEqualsDeclaration).moduleReference as ExternalModuleReference).expression === node) ||
        ((parent.kind === SyntaxKind.ImportDeclaration ||
          parent.kind === SyntaxKind.JSImportDeclaration ||
          parent.kind === SyntaxKind.ExportDeclaration) &&
          getExternalModuleName(parent) === node) ||
        (grandParent !== undefined && isVariableDeclarationInitializedToRequire(grandParent)) ||
        isImportCall(parent) ||
        (parent.kind === SyntaxKind.LiteralType &&
          grandParent !== undefined &&
          isLiteralImportTypeNode(grandParent) &&
          (grandParent as ImportTypeNode).argument === parent)
      )
        return resolveExternalModuleName(c, node, node, ignoreErrors);
      if (
        parent.kind === SyntaxKind.CallExpression &&
        isBindableObjectDefinePropertyCall(parent) &&
        getArguments(parent)!.nodes[1]! === node
      )
        return getSymbolOfDeclaration(c, parent);
      return getSymbolOfLiteralIndex(c, node);
    case SyntaxKind.NumericLiteral:
      return getSymbolOfLiteralIndex(c, node);
    case SyntaxKind.DefaultKeyword:
    case SyntaxKind.FunctionKeyword:
    case SyntaxKind.EqualsGreaterThanToken:
    case SyntaxKind.ClassKeyword:
      return getSymbolOfDeclaration(c, parent);
    case SyntaxKind.ImportType:
      if (isLiteralImportTypeNode(node))
        return getSymbolAtLocationWorker(
          c,
          ((node as ImportTypeNode).argument as LiteralTypeNode).literal,
          ignoreErrors,
        );
      return undefined;
    case SyntaxKind.ExportKeyword:
      return parent.kind === SyntaxKind.ExportAssignment ? getSymbol(parent) : undefined;
    case SyntaxKind.ImportKeyword:
      if (parent.kind === SyntaxKind.MetaProperty && (parent as MetaProperty).name.text === 'defer') return undefined;
      return parent.kind === SyntaxKind.MetaProperty ? checkMetaPropertyKeyword(c).symbol : undefined;
    case SyntaxKind.NewKeyword:
      return parent.kind === SyntaxKind.MetaProperty ? checkMetaPropertyKeyword(c).symbol : undefined;
    case SyntaxKind.InstanceOfKeyword:
      if (parent.kind === SyntaxKind.BinaryExpression) {
        const t = checkExpressionCached(c, (parent as BinaryExpression).right);
        const hasInstanceMethodType = getSymbolHasInstanceMethodOfObjectType(c, t);
        if (hasInstanceMethodType !== undefined && hasInstanceMethodType.symbol !== undefined)
          return hasInstanceMethodType.symbol;
        return t.symbol;
      }
      return undefined;
    case SyntaxKind.MetaProperty:
      return checkExpression(c, node).symbol;
    case SyntaxKind.JsxNamespacedName:
      if (isJsxTagName(node) && isJsxIntrinsicTagName(node)) {
        const symbol = getIntrinsicTagSymbol(c, parent);
        return symbol === c.unknownSymbol ? undefined : symbol;
      }
      return undefined;
  }
  return undefined;
}

/** The symbol of `this`: the function's `this` parameter, or the type `this` refers to. */
function getSymbolOfThis(c: Checker, node: Node): Symbol | undefined {
  const container = getThisContainer(node, false, false);
  if (isFunctionLike(container)) {
    const signature = getSignatureFromDeclaration(c, container);
    if (signature.thisParameter !== undefined) return signature.thisParameter;
  }
  if (isInExpressionContext(node)) return checkExpression(c, node).symbol;
  return getTypeFromThisTypeNode(c, node).symbol;
}

/** The property a literal index refers to, in `o["x"]` or `T["x"]`. */
function getSymbolOfLiteralIndex(c: Checker, node: Node): Symbol | undefined {
  const parent = node.parent!;
  let objectType: Type | undefined;
  if (parent.kind === SyntaxKind.ElementAccessExpression) {
    if ((parent as ElementAccessExpression).argumentExpression === node)
      objectType = checkExpressionCached(c, (parent as ElementAccessExpression).expression);
  } else if (parent.kind === SyntaxKind.LiteralType && parent.parent!.kind === SyntaxKind.IndexedAccessType)
    objectType = getTypeFromTypeNode(c, (parent.parent as IndexedAccessTypeNode).objectType);
  return objectType !== undefined ? getPropertyOfType(c, objectType, getText(node)) : undefined;
}

function getSymbolOfNameOrPropertyAccessExpression(c: Checker, nameIn: Node): Symbol | undefined {
  let name = nameIn;
  if (isDeclarationName(name)) return getSymbolOfDeclaration(c, name.parent!);
  if (name.parent!.kind === SyntaxKind.ExportAssignment && isEntityNameExpression(name)) {
    // An entity name that doesn't resolve as one may still check as a property access.
    const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias;
    const success = resolveEntityName(c, name, meaning, true, false, undefined);
    if (success !== undefined && success !== c.unknownSymbol) return success;
  } else if (isEntityName(name) && isInRightSideOfImportOrExportAssignment(name)) {
    // Export assignments were handled above, so this is an import.
    return getSymbolOfPartOfRightHandSideOfImportEquals(c, name);
  }
  if (isEntityName(name)) {
    const possibleImportNode = isImportTypeQualifierPart(name);
    if (possibleImportNode !== undefined) {
      getTypeFromTypeNode(c, possibleImportNode);
      const symbol = c.resolvedSymbols.get(name.id);
      return symbol === c.unknownSymbol ? undefined : symbol;
    }
  }
  while (isRightSideOfQualifiedNameOrPropertyAccess(name)) name = name.parent!;
  if (isInNameOfExpressionWithTypeArguments(name)) {
    let meaning: SymbolFlags;
    if (name.parent!.kind === SyntaxKind.ExpressionWithTypeArguments) {
      // `extends Bar<T>` in an interface is a type, `foo<T>` a value, and a class `extends` both.
      meaning = isPartOfTypeNode(name) ? SymbolFlags.Type : SymbolFlags.Value;
      if (isExpressionWithTypeArgumentsInClassExtendsClause(name.parent!)) meaning |= SymbolFlags.Value;
    } else meaning = SymbolFlags.Namespace;
    meaning |= SymbolFlags.Alias;
    const entityNameSymbol = isEntityNameExpression(name)
      ? resolveEntityName(c, name, meaning, true, false, undefined)
      : undefined;
    if (entityNameSymbol !== undefined) return entityNameSymbol;
  }
  if (isExpressionNode(name)) {
    // A missing entity name.
    if (nodeIsMissing(name)) return undefined;
    const isJSDoc = isJSDocNameReferenceContext(name);
    if (name.kind === SyntaxKind.Identifier) {
      if (isJsxTagName(name) && isJsxIntrinsicTagName(name)) {
        const symbol = getIntrinsicTagSymbol(c, name.parent!);
        return symbol === c.unknownSymbol ? undefined : symbol;
      }
      const meaning = isJSDoc ? SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace : SymbolFlags.Value;
      const location = isJSDoc ? getHostSignatureFromJSDoc(name) : undefined;
      let result = resolveEntityName(c, name, meaning, true, true, location);
      if (result === undefined && isJSDoc) {
        // Unqualified references to static members and instance members of a class or interface.
        let container = name.parent;
        while (container !== undefined && !isClassOrInterfaceLike(container)) container = container.parent;
        if (container !== undefined) {
          const symbol = getSymbolOfDeclaration(c, container)!;
          const member = getExportsOfSymbol(c, symbol).get(getText(name));
          result =
            member !== undefined && (member.flags & meaning) !== 0
              ? getMergedSymbol(c, member)
              : getPropertyOfType(c, getDeclaredTypeOfSymbol(c, symbol), getText(name));
        }
      }
      return result;
    }
    if (name.kind === SyntaxKind.PrivateIdentifier) return getSymbolForPrivateIdentifierExpression(c, name);
    if (name.kind === SyntaxKind.PropertyAccessExpression || name.kind === SyntaxKind.QualifiedName) {
      const cached = c.resolvedSymbols.get(name.id);
      if (cached !== undefined) return cached;
      if (name.kind === SyntaxKind.PropertyAccessExpression) {
        const access = name as PropertyAccessExpression;
        checkPropertyAccessExpression(c, access, false);
        if (c.resolvedSymbols.get(name.id) === undefined && access.name.kind !== SyntaxKind.PrivateIdentifier)
          c.resolvedSymbols.set(
            name.id,
            getApplicableIndexSymbol(
              c,
              checkExpressionCached(c, access.expression),
              getLiteralTypeFromPropertyName(c, access.name) ?? c.errorType,
            ),
          );
      } else checkQualifiedName(c, name as QualifiedName);
      if (c.resolvedSymbols.get(name.id) === undefined && isJSDoc && name.kind === SyntaxKind.QualifiedName)
        return resolveJSDocMemberName(c, name);
      return c.resolvedSymbols.get(name.id);
    }
  } else if (isEntityName(name) && isTypeReferenceIdentifier(name)) {
    const meaning = name.parent!.kind === SyntaxKind.TypeReference ? SymbolFlags.Type : SymbolFlags.Namespace;
    const symbol = resolveEntityName(c, name, meaning, true, true, undefined);
    if (symbol !== undefined && symbol !== c.unknownSymbol) return symbol;
    return getUnresolvedSymbolForEntityName(c, name);
  }
  if (name.parent!.kind === SyntaxKind.TypePredicate)
    return resolveEntityName(c, name, SymbolFlags.FunctionScopedVariable, true, false, undefined);
  return undefined;
}

/** A property symbol for the index signatures of `t` that apply to `keyType`, made once per signature. */
function getApplicableIndexSymbol(c: Checker, t: Type, keyType: Type): Symbol | undefined {
  const info = getApplicableIndexInfo(c, t, keyType);
  if (info === undefined || info === c.anyBaseTypeIndexInfo) return undefined;
  if (info.indexSymbol === undefined) {
    const declarations: Node[] = [];
    if (info.declaration !== undefined) declarations.push(info.declaration);
    else
      for (const other of getIndexInfosOfType(c, t))
        if (other.declaration !== undefined && isApplicableIndexType(c, keyType, other.keyType))
          declarations.push(other.declaration);
    if (declarations.length !== 0) {
      const symbol = c.newSymbolWithCheckFlags(SymbolFlags.Property, InternalSymbolName.Index, CheckFlags.IndexSymbol);
      setDeclarations(symbol, declarations);
      symbol.valueDeclaration = declarations[0]!;
      symbol.parent = t.symbol;
      c.symbolTypes.set(getSymbolId(symbol), info.valueType);
      info.indexSymbol = symbol;
    }
  }
  return info.indexSymbol;
}

/** The type of `import.meta` as an expression: `{ meta: ImportMeta }`. */
function getGlobalImportMetaExpressionType(c: Checker): Type {
  let t = c.importMetaExpressionType;
  if (t === undefined) {
    const symbol = c.newSymbol(SymbolFlags.None, 'ImportMetaExpression');
    const metaProperty = c.newSymbolWithCheckFlags(SymbolFlags.Property, 'meta', CheckFlags.Readonly);
    metaProperty.parent = symbol;
    c.symbolTypes.set(getSymbolId(metaProperty), getCachedGlobalType(c, 'ImportMeta', 0, true));
    const members = new Map<string, Symbol>();
    members.set('meta', metaProperty);
    symbol.members = members;
    t = createAnonymousType(c, symbol, members, [], [], []);
    c.importMetaExpressionType = t;
  }
  return t;
}

/** The type of the `import` or `new` keyword of a meta property, which has none. */
function checkMetaPropertyKeyword(c: Checker): Type {
  return c.errorType;
}

// ---- Types at locations

/** The type of the expression, type node or declaration at `node`. */
export function getTypeAtLocation(c: Checker, node: Node): Type {
  return getTypeOfNode(c, getReparsedNodeForNode(node));
}

export function getTypeOfNode(c: Checker, node: Node): Type {
  if (node.kind === SyntaxKind.SourceFile && !isExternalOrCommonJSModule(node as SourceFile)) return c.errorType;
  // Semantic questions inside `with` blocks have no answer.
  if ((node.flags & NodeFlags.InWithStatement) !== 0) return c.errorType;
  const heritage = getClassOfHeritageExpression(node);
  const classType =
    heritage !== undefined ? getDeclaredTypeOfClassOrInterface(c, getSymbolOfDeclaration(c, heritage)!) : undefined;
  if (isPartOfTypeNode(node)) {
    const typeFromTypeNode = getTypeFromTypeNode(c, node);
    return classType !== undefined
      ? getTypeWithThisArgument(c, typeFromTypeNode, classType.thisType, false)
      : typeFromTypeNode;
  }
  if (isExpressionNode(node)) return getRegularTypeOfExpression(c, node);
  if (classType !== undefined && !isImplementsExpression(node)) {
    // An expression with type arguments in a class `extends` clause is the base type.
    const baseTypes = getBaseTypes(c, classType);
    return baseTypes.length > 0 ? getTypeWithThisArgument(c, baseTypes[0]!, classType.thisType, false) : c.errorType;
  }
  if (isTypeDeclaration(node)) return getDeclaredTypeOfSymbol(c, getSymbolOfDeclaration(c, node)!);
  if (isTypeDeclarationName(node)) {
    const symbol = getSymbolAtLocationWorker(c, node, false);
    return symbol !== undefined ? getDeclaredTypeOfSymbol(c, symbol) : c.errorType;
  }
  if (node.kind === SyntaxKind.BindingElement) return getTypeForVariableLikeDeclaration(c, node, true) ?? c.errorType;
  if (isDeclaration(node)) {
    const symbol = getSymbolOfDeclaration(c, node);
    return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.errorType;
  }
  if (isDeclarationNameOrImportPropertyName(node)) {
    const symbol = getSymbolAtLocationWorker(c, node, false);
    return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.errorType;
  }
  if (isBindingPattern(node)) return getTypeForVariableLikeDeclaration(c, node.parent!, true) ?? c.errorType;
  if (isInRightSideOfImportOrExportAssignment(node)) {
    const symbol = getSymbolAtLocationWorker(c, node, false);
    if (symbol !== undefined) {
      const declaredType = getDeclaredTypeOfSymbol(c, symbol);
      return !isErrorType(c, declaredType) ? declaredType : getTypeOfSymbol(c, symbol);
    }
  }
  const parent = node.parent;
  if (
    parent !== undefined &&
    parent.kind === SyntaxKind.MetaProperty &&
    (parent as MetaProperty).keywordToken === node.kind
  )
    return checkMetaPropertyKeyword(c);
  if (node.kind === SyntaxKind.ImportAttributes) return getCachedGlobalType(c, 'ImportAttributes', 0, true);
  return c.errorType;
}

function getRegularTypeOfExpression(c: Checker, node: Node): Type {
  const expr = isRightSideOfQualifiedNameOrPropertyAccess(node) ? node.parent! : node;
  return getRegularTypeOfLiteralType(c, checkExpressionCached(c, expr));
}

/** The narrowed type of `symbol` at `location`, or its declared type when `location` doesn't reference it. */
export function getTypeOfSymbolAtLocation(c: Checker, symbolIn: Symbol, locationIn: Node | undefined): Type {
  const symbol = getExportSymbolOfValueSymbolIfExported(c, symbolIn);
  let location = locationIn;
  if (location !== undefined) {
    // A reference to the symbol that isn't only assigned to has a flow type.
    if (
      (location.kind === SyntaxKind.Identifier || location.kind === SyntaxKind.PrivateIdentifier) &&
      !(
        isJsxTagName(location) ||
        location.parent!.kind === SyntaxKind.JsxAttribute ||
        location.parent!.kind === SyntaxKind.JsxNamespacedName
      )
    ) {
      if (isRightSideOfQualifiedNameOrPropertyAccess(location)) location = location.parent!;
      if (isExpressionNode(location) && (!isAssignmentTarget(location) || isWriteAccess(location))) {
        const t = checkExpressionCached(c, location);
        const resolved = c.resolvedSymbols.get(location.id);
        if (resolved !== undefined && getExportSymbolOfValueSymbolIfExported(c, resolved) === symbol)
          return removeOptionalTypeMarker(c, t);
      }
    }
    if (
      isDeclarationName(location) &&
      location.parent!.kind === SyntaxKind.SetAccessor &&
      getAnnotatedAccessorTypeNode(location.parent) !== undefined
    )
      return getWriteTypeOfAccessors(c, getSymbol(location.parent!)!);
    // A hypothetical reference has no flow information, so it gets the declared type.
    if (isRightSideOfAccessExpression(location) && isWriteAccess(location.parent!))
      return getWriteTypeOfSymbol(c, symbol);
  }
  return getNonMissingTypeOfSymbol(c, symbol);
}

// ---- Other queries

/** The value symbol of a shorthand property assignment's name. */
export function getShorthandAssignmentValueSymbol(c: Checker, node: Node | undefined): Symbol | undefined {
  if (node === undefined || node.kind !== SyntaxKind.ShorthandPropertyAssignment) return undefined;
  return resolveEntityName(
    c,
    (node as ShorthandPropertyAssignment).name,
    SymbolFlags.Value | SymbolFlags.Alias,
    true,
    false,
    undefined,
  );
}

/** The local symbol an export specifier, or the identifier of one, refers to. Throws for other nodes. */
export function getExportSpecifierLocalTargetSymbol(c: Checker, node: Node): Symbol | undefined {
  const meaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias;
  if (node.kind === SyntaxKind.ExportSpecifier) {
    const exportDeclaration = node.parent!.parent!;
    if (getExternalModuleName(exportDeclaration) !== undefined)
      return getExternalModuleMember(c, exportDeclaration, node, false);
    const specifier = node as ExportSpecifier;
    const name = specifier.propertyName ?? specifier.name;
    // Invalid syntax like `export { "x" }`.
    if (name.kind === SyntaxKind.StringLiteral) return undefined;
    return resolveEntityName(c, name, meaning, true, false, undefined);
  }
  if (node.kind === SyntaxKind.Identifier) return resolveEntityName(c, node, meaning, true, false, undefined);
  throw new Error('getExportSpecifierLocalTargetSymbol expects an export specifier or identifier');
}

/** The value of an enum member, or of a reference to a const enum member. */
export function getConstantValue(c: Checker, node: Node): string | number | undefined {
  if (node.kind === SyntaxKind.EnumMember) return getEnumMemberValue(c, node);
  // Checking the expression records the symbol it resolves to.
  if (c.resolvedSymbols.get(node.id) === undefined) checkExpressionCached(c, node);
  let symbol = c.resolvedSymbols.get(node.id);
  if (symbol === undefined && isEntityNameExpression(node))
    symbol = resolveEntityName(c, node, SymbolFlags.Value, true, false, undefined);
  if (symbol !== undefined && (symbol.flags & SymbolFlags.EnumMember) !== 0) {
    // Only const enum accesses are inlined.
    const member = symbol.valueDeclaration!;
    if (isEnumConst(member.parent!)) return getEnumMemberValue(c, member);
  }
  return undefined;
}

function getEnumMemberValue(c: Checker, member: Node): string | number | undefined {
  computeEnumMemberValues(c, member.parent!);
  const links = c.nodeLinks(member);
  if (links.enumValueKind === EvaluatedKind.Number) return links.enumNumberValue;
  if (links.enumValueKind === EvaluatedKind.String) return links.enumStringValue;
  return undefined;
}

/** The symbol an alias refers to directly, without following further aliases. Throws for non-aliases. */
export function getImmediateAliasedSymbol(c: Checker, symbol: Symbol): Symbol | undefined {
  const links = c.symbolLinks(symbol);
  if (links.immediateTarget === undefined) {
    const node = getDeclarationOfAliasSymbol(symbol);
    if (node === undefined) throw new Error('getImmediateAliasedSymbol expects an alias symbol');
    links.immediateTarget = getTargetOfAliasDeclaration(c, node);
  }
  return links.immediateTarget;
}

/** The export of a module named `name`. */
export function tryGetMemberInModuleExports(c: Checker, name: string, moduleSymbol: Symbol): Symbol | undefined {
  return getExportsOfModule(c, moduleSymbol).get(name);
}

/** The exports of a module, without reserved names like `export=`. */
export function getExportsOfModuleAsArray(c: Checker, moduleSymbol: Symbol): Symbol[] {
  const result: Symbol[] = [];
  for (const [name, symbol] of getExportsOfModule(c, moduleSymbol))
    if (!isReservedMemberName(name)) result.push(symbol);
  return result;
}

/** The element type of a signature's rest parameter, or `any` without one. */
export function getRestTypeOfSignature(c: Checker, signature: Signature): Type {
  return tryGetRestTypeOfSignature(c, signature) ?? c.anyType;
}

/**
 * The signature of a function-like declaration. Declarations and call-like expressions share the
 * cached signature, so a call that was resolved gives its signature; other nodes throw.
 */
export function querySignatureFromDeclaration(c: Checker, node: Node): Signature {
  const cached = c.resolvedSignatures.get(node.id);
  if (cached !== undefined) return cached;
  if (!isFunctionLike(node)) throw new Error('getSignatureFromDeclaration expects a function-like declaration');
  return getSignatureFromDeclaration(c, node);
}

/** The signature a call-like expression resolves to. Throws for other nodes. */
export function queryResolvedSignature(c: Checker, node: Node): Signature {
  switch (node.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.Decorator:
    case SyntaxKind.JsxOpeningFragment:
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.BinaryExpression:
      return getResolvedSignature(c, node, CheckMode.Normal);
  }
  throw new Error('getResolvedSignature expects a call-like expression');
}

/** The contextual type of an expression. Throws for a source file, which has no parent. */
export function queryContextualType(c: Checker, node: Node): Type | undefined {
  if (node.parent === undefined) throw new Error('getContextualType expects a node with a parent');
  // Semantic questions inside `with` blocks have no answer.
  if ((node.flags & NodeFlags.InWithStatement) !== 0) return undefined;
  return getContextualType(c, node);
}

// ---- Syntax

/**
 * The node a JSDoc node was reparsed into, if any: types and declarations written in JSDoc are
 * checked as clones in the tree.
 */
export function getReparsedNodeForNode(node: Node): Node {
  if ((node.flags & NodeFlags.JSDoc) === 0 || (node.flags & NodeFlags.Reparsed) !== 0) return node;
  const clones = getSourceFileOfNode(node).reparsedClones;
  if (clones.length === 0) return node;
  let low = 0;
  let high = clones.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const cmp = compareNodePositions(clones[middle]!, node);
    if (cmp < 0) low = middle + 1;
    else if (cmp > 0) high = middle - 1;
    else {
      index = middle;
      break;
    }
  }
  if (index < 0) index = low > 0 ? low - 1 : 0;
  const candidate = clones[index]!;
  if (candidate.pos <= node.pos && node.end <= candidate.end) {
    const clone = findCloneInNode(candidate, node);
    if (clone !== undefined) return clone;
  }
  return node;
}

function findCloneInNode(root: Node, original: Node): Node | undefined {
  let node = root;
  for (;;) {
    if (node.kind === original.kind && node.pos === original.pos && node.end === original.end) return node;
    let next: Node | undefined;
    for (const child of childrenOf(node))
      if (child.pos <= original.pos && original.end <= child.end) {
        next = child;
        break;
      }
    if (next === undefined) return undefined;
    node = next;
  }
}

function childrenOf(node: Node): Node[] {
  const result: Node[] = [];
  node.forEachChild(new ChildCollector(result));
  return result;
}

class ChildCollector extends NodeVisitor {
  readonly nodes: Node[];

  constructor(nodes: Node[]) {
    super();
    this.nodes = nodes;
  }

  visitNode(node: Node): boolean {
    this.nodes.push(node);
    return false;
  }
}

export function isEntityName(node: Node): boolean {
  return node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.QualifiedName;
}

function isBindingPattern(node: Node): boolean {
  return node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern;
}

function isImportOrExportSpecifier(node: Node): boolean {
  return node.kind === SyntaxKind.ImportSpecifier || node.kind === SyntaxKind.ExportSpecifier;
}

function isClassOrInterfaceLike(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ClassDeclaration ||
    node.kind === SyntaxKind.ClassExpression ||
    node.kind === SyntaxKind.InterfaceDeclaration
  );
}

function isJSDocLinkLike(node: Node): boolean {
  return (
    node.kind === SyntaxKind.JSDocLink ||
    node.kind === SyntaxKind.JSDocLinkCode ||
    node.kind === SyntaxKind.JSDocLinkPlain
  );
}

export function isDeclaration(node: Node): boolean {
  if (node.kind === SyntaxKind.TypeParameter) return node.parent !== undefined;
  return isDeclarationNode(node);
}

export function isDeclarationName(name: Node): boolean {
  return (
    name.kind !== SyntaxKind.SourceFile &&
    !isBindingPattern(name) &&
    isDeclaration(name.parent!) &&
    getName(name.parent!) === name
  );
}

/** Like `isDeclarationName`, but also the left of `import { x as y }` and `export { x as y }`. */
function isDeclarationNameOrImportPropertyName(name: Node): boolean {
  if (isImportOrExportSpecifier(name.parent!))
    return name.kind === SyntaxKind.Identifier || name.kind === SyntaxKind.StringLiteral;
  return isDeclarationName(name);
}

export function isLiteralComputedPropertyDeclarationName(node: Node): boolean {
  return (
    (isStringLiteralLike(node) || node.kind === SyntaxKind.NumericLiteral) &&
    node.parent!.kind === SyntaxKind.ComputedPropertyName &&
    isDeclaration(node.parent!.parent!)
  );
}

function isExternalModuleImportEqualsDeclaration(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ImportEqualsDeclaration &&
    (node as ImportEqualsDeclaration).moduleReference.kind === SyntaxKind.ExternalModuleReference
  );
}

export function isInRightSideOfImportOrExportAssignment(nodeIn: Node): boolean {
  let node = nodeIn;
  while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
  const parent = node.parent!;
  return (
    (parent.kind === SyntaxKind.ImportEqualsDeclaration &&
      (parent as ImportEqualsDeclaration).moduleReference === node) ||
    (parent.kind === SyntaxKind.ExportAssignment && getExpression(parent) === node)
  );
}

/** The `import()` type whose qualifier contains `node`. */
function isImportTypeQualifierPart(nodeIn: Node): Node | undefined {
  let node = nodeIn;
  let parent = node.parent;
  while (parent !== undefined && parent.kind === SyntaxKind.QualifiedName) {
    node = parent;
    parent = parent.parent;
  }
  if (parent !== undefined && parent.kind === SyntaxKind.ImportType && (parent as ImportTypeNode).qualifier === node)
    return parent;
  return undefined;
}

function isInNameOfExpressionWithTypeArguments(nodeIn: Node): boolean {
  let node = nodeIn;
  while (node.parent!.kind === SyntaxKind.PropertyAccessExpression) node = node.parent!;
  return node.parent!.kind === SyntaxKind.ExpressionWithTypeArguments;
}

export function isRightSideOfQualifiedNameOrPropertyAccess(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.QualifiedName:
      return (parent as QualifiedName).right === node;
    case SyntaxKind.PropertyAccessExpression:
      return (parent as PropertyAccessExpression).name === node;
    case SyntaxKind.MetaProperty:
      return (parent as MetaProperty).name === node;
  }
  return false;
}

function isRightSideOfAccessExpression(node: Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (parent.kind === SyntaxKind.PropertyAccessExpression) return (parent as PropertyAccessExpression).name === node;
  if (parent.kind === SyntaxKind.ElementAccessExpression)
    return (parent as ElementAccessExpression).argumentExpression === node;
  return false;
}

function isJsxTagName(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxClosingElement:
    case SyntaxKind.JsxSelfClosingElement:
      return getTagName(parent) === node;
  }
  return false;
}

export function isJSDocNameReferenceContext(node: Node): boolean {
  if ((node.flags & NodeFlags.JSDoc) === 0) return false;
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current.kind === SyntaxKind.JSDocNameReference || isJSDocLinkLike(current)) return true;
  return false;
}

/** The class of an expression with type arguments in its heritage clause. */
function getClassOfHeritageExpression(node: Node): Node | undefined {
  if (node.kind !== SyntaxKind.ExpressionWithTypeArguments) return undefined;
  const parent = node.parent!;
  return parent.kind === SyntaxKind.HeritageClause && isClassLike(parent.parent!) ? parent.parent : undefined;
}

function isImplementsExpression(node: Node): boolean {
  return (node.parent as HeritageClause).token === SyntaxKind.ImplementsKeyword;
}

function isExpressionWithTypeArgumentsInClassExtendsClause(node: Node): boolean {
  return getClassOfHeritageExpression(node) !== undefined && !isImplementsExpression(node);
}

function isTypeDeclarationName(name: Node): boolean {
  return (
    name.kind === SyntaxKind.Identifier && isTypeDeclaration(name.parent!) && getNameOfDeclaration(name.parent) === name
  );
}

/** Whether a type reference names `node`, as `T`, `N.T` or the namespace part of one. */
function isTypeReferenceIdentifier(nodeIn: Node): boolean {
  let node = nodeIn;
  while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
  return node.parent!.kind === SyntaxKind.TypeReference;
}

export function isPartOfTypeNode(node: Node): boolean {
  const kind = node.kind;
  if (kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode) return true;
  switch (kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.NeverKeyword:
      return true;
    case SyntaxKind.VoidKeyword:
      return node.parent!.kind !== SyntaxKind.VoidExpression;
    case SyntaxKind.ExpressionWithTypeArguments:
      return isPartOfTypeExpressionWithTypeArguments(node);
    case SyntaxKind.TypeParameter:
      return node.parent!.kind === SyntaxKind.MappedType || node.parent!.kind === SyntaxKind.InferType;
    case SyntaxKind.Identifier: {
      const parent = node.parent!;
      if (parent.kind === SyntaxKind.QualifiedName && (parent as QualifiedName).right === node)
        return isPartOfTypeNodeInParent(parent);
      if (parent.kind === SyntaxKind.PropertyAccessExpression && (parent as PropertyAccessExpression).name === node)
        return isPartOfTypeNodeInParent(parent);
      return isPartOfTypeNodeInParent(node);
    }
    case SyntaxKind.QualifiedName:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ThisKeyword:
      return isPartOfTypeNodeInParent(node);
  }
  return false;
}

function isPartOfTypeExpressionWithTypeArguments(node: Node): boolean {
  const parent = node.parent!;
  return (
    (parent.kind === SyntaxKind.HeritageClause &&
      (!isClassLike(parent.parent!) || (parent as HeritageClause).token === SyntaxKind.ImplementsKeyword)) ||
    parent.kind === SyntaxKind.JSDocImplementsTag ||
    parent.kind === SyntaxKind.JSDocAugmentsTag
  );
}

// Only the parent is tested: in `let a: A.B.C`, `C` and `A.B.C` are type nodes but `A.B` isn't.
function isPartOfTypeNodeInParent(node: Node): boolean {
  const parent = node.parent!;
  if (parent.kind === SyntaxKind.TypeQuery) return false;
  if (parent.kind === SyntaxKind.ImportType) return !(parent as ImportTypeNode).isTypeOf;
  if (parent.kind >= SyntaxKind.FirstTypeNode && parent.kind <= SyntaxKind.LastTypeNode) return true;
  switch (parent.kind) {
    case SyntaxKind.ExpressionWithTypeArguments:
      return isPartOfTypeExpressionWithTypeArguments(parent);
    case SyntaxKind.TypeParameter:
      return node === (parent as TypeParameterDeclaration).constraint;
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.Constructor:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.TypeAssertionExpression:
      return node === getType(parent);
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression: {
      const typeArguments = getTypeArguments(parent);
      return typeArguments !== undefined && typeArguments.nodes.includes(node);
    }
  }
  return false;
}

export function isExpressionNode(nodeIn: Node): boolean {
  let node = nodeIn;
  switch (node.kind) {
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.ConditionalExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.OmittedExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.AwaitExpression:
      return true;
    case SyntaxKind.MetaProperty:
      // `import.defer` in `import.defer(...)` isn't an expression.
      return !isImportCall(node.parent!) || getExpression(node.parent!) !== node;
    case SyntaxKind.ExpressionWithTypeArguments:
      return node.parent!.kind !== SyntaxKind.HeritageClause;
    case SyntaxKind.QualifiedName:
      while (node.parent!.kind === SyntaxKind.QualifiedName) node = node.parent!;
      return isNameReferenceParent(node) || isJsxTagName(node);
    case SyntaxKind.PrivateIdentifier: {
      const parent = node.parent!;
      return (
        parent.kind === SyntaxKind.BinaryExpression &&
        (parent as BinaryExpression).left === node &&
        (parent as BinaryExpression).operatorToken.kind === SyntaxKind.InKeyword
      );
    }
    case SyntaxKind.Identifier:
      if (isNameReferenceParent(node) || isJsxTagName(node)) return true;
      return isInExpressionContext(node);
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.ThisKeyword:
      return isInExpressionContext(node);
  }
  return false;
}

/** Whether `node`'s parent is a `typeof` query, a JSDoc link or a JSDoc name reference. */
function isNameReferenceParent(node: Node): boolean {
  const parent = node.parent!;
  return (
    parent.kind === SyntaxKind.TypeQuery || isJSDocLinkLike(parent) || parent.kind === SyntaxKind.JSDocNameReference
  );
}

function isInExpressionContext(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.EnumMember:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.BindingElement:
      return getInitializer(parent) === node;
    case SyntaxKind.ExpressionStatement:
    case SyntaxKind.IfStatement:
    case SyntaxKind.DoStatement:
    case SyntaxKind.WhileStatement:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.WithStatement:
    case SyntaxKind.SwitchStatement:
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
    case SyntaxKind.ThrowStatement:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TemplateSpan:
    case SyntaxKind.ComputedPropertyName:
    case SyntaxKind.SatisfiesExpression:
      return getExpression(parent) === node;
    case SyntaxKind.ForStatement: {
      const s = parent as ForStatement;
      return (
        (s.initializer === node && node.kind !== SyntaxKind.VariableDeclarationList) ||
        s.condition === node ||
        s.incrementor === node
      );
    }
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement: {
      const s = parent as ForInOrOfStatement;
      return (s.initializer === node && node.kind !== SyntaxKind.VariableDeclarationList) || s.expression === node;
    }
    case SyntaxKind.Decorator:
    case SyntaxKind.JsxExpression:
    case SyntaxKind.JsxSpreadAttribute:
    case SyntaxKind.SpreadAssignment:
      return true;
    case SyntaxKind.ExpressionWithTypeArguments:
      return getExpression(parent) === node && !isPartOfTypeNode(parent);
    case SyntaxKind.ShorthandPropertyAssignment:
      return (parent as ShorthandPropertyAssignment).objectAssignmentInitializer === node;
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
      // The name of a function or class expression is a declaration name, not an expression.
      return getName(parent) !== node;
  }
  return isExpressionNode(parent);
}

function isWriteAccess(node: Node): boolean {
  return accessKind(node) !== AccessKind.Read;
}

const enum AccessKind {
  Read,
  Write,
  ReadWrite,
}

function accessKind(node: Node): AccessKind {
  const parent = node.parent;
  if (parent === undefined) return AccessKind.Read;
  switch (parent.kind) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ArrayLiteralExpression:
      return accessKind(parent);
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression: {
      const operator =
        parent.kind === SyntaxKind.PrefixUnaryExpression
          ? (parent as PrefixUnaryExpression).operator
          : (parent as PostfixUnaryExpression).operator;
      return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken
        ? AccessKind.ReadWrite
        : AccessKind.Read;
    }
    case SyntaxKind.BinaryExpression: {
      const binary = parent as BinaryExpression;
      if (binary.left === node && isAssignmentOperator(binary.operatorToken.kind))
        return binary.operatorToken.kind === SyntaxKind.EqualsToken ? AccessKind.Write : AccessKind.ReadWrite;
      return AccessKind.Read;
    }
    case SyntaxKind.PropertyAccessExpression:
      return (parent as PropertyAccessExpression).name !== node ? AccessKind.Read : accessKind(parent);
    case SyntaxKind.PropertyAssignment: {
      const parentAccess = accessKind(parent.parent!);
      // In `({ x: v } = o)`, the `x` is read and `v` written.
      if (node === getName(parent)) {
        if (parentAccess === AccessKind.Read) return AccessKind.Write;
        if (parentAccess === AccessKind.Write) return AccessKind.Read;
        return AccessKind.ReadWrite;
      }
      return parentAccess;
    }
    case SyntaxKind.ShorthandPropertyAssignment:
      // The local variable is what's accessed.
      if (node === (parent as ShorthandPropertyAssignment).objectAssignmentInitializer) return AccessKind.Read;
      return accessKind(parent.parent!);
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return node === (parent as ForInOrOfStatement).initializer ? AccessKind.Write : AccessKind.Read;
  }
  return AccessKind.Read;
}
