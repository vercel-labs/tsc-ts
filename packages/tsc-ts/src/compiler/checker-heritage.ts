// Class and interface heritage: base class and implemented interface conformance, member overrides,
// index signature constraints and duplicate members.
import {
  type HeritageClause,
  ModifierFlags,
  type Node,
  NodeFlags,
  type TypeParameterDeclaration,
  getExpression,
  getHeritageClauses,
  getInitializer,
  getMembers,
  getName,
  getParameters,
  getPostfixToken,
  getText,
  getType,
  getTypeParameters,
  getTypeArguments,
  type ExpressionWithTypeArguments,
} from './ast.js';
import {
  findConstructorDeclaration,
  getNameOfDeclaration,
  getDeclarationOfKind,
  hasStaticModifier,
  hasSyntacticModifier,
  isClassLike,
  isOptionalChain,
  isParameterPropertyDeclaration,
  isStatic,
} from './binder-utilities.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics, chainDiagnostic } from './diagnostics.js';
import { getUseDefineForClassFields } from './options.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { checkJSDocAugmentsTagMatchesExtends } from './checker-jsdoc.js';
import {
  type IndexInfo,
  type InterfaceType,
  ObjectFlags,
  SignatureFlags,
  SignatureKind,
  type Type,
  TypeFlags,
  emptyIndexInfos,
  emptySignatures,
  type Signature,
  type TypeMapper,
  newTypeMapper,
} from './checker-types.js';
import { createAnonymousType, getIntersectionType, isErrorType, typesOf } from './checker-type-factory.js';
import {
  getBaseConstructorTypeOfClass,
  getBaseTypes,
  getClassLikeDeclarationOfSymbol,
  getConstraintOfTypeParameter,
  getDeclaredTypeOfSymbol,
  getDefaultFromTypeParameter,
  getExtendsHeritageClauseElement,
  getExtendsHeritageClauseElements,
  getMinTypeArgumentCount,
  isEntityNameExpression,
  isMixinConstructorType,
  isValidBaseType,
  getDeclaredTypeOfTypeParameter,
  fillMissingTypeArguments,
  getInstantiatedConstructorsForTypeArguments,
} from './checker-declared-types.js';
import { getReturnTypeOfSignature } from './checker-signatures.js';
import { instantiateType } from './instantiation.js';
import { checkSourceElement } from './checker-source-file.js';
import { isInJSFile } from './ast-utilities.js';
import {
  getFullyQualifiedName,
  getParentOfSymbol,
  getSpellingSuggestionForName,
  getSymbolOfDeclaration,
} from './checker-symbols.js';
import { getNonMissingTypeOfSymbol, getTypeOfSymbol } from './checker-symbol-types.js';
import {
  getApparentType,
  getDeclarationModifierFlagsFromSymbol,
  getIndexInfoOfType,
  getIndexInfosOfType,
  getIndexSymbol,
  getIndexTypeOfType,
  getPropertiesOfObjectType,
  getPropertiesOfType,
  getPropertyOfObjectType,
  getPropertyOfType,
  getReducedType,
  getSignaturesOfType,
  getTargetSymbol,
  getTypeWithThisArgument,
  isApplicableIndexType,
  isNamedMember,
  isPrototypeProperty,
  resolveDeclaredMembers,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import { getLiteralTypeFromProperty } from './checker-type-operators.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import { getTypeOfExpression } from './checker-expressions.js';
import { tryGetNameFromType } from './checker-narrowing.js';
import { hasDynamicName, hasLateBindableName, isBindingPattern } from './checker-utilities.js';
import {
  checkTypeAssignableTo,
  checkTypeRelatedTo,
  compareProperties,
  ComparerKind,
  isTypeAssignableTo,
  isTypeIdenticalTo,
} from './relations.js';
import { Ternary } from './checker-types.js';
import { symbolToString, typeToString } from './type-printer.js';
import { checkFunctionOrConstructorSymbol } from './checker-overloads.js';
import { getConstructorAccessibilityError, isPropertyInitializedInConstructor } from './checker-classes.js';
import {
  CheckFlags,
  declarationCount,
  getDeclarations,
  InternalSymbolName,
  type Symbol,
  SymbolFlags,
} from './symbol.js';

// ---- Classes

/** Checks a class's merged declarations, members, base class, implemented types and index signatures. */
export function checkClassHeritage(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const classType = getDeclaredTypeOfSymbol(c, symbol) as InterfaceType;
  if ((classType.flags & TypeFlags.Object) === 0) return;
  const typeWithThis = getTypeWithThisArgument(c, classType, undefined, false);
  const staticType = getTypeOfSymbol(c, symbol);
  checkTypeParameterListsIdentical(c, symbol);
  checkFunctionOrConstructorSymbol(c, symbol);
  checkObjectTypeForDuplicateDeclarations(c, node, true);
  if ((node.flags & NodeFlags.Ambient) === 0) checkClassForStaticPropertyNameConflicts(c, node);
  const baseTypeNode = getExtendsHeritageClauseElement(node);
  if (baseTypeNode !== undefined) {
    const baseTypes = getBaseTypes(c, classType);
    if (baseTypes.length !== 0) checkBaseClass(c, node, classType, typeWithThis, staticType, baseTypes[0]!);
  }
  checkMembersForOverrideModifier(c, node, classType, typeWithThis, staticType);
  for (const typeRefNode of getImplementsHeritageClauseElements(node)) {
    // The parser makes an entity name element a type reference; anything else stays an expression.
    if (typeRefNode.kind === SyntaxKind.ExpressionWithTypeArguments) {
      const expr = getExpression(typeRefNode)!;
      if (!isEntityNameExpression(expr) || isOptionalChain(expr))
        c.error(
          expr,
          Diagnostics.A_class_can_only_implement_an_identifier_Slashqualified_name_with_optional_type_arguments,
        );
    }
    const t = getReducedType(c, getTypeFromTypeNode(c, typeRefNode));
    if (isErrorType(c, t)) continue;
    if (!isValidBaseType(c, t)) {
      c.error(
        typeRefNode,
        Diagnostics.A_class_can_only_implement_an_object_type_or_intersection_of_object_types_with_statically_known_members,
      );
      continue;
    }
    const message =
      t.symbol !== undefined && (t.symbol.flags & SymbolFlags.Class) !== 0
        ? Diagnostics.Class_0_incorrectly_implements_class_1_Did_you_mean_to_extend_1_and_inherit_its_members_as_a_subclass
        : Diagnostics.Class_0_incorrectly_implements_interface_1;
    const baseWithThis = getTypeWithThisArgument(c, t, classType.thisType, false);
    if (!checkTypeAssignableTo(c, typeWithThis, baseWithThis, undefined, undefined))
      issueMemberSpecificError(c, node, typeWithThis, baseWithThis, message);
  }
  checkIndexConstraints(c, classType, symbol, false);
  checkIndexConstraints(c, staticType, symbol, true);
  checkClassOrInterfaceForDuplicateIndexSignatures(c, node);
}

function checkBaseClass(
  c: Checker,
  node: Node,
  classType: InterfaceType,
  typeWithThis: Type,
  staticType: Type,
  baseType: Type,
): void {
  const baseConstructorType = getBaseConstructorTypeOfClass(c, classType);
  const baseTypeNode = getExtendsHeritageClauseElement(node)!;
  checkJSDocAugmentsTagMatchesExtends(c, node, baseTypeNode as ExpressionWithTypeArguments, baseType);
  const staticBaseType = getApparentType(c, baseConstructorType);
  checkBaseTypeAccessibility(c, staticBaseType, baseTypeNode);
  const typeArgumentNodes = getTypeArguments(baseTypeNode);
  if (typeArgumentNodes !== undefined && typeArgumentNodes.nodes.length !== 0) {
    for (const n of typeArgumentNodes.nodes) checkSourceElement(c, n);
    for (const constructor of getConstructorsForTypeArguments(c, staticBaseType, typeArgumentNodes.nodes))
      if (!checkTypeArgumentConstraints(c, baseTypeNode, constructor.typeParameters)) break;
  }
  const baseWithThis = getTypeWithThisArgument(c, baseType, classType.thisType, false);
  const errorNode = getName(node) ?? node;
  if (!checkTypeAssignableTo(c, typeWithThis, baseWithThis, undefined, undefined))
    issueMemberSpecificError(c, node, typeWithThis, baseWithThis, Diagnostics.Class_0_incorrectly_extends_base_class_1);
  // The static side is checked only when the instance side is assignable.
  else
    checkTypeAssignableTo(
      c,
      staticType,
      getTypeWithoutSignatures(c, staticBaseType),
      errorNode,
      Diagnostics.Class_static_side_0_incorrectly_extends_base_class_static_side_1,
    );
  if ((baseConstructorType.flags & TypeFlags.TypeVariable) !== 0) {
    if (!isMixinConstructorType(c, staticType))
      c.error(errorNode, Diagnostics.A_mixin_class_must_have_a_constructor_with_a_single_rest_parameter_of_type_any);
    else if (
      hasAbstractSignature(getSignaturesOfType(c, baseConstructorType, SignatureKind.Construct)) &&
      !hasSyntacticModifier(node, ModifierFlags.Abstract)
    )
      c.error(
        errorNode,
        Diagnostics.A_mixin_class_that_extends_from_a_type_variable_containing_an_abstract_construct_signature_must_also_be_declared_abstract,
      );
  }
  // A class-like constructor function that isn't a class must return the same type from every
  // instantiated construct signature.
  if (
    !(staticBaseType.symbol !== undefined && (staticBaseType.symbol.flags & SymbolFlags.Class) !== 0) &&
    (baseConstructorType.flags & TypeFlags.TypeVariable) === 0
  ) {
    const constructors = getInstantiatedConstructorsForTypeArguments(
      c,
      staticBaseType,
      getTypeArguments(baseTypeNode)?.nodes,
      baseTypeNode,
    );
    for (const sig of constructors) {
      if (!isTypeIdenticalTo(c, getReturnTypeOfSignature(c, sig), baseType)) {
        c.error(getExpression(baseTypeNode), Diagnostics.Base_constructors_must_all_have_the_same_return_type);
        break;
      }
    }
  }
  checkKindsOfPropertyMemberOverrides(c, classType, baseType);
}

function hasAbstractSignature(signatures: readonly Signature[]): boolean {
  for (const s of signatures) if ((s.flags & SignatureFlags.Abstract) !== 0) return true;
  return false;
}

function getConstructorsForTypeArguments(c: Checker, t: Type, typeArgumentNodes: readonly Node[]): Signature[] {
  const count = typeArgumentNodes.length;
  const result: Signature[] = [];
  for (const sig of getSignaturesOfType(c, t, SignatureKind.Construct))
    if (count >= getMinTypeArgumentCount(c, sig.typeParameters) && count <= sig.typeParameters.length) result.push(sig);
  return result;
}

/**
 * Checks the type arguments of `node` against the constraints of `typeParameters`, defaults included, up to
 * the first that does not satisfy its constraint.
 */
export function checkTypeArgumentConstraints(c: Checker, node: Node, typeParameters: readonly Type[]): boolean {
  let typeArguments: Type[] | undefined = undefined;
  let mapper: TypeMapper | undefined = undefined;
  const typeArgumentNodes = getTypeArguments(node)?.nodes ?? [];
  let result = true;
  for (let i = 0; i < typeParameters.length; i++) {
    const constraint = getConstraintOfTypeParameter(c, typeParameters[i]!);
    if (constraint === undefined) continue;
    if (typeArguments === undefined) {
      const explicit: Type[] = [];
      for (const n of typeArgumentNodes) explicit.push(getTypeFromTypeNode(c, n));
      typeArguments = fillMissingTypeArguments(
        c,
        explicit,
        typeParameters,
        getMinTypeArgumentCount(c, typeParameters),
        isInJSFile(node),
      );
      mapper = newTypeMapper(typeParameters.slice(), typeArguments);
    }
    result =
      result &&
      checkTypeAssignableTo(
        c,
        typeArguments![i]!,
        instantiateType(c, constraint, mapper),
        i < typeArgumentNodes.length ? typeArgumentNodes[i]! : undefined,
        Diagnostics.Type_0_does_not_satisfy_the_constraint_1,
      );
  }
  return result;
}

function getImplementsHeritageClauseElements(node: Node): Node[] {
  const result: Node[] = [];
  const clauses = getHeritageClauses(node);
  if (clauses === undefined) return result;
  // Only the first `implements` clause counts; others are syntax errors.
  for (const clause of clauses.nodes) {
    const heritage = clause as HeritageClause;
    if (heritage.token === SyntaxKind.ImplementsKeyword) {
      for (const t of heritage.types.nodes) result.push(t);
      break;
    }
  }
  return result;
}

function checkBaseTypeAccessibility(c: Checker, t: Type, node: Node): void {
  const signatures = getSignaturesOfType(c, t, SignatureKind.Construct);
  const error = getConstructorAccessibilityError(c, node, signatures, ModifierFlags.Private);
  if (error !== undefined)
    c.error(
      node,
      Diagnostics.Cannot_extend_a_class_0_Class_constructor_is_marked_as_private,
      getFullyQualifiedName(c, error.declaringClass.symbol!),
    );
}

/** Reports each incompatible member, or the class as a whole when no member is to blame. */
function issueMemberSpecificError(
  c: Checker,
  node: Node,
  typeWithThis: Type,
  baseWithThis: Type,
  broadMessage: DiagnosticMessage,
): void {
  let issuedMemberError = false;
  for (const member of getMembers(node)!.nodes) {
    if (isStatic(member)) continue;
    const declaredProp = getSymbolOfDeclaration(c, member);
    if (declaredProp === undefined || declaredProp.name === InternalSymbolName.Computed) continue;
    const prop = getPropertyOfType(c, typeWithThis, declaredProp.name);
    const baseProp = getPropertyOfType(c, baseWithThis, declaredProp.name);
    if (prop === undefined || baseProp === undefined) continue;
    const diagnostics: Diagnostic[] = [];
    if (
      !checkTypeRelatedTo(
        c,
        getTypeOfSymbol(c, prop),
        getTypeOfSymbol(c, baseProp),
        c.assignableRelation,
        getName(member) ?? member,
        undefined,
        diagnostics,
      )
    ) {
      c.addDiagnostic(
        chainDiagnostic(
          diagnostics[0]!,
          Diagnostics.Property_0_in_type_1_is_not_assignable_to_the_same_property_in_base_type_2,
          symbolToString(c, declaredProp),
          typeToString(c, typeWithThis),
          typeToString(c, baseWithThis),
        ),
      );
      issuedMemberError = true;
    }
  }
  if (!issuedMemberError) checkTypeAssignableTo(c, typeWithThis, baseWithThis, getName(node) ?? node, broadMessage);
}

function getTypeWithoutSignatures(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Object) !== 0) {
    const resolved = resolveStructuredTypeMembers(c, t);
    if (resolved.callSignatures.length !== 0 || resolved.constructSignatures.length !== 0)
      return createAnonymousType(c, t.symbol, resolved.members, emptySignatures, emptySignatures, emptyIndexInfos);
  } else if ((t.flags & TypeFlags.Intersection) !== 0) {
    const types: Type[] = [];
    for (const u of typesOf(t)) types.push(getTypeWithoutSignatures(c, u));
    return getIntersectionType(c, types);
  }
  return t;
}

