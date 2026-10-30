// Property access: member lookup on `a.b` and `A.B`, accessibility and readonly checks, and
// errors for missing members.
import { ScriptTarget, getUseDefineForClassFields } from './options.js';
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import {
  type Node,
  type PropertyAccessExpression,
  type QualifiedName,
  ModifierFlags,
  getBody,
  getExpression,
  getName,
  getParameters,
  getSymbol,
  getText,
  getType,
  type BindingElement,
  BinaryExpression,
  getInitializer,
} from './ast.js';
import {
  declarationNameToString,
  getContainingClass,
  getSourceFileOfNode,
  getThisContainer,
  isAccessExpression,
  hasSyntacticModifier,
  isClassLike,
  isOptionalChain,
  isPrivateIdentifierClassElementDeclaration,
  isStatic,
  skipParentheses,
  getElementOrPropertyAccessName,
  isBindableStaticAccessExpression,
  isBindableStaticNameExpression,
} from './binder-utilities.js';
import { isFunctionLike, isInJSFile } from './ast-utilities.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { type Diagnostic, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import {
  CheckMode,
  type IntersectionType,
  ObjectFlags,
  type Type,
  TypeFlags,
  TypeFormatFlags,
  type TypeParameter,
  type TypeReference,
} from './checker-types.js';
import {
  everyContainedType,
  getTargetType,
  getUnionType,
  isEmptyObjectType,
  isErrorType,
  typesOf,
} from './checker-type-factory.js';
import {
  getApparentType,
  getApplicableIndexInfoForName,
  getDeclarationModifierFlagsFromSymbol,
  getPropertiesOfType,
  getPropertiesOfUnionOrIntersectionType,
  getPropertyOfType,
  getPropertyOfTypeEx,
  isConflictingPrivateProperty,
  isDiscriminantWithNeverType,
} from './checker-members.js';
import {
  getDeclarationOfAliasSymbol,
  getParentOfSymbol,
  getSpellingSuggestionForName,
  getSymbolOfDeclaration,
} from './checker-symbols.js';
import { getFeatureMap } from './checker-features.js';
import { lazyObjectFlags } from './side-state.js';
import { isNodeDescendantOf } from './instantiation.js';
import { getTypeOfSymbol, getWidenedType, getWriteTypeOfSymbol, isReadonlySymbol } from './checker-symbol-types.js';
import {
  getClassLikeDeclarationOfSymbol,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfSymbol,
  hasBaseType,
} from './checker-declared-types.js';
import { getBaseConstraintOfType } from './checker-members.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { isGenericObjectType } from './checker-type-operators.js';
import { typeToString, symbolToString } from './type-printer.js';
import { getPromisedTypeOfPromise } from './checker-iteration.js';
import { AssignmentKind, getAssignmentTargetKind, getControlFlowContainer } from './checker-narrowing.js';
import { getSymbolNameForPrivateIdentifier } from './binder.js';
import { checkPropertyNotUsedBeforeDeclaration } from './checker-declaration-order.js';
import { grammarErrorOnNode } from './checker-operators.js';
import { markPropertyAliasReferenced } from './checker-modules.js';
import { checkDeprecatedIndexSignature, checkDeprecatedProperty } from './checker-deprecation.js';
import { isSelfTypeAccess, markPropertyAsReferenced } from './checker-unused.js';
import {
  getContextualThisParameterType,
  getFlowTypeOfAccessExpression,
  getResolvedSymbol,
} from './checker-expressions.js';
import { isJSLiteralType, isThisPropertyAccessInConstructor } from './checker-javascript.js';
import { CheckFlags, getDeclarations, getSymbolId, type Symbol, SymbolFlags } from './symbol.js';

