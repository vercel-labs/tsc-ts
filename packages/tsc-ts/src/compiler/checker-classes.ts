// Classes and interfaces.
import { checkCollisionsForDeclarationName, markPrivateIdentifierScope } from './checker-generated-code.js';
import { isNamedEvaluationSource } from './transformers/named-evaluation.js';
import { classOrConstructorParameterIsDecorated } from './transformers/decorator-utilities.js';
import { OuterExpressionKinds, isOuterExpression } from './transformers/utilities.js';
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import {
  type ClassStaticBlockDeclaration,
  type ConstructorDeclaration,
  Identifier,
  PrivateIdentifier,
  getType,
  getSymbol,
  ElementAccessExpression,
  type HeritageClause,
  type InterfaceDeclaration,
  KeywordExpression,
  ModifierFlags,
  type Node,
  NodeFlags,
  NodeVisitor,
  PropertyAccessExpression,
  type PropertyDeclaration,
  getBody,
  getName,
  getStatements,
  getExpression,
  getTypeArguments,
  getHeritageClauses,
  getMembers,
  getText,
  getTypeParameters,
  getInitializer,
  getParameters,
  getModifiers,
} from './ast.js';
import {
  declarationNameToString,
  findConstructorDeclaration,
  getContainingClass,
  getDeclarationOfKind,
  getModifierFlags,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isClassLike,
  isPrivateIdentifierClassElementDeclaration,
  isStatic,
} from './binder-utilities.js';
import { isFunctionLike, nodeIsMissing, nodeIsPresent } from './ast-utilities.js';
import { ScriptTarget, getEmitScriptTarget, getUseDefineForClassFields } from './options.js';
import { hasDynamicName, hasLateBindableName } from './checker-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  type InterfaceType,
  NodeCheckFlags,
  ObjectFlags,
  type Signature,
  SignatureKind,
  type Type,
  TypeFlags,
} from './checker-types.js';
import { everyType, getTargetType, typesOf } from './checker-type-factory.js';
import { type Symbol } from './symbol.js';
import type { FlowNode } from './flow.js';
import { symbolToString, typeToString } from './type-printer.js';
import { getDeclaringClass } from './checker-property-access.js';
import {
  getBaseConstructorTypeOfClass,
  getBaseTypes,
  getDeclaredTypeOfSymbol,
  getClassLikeDeclarationOfSymbol,
  getExtendsHeritageClauseElement,
  isMixinConstructorType,
} from './checker-declared-types.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { getOptionalType, getTypeOfSymbol } from './checker-symbol-types.js';
import { convertAutoToAny, getFlowTypeOfReference } from './checker-narrowing.js';
import { TypeFacts, hasTypeFacts } from './checker-flow.js';
import { getIndexInfosOfType, getSignaturesOfType, getTypeOfPropertyOfType } from './checker-members.js';
import {
  checkJSDocLinksOfNode,
  checkNodeDeferred,
  checkSourceElement,
  checkTypeNodeIfPresent,
} from './checker-source-file.js';
import {
  checkVariableLikeDeclaration,
  checkTypeParameters,
  checkExportsOnMergedDeclarations,
} from './checker-declarations.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { checkJSDocFullSignature } from './checker-jsdoc.js';
import { checkComputedPropertyName } from './checker-expressions.js';
import { checkFunctionOrConstructorSymbol, checkFunctionOrMethodSymbols } from './checker-overloads.js';
import {
  checkClassHeritage,
  checkClassOrInterfaceForDuplicateIndexSignatures,
  checkInterfaceHeritage,
} from './checker-heritage.js';
import { checkDecorators, getFirstTransformableStaticClassElement } from './checker-decorators.js';
import { getTypeOfNode } from './checker-services.js';

export function checkClassDeclaration(c: Checker, node: Node): void {
  checkClassLikeDeclaration(c, node);
  checkClassMembers(c, node);
}