function checkClassForStaticPropertyNameConflicts(c: Checker, node: Node): void {
  if (getUseDefineForClassFields(c.compilerOptions)) return;
  for (const member of getMembers(node)!.nodes) {
    const name = getName(member);
    if (name === undefined || !isStatic(member)) continue;
    const memberName = getEffectivePropertyName(c, name);
    if (memberName === 'name' || memberName === 'length' || memberName === 'caller' || memberName === 'arguments')
      c.error(
        name,
        Diagnostics.Static_property_0_conflicts_with_built_in_property_Function_0_of_constructor_function_1,
        memberName,
        symbolToString(c, getSymbolOfDeclaration(c, node)!),
      );
  }
}

/** The property name a name denotes: a literal name, or the literal type of a computed name's expression. */
function getEffectivePropertyName(c: Checker, name: Node): string | undefined {
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return getText(name);
    case SyntaxKind.ComputedPropertyName: {
      const e = getExpression(name)!;
      if (
        e.kind === SyntaxKind.StringLiteral ||
        e.kind === SyntaxKind.NumericLiteral ||
        e.kind === SyntaxKind.NoSubstitutionTemplateLiteral
      )
        return getText(e);
      return tryGetNameFromType(getTypeOfExpression(c, e));
    }
  }
  return undefined;
}