export function checkPropertyAccessExpressionOrQualifiedName(
  c: Checker,
  node: Node,
  left: Node,
  leftType: Type,
  right: Node,
  writeOnly: boolean,
  checkMode: CheckMode = CheckMode.Normal,
): Type {
  const parentSymbol = c.resolvedSymbols.get(left.id);
  const assignmentKind = getAssignmentTargetKind(node);
  const widenedType =
    assignmentKind !== AssignmentKind.None || isMethodAccessForCall(node) ? getWidenedType(c, leftType) : leftType;
  const apparentType = getApparentType(c, widenedType);
  const isAnyLike = (apparentType.flags & TypeFlags.Any) !== 0 || apparentType === c.silentNeverType;
  const name = getText(right);
  const isPrivate = right.kind === SyntaxKind.PrivateIdentifier;
  let prop: Symbol | undefined = undefined;
  if (isPrivate) {
    // Downleveled private names use __classPrivateFieldGet and __classPrivateFieldSet.
    if (c.languageVersion < ScriptTarget.ESNext || !getUseDefineForClassFields(c.compilerOptions)) {
      if (assignmentKind !== AssignmentKind.None)
        checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ClassPrivateFieldSet);
      if (assignmentKind !== AssignmentKind.Definite)
        checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ClassPrivateFieldGet);
    }
    const lexicallyScopedSymbol = lookupSymbolForPrivateIdentifierDeclaration(name, right);
    if (
      assignmentKind !== AssignmentKind.None &&
      lexicallyScopedSymbol !== undefined &&
      lexicallyScopedSymbol.valueDeclaration !== undefined &&
      lexicallyScopedSymbol.valueDeclaration.kind === SyntaxKind.MethodDeclaration
    )
      grammarErrorOnNode(
        c,
        right,
        Diagnostics.Cannot_assign_to_private_method_0_Private_methods_are_not_writable,
        name,
      );
    if (isAnyLike) {
      if (lexicallyScopedSymbol !== undefined) return isErrorType(c, apparentType) ? c.errorType : apparentType;
      if (getContainingClassExcludingClassDecorators(right) === undefined) {
        grammarErrorOnNode(c, right, Diagnostics.Private_identifiers_are_not_allowed_outside_class_bodies);
        return c.anyType;
      }
    }
    if (lexicallyScopedSymbol !== undefined) prop = getPropertyOfType(c, leftType, lexicallyScopedSymbol.name);
    if (prop === undefined) {
      // Shadowing and lexical scoping errors specific to private names.
      if (checkPrivateIdentifierPropertyAccess(c, leftType, right, lexicallyScopedSymbol)) return c.errorType;
    } else if (
      (prop.flags & SymbolFlags.SetAccessor) !== 0 &&
      (prop.flags & SymbolFlags.GetAccessor) === 0 &&
      assignmentKind !== AssignmentKind.Definite
    )
      c.error(node, Diagnostics.Private_accessor_was_defined_without_a_getter);
  } else {
    if (isAnyLike) {
      if (left.kind === SyntaxKind.Identifier && c.resolvedSymbols.get(left.id) !== undefined)
        markPropertyAliasReferenced(c, node, undefined, leftType);
      return isErrorType(c, apparentType) ? c.errorType : apparentType;
    }
    prop = getPropertyOfTypeEx(
      c,
      apparentType,
      name,
      isConstEnumObjectType(apparentType),
      node.kind === SyntaxKind.QualifiedName,
    );
  }
  markPropertyAliasReferenced(c, node, prop, leftType);
  let propType: Type;
  if (prop === undefined) {
    const indexInfo =
      !isPrivate &&
      (assignmentKind === AssignmentKind.None || !isGenericObjectType(c, leftType) || isThisTypeParameter(leftType))
        ? getApplicableIndexInfoForName(c, apparentType, name)
        : undefined;
    if (indexInfo === undefined) {
      if (isJSLiteralType(c, leftType)) return c.anyType;
      if (leftType.symbol === c.globalThisSymbol) {
        const globalSymbol = c.globalThisSymbol.exports?.get(name);
        if (globalSymbol !== undefined && (globalSymbol.flags & SymbolFlags.BlockScoped) !== 0)
          c.error(right, Diagnostics.Property_0_does_not_exist_on_type_1, name, typeToString(c, leftType));
        else if (c.noImplicitAny)
          c.error(
            right,
            Diagnostics.Element_implicitly_has_an_any_type_because_type_0_has_no_index_signature,
            typeToString(c, leftType),
          );
        return c.anyType;
      }
      if (name !== '') {
        // Deferred, since printing the containing type can resolve it completely, and report circularities
        // while it is being resolved.
        const containingType = isThisTypeParameter(leftType) ? apparentType : leftType;
        c.deferredDiagnostics.push(() => reportNonexistentProperty(c, right, containingType));
      }
      return c.errorType;
    }
    if (indexInfo.isReadonly && (assignmentKind !== AssignmentKind.None || isDeleteTarget(node)))
      c.error(node, Diagnostics.Index_signature_in_type_0_only_permits_reading, typeToString(c, apparentType));
    propType = indexInfo.valueType;
    if (c.noUncheckedIndexedAccess && assignmentKind !== AssignmentKind.Definite)
      propType = getUnionType(c, [propType, c.missingType]);
    if (
      c.compilerOptions.noPropertyAccessFromIndexSignature === true &&
      node.kind === SyntaxKind.PropertyAccessExpression
    )
      c.error(right, Diagnostics.Property_0_comes_from_an_index_signature_so_it_must_be_accessed_with_0, name);
    checkDeprecatedIndexSignature(c, right, indexInfo.declaration);
  } else {
    checkDeprecatedProperty(c, node, right, prop);
    checkPropertyNotUsedBeforeDeclaration(c, prop, node, right);
    markPropertyAsReferenced(c, prop, node, isSelfTypeAccess(c, left, parentSymbol));
    // An access checked again (under another check mode) usually resolves to the same property.
    if (c.resolvedSymbols.get(node.id) !== prop) c.resolvedSymbols.set(node.id, prop);
    checkPropertyAccessibility(
      c,
      node,
      left.kind === SyntaxKind.SuperKeyword,
      assignmentKind !== AssignmentKind.None,
      apparentType,
      prop,
    );
    if (isAssignmentToReadonlyEntity(c, node, prop, assignmentKind)) {
      c.error(right, Diagnostics.Cannot_assign_to_0_because_it_is_a_read_only_property, name);
      return c.errorType;
    }
    if (isThisPropertyAccessInConstructor(c, node, prop)) propType = c.autoType;
    else
      propType =
        writeOnly || assignmentKind === AssignmentKind.Definite
          ? getWriteTypeOfSymbol(c, prop)
          : getTypeOfSymbol(c, prop);
  }
  return getFlowTypeOfAccessExpression(c, node, prop, propType, right, checkMode);
}