/** Checks a class expression each time it is checked; its members are checked deferred. */
export function checkClassExpression(c: Checker, node: Node): Type {
  checkClassLikeDeclaration(c, node);
  checkNodeDeferred(c, node);
  checkClassExpressionExternalHelpers(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.anyType;
}

/** An anonymous class expression whose emit sets its name (__setFunctionName), and computes the key (__propKey). */
function checkClassExpressionExternalHelpers(c: Checker, node: Node): void {
  if (getName(node) !== undefined) return;
  let parent = node.parent;
  while (parent !== undefined && isOuterExpression(parent, OuterExpressionKinds.All)) parent = parent.parent;
  if (parent === undefined || !isNamedEvaluationSource(parent)) return;
  const willTransformESDecorators = !c.legacyDecorators && c.languageVersion < ScriptTarget.ESNext;
  let location: Node | undefined;
  if (willTransformESDecorators && classOrConstructorParameterIsDecorated(false, node)) {
    location = node;
    for (const modifier of getModifiers(node)?.nodes ?? [])
      if (modifier.kind === SyntaxKind.Decorator) {
        location = modifier;
        break;
      }
  } else location = getFirstTransformableStaticClassElement(c, node);
  if (location === undefined) return;
  checkExternalEmitHelpers(c, location, ExternalEmitHelpers.SetFunctionName);
  if (
    (parent.kind === SyntaxKind.PropertyAssignment ||
      parent.kind === SyntaxKind.PropertyDeclaration ||
      parent.kind === SyntaxKind.BindingElement) &&
    getName(parent)!.kind === SyntaxKind.ComputedPropertyName
  )
    checkExternalEmitHelpers(c, location, ExternalEmitHelpers.PropKey);
}

export function checkClassLikeDeferred(c: Checker, node: Node): void {
  checkClassMembers(c, node);
}

function checkClassMembers(c: Checker, node: Node): void {
  for (const member of getMembers(node)!.nodes) checkClassMember(c, member);
}

function checkClassLikeDeclaration(c: Checker, node: Node): void {
  checkDecorators(c, node);
  checkCollisionsForDeclarationName(c, node, getName(node));
  if (node.kind === SyntaxKind.ClassDeclaration) checkExportsOnMergedDeclarations(c, node);
  const typeParameters = getTypeParameters(node);
  checkTypeParameters(c, typeParameters);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) {
    const t = getDeclaredTypeOfSymbol(c, symbol) as InterfaceType;
    getTypeOfSymbol(c, symbol);
    if ((t.flags & TypeFlags.Object) !== 0) {
      getBaseConstructorTypeOfClass(c, t);
      getBaseTypes(c, t);
    }
  }
  const name = getName(node);
  if (name !== undefined) checkTypeNameIsReserved(c, name, Diagnostics.Class_name_cannot_be_0);
  const heritageClauses = getHeritageClauses(node);
  if (heritageClauses !== undefined) checkHeritageClauses(c, heritageClauses.nodes, true);
  checkClassHeritage(c, node);
  checkPropertyInitialization(c, node);
}

/** Reports a class, interface, enum or type alias named after a predefined type. */
export function checkTypeNameIsReserved(c: Checker, name: Node, message: DiagnosticMessage): void {
  switch (getText(name)) {
    case 'any':
    case 'unknown':
    case 'never':
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'string':
    case 'symbol':
    case 'void':
    case 'object':
    case 'undefined':
      c.error(name, message, getText(name));
  }
}

function checkHeritageClauses(c: Checker, clauses: Node[], isClass: boolean): void {
  // Only the first clause of each kind counts; others are syntax errors.
  let seenExtends = false;
  let seenImplements = false;
  for (const clause of clauses) {
    if ((clause as HeritageClause).token === SyntaxKind.ImplementsKeyword) {
      if (seenImplements) continue;
      seenImplements = true;
    } else {
      if (seenExtends) continue;
      seenExtends = true;
    }
    for (const t of (clause as HeritageClause).types.nodes) {
      const args = getTypeArguments(t);
      if (args !== undefined) for (const a of args.nodes) checkSourceElement(c, a);
      if (!isClass || (clause as HeritageClause).token === SyntaxKind.ImplementsKeyword) checkSourceElement(c, t);
    }
  }
}