// ---- Member overrides

class MissingAbstractMembers {
  readonly baseTypeName: string;
  readonly typeName: string;
  readonly properties: string[] = [];

  constructor(baseTypeName: string, typeName: string) {
    this.baseTypeName = baseTypeName;
    this.typeName = typeName;
  }
}

/**
 * Checks that derived members override base members of the same kind, and that abstract members
 * are implemented. Assignability is checked by `checkBaseClass`.
 */
function checkKindsOfPropertyMemberOverrides(c: Checker, t: InterfaceType, baseType: Type): void {
  let missing: MissingAbstractMembers | undefined = undefined;
  let missingNode: Node | undefined = undefined;
  for (const baseProperty of getPropertiesOfType(c, baseType)) {
    const base = getTargetSymbol(c, baseProperty);
    if ((base.flags & SymbolFlags.Prototype) !== 0) continue;
    const baseSymbol = getPropertyOfObjectType(c, t, base.name);
    if (baseSymbol === undefined) continue;
    const derived = getTargetSymbol(c, baseSymbol);
    const baseDeclarationFlags = getDeclarationModifierFlagsFromSymbol(c, base, false);
    // Uninstantiated targets: an inherited member of a generic class resolves to the same symbol.
    if (derived === base) {
      // An inherited abstract member must be implemented, or the class declared abstract.
      if ((baseDeclarationFlags & ModifierFlags.Abstract) === 0) continue;
      const derivedClassDecl = getClassLikeDeclarationOfSymbol(t.symbol!);
      if (derivedClassDecl !== undefined && hasSyntacticModifier(derivedClassDecl, ModifierFlags.Abstract)) continue;
      // Another base type (from a merged interface) may implement it.
      if (isImplementedByOtherBaseType(c, t, baseType, base)) continue;
      if (missing === undefined) {
        missing = new MissingAbstractMembers(typeToString(c, baseType), typeToString(c, t));
        missingNode = derivedClassDecl;
      }
      missing.properties.push(symbolToString(c, baseProperty));
      continue;
    }
    const derivedDeclarationFlags = getDeclarationModifierFlagsFromSymbol(c, derived, false);
    // Private members aren't overridden.
    if (((baseDeclarationFlags | derivedDeclarationFlags) & ModifierFlags.Private) !== 0) continue;
    const basePropertyFlags = base.flags & SymbolFlags.PropertyOrAccessor;
    const derivedPropertyFlags = derived.flags & SymbolFlags.PropertyOrAccessor;
    const derivedName = getNameOfDeclaration(derived.valueDeclaration) ?? derived.valueDeclaration;
    if (basePropertyFlags !== 0 && derivedPropertyFlags !== 0) {
      // Abstract and interface members, and assignment-declared overrides, may change kind.
      if (
        (base.checkFlags & CheckFlags.Mapped) !== 0 ||
        (derived.valueDeclaration !== undefined && derived.valueDeclaration.kind === SyntaxKind.BinaryExpression) ||
        arePropertiesAbstractOrInterface(base, baseDeclarationFlags)
      )
        continue;
      const overriddenInstanceProperty =
        basePropertyFlags !== SymbolFlags.Property && derivedPropertyFlags === SymbolFlags.Property;
      const overriddenInstanceAccessor =
        basePropertyFlags === SymbolFlags.Property && derivedPropertyFlags !== SymbolFlags.Property;
      if (overriddenInstanceProperty || overriddenInstanceAccessor)
        c.error(
          derivedName,
          overriddenInstanceProperty
            ? Diagnostics.X_0_is_defined_as_an_accessor_in_class_1_but_is_overridden_here_in_2_as_an_instance_property
            : Diagnostics.X_0_is_defined_as_a_property_in_class_1_but_is_overridden_here_in_2_as_an_accessor,
          symbolToString(c, base),
          typeToString(c, baseType),
          typeToString(c, t),
        );
      else if (getUseDefineForClassFields(c.compilerOptions))
        checkPropertyOverwritesBase(c, t, baseType, base, derived, baseDeclarationFlags, derivedDeclarationFlags);
      continue;
    }
    let message: DiagnosticMessage;
    if (isPrototypeProperty(base)) {
      // A method may be overridden by a method or property.
      if (isPrototypeProperty(derived) || (derived.flags & SymbolFlags.Property) !== 0) continue;
      message =
        Diagnostics.Class_0_defines_instance_member_function_1_but_extended_class_2_defines_it_as_instance_member_accessor;
    } else if ((base.flags & SymbolFlags.Accessor) !== 0)
      message =
        Diagnostics.Class_0_defines_instance_member_accessor_1_but_extended_class_2_defines_it_as_instance_member_function;
    else
      message =
        Diagnostics.Class_0_defines_instance_member_property_1_but_extended_class_2_defines_it_as_instance_member_function;
    c.error(derivedName, message, typeToString(c, baseType), symbolToString(c, base), typeToString(c, t));
  }
  if (missing !== undefined) reportMissingAbstractMembers(c, missingNode!, missing);
}