/** Whether `node` is a property of an object destructuring assignment from `this`. */
function isThisInitializedObjectBindingExpression(node: Node): boolean {
  if (node.kind !== SyntaxKind.ShorthandPropertyAssignment && node.kind !== SyntaxKind.PropertyAssignment) return false;
  const binary = node.parent!.parent!;
  return (
    binary.kind === SyntaxKind.BinaryExpression &&
    (binary as BinaryExpression).operatorToken.kind === SyntaxKind.EqualsToken &&
    (binary as BinaryExpression).right.kind === SyntaxKind.ThisKeyword
  );
}

function isThisInitializedDeclaration(node: Node): boolean {
  if (node.kind !== SyntaxKind.VariableDeclaration) return false;
  const initializer = getInitializer(node);
  return initializer !== undefined && initializer.kind === SyntaxKind.ThisKeyword;
}

// ---- Private names

/** A private name used as an expression, as in `#x in obj`; records its declaration. */
export function checkPrivateIdentifierExpression(c: Checker, node: Node): Type {
  const symbol = getSymbolForPrivateIdentifierExpression(c, node);
  if (symbol !== undefined) markPropertyAsReferenced(c, symbol, undefined, false);
  return c.anyType;
}

export function getSymbolForPrivateIdentifierExpression(c: Checker, node: Node): Symbol | undefined {
  let symbol = c.resolvedSymbols.get(node.id);
  if (symbol === undefined) {
    symbol = lookupSymbolForPrivateIdentifierDeclaration(getText(node), node);
    c.resolvedSymbols.set(node.id, symbol);
  }
  return symbol;
}

/** The declaration of a private name in the enclosing classes, innermost first. */
function lookupSymbolForPrivateIdentifierDeclaration(name: string, location: Node): Symbol | undefined {
  for (
    let containingClass = getContainingClassExcludingClassDecorators(location);
    containingClass !== undefined;
    containingClass = getContainingClass(containingClass)
  ) {
    const symbol = getSymbol(containingClass);
    if (symbol === undefined) continue;
    const memberName = getSymbolNameForPrivateIdentifier(symbol, name);
    const prop = symbol.members?.get(memberName) ?? symbol.exports?.get(memberName);
    if (prop !== undefined) return prop;
  }
  return undefined;
}

/** The containing class of `node`, skipping classes whose decorators contain it. */
function getContainingClassExcludingClassDecorators(node: Node): Node | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (isClassLike(current)) break;
    if (current.kind === SyntaxKind.Decorator) {
      if (current.parent !== undefined && isClassLike(current.parent)) return getContainingClass(current.parent);
      break;
    }
  }
  return getContainingClass(node);
}

/**
 * Reports a private name that's on the type but not reachable here: shadowed by another
 * private name of the same spelling, or accessed outside its class.
 */
function checkPrivateIdentifierPropertyAccess(
  c: Checker,
  leftType: Type,
  right: Node,
  lexicallyScopedIdentifier: Symbol | undefined,
): boolean {
  let propertyOnType: Symbol | undefined = undefined;
  for (const symbol of getPropertiesOfType(c, leftType)) {
    const declaration = symbol.valueDeclaration;
    const name = declaration !== undefined ? getName(declaration) : undefined;
    if (name !== undefined && name.kind === SyntaxKind.PrivateIdentifier && getText(name) === getText(right)) {
      propertyOnType = symbol;
      break;
    }
  }
  if (propertyOnType === undefined) return false;
  const diagName = declarationNameToString(getSourceFileOfNode(right), right);
  const typeValueDecl = propertyOnType.valueDeclaration!;
  const typeClass = getContainingClass(typeValueDecl)!;
  const lexicalValueDecl = lexicallyScopedIdentifier?.valueDeclaration;
  if (lexicalValueDecl !== undefined) {
    for (let n = getContainingClass(lexicalValueDecl); n !== undefined; n = n.parent) {
      if (n !== typeClass) continue;
      const diagnostic = c.error(
        right,
        Diagnostics.The_property_0_cannot_be_accessed_on_type_1_within_this_class_because_it_is_shadowed_by_another_private_identifier_with_the_same_spelling,
        diagName,
        typeToString(c, leftType),
      );
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(lexicalValueDecl, Diagnostics.The_shadowing_declaration_of_0_is_defined_here, [
          diagName,
        ]),
      );
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(
          typeValueDecl,
          Diagnostics.The_declaration_of_0_that_you_probably_intended_to_use_is_defined_here,
          [diagName],
        ),
      );
      return true;
    }
  }
  c.error(
    right,
    Diagnostics.Property_0_is_not_accessible_outside_class_1_because_it_has_a_private_identifier,
    diagName,
    symbolToString(c, getSymbol(typeClass)!),
  );
  return true;
}