function checkClassMember(c: Checker, member: Node): void {
  checkJSDocLinksOfNode(c, member);
  if (
    member.kind === SyntaxKind.PropertyDeclaration ||
    member.kind === SyntaxKind.MethodDeclaration ||
    member.kind === SyntaxKind.GetAccessor ||
    member.kind === SyntaxKind.SetAccessor
  )
    markPrivateIdentifierScope(c, member);
  switch (member.kind) {
    case SyntaxKind.PropertyDeclaration:
      checkVariableLikeDeclaration(c, member);
      if (hasSyntacticModifier(member, ModifierFlags.Abstract) && getInitializer(member) !== undefined)
        c.error(
          member,
          Diagnostics.Property_0_cannot_have_an_initializer_because_it_is_marked_abstract,
          declarationNameToString(getSourceFileOfNode(member), getName(member)),
        );
      return;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor: {
      checkDecorators(c, member);
      const name = getName(member);
      if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
      const symbol = getSymbolOfDeclaration(c, member);
      if (symbol !== undefined && member.kind !== SyntaxKind.Constructor) getTypeOfSymbol(c, symbol);
      checkFunctionLikeBody(c, member);
      if (member.kind === SyntaxKind.MethodDeclaration) {
        checkJSDocFullSignature(c, member);
        checkFunctionOrMethodSymbols(c, member);
        if (hasSyntacticModifier(member, ModifierFlags.Abstract) && getBody(member) !== undefined)
          c.error(
            member,
            Diagnostics.Method_0_cannot_have_an_implementation_because_it_is_marked_abstract,
            declarationNameToString(getSourceFileOfNode(member), name),
          );
      } else if (member.kind === SyntaxKind.Constructor) {
        if (symbol !== undefined) checkFunctionOrConstructorSymbol(c, symbol);
        checkConstructorSuperCall(c, member);
      } else checkAccessorDeclaration(c, member);
      return;
    }
    case SyntaxKind.IndexSignature:
      checkSignatureDeclarationTypes(c, member);
      return;
    case SyntaxKind.ClassStaticBlockDeclaration: {
      const body = getBody(member);
      if (body !== undefined) for (const s of getStatements(body)!.nodes) checkSourceElement(c, s);
      return;
    }
  }
}

/** Accessor checks beyond the body: returns, `constructor` names and getter/setter agreement. */
export function checkAccessorDeclaration(c: Checker, node: Node): void {
  const name = getName(node)!;
  if (name.kind === SyntaxKind.Identifier && getText(name) === 'constructor' && isClassLike(node.parent!))
    c.error(name, Diagnostics.Class_constructor_may_not_be_an_accessor);
  if (
    node.kind === SyntaxKind.GetAccessor &&
    (node.flags & NodeFlags.Ambient) === 0 &&
    nodeIsPresent(getBody(node)) &&
    (node.flags & NodeFlags.HasImplicitReturn) !== 0 &&
    (node.flags & NodeFlags.HasExplicitReturn) === 0
  )
    c.error(name, Diagnostics.A_get_accessor_must_return_a_value);
  if (hasDynamicName(node) && !hasLateBindableName(c, node)) return;
  // Accessors of one member must agree on accessibility and abstractness; checked once, at the getter.
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol === undefined) return;
  const getter = getDeclarationOfKind(symbol, SyntaxKind.GetAccessor);
  const setter = getDeclarationOfKind(symbol, SyntaxKind.SetAccessor);
  if (getter === undefined || setter === undefined) return;
  const links = c.nodeLinks(getter);
  if ((links.flags & NodeCheckFlags.TypeChecked) !== 0) return;
  links.flags |= NodeCheckFlags.TypeChecked;
  const getterFlags = getModifierFlags(getter);
  const setterFlags = getModifierFlags(setter);
  if ((getterFlags & ModifierFlags.Abstract) !== (setterFlags & ModifierFlags.Abstract)) {
    c.error(getName(getter), Diagnostics.Accessors_must_both_be_abstract_or_non_abstract);
    c.error(getName(setter), Diagnostics.Accessors_must_both_be_abstract_or_non_abstract);
  }
  if (
    ((getterFlags & ModifierFlags.Protected) !== 0 &&
      (setterFlags & (ModifierFlags.Protected | ModifierFlags.Private)) === 0) ||
    ((getterFlags & ModifierFlags.Private) !== 0 && (setterFlags & ModifierFlags.Private) === 0)
  ) {
    c.error(getName(getter), Diagnostics.A_get_accessor_must_be_at_least_as_accessible_as_the_setter);
    c.error(getName(setter), Diagnostics.A_get_accessor_must_be_at_least_as_accessible_as_the_setter);
  }
}