function isImplementedByOtherBaseType(c: Checker, t: InterfaceType, baseType: Type, base: Symbol): boolean {
  for (const otherBaseType of getBaseTypes(c, t)) {
    if (otherBaseType === baseType) continue;
    const baseSymbol = getPropertyOfObjectType(c, otherBaseType, base.name);
    if (baseSymbol !== undefined && getTargetSymbol(c, baseSymbol) !== base) return true;
  }
  return false;
}

/** With `useDefineForClassFields`, a redeclared property without an initializer resets the base value. */
function checkPropertyOverwritesBase(
  c: Checker,
  t: InterfaceType,
  baseType: Type,
  base: Symbol,
  derived: Symbol,
  baseDeclarationFlags: ModifierFlags,
  derivedDeclarationFlags: ModifierFlags,
): void {
  let uninitialized: Node | undefined;
  for (const d of getDeclarations(derived)) {
    if (d.kind === SyntaxKind.PropertyDeclaration && getInitializer(d) === undefined) {
      uninitialized = d;
      break;
    }
  }
  if (
    uninitialized === undefined ||
    (derived.flags & SymbolFlags.Transient) !== 0 ||
    (baseDeclarationFlags & ModifierFlags.Abstract) !== 0 ||
    (derivedDeclarationFlags & ModifierFlags.Abstract) !== 0
  )
    return;
  for (const d of getDeclarations(derived)) if ((d.flags & NodeFlags.Ambient) !== 0) return;
  const constructor = findConstructorDeclaration(getClassLikeDeclarationOfSymbol(t.symbol!)!);
  const propName = getName(uninitialized)!;
  const postfix = getPostfixToken(uninitialized);
  if (
    (postfix !== undefined && postfix.kind === SyntaxKind.ExclamationToken) ||
    constructor === undefined ||
    propName.kind !== SyntaxKind.Identifier ||
    !c.strictNullChecks ||
    !isPropertyInitializedInConstructor(c, propName, t, constructor)
  )
    c.error(
      getNameOfDeclaration(derived.valueDeclaration) ?? derived.valueDeclaration,
      Diagnostics.Property_0_will_overwrite_the_base_property_in_1_If_this_is_intentional_add_an_initializer_Otherwise_add_a_declare_modifier_or_remove_the_redundant_declaration,
      symbolToString(c, base),
      typeToString(c, baseType),
    );
}

function reportMissingAbstractMembers(c: Checker, node: Node | undefined, missing: MissingAbstractMembers): void {
  const isExpression = node !== undefined && node.kind === SyntaxKind.ClassExpression;
  const properties = missing.properties;
  if (properties.length === 1) {
    if (isExpression)
      c.error(
        node,
        Diagnostics.Non_abstract_class_expression_does_not_implement_inherited_abstract_member_0_from_class_1,
        properties[0]!,
        missing.baseTypeName,
      );
    else
      c.error(
        node,
        Diagnostics.Non_abstract_class_0_does_not_implement_inherited_abstract_member_1_from_class_2,
        missing.typeName,
        properties[0]!,
        missing.baseTypeName,
      );
    return;
  }
  if (properties.length > 5) {
    const listed = properties
      .slice(0, 4)
      .map((p) => "'" + p + "'")
      .join(', ');
    const remaining = String(properties.length - 4);
    if (isExpression)
      c.error(
        node,
        Diagnostics.Non_abstract_class_expression_is_missing_implementations_for_the_following_members_of_0_Colon_1_and_2_more,
        missing.baseTypeName,
        listed,
        remaining,
      );
    else
      c.error(
        node,
        Diagnostics.Non_abstract_class_0_is_missing_implementations_for_the_following_members_of_1_Colon_2_and_3_more,
        missing.typeName,
        missing.baseTypeName,
        listed,
        remaining,
      );
    return;
  }
  const listed = properties.map((p) => "'" + p + "'").join(', ');
  if (isExpression)
    c.error(
      node,
      Diagnostics.Non_abstract_class_expression_is_missing_implementations_for_the_following_members_of_0_Colon_1,
      missing.baseTypeName,
      listed,
    );
  else
    c.error(
      node,
      Diagnostics.Non_abstract_class_0_is_missing_implementations_for_the_following_members_of_1_Colon_2,
      missing.typeName,
      missing.baseTypeName,
      listed,
    );
}

function arePropertiesAbstractOrInterface(base: Symbol, baseDeclarationFlags: ModifierFlags): boolean {
  // Synthetic (intersection) properties need any declaration to qualify; others need all.
  if ((base.checkFlags & CheckFlags.Synthetic) !== 0) {
    for (const d of getDeclarations(base)) if (isPropertyAbstractOrInterface(d, baseDeclarationFlags)) return true;
    return false;
  }
  for (const d of getDeclarations(base)) if (!isPropertyAbstractOrInterface(d, baseDeclarationFlags)) return false;
  return true;
}