function isThisTypeParameter(t: Type): boolean {
  return (t.flags & TypeFlags.TypeParameter) !== 0 && (t as TypeParameter).isThisType;
}

function isConstEnumObjectType(t: Type): boolean {
  return (
    (t.objectFlags & ObjectFlags.Anonymous) !== 0 &&
    t.symbol !== undefined &&
    (t.symbol.flags & SymbolFlags.ConstEnum) !== 0
  );
}

export function isMethodAccessForCall(node: Node): boolean {
  let current = node;
  while (current.parent!.kind === SyntaxKind.ParenthesizedExpression) current = current.parent!;
  const parent = current.parent!;
  return (
    (parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) &&
    getExpression(parent) === current
  );
}

/** Whether `node` is the operand of `delete`, through parentheses. */
export function isDeleteTarget(node: Node): boolean {
  if (!isAccessExpression(node)) return false;
  let current = node.parent!;
  while (current.kind === SyntaxKind.ParenthesizedExpression) current = current.parent!;
  return current.kind === SyntaxKind.DeleteExpression;
}

/** Whether assigning through `expr` targets a readonly entity, outside of initialization. */
export function isAssignmentToReadonlyEntity(
  c: Checker,
  expr: Node,
  symbol: Symbol,
  assignmentKind: AssignmentKind,
): boolean {
  if (assignmentKind === AssignmentKind.None) return false;
  // CommonJS `module.exports` is never readonly.
  if (isAccessExpression(expr)) {
    const target = skipParentheses(getExpression(expr)!);
    if (target.kind === SyntaxKind.Identifier && (getResolvedSymbol(c, target).flags & SymbolFlags.ModuleExports) !== 0)
      return false;
  }
  if (isReadonlySymbol(c, symbol)) {
    // Readonly properties may be assigned through `this` in the constructor of their class.
    if (
      (symbol.flags & SymbolFlags.Property) !== 0 &&
      isAccessExpression(expr) &&
      getExpression(expr)!.kind === SyntaxKind.ThisKeyword
    ) {
      const ctor = getControlFlowContainer(expr);
      if (ctor.kind !== SyntaxKind.Constructor) return true;
      const declaration = symbol.valueDeclaration;
      if (declaration !== undefined) {
        const isLocalPropertyDeclaration = ctor.parent === declaration.parent;
        const isLocalParameterProperty = ctor === declaration.parent;
        // A JavaScript `this.x = …` declaration of this class or constructor function.
        const isAssignmentDeclaration = declaration.kind === SyntaxKind.BinaryExpression;
        const parentDeclaration = symbol.parent?.valueDeclaration;
        const isLocalThisPropertyAssignment =
          isAssignmentDeclaration && (parentDeclaration === ctor.parent || parentDeclaration === ctor);
        return !isLocalPropertyDeclaration && !isLocalParameterProperty && !isLocalThisPropertyAssignment;
      }
    }
    return true;
  }
  if (isAccessExpression(expr)) {
    // References through namespace imports are readonly.
    const node = skipParentheses(getExpression(expr)!);
    if (node.kind === SyntaxKind.Identifier) {
      const expressionSymbol = getResolvedSymbol(c, node);
      if ((expressionSymbol.flags & SymbolFlags.Alias) !== 0) {
        const declaration = getDeclarationOfAliasSymbol(expressionSymbol);
        return declaration !== undefined && declaration.kind === SyntaxKind.NamespaceImport;
      }
    }
  }
  return false;
}

// ---- Accessibility

/** Checks that `prop` of `containingType` may be accessed at `node`; reports and returns false otherwise. */
export function checkPropertyAccessibility(
  c: Checker,
  node: Node,
  isSuper: boolean,
  writing: boolean,
  containingType: Type,
  prop: Symbol,
): boolean {
  let errorNode: Node | undefined;
  if (node.kind === SyntaxKind.PropertyAccessExpression) errorNode = (node as PropertyAccessExpression).name;
  else if (node.kind === SyntaxKind.QualifiedName) errorNode = (node as QualifiedName).right;
  else if (node.kind === SyntaxKind.ImportType) errorNode = node;
  else if (node.kind === SyntaxKind.BindingElement)
    errorNode = (node as BindingElement).propertyName ?? (node as BindingElement).name!;
  else errorNode = getName(node) ?? node;
  return checkPropertyAccessibilityAtLocation(c, node, isSuper, writing, containingType, prop, errorNode);
}