/** Derived class constructors must call `super`, at the root when properties are initialized. */
function checkConstructorSuperCall(c: Checker, node: Node): void {
  const body = getBody(node);
  if (nodeIsMissing(body)) return;
  const classDecl = node.parent!;
  if (getExtendsHeritageClauseElement(classDecl) === undefined) return;
  const classSymbol = getSymbolOfDeclaration(c, classDecl);
  const classType = classSymbol !== undefined ? getDeclaredTypeOfSymbol(c, classSymbol) : undefined;
  const classExtendsNull =
    classType !== undefined &&
    (classType.flags & TypeFlags.Object) !== 0 &&
    getBaseConstructorTypeOfClass(c, classType as InterfaceType) === c.nullWideningType;
  const finder = new SuperCallFinder();
  body!.forEachChild(finder);
  const superCall = finder.superCall;
  if (superCall === undefined) {
    if (!classExtendsNull) c.error(node, Diagnostics.Constructors_for_derived_classes_must_contain_a_super_call);
    return;
  }
  if (classExtendsNull)
    c.error(superCall, Diagnostics.A_constructor_cannot_contain_a_super_call_when_its_class_extends_null);
  const emitStandardClassFields =
    getUseDefineForClassFields(c.compilerOptions) && getEmitScriptTarget(c.compilerOptions) >= ScriptTarget.ES2022;
  if (emitStandardClassFields) return;
  // Until there's better flow analysis, the super call must be a root statement when properties are initialized.
  if (!needsRootLevelSuperCall(classDecl, node)) return;
  let parent = superCall.parent!;
  while (parent.kind === SyntaxKind.ParenthesizedExpression) parent = parent.parent!;
  if (parent.kind !== SyntaxKind.ExpressionStatement || parent.parent !== body) {
    c.error(
      superCall,
      Diagnostics.A_super_call_must_be_a_root_level_statement_within_a_constructor_of_a_derived_class_that_contains_initialized_properties_parameter_properties_or_private_identifiers,
    );
    return;
  }
  for (const statement of getStatements(body!)!.nodes) {
    if (
      statement.kind === SyntaxKind.ExpressionStatement &&
      isSuperCall(skipOuterExpressions(getExpression(statement)!))
    )
      return;
    if (nodeImmediatelyReferencesSuperOrThis(statement)) break;
  }
  c.error(
    node,
    Diagnostics.A_super_call_must_be_the_first_statement_in_the_constructor_to_refer_to_super_or_this_when_a_derived_class_contains_initialized_properties_parameter_properties_or_private_identifiers,
  );
}

function isSuperCall(node: Node): boolean {
  return node.kind === SyntaxKind.CallExpression && getExpression(node)!.kind === SyntaxKind.SuperKeyword;
}