function isPropertyAbstractOrInterface(declaration: Node, baseDeclarationFlags: ModifierFlags): boolean {
  return (
    declaration.parent!.kind === SyntaxKind.InterfaceDeclaration ||
    ((baseDeclarationFlags & ModifierFlags.Abstract) !== 0 &&
      (declaration.kind !== SyntaxKind.PropertyDeclaration || getInitializer(declaration) === undefined))
  );
}

// ---- `override`

function checkMembersForOverrideModifier(
  c: Checker,
  node: Node,
  t: InterfaceType,
  typeWithThis: Type,
  staticType: Type,
): void {
  let baseWithThis: Type | undefined = undefined;
  if (getExtendsHeritageClauseElement(node) !== undefined) {
    const baseTypes = getBaseTypes(c, t);
    if (baseTypes.length > 0) baseWithThis = getTypeWithThisArgument(c, baseTypes[0]!, t.thisType, false);
  }
  const baseStaticType = getBaseConstructorTypeOfClass(c, t);
  for (const member of getMembers(node)!.nodes) {
    if (hasSyntacticModifier(member, ModifierFlags.Ambient)) continue;
    if (member.kind === SyntaxKind.Constructor) {
      for (const param of getParameters(member)!.nodes)
        if (isParameterPropertyDeclaration(param, member))
          checkMemberForOverrideModifier(c, node, staticType, baseStaticType, baseWithThis, t, typeWithThis, param);
    } else checkMemberForOverrideModifier(c, node, staticType, baseStaticType, baseWithThis, t, typeWithThis, member);
  }
}

function checkMemberForOverrideModifier(
  c: Checker,
  node: Node,
  staticType: Type,
  baseStaticType: Type,
  baseWithThis: Type | undefined,
  t: Type,
  typeWithThis: Type,
  member: Node,
): void {
  const isJs = (node.flags & NodeFlags.JavaScriptFile) !== 0;
  const memberHasOverrideModifier = hasSyntacticModifier(member, ModifierFlags.Override);
  if (baseWithThis === undefined) {
    if (memberHasOverrideModifier)
      c.error(
        member,
        isJs
          ? Diagnostics.This_member_cannot_have_a_JSDoc_comment_with_an_override_tag_because_its_containing_class_0_does_not_extend_another_class
          : Diagnostics.This_member_cannot_have_an_override_modifier_because_its_containing_class_0_does_not_extend_another_class,
        typeToString(c, t),
      );
    return;
  }
  const memberSymbol = getSymbolOfDeclaration(c, member);
  if (
    memberHasOverrideModifier &&
    memberSymbol !== undefined &&
    memberSymbol.valueDeclaration !== undefined &&
    member.kind !== SyntaxKind.Parameter &&
    hasDynamicName(member) &&
    !hasLateBindableName(c, member)
  ) {
    c.error(
      member,
      isJs
        ? Diagnostics.This_member_cannot_have_a_JSDoc_comment_with_an_override_tag_because_its_name_is_dynamic
        : Diagnostics.This_member_cannot_have_an_override_modifier_because_its_name_is_dynamic,
    );
    return;
  }
  if (!memberHasOverrideModifier && c.compilerOptions.noImplicitOverride !== true) return;
  if (memberSymbol === undefined) return;
  const memberIsStatic = isStatic(member);
  const prop = getPropertyOfType(c, memberIsStatic ? staticType : typeWithThis, memberSymbol.name);
  if (prop === undefined) return;
  const baseType = memberIsStatic ? baseStaticType : baseWithThis;
  const baseProp = getPropertyOfType(c, baseType, memberSymbol.name);
  if (baseProp === undefined && memberHasOverrideModifier) {
    const suggestion = getSpellingSuggestionForName(
      c,
      memberSymbol.name,
      getPropertiesOfType(c, baseType),
      SymbolFlags.ClassMember,
    );
    if (suggestion !== undefined)
      c.error(
        member,
        isJs
          ? Diagnostics.This_member_cannot_have_a_JSDoc_comment_with_an_override_tag_because_it_is_not_declared_in_the_base_class_0_Did_you_mean_1
          : Diagnostics.This_member_cannot_have_an_override_modifier_because_it_is_not_declared_in_the_base_class_0_Did_you_mean_1,
        typeToString(c, baseWithThis),
        symbolToString(c, suggestion),
      );
    else
      c.error(
        member,
        isJs
          ? Diagnostics.This_member_cannot_have_a_JSDoc_comment_with_an_override_tag_because_it_is_not_declared_in_the_base_class_0
          : Diagnostics.This_member_cannot_have_an_override_modifier_because_it_is_not_declared_in_the_base_class_0,
        typeToString(c, baseWithThis),
      );
    return;
  }
  if (
    baseProp === undefined ||
    declarationCount(baseProp) === 0 ||
    memberHasOverrideModifier ||
    c.compilerOptions.noImplicitOverride !== true ||
    (node.flags & NodeFlags.Ambient) !== 0
  )
    return;
  let baseHasAbstract = false;
  for (const d of getDeclarations(baseProp)) {
    if (hasSyntacticModifier(d, ModifierFlags.Abstract)) {
      baseHasAbstract = true;
      break;
    }
  }
  if (!baseHasAbstract) {
    let message: DiagnosticMessage;
    if (member.kind === SyntaxKind.Parameter)
      message = isJs
        ? Diagnostics.This_parameter_property_must_have_a_JSDoc_comment_with_an_override_tag_because_it_overrides_a_member_in_the_base_class_0
        : Diagnostics.This_parameter_property_must_have_an_override_modifier_because_it_overrides_a_member_in_base_class_0;
    else
      message = isJs
        ? Diagnostics.This_member_must_have_a_JSDoc_comment_with_an_override_tag_because_it_overrides_a_member_in_the_base_class_0
        : Diagnostics.This_member_must_have_an_override_modifier_because_it_overrides_a_member_in_the_base_class_0;
    c.error(member, message, typeToString(c, baseWithThis));
    return;
  }
  if (hasSyntacticModifier(member, ModifierFlags.Abstract))
    c.error(
      member,
      Diagnostics.This_member_must_have_an_override_modifier_because_it_overrides_an_abstract_method_that_is_declared_in_the_base_class_0,
      typeToString(c, baseWithThis),
    );
}

// ---- Interfaces