/** Whether `prop` of `containingType` may be accessed at `node`, without reporting errors. */
export function isPropertyAccessible(
  c: Checker,
  node: Node,
  isSuper: boolean,
  isWrite: boolean,
  containingType: Type,
  prop: Symbol,
): boolean {
  if ((containingType.flags & TypeFlags.Any) !== 0) return true;
  // A #private property access in an optional chain is an error the parser reports.
  const declaration = prop.valueDeclaration;
  if (declaration !== undefined && isPrivateIdentifierClassElementDeclaration(declaration)) {
    const declaringClass = getContainingClass(declaration);
    return !isOptionalChain(node) && declaringClass !== undefined && isNodeDescendantOf(node, declaringClass);
  }
  return checkPropertyAccessibilityAtLocation(c, node, isSuper, isWrite, containingType, prop, undefined);
}

function checkPropertyAccessibilityAtLocation(
  c: Checker,
  location: Node,
  isSuper: boolean,
  writing: boolean,
  containingTypeIn: Type,
  prop: Symbol,
  errorNode: Node | undefined,
): boolean {
  const flags = getDeclarationModifierFlagsFromSymbol(c, prop, writing);
  if (isSuper) {
    // Abstract methods can't be reached through `super`.
    if ((flags & ModifierFlags.Abstract) !== 0) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Abstract_method_0_in_class_1_cannot_be_accessed_via_super_expression,
          symbolToString(c, prop),
          typeToString(c, getDeclaringClass(c, prop)!),
        );
      return false;
    }
    // Class fields of the parent aren't on the prototype.
    if ((flags & ModifierFlags.Static) === 0 && hasClassInstancePropertyDeclaration(prop)) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Class_field_0_defined_by_the_parent_class_is_not_accessible_in_the_child_class_via_super,
          symbolToString(c, prop),
        );
      return false;
    }
  }
  // Abstract properties can't be read during initialization of their class.
  if (
    (flags & ModifierFlags.Abstract) !== 0 &&
    symbolHasNonMethodDeclaration(c, prop) &&
    (isThisProperty(location) ||
      isThisInitializedObjectBindingExpression(location) ||
      (location.parent!.kind === SyntaxKind.ObjectBindingPattern &&
        isThisInitializedDeclaration(location.parent!.parent!)))
  ) {
    const parentSymbol = getParentOfSymbol(c, prop);
    if (
      parentSymbol !== undefined &&
      (parentSymbol.flags & SymbolFlags.Class) !== 0 &&
      isNodeUsedDuringClassInitialization(location)
    ) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Abstract_property_0_in_class_1_cannot_be_accessed_in_the_constructor,
          symbolToString(c, prop),
          symbolToString(c, parentSymbol),
        );
      return false;
    }
  }
  if ((flags & ModifierFlags.NonPublicAccessibilityModifier) === 0) return true;
  // Private members are accessible within their declaring class.
  if ((flags & ModifierFlags.Private) !== 0) {
    const parent = getParentOfSymbol(c, prop);
    const declaringClassDeclaration = parent !== undefined ? getClassLikeDeclarationOfSymbol(parent) : undefined;
    if (!isNodeWithinClass(location, declaringClassDeclaration)) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Property_0_is_private_and_only_accessible_within_class_1,
          symbolToString(c, prop),
          typeToString(c, getDeclaringClass(c, prop) ?? containingTypeIn),
        );
      return false;
    }
    return true;
  }
  // Protected members of a supertype are accessible through `super`.
  if (isSuper) return true;
  // The first enclosing class deriving from the declaring classes of the protected constituents.
  let enclosingClass: Type | undefined = undefined;
  for (
    let container = getContainingClass(location);
    container !== undefined;
    container = getContainingClass(container)
  ) {
    const classSymbol = getSymbolOfDeclaration(c, container);
    if (classSymbol === undefined) continue;
    const classType = getDeclaredTypeOfSymbol(c, classSymbol);
    if (isClassDerivedFromDeclaringClasses(c, classType, prop, writing)) {
      enclosingClass = classType;
      break;
    }
  }
  if (enclosingClass === undefined) {
    // Functions with a `this` parameter of a derived class may access instance members.
    const thisClass = getEnclosingClassFromThisParameter(c, location);
    if (thisClass !== undefined && isClassDerivedFromDeclaringClasses(c, thisClass, prop, writing))
      enclosingClass = thisClass;
    if ((flags & ModifierFlags.Static) !== 0 || enclosingClass === undefined) {
      if (errorNode !== undefined)
        c.error(
          errorNode,
          Diagnostics.Property_0_is_protected_and_only_accessible_within_class_1_and_its_subclasses,
          symbolToString(c, prop),
          typeToString(c, getDeclaringClass(c, prop) ?? containingTypeIn),
        );
      return false;
    }
  }
  if ((flags & ModifierFlags.Static) !== 0) return true;
  let containingType: Type | undefined = containingTypeIn;
  if ((containingType.flags & TypeFlags.TypeParameter) !== 0)
    containingType = (containingType as TypeParameter).isThisType
      ? getConstraintOfTypeParameter(c, containingType)
      : getBaseConstraintOfType(c, containingType);
  if (containingType === undefined || !hasBaseType(c, containingType, enclosingClass)) {
    if (containingType !== undefined && errorNode !== undefined)
      c.error(
        errorNode,
        Diagnostics.Property_0_is_protected_and_only_accessible_through_an_instance_of_class_1_This_is_an_instance_of_class_2,
        symbolToString(c, prop),
        typeToString(c, enclosingClass),
        typeToString(c, containingType),
      );
    return false;
  }
  return true;
}