function skipOuterExpressions(node: Node): Node {
  let n = node;
  while (
    n.kind === SyntaxKind.ParenthesizedExpression ||
    n.kind === SyntaxKind.AsExpression ||
    n.kind === SyntaxKind.SatisfiesExpression ||
    n.kind === SyntaxKind.TypeAssertionExpression ||
    n.kind === SyntaxKind.NonNullExpression
  )
    n = getExpression(n)!;
  return n;
}

function needsRootLevelSuperCall(classDecl: Node, constructor: Node): boolean {
  for (const m of getMembers(classDecl)!.nodes)
    if (isInstancePropertyWithInitializerOrPrivateIdentifierProperty(m)) return true;
  for (const p of getParameters(constructor)!.nodes)
    if (hasSyntacticModifier(p, ModifierFlags.ParameterPropertyModifier)) return true;
  return false;
}

function isInstancePropertyWithInitializerOrPrivateIdentifierProperty(n: Node): boolean {
  return (
    isPrivateIdentifierClassElementDeclaration(n) ||
    (n.kind === SyntaxKind.PropertyDeclaration && !isStatic(n) && getInitializer(n) !== undefined)
  );
}

/** Finds the first `super(...)` call outside nested functions. */
class SuperCallFinder extends NodeVisitor {
  superCall: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    if (isSuperCall(node)) {
      this.superCall = node;
      return true;
    }
    if (isFunctionLike(node)) return false;
    return node.forEachChild(this);
  }
}

/** Finds `super` or `this` outside nested functions, properties and member bodies. */
class SuperOrThisReferenceFinder extends NodeVisitor {
  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.SuperKeyword:
      case SyntaxKind.ThisKeyword:
        return true;
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.PropertyDeclaration:
        return false;
      case SyntaxKind.Block:
        switch (node.parent!.kind) {
          case SyntaxKind.Constructor:
          case SyntaxKind.MethodDeclaration:
          case SyntaxKind.GetAccessor:
          case SyntaxKind.SetAccessor:
            return false;
        }
    }
    return node.forEachChild(this);
  }
}

function nodeImmediatelyReferencesSuperOrThis(node: Node): boolean {
  return new SuperOrThisReferenceFinder().visitNode(node);
}

function checkSignatureDeclarationTypes(c: Checker, node: Node): void {
  checkTypeNodeIfPresent(c, node);
}

// ---- Strict property initialization

function checkPropertyInitialization(c: Checker, node: Node): void {
  if (!c.strictNullChecks || !c.strictPropertyInitialization || (node.flags & NodeFlags.Ambient) !== 0) return;
  const constructor = findConstructorDeclaration(node);
  for (const member of getMembers(node)!.nodes) {
    if (member.kind !== SyntaxKind.PropertyDeclaration) continue;
    if (
      hasSyntacticModifier(member, ModifierFlags.Ambient) ||
      hasSyntacticModifier(member, ModifierFlags.Abstract) ||
      isStatic(member)
    )
      continue;
    const prop = member as PropertyDeclaration;
    if (prop.initializer !== undefined || prop.postfixToken !== undefined) continue;
    const propName = prop.name;
    if (
      propName.kind !== SyntaxKind.Identifier &&
      propName.kind !== SyntaxKind.PrivateIdentifier &&
      propName.kind !== SyntaxKind.ComputedPropertyName
    )
      continue;
    const symbol = getSymbolOfDeclaration(c, member);
    if (symbol === undefined) continue;
    const t = getTypeOfSymbol(c, symbol);
    if ((t.flags & TypeFlags.AnyOrUnknown) !== 0 || containsUndefinedType(t)) continue;
    if (constructor !== undefined && isPropertyInitializedInConstructor(c, propName, t, constructor)) continue;
    c.error(
      propName,
      Diagnostics.Property_0_has_no_initializer_and_is_not_definitely_assigned_in_the_constructor,
      declarationNameToString(getSourceFileOfNode(propName), propName),
    );
  }
}