/** Checks an interface's merged declarations, base interfaces and index signatures, once per symbol. */
export function checkInterfaceHeritage(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  checkTypeParameterListsIdentical(c, symbol);
  const links = c.symbolLinks(symbol);
  if (!links.interfaceChecked) {
    links.interfaceChecked = true;
    // Reported on the first interface declaration, whichever declaration is checked first.
    const firstName = getName(getDeclarationOfKind(symbol, SyntaxKind.InterfaceDeclaration)!)!;
    const t = getDeclaredTypeOfSymbol(c, symbol) as InterfaceType;
    if ((t.flags & TypeFlags.Object) !== 0) {
      const typeWithThis = getTypeWithThisArgument(c, t, undefined, false);
      // Later checks run only when inherited properties agree.
      if (checkInheritedPropertiesAreIdentical(c, t, firstName)) {
        for (const baseType of getBaseTypes(c, t))
          checkTypeAssignableTo(
            c,
            typeWithThis,
            getTypeWithThisArgument(c, baseType, t.thisType, false),
            firstName,
            Diagnostics.Interface_0_incorrectly_extends_interface_1,
          );
        checkIndexConstraints(c, t, symbol, false);
      }
    }
  }
  checkObjectTypeForDuplicateDeclarations(c, node, false);
  for (const element of getExtendsHeritageClauseElements(node)) {
    if (element.kind !== SyntaxKind.ExpressionWithTypeArguments) continue;
    const expr = getExpression(element)!;
    if (!isEntityNameExpression(expr) || isOptionalChain(expr))
      c.error(
        expr,
        Diagnostics.An_interface_can_only_extend_an_identifier_Slashqualified_name_with_optional_type_arguments,
      );
  }
}

/** Checks a type literal's index signatures and members after its members are checked. */
export function checkTypeLiteralMembers(c: Checker, node: Node): void {
  const t = getTypeFromTypeNode(c, node);
  if (t.symbol !== undefined) checkIndexConstraints(c, t, t.symbol, false);
  checkTypeForDuplicateIndexSignatures(c, node);
  checkObjectTypeForDuplicateDeclarations(c, node, false);
}

class InheritanceInfo {
  readonly prop: Symbol;
  readonly containingType: Type;

  constructor(prop: Symbol, containingType: Type) {
    this.prop = prop;
    this.containingType = containingType;
  }
}

function checkInheritedPropertiesAreIdentical(c: Checker, t: InterfaceType, typeNode: Node): boolean {
  const baseTypes = getBaseTypes(c, t);
  if (baseTypes.length < 2) return true;
  const seen = new Map<string, InheritanceInfo>();
  const declaredMembers = resolveDeclaredMembers(c, t).declaredMembers;
  if (declaredMembers !== undefined)
    for (const [id, p] of declaredMembers) if (isNamedMember(c, p, id)) seen.set(p.name, new InheritanceInfo(p, t));
  let identical = true;
  for (const base of baseTypes) {
    for (const prop of getPropertiesOfType(c, getTypeWithThisArgument(c, base, t.thisType, false))) {
      const existing = seen.get(prop.name);
      if (existing === undefined) {
        seen.set(prop.name, new InheritanceInfo(prop, base));
        continue;
      }
      if (
        existing.containingType !== t &&
        compareProperties(c, existing.prop, prop, ComparerKind.Identical) === Ternary.False
      ) {
        identical = false;
        const typeName1 = typeToString(c, existing.containingType);
        const typeName2 = typeToString(c, base);
        const errorInfo = createDiagnosticForNode(
          typeNode,
          Diagnostics.Named_property_0_of_types_1_and_2_are_not_identical,
          [symbolToString(c, prop), typeName1, typeName2],
        );
        c.addDiagnostic(
          chainDiagnostic(
            errorInfo,
            Diagnostics.Interface_0_cannot_simultaneously_extend_types_1_and_2,
            typeToString(c, t),
            typeName1,
            typeName2,
          ),
        );
      }
    }
  }
  return identical;
}

// ---- Type parameters of merged declarations

/** Reports class and interface declarations of one symbol whose type parameters differ. */
export function checkTypeParameterListsIdentical(c: Checker, symbol: Symbol): void {
  if (declarationCount(symbol) === 1) return;
  const links = c.symbolLinks(symbol);
  if (links.typeParametersChecked) return;
  links.typeParametersChecked = true;
  const declarations: Node[] = [];
  for (const d of getDeclarations(symbol))
    if (d.kind === SyntaxKind.ClassDeclaration || d.kind === SyntaxKind.InterfaceDeclaration) declarations.push(d);
  if (declarations.length <= 1) return;
  const t = getDeclaredTypeOfSymbol(c, symbol) as InterfaceType;
  if ((t.flags & TypeFlags.Object) === 0) return;
  const lists: (readonly Node[])[] = [];
  for (const d of declarations) {
    const list = getTypeParameters(d);
    lists.push(list !== undefined ? list.nodes : []);
  }
  if (areTypeParametersIdentical(c, lists, t.localTypeParameters())) return;
  const name = symbolToString(c, symbol);
  for (const d of declarations)
    c.error(getName(d), Diagnostics.All_declarations_of_0_must_have_identical_type_parameters, name);
}

/** Reports the declarations of an `infer` type parameter declared more than once with different constraints. */
export function checkInferTypeParameterDeclarations(c: Checker, symbol: Symbol): void {
  if (declarationCount(symbol) <= 1) return;
  const links = c.symbolLinks(symbol);
  if (links.typeParametersChecked) return;
  links.typeParametersChecked = true;
  const declarations: Node[] = [];
  const typeParameterLists: Node[][] = [];
  for (const d of getDeclarations(symbol)) {
    if (d.kind === SyntaxKind.TypeParameter) {
      declarations.push(d);
      typeParameterLists.push([d]);
    }
  }
  if (areTypeParametersIdentical(c, typeParameterLists, [getDeclaredTypeOfTypeParameter(c, symbol)])) return;
  const name = symbolToString(c, symbol);
  for (const d of declarations)
    c.error(getName(d), Diagnostics.All_declarations_of_0_must_have_identical_constraints, name);
}

function areTypeParametersIdentical(
  c: Checker,
  lists: readonly (readonly Node[])[],
  targetParameters: readonly Type[],
): boolean {
  const maxTypeArgumentCount = targetParameters.length;
  const minTypeArgumentCount = getMinTypeArgumentCount(c, targetParameters);
  for (const sourceParameters of lists) {
    if (sourceParameters.length < minTypeArgumentCount || sourceParameters.length > maxTypeArgumentCount) return false;
    for (let i = 0; i < sourceParameters.length; i++) {
      const source = sourceParameters[i]! as TypeParameterDeclaration;
      const target = targetParameters[i]!;
      if (getText(source.name) !== target.symbol!.name) return false;
      // A later declaration without a constraint may merge with a constrained one.
      const targetConstraint = getConstraintOfTypeParameter(c, target);
      if (
        source.constraint !== undefined &&
        targetConstraint !== undefined &&
        !isTypeIdenticalTo(c, getTypeFromTypeNode(c, source.constraint), targetConstraint)
      )
        return false;
      const targetDefault = getDefaultFromTypeParameter(c, target);
      if (
        source.defaultType !== undefined &&
        targetDefault !== undefined &&
        !isTypeIdenticalTo(c, getTypeFromTypeNode(c, source.defaultType), targetDefault)
      )
        return false;
    }
  }
  return true;
}