function hasClassInstancePropertyDeclaration(symbol: Symbol): boolean {
  for (const d of getDeclarations(symbol)) if (isClassInstanceProperty(d)) return true;
  return false;
}

function isClassInstanceProperty(node: Node): boolean {
  // `this.x = v` in JavaScript declares a field, but `C.prototype.x = v` and `C.x = v` don't.
  if (isInJSFile(node) && node instanceof BinaryExpression) {
    const left = node.left;
    return (
      (!isBindableStaticAccessExpression(left, false) || !isPrototypeAccess(getExpression(left)!)) &&
      !isBindableStaticNameExpression(left, true)
    );
  }
  return (
    node.parent !== undefined &&
    isClassLike(node.parent) &&
    node.kind === SyntaxKind.PropertyDeclaration &&
    !isStatic(node) &&
    !hasSyntacticModifier(node, ModifierFlags.Accessor)
  );
}

function isPrototypeAccess(node: Node): boolean {
  if (!isBindableStaticAccessExpression(node, false)) return false;
  const name = getElementOrPropertyAccessName(node);
  return name !== undefined && getText(name) === 'prototype';
}

function isThisProperty(node: Node): boolean {
  return isAccessExpression(node) && getExpression(node)!.kind === SyntaxKind.ThisKeyword;
}

function isNodeUsedDuringClassInitialization(node: Node): boolean {
  for (let element = node.parent; element !== undefined; element = element.parent) {
    if (
      (element.kind === SyntaxKind.Constructor && getBody(element) !== undefined) ||
      element.kind === SyntaxKind.PropertyDeclaration
    )
      return true;
    if (isClassLike(element) || isFunctionLike(element)) return false;
  }
  return false;
}

/** The declaring class of a class member. */
export function getDeclaringClass(c: Checker, prop: Symbol): Type | undefined {
  if (prop.parent === undefined || (prop.parent.flags & SymbolFlags.Class) === 0) return undefined;
  return getDeclaredTypeOfSymbol(c, getParentOfSymbol(c, prop)!);
}

function isNodeWithinClass(node: Node, classDeclaration: Node | undefined): boolean {
  for (let container = getContainingClass(node); container !== undefined; container = getContainingClass(container))
    if (container === classDeclaration) return true;
  return false;
}

/** The properties a possibly synthetic union or intersection property stands for. */
function getUnderlyingProperties(c: Checker, prop: Symbol, out: Symbol[]): void {
  if ((prop.checkFlags & CheckFlags.Synthetic) === 0) {
    out.push(prop);
    return;
  }
  const containingType = c.symbolContainingTypes.get(getSymbolId(prop));
  if (containingType === undefined) return;
  for (const t of typesOf(containingType)) {
    const p = getPropertyOfType(c, t, prop.name);
    if (p !== undefined) getUnderlyingProperties(c, p, out);
  }
}

function symbolHasNonMethodDeclaration(c: Checker, symbol: Symbol): boolean {
  const props: Symbol[] = [];
  getUnderlyingProperties(c, symbol, props);
  for (const p of props) if ((p.flags & SymbolFlags.Method) === 0) return true;
  return false;
}

function isClassDerivedFromDeclaringClasses(c: Checker, checkClass: Type, prop: Symbol, writing: boolean): boolean {
  const props: Symbol[] = [];
  getUnderlyingProperties(c, prop, props);
  for (const p of props) {
    if ((getDeclarationModifierFlagsFromSymbol(c, p, writing) & ModifierFlags.Protected) === 0) continue;
    const declaringClass = getDeclaringClass(c, p);
    if (declaringClass === undefined || !hasBaseType(c, checkClass, declaringClass)) return false;
  }
  return true;
}