/** Whether `this.name` is definitely assigned at the end of the constructor, by control flow. */
export function isPropertyInitializedInConstructor(
  c: Checker,
  propName: Node,
  propType: Type,
  constructor: Node,
): boolean {
  const thisExpression = new KeywordExpression(SyntaxKind.ThisKeyword);
  const returnFlowNode = (constructor as ConstructorDeclaration).returnFlowNode;
  let reference: Node;
  if (propName.kind === SyntaxKind.ComputedPropertyName) {
    const access = new ElementAccessExpression(thisExpression, undefined, getExpression(propName)!, NodeFlags.None);
    access.flowNode = returnFlowNode;
    reference = access;
  } else {
    const access = new PropertyAccessExpression(thisExpression, undefined, propName, NodeFlags.None);
    access.flowNode = returnFlowNode;
    reference = access;
  }
  thisExpression.parent = reference;
  reference.parent = constructor;
  const flowType = getFlowTypeOfReference(c, reference, propType, getOptionalType(c, propType, false), undefined);
  return !containsUndefinedType(flowType);
}

/** Whether a static block between `startPos` and `endPos` definitely assigns `this.name`. */
export function isPropertyInitializedInStaticBlocks(
  c: Checker,
  propName: Node,
  propType: Type,
  staticBlocks: readonly Node[],
  startPos: number,
  endPos: number,
): boolean {
  // Static blocks run in document order, unlike constructors.
  for (const staticBlock of staticBlocks) {
    if (staticBlock.pos < startPos || staticBlock.pos > endPos) continue;
    const thisExpression = new KeywordExpression(SyntaxKind.ThisKeyword);
    const reference = new PropertyAccessExpression(thisExpression, undefined, propName, NodeFlags.None);
    reference.flowNode = (staticBlock as ClassStaticBlockDeclaration).returnFlowNode;
    thisExpression.parent = reference;
    reference.parent = staticBlock;
    const flowType = getFlowTypeOfReference(c, reference, propType, getOptionalType(c, propType, false), undefined);
    if (!containsUndefinedType(flowType)) return true;
  }
  return false;
}

/** The type of an unannotated, uninitialized property from its `this` assignments in the constructor. */
export function getFlowTypeInConstructor(c: Checker, symbol: Symbol, constructor: Node): Type | undefined {
  const reference = newThisPropertyReference(
    symbol,
    constructor,
    (constructor as ConstructorDeclaration).returnFlowNode,
  );
  const flowType = getFlowTypeOfProperty(c, reference, symbol);
  if (c.noImplicitAny && (flowType === c.autoType || flowType === c.autoArrayType))
    c.error(
      symbol.valueDeclaration,
      Diagnostics.Member_0_implicitly_has_an_1_type,
      symbolToString(c, symbol),
      typeToString(c, flowType),
    );
  // Assignments of only null or undefined infer nothing.
  if (everyType(flowType, (t) => hasTypeFacts(c, t, TypeFacts.IsUndefinedOrNull))) return undefined;
  return convertAutoToAny(c, flowType);
}

/** The type of an unannotated, uninitialized static property from its `this` assignments in static blocks. */
export function getFlowTypeInStaticBlocks(c: Checker, symbol: Symbol, staticBlocks: Node[]): Type | undefined {
  for (const staticBlock of staticBlocks) {
    const reference = newThisPropertyReference(
      symbol,
      staticBlock,
      (staticBlock as ClassStaticBlockDeclaration).returnFlowNode,
    );
    const flowType = getFlowTypeOfProperty(c, reference, symbol);
    if (c.noImplicitAny && (flowType === c.autoType || flowType === c.autoArrayType))
      c.error(
        symbol.valueDeclaration,
        Diagnostics.Member_0_implicitly_has_an_1_type,
        symbolToString(c, symbol),
        typeToString(c, flowType),
      );
    if (everyType(flowType, (t) => hasTypeFacts(c, t, TypeFacts.IsUndefinedOrNull))) continue;
    return convertAutoToAny(c, flowType);
  }
  return undefined;
}