// ---- Duplicate members

const enum MemberKind {
  None = 0,
  Property = 1,
  Accessor = 2,
  Reported = 3,
}

/**
 * Reports properties declared twice, properties combined with accessors, `static prototype`, and
 * (with `checkPrivateNames`) private names shared by static and instance members.
 */
export function checkObjectTypeForDuplicateDeclarations(c: Checker, node: Node, checkPrivateNames: boolean): void {
  const instanceNames = new Map<string, MemberKind>();
  const staticNames = new Map<string, MemberKind>();
  const privateNames = new Map<string, number>();
  const nodeInAmbientContext = (node.flags & NodeFlags.Ambient) !== 0;
  for (const member of getMembers(node)!.nodes) {
    if (member.kind === SyntaxKind.Constructor) {
      for (const param of getParameters(member)!.nodes)
        if (isParameterPropertyDeclaration(param, member) && !isBindingPattern(getName(param))) {
          const symbol = getSymbolOfDeclaration(c, param);
          if (symbol !== undefined) checkPropertyOrAccessor(c, node, instanceNames, symbol, MemberKind.Property, false);
        }
      continue;
    }
    const symbol = getSymbolOfDeclaration(c, member);
    if (symbol === undefined) continue;
    const memberIsStatic = hasStaticModifier(member);
    if (!nodeInAmbientContext && memberIsStatic && symbol.name === 'prototype')
      c.error(
        getName(member),
        Diagnostics.Static_property_0_conflicts_with_built_in_property_Function_0_of_constructor_function_1,
        symbol.name,
        symbolToString(c, getSymbolOfDeclaration(c, node)!),
      );
    const names = memberIsStatic ? staticNames : instanceNames;
    const hasAccessorModifier = hasSyntacticModifier(member, ModifierFlags.Accessor);
    if (
      (member.kind === SyntaxKind.PropertyDeclaration && !hasAccessorModifier) ||
      member.kind === SyntaxKind.PropertySignature
    )
      checkPropertyOrAccessor(c, node, names, symbol, MemberKind.Property, memberIsStatic);
    else if (
      member.kind === SyntaxKind.GetAccessor ||
      member.kind === SyntaxKind.SetAccessor ||
      (member.kind === SyntaxKind.PropertyDeclaration && hasAccessorModifier)
    )
      checkPropertyOrAccessor(c, node, names, symbol, MemberKind.Accessor, memberIsStatic);
    const name = getName(member);
    if (checkPrivateNames && name !== undefined && name.kind === SyntaxKind.PrivateIdentifier) {
      let flags = privateNames.get(symbol.name) ?? 0;
      if (flags === 3) continue;
      flags |= isStatic(member) ? 2 : 1;
      privateNames.set(symbol.name, flags);
      if (flags === 3)
        reportDuplicateMemberErrors(
          c,
          node,
          symbol.name,
          false,
          false,
          Diagnostics.Duplicate_identifier_0_Static_and_instance_elements_cannot_share_the_same_private_name,
        );
    }
  }
}

function checkPropertyOrAccessor(
  c: Checker,
  node: Node,
  names: Map<string, MemberKind>,
  symbol: Symbol,
  kind: MemberKind,
  isStaticMember: boolean,
): void {
  if (declarationCount(symbol) <= 1) return;
  const state = names.get(symbol.name) ?? MemberKind.None;
  if (state === MemberKind.None) names.set(symbol.name, kind);
  // A second property, or a property combined with an accessor.
  else if (state === MemberKind.Property || (state === MemberKind.Accessor && kind !== MemberKind.Accessor)) {
    reportDuplicateMemberErrors(c, node, symbol.name, true, isStaticMember, Diagnostics.Duplicate_identifier_0);
    names.set(symbol.name, MemberKind.Reported);
  }
}

function reportDuplicateMemberErrors(
  c: Checker,
  node: Node,
  name: string,
  checkStatic: boolean,
  isStaticMember: boolean,
  message: DiagnosticMessage,
): void {
  for (const member of getMembers(node)!.nodes) {
    if (member.kind === SyntaxKind.Constructor) {
      for (const param of getParameters(member)!.nodes) {
        if (!isParameterPropertyDeclaration(param, member) || isBindingPattern(getName(param))) continue;
        const symbol = getSymbolOfDeclaration(c, param);
        if (symbol !== undefined && symbol.name === name) c.error(getName(param), message, symbolToString(c, symbol));
      }
      continue;
    }
    const symbol = getSymbolOfDeclaration(c, member);
    if (symbol !== undefined && symbol.name === name && (!checkStatic || isStaticMember === isStatic(member)))
      c.error(getName(member), message, symbolToString(c, symbol));
  }
}

// ---- Index signatures

/** Checks properties and index signatures of `t` against its applicable index signatures. */
export function checkIndexConstraints(c: Checker, t: Type, symbol: Symbol, isStaticIndex: boolean): void {
  const indexInfos = getIndexInfosOfType(c, t);
  if (indexInfos.length === 0) return;
  for (const prop of getPropertiesOfObjectType(c, t)) {
    if (isStaticIndex && (prop.flags & SymbolFlags.Prototype) !== 0) continue;
    checkIndexConstraintForProperty(
      c,
      t,
      prop,
      getLiteralTypeFromProperty(c, prop, TypeFlags.StringOrNumberLiteralOrUnique, true),
      getNonMissingTypeOfSymbol(c, prop),
    );
  }
  const typeDeclaration = symbol.valueDeclaration;
  if (typeDeclaration !== undefined && isClassLike(typeDeclaration)) {
    // Members with dynamic names aren't properties of the type.
    for (const member of getMembers(typeDeclaration)!.nodes) {
      if (isStatic(member) !== isStaticIndex || !hasDynamicName(member) || hasLateBindableName(c, member)) continue;
      const memberSymbol = getSymbolOfDeclaration(c, member);
      if (memberSymbol === undefined) continue;
      checkIndexConstraintForProperty(
        c,
        t,
        memberSymbol,
        getTypeOfExpression(c, getExpression(getName(member)!)!),
        getNonMissingTypeOfSymbol(c, memberSymbol),
      );
    }
  }
  if (indexInfos.length > 1) for (const info of indexInfos) checkIndexConstraintForIndexSignature(c, t, info);
}