function getEnclosingClassFromThisParameter(c: Checker, node: Node): Type | undefined {
  const thisContainer = getThisContainer(node, false, false);
  let thisType: Type | undefined = undefined;
  if (isFunctionLike(thisContainer)) {
    const thisParameter = getThisParameterDeclaration(thisContainer);
    const typeNode = thisParameter !== undefined ? getType(thisParameter) : undefined;
    if (typeNode !== undefined) {
      thisType = getTypeFromTypeNode(c, typeNode);
      if ((thisType.flags & TypeFlags.TypeParameter) !== 0) thisType = getConstraintOfTypeParameter(c, thisType);
    } else thisType = getContextualThisParameterType(c, thisContainer);
  }
  if (thisType !== undefined && (thisType.objectFlags & (ObjectFlags.ClassOrInterface | ObjectFlags.Reference)) !== 0)
    return getTargetType(thisType as TypeReference);
  return undefined;
}

/** The explicit `this` parameter of a function, if any. */
function getThisParameterDeclaration(func: Node): Node | undefined {
  const parameters = getParameters(func);
  if (parameters === undefined || parameters.nodes.length === 0) return undefined;
  const first = parameters.nodes[0]!;
  const name = getName(first);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this' ? first : undefined;
}

// ---- Missing properties

/** Reports a missing property once per name node, with the most helpful message available. */
export function reportNonexistentProperty(c: Checker, propNode: Node, containingType: Type): void {
  const links = c.nodeLinks(propNode);
  if ((links.flags & 1) !== 0) return;
  links.flags |= 1;
  const name = getText(propNode);
  const missingProperty = declarationNameToString(getSourceFileOfNode(propNode), propNode);
  const container = typeToString(c, containingType);
  let chain: Diagnostic | undefined = undefined;
  if (
    propNode.kind !== SyntaxKind.PrivateIdentifier &&
    (containingType.flags & TypeFlags.Union) !== 0 &&
    (containingType.flags & TypeFlags.Primitive) === 0
  ) {
    for (const subtype of typesOf(containingType)) {
      if (
        getPropertyOfType(c, subtype, name) === undefined &&
        getApplicableIndexInfoForName(c, subtype, name) === undefined
      ) {
        chain = createDiagnosticForNode(propNode, Diagnostics.Property_0_does_not_exist_on_type_1, [
          missingProperty,
          typeToString(c, subtype),
        ]);
        break;
      }
    }
  }
  let diagnostic: Diagnostic;
  if (typeHasStaticProperty(c, name, containingType))
    diagnostic = createDiagnosticForNode(
      propNode,
      Diagnostics.Property_0_does_not_exist_on_type_1_Did_you_mean_to_access_the_static_member_2_instead,
      [missingProperty, container, container + '.' + missingProperty],
    );
  else {
    const promisedType = getPromisedTypeOfPromise(c, containingType);
    if (promisedType !== undefined && getPropertyOfType(c, promisedType, name) !== undefined) {
      diagnostic = createDiagnosticForNode(propNode, Diagnostics.Property_0_does_not_exist_on_type_1, [
        missingProperty,
        container,
      ]);
      diagnostic.addRelatedInfo(createDiagnosticForNode(propNode, Diagnostics.Did_you_forget_to_use_await, []));
    } else {
      const libSuggestion = getSuggestedLibForNonExistentProperty(c, missingProperty, containingType);
      const suggestion =
        libSuggestion === '' ? getSuggestedSymbolForNonexistentProperty(c, propNode, containingType) : undefined;
      if (libSuggestion !== '')
        diagnostic = createDiagnosticForNode(
          propNode,
          Diagnostics.Property_0_does_not_exist_on_type_1_Do_you_need_to_change_your_target_library_Try_changing_the_lib_compiler_option_to_2_or_later,
          [missingProperty, container, libSuggestion],
        );
      else if (suggestion !== undefined) {
        diagnostic = createDiagnosticForNode(propNode, Diagnostics.Property_0_does_not_exist_on_type_1_Did_you_mean_2, [
          missingProperty,
          container,
          suggestion.name,
        ]);
        if (suggestion.valueDeclaration !== undefined)
          diagnostic.addRelatedInfo(
            createDiagnosticForNode(suggestion.valueDeclaration, Diagnostics.X_0_is_declared_here, [suggestion.name]),
          );
      } else {
        chain = elaborateNeverIntersection(c, chain, propNode, containingType);
        diagnostic = createDiagnosticForNode(
          propNode,
          containerSeemsToBeEmptyDomElement(c, containingType)
            ? Diagnostics.Property_0_does_not_exist_on_type_1_Try_changing_the_lib_compiler_option_to_include_dom
            : Diagnostics.Property_0_does_not_exist_on_type_1,
          [missingProperty, container],
        );
      }
    }
  }
  if (chain !== undefined) diagnostic.addMessageChain(chain);
  c.addDiagnostic(diagnostic);
}