/** A synthetic `this.name` at the end of `container`. */
function newThisPropertyReference(symbol: Symbol, container: Node, flowNode: FlowNode | undefined): Node {
  const name = symbol.name;
  let accessName: Node;
  if (name.startsWith('\ufffe#')) accessName = new PrivateIdentifier(name.substring(name.indexOf('@') + 1));
  else accessName = new Identifier(name);
  const thisExpression = new KeywordExpression(SyntaxKind.ThisKeyword);
  const reference = new PropertyAccessExpression(thisExpression, undefined, accessName, NodeFlags.None);
  thisExpression.parent = reference;
  accessName.parent = reference;
  reference.parent = container;
  reference.flowNode = flowNode;
  return reference;
}

/** The control flow type of `this.x` at `reference`, from `undefined` or the base class property type. */
export function getFlowTypeOfProperty(c: Checker, reference: Node, prop: Symbol): Type {
  let initialType: Type = c.undefinedType;
  const declaration = prop.valueDeclaration;
  if (
    declaration !== undefined &&
    (!isAutoTypedProperty(c, prop) || hasSyntacticModifier(declaration, ModifierFlags.Ambient))
  ) {
    const baseType = getTypeOfPropertyInBaseClass(c, prop);
    if (baseType !== undefined) initialType = baseType;
  }
  return getFlowTypeOfReference(c, reference, c.autoType, initialType, undefined);
}

/** Whether a property's type comes from its assignments: it has no annotation or initializer. */
export function isAutoTypedProperty(c: Checker, symbol: Symbol): boolean {
  const declaration = symbol.valueDeclaration;
  return (
    declaration !== undefined &&
    declaration.kind === SyntaxKind.PropertyDeclaration &&
    getType(declaration) === undefined &&
    getInitializer(declaration) === undefined &&
    c.noImplicitAny
  );
}

/** The type of the property in the first base class, if it has one. */
export function getTypeOfPropertyInBaseClass(c: Checker, property: Symbol): Type | undefined {
  const classType = getDeclaringClass(c, property);
  if (classType === undefined) return undefined;
  const baseClassTypes = getBaseTypes(c, classType);
  return baseClassTypes.length > 0 ? getTypeOfPropertyOfType(c, baseClassTypes[0]!, property.name) : undefined;
}

function containsUndefinedType(t: Type): boolean {
  const first = (t.flags & TypeFlags.Union) !== 0 ? typesOf(t)[0]! : t;
  return (first.flags & TypeFlags.Undefined) !== 0;
}

/** A constructor that `node` may not call: the modifiers that forbid it, and the class that declares it. */
export class ConstructorAccessibilityError {
  constructor(
    readonly kind: ModifierFlags,
    readonly declaringClass: Type,
  ) {}
}

/**
 * The first of `signatures` whose constructor `node` may not call because of the modifiers in `modifiersMask`:
 * private and protected constructors are only callable within their class, or subclasses if protected.
 */
export function getConstructorAccessibilityError(
  c: Checker,
  node: Node,
  signatures: readonly Signature[],
  modifiersMask: ModifierFlags,
): ConstructorAccessibilityError | undefined {
  for (const signature of signatures) {
    const declaration = signature.declaration;
    if (declaration === undefined) continue;
    const modifiers = getModifierFlags(declaration) & modifiersMask;
    // Public constructors and constructor functions are always accessible.
    if (modifiers === 0 || declaration.kind !== SyntaxKind.Constructor) continue;
    const classSymbol = getSymbol(declaration.parent!)!;
    const declaringClassDeclaration = getClassLikeDeclarationOfSymbol(classSymbol);
    let withinClass = false;
    for (let container = getContainingClass(node); container !== undefined; container = getContainingClass(container))
      if (container === declaringClassDeclaration) {
        withinClass = true;
        break;
      }
    if (withinClass) continue;
    const containingClass = getContainingClass(node);
    if (containingClass !== undefined && (modifiers & ModifierFlags.Protected) !== 0) {
      const containingType = getTypeOfNode(c, containingClass);
      if (typeHasProtectedAccessibleBase(c, classSymbol, containingType)) continue;
    }
    return new ConstructorAccessibilityError(modifiers, getDeclaredTypeOfSymbol(c, classSymbol));
  }
  return undefined;
}