function getApplicableIndexInfos(c: Checker, t: Type, keyType: Type): IndexInfo[] {
  const result: IndexInfo[] = [];
  for (const info of getIndexInfosOfType(c, t)) if (isApplicableIndexType(c, keyType, info.keyType)) result.push(info);
  return result;
}

function getLocalIndexDeclaration(c: Checker, t: Type, info: IndexInfo): Node | undefined {
  const declaration = info.declaration;
  if (declaration === undefined) return undefined;
  const symbol = getSymbolOfDeclaration(c, declaration);
  return symbol !== undefined && getParentOfSymbol(c, symbol) === t.symbol ? declaration : undefined;
}

function checkIndexConstraintForProperty(c: Checker, t: Type, prop: Symbol, propNameType: Type, propType: Type): void {
  const declaration = prop.valueDeclaration;
  const name = getNameOfDeclaration(declaration);
  if (name !== undefined && name.kind === SyntaxKind.PrivateIdentifier) return;
  const indexInfos = getApplicableIndexInfos(c, t, propNameType);
  if (indexInfos.length === 0) return;
  const interfaceDeclaration =
    (t.objectFlags & ObjectFlags.Interface) !== 0
      ? getDeclarationOfKind(t.symbol!, SyntaxKind.InterfaceDeclaration)
      : undefined;
  const propDeclaration =
    (declaration !== undefined && declaration.kind === SyntaxKind.BinaryExpression) ||
    (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName)
      ? declaration
      : undefined;
  const localPropDeclaration = getParentOfSymbol(c, prop) === t.symbol ? declaration : undefined;
  for (const info of indexInfos) {
    // Only check a property or index signature declared here, or, in an interface, ones inherited
    // from different bases.
    let errorNode = localPropDeclaration ?? getLocalIndexDeclaration(c, t, info);
    if (
      errorNode === undefined &&
      interfaceDeclaration !== undefined &&
      !someBaseHasPropertyAndIndexType(c, t, prop.name, info.keyType)
    )
      errorNode = interfaceDeclaration;
    if (errorNode === undefined || isTypeAssignableTo(c, propType, info.valueType)) continue;
    const diagnostic = createDiagnosticForNode(
      errorNode,
      Diagnostics.Property_0_of_type_1_is_not_assignable_to_2_index_type_3,
      [
        symbolToString(c, prop),
        typeToString(c, propType),
        typeToString(c, info.keyType),
        typeToString(c, info.valueType),
      ],
    );
    if (propDeclaration !== undefined && errorNode !== propDeclaration)
      diagnostic.addRelatedInfo(
        createDiagnosticForNode(propDeclaration, Diagnostics.X_0_is_declared_here, [symbolToString(c, prop)]),
      );
    c.addDiagnostic(diagnostic);
  }
}

function someBaseHasPropertyAndIndexType(c: Checker, t: Type, name: string, keyType: Type): boolean {
  for (const base of getBaseTypes(c, t))
    if (getPropertyOfObjectType(c, base, name) !== undefined && getIndexTypeOfType(c, base, keyType) !== undefined)
      return true;
  return false;
}

function someBaseHasIndexTypes(c: Checker, t: Type, checkKeyType: Type, keyType: Type): boolean {
  for (const base of getBaseTypes(c, t))
    if (getIndexInfoOfType(c, base, checkKeyType) !== undefined && getIndexTypeOfType(c, base, keyType) !== undefined)
      return true;
  return false;
}

function checkIndexConstraintForIndexSignature(c: Checker, t: Type, checkInfo: IndexInfo): void {
  const indexInfos = getApplicableIndexInfos(c, t, checkInfo.keyType);
  if (indexInfos.length === 0) return;
  const interfaceDeclaration =
    (t.objectFlags & ObjectFlags.Interface) !== 0
      ? getDeclarationOfKind(t.symbol!, SyntaxKind.InterfaceDeclaration)
      : undefined;
  const localCheckDeclaration = getLocalIndexDeclaration(c, t, checkInfo);
  for (const info of indexInfos) {
    if (info === checkInfo) continue;
    let errorNode = localCheckDeclaration ?? getLocalIndexDeclaration(c, t, info);
    if (
      errorNode === undefined &&
      interfaceDeclaration !== undefined &&
      !someBaseHasIndexTypes(c, t, checkInfo.keyType, info.keyType)
    )
      errorNode = interfaceDeclaration;
    if (errorNode !== undefined && !isTypeAssignableTo(c, checkInfo.valueType, info.valueType))
      c.error(
        errorNode,
        Diagnostics.X_0_index_type_1_is_not_assignable_to_2_index_type_3,
        typeToString(c, checkInfo.keyType),
        typeToString(c, checkInfo.valueType),
        typeToString(c, info.keyType),
        typeToString(c, info.valueType),
      );
  }
}

/** Reports duplicate index signatures of a class or interface, once per symbol. */
export function checkClassOrInterfaceForDuplicateIndexSignatures(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const links = c.symbolLinks(symbol);
  if (links.indexSignaturesChecked) return;
  links.indexSignaturesChecked = true;
  checkTypeForDuplicateIndexSignatures(c, node);
}

function checkTypeForDuplicateIndexSignatures(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const indexSymbol = getIndexSymbol(c, symbol);
  if (indexSymbol === undefined || declarationCount(indexSymbol) <= 1) return;
  // Late-bound index signatures may duplicate each other and explicit ones.
  const keyTypes: Type[] = [];
  const declarationsByKey: Node[][] = [];
  for (const declaration of getDeclarations(indexSymbol)) {
    if (declaration.kind !== SyntaxKind.IndexSignature) continue;
    const parameters = getParameters(declaration)!.nodes;
    if (parameters.length !== 1) continue;
    const typeNode = getType(parameters[0]!);
    if (typeNode === undefined) continue;
    const keyType = getTypeFromTypeNode(c, typeNode);
    const distributed = (keyType.flags & TypeFlags.Union) !== 0 ? typesOf(keyType) : [keyType];
    for (const k of distributed) {
      let index = keyTypes.indexOf(k);
      if (index < 0) {
        index = keyTypes.length;
        keyTypes.push(k);
        declarationsByKey.push([]);
      }
      declarationsByKey[index]!.push(declaration);
    }
  }
  for (let i = 0; i < keyTypes.length; i++) {
    if (declarationsByKey[i]!.length <= 1) continue;
    for (const declaration of declarationsByKey[i]!)
      c.error(declaration, Diagnostics.Duplicate_index_signature_for_type_0, typeToString(c, keyTypes[i]!));
  }
}