/**
 * `chain` under the reason an intersection reduced to `never` when `t` is one: a property with conflicting
 * literal types, or one private in some constituents.
 */
export function elaborateNeverIntersection(
  c: Checker,
  chain: Diagnostic | undefined,
  node: Node,
  t: Type,
): Diagnostic | undefined {
  if ((t.flags & TypeFlags.Intersection) === 0 || (lazyObjectFlags(c, t) & ObjectFlags.IsNeverIntersection) === 0)
    return chain;
  const props = getPropertiesOfUnionOrIntersectionType(c, t as IntersectionType);
  let message =
    Diagnostics.The_intersection_0_was_reduced_to_never_because_property_1_has_conflicting_types_in_some_constituents;
  let prop = props.find((p) => isDiscriminantWithNeverType(c, p));
  if (prop === undefined) {
    message =
      Diagnostics.The_intersection_0_was_reduced_to_never_because_property_1_exists_in_multiple_constituents_and_is_private_in_some;
    prop = props.find(isConflictingPrivateProperty);
  }
  if (prop === undefined) return chain;
  const result = createDiagnosticForNode(node, message, [
    typeToString(c, t, undefined, TypeFormatFlags.NoTypeReduction),
    symbolToString(c, prop),
  ]);
  return result.addMessageChain(chain);
}

/** The library that adds `missingProperty` to the apparent type's global, or '' if none does. */
function getSuggestedLibForNonExistentProperty(c: Checker, missingProperty: string, containingType: Type): string {
  const container = getApparentType(c, containingType).symbol;
  if (container === undefined) return '';
  const entries = getFeatureMap().get(container.name);
  if (entries !== undefined) for (const entry of entries) if (entry.props.includes(missingProperty)) return entry.lib;
  return '';
}

/** Whether the type looks like an empty DOM type, as when the DOM lib is missing. */
function containerSeemsToBeEmptyDomElement(c: Checker, containingType: Type): boolean {
  return (
    !(c.compilerOptions.lib ?? []).includes('lib.dom.d.ts') &&
    everyContainedType(containingType, hasCommonDomTypeName) &&
    isEmptyObjectType(c, containingType)
  );
}

function hasCommonDomTypeName(t: Type): boolean {
  if (t.symbol === undefined) return false;
  const name = t.symbol.name;
  return (
    name === 'EventTarget' ||
    name === 'Node' ||
    name === 'Element' ||
    (name.startsWith('HTML') && name.endsWith('Element'))
  );
}

/** Whether the type's symbol has a static member `name`, as when an instance member was expected. */
export function typeHasStaticProperty(c: Checker, name: string, containingType: Type): boolean {
  if (containingType.symbol === undefined) return false;
  const prop = getPropertyOfType(c, getTypeOfSymbol(c, containingType.symbol), name);
  return prop !== undefined && prop.valueDeclaration !== undefined && isStatic(prop.valueDeclaration);
}

/** The value member with the closest name, for "Did you mean" suggestions. */
export function getSuggestedSymbolForNonexistentProperty(
  c: Checker,
  name: Node,
  containingType: Type,
): Symbol | undefined {
  let props = getPropertiesOfType(c, containingType);
  const parent = name.parent!;
  if (parent.kind === SyntaxKind.PropertyAccessExpression) {
    const valid: Symbol[] = [];
    for (const prop of props)
      if (isValidPropertyAccessForCompletions(c, parent, containingType, prop)) valid.push(prop);
    props = valid;
  }
  return getSpellingSuggestionForName(c, getText(name), props, SymbolFlags.Value);
}

/** The value property of `containingType` with the closest name to `name`. */
export function getSuggestionForNonexistentProperty(
  c: Checker,
  name: string,
  containingType: Type,
): Symbol | undefined {
  return getSpellingSuggestionForName(c, name, getPropertiesOfType(c, containingType), SymbolFlags.Value);
}

/** Whether `property` of `t` may be accessed at `node` without an error, as completions decide. */
function isValidPropertyAccessForCompletions(c: Checker, node: Node, t: Type, property: Symbol): boolean {
  const isSuper =
    node.kind === SyntaxKind.PropertyAccessExpression && getExpression(node)!.kind === SyntaxKind.SuperKeyword;
  if ((t.flags & TypeFlags.Any) !== 0) return true;
  // `#private` access in an optional chain is a parse error.
  const declaration = property.valueDeclaration;
  if (declaration !== undefined && isPrivateIdentifierClassElementDeclaration(declaration)) {
    const declClass = getContainingClass(declaration);
    return !isOptionalChain(node) && declClass !== undefined && isNodeDescendantOf(node, declClass);
  }
  return checkPropertyAccessibilityAtLocation(c, node, isSuper, false, t, property, undefined);
}