/** Whether `new` at `node` may call the constructors of `signatures`, reporting private and protected ones out of reach. */
export function isConstructorAccessible(c: Checker, node: Node, signatures: readonly Signature[]): boolean {
  const error = getConstructorAccessibilityError(c, node, signatures, ModifierFlags.NonPublicAccessibilityModifier);
  if (error === undefined) return true;
  if ((error.kind & ModifierFlags.Private) !== 0)
    c.error(
      node,
      Diagnostics.Constructor_of_class_0_is_private_and_only_accessible_within_the_class_declaration,
      typeToString(c, error.declaringClass),
    );
  if ((error.kind & ModifierFlags.Protected) !== 0)
    c.error(
      node,
      Diagnostics.Constructor_of_class_0_is_protected_and_only_accessible_within_the_class_declaration,
      typeToString(c, error.declaringClass),
    );
  return false;
}

/** Whether `target` is a base class of `t`, through bases that aren't mixins. */
function typeHasProtectedAccessibleBase(c: Checker, target: Symbol, t: Type): boolean {
  const baseTypes = getBaseTypes(c, getTargetType(t));
  if (baseTypes.length === 0) return false;
  const firstBase = baseTypes[0]!;
  if ((firstBase.flags & TypeFlags.Intersection) !== 0) {
    const types = typesOf(firstBase);
    const mixinFlags = findMixins(c, types);
    for (let i = 0; i < types.length; i++) {
      const member = types[i]!;
      if (mixinFlags[i]! || (member.objectFlags & (ObjectFlags.Class | ObjectFlags.Interface)) === 0) continue;
      if (member.symbol === target || typeHasProtectedAccessibleBase(c, target, member)) return true;
    }
    return false;
  }
  return firstBase.symbol === target || typeHasProtectedAccessibleBase(c, target, firstBase);
}

/** Which of an intersection's constituents are mixin constructors; one stays if all constructors are. */
function findMixins(c: Checker, types: Type[]): boolean[] {
  const mixinFlags: boolean[] = [];
  let constructorTypeCount = 0;
  let mixinCount = 0;
  let firstMixinIndex = -1;
  for (let i = 0; i < types.length; i++) {
    const isMixin = isMixinConstructorType(c, types[i]!);
    mixinFlags.push(isMixin);
    if (getSignaturesOfType(c, types[i]!, SignatureKind.Construct).length > 0) constructorTypeCount++;
    if (isMixin) {
      if (firstMixinIndex < 0) firstMixinIndex = i;
      mixinCount++;
    }
  }
  if (constructorTypeCount > 0 && constructorTypeCount === mixinCount) mixinFlags[firstMixinIndex] = false;
  return mixinFlags;
}

// ---- Interfaces

export function checkInterfaceDeclaration(c: Checker, node: Node): void {
  const decl = node as InterfaceDeclaration;
  checkTypeParameters(c, decl.typeParameters);
  checkTypeNameIsReserved(c, decl.name, Diagnostics.Interface_name_cannot_be_0);
  checkExportsOnMergedDeclarations(c, node);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) {
    const t = getDeclaredTypeOfSymbol(c, symbol);
    getBaseTypes(c, t);
    getIndexInfosOfType(c, t);
  }
  checkInterfaceHeritage(c, node);
  if (decl.heritageClauses !== undefined) checkHeritageClauses(c, decl.heritageClauses.nodes, false);
  for (const member of decl.members.nodes) {
    checkJSDocLinksOfNode(c, member);
    if (member.kind === SyntaxKind.PropertySignature) checkVariableLikeDeclaration(c, member);
    else checkTypeNodeIfPresent(c, member);
  }
  checkClassOrInterfaceForDuplicateIndexSignatures(c, node);
}
