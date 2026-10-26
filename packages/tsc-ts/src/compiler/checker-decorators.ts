// Decorators: their applicability, resolution as calls and return types.
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import { resolvedReturnTypeOf } from './side-state.js';
import { checkDeprecatedSignature } from './checker-deprecation.js';
import {
  type ConditionalTypeNode,
  type Decorator,
  type IntersectionTypeNode,
  type LiteralTypeNode,
  type Node,
  type TypeReferenceNode,
  type UnionTypeNode,
  FunctionTypeNode,
  KeywordTypeNode,
  NodeFlags,
  NodeList,
  getBody,
  getDotDotDotToken,
  getModifiers,
  getName,
  getParameters,
  getText,
  getType,
  getInitializer,
  getMembers,
} from './ast.js';
import { canHaveDecorators } from './ast-utilities.js';
import {
  getDeclarationOfKind,
  getSourceFileOfNode,
  getSourceTextOfNode,
  hasStaticModifier,
  hasSyntacticModifier,
  isClassLike,
  isStatic,
  isPrivateIdentifierClassElementDeclaration,
  isAutoAccessorPropertyDeclaration,
} from './binder-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { ModuleKind, getEmitModuleKind, ScriptTarget, getUseDefineForClassFields } from './options.js';
import {
  getFirstConstructorWithBody,
  getRestParameterElementType,
  classElementOrClassElementParameterIsDecorated,
  classOrConstructorParameterIsDecorated,
} from './transformers/decorator-utilities.js';
import { isTypeOnlyImportOrExportDeclaration } from './checker-modules.js';
import { ModifierFlags } from './ast.js';
import { CheckMode, type Signature, SignatureFlags, type Type, TypeFlags } from './checker-types.js';
import { getDeclaredTypeOfClassOrInterface, getDeclaredTypeOfSymbol } from './checker-declared-types.js';
import { checkComputedPropertyName } from './checker-expressions.js';
import {
  getFirstIdentifier,
  getSymbolOfDeclaration,
  isAliasSymbolDeclaration,
  resolveName,
  symbolIsValue,
} from './checker-symbols.js';
import { getAnnotatedAccessorTypeNode, getTypeOfSymbol } from './checker-symbol-types.js';
import {
  createAnonymousType,
  createTypeFromGenericGlobalType,
  getIntersectionType,
  getNumberLiteralType,
  getStringLiteralType,
  getUnionType,
  tryCreateTypeReference,
} from './checker-type-factory.js';
import { getLiteralTypeFromPropertyName, isTypeAssignableToKind } from './checker-type-operators.js';
import {
  getOrCreateTypeFromSignature,
  getParameterCount,
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
} from './checker-signatures.js';
import { checkTypeAssignableTo } from './relations.js';
import { getResolvedSignature } from './checker-calls.js';
import {
  getGlobalClassAccessorDecoratorContextType,
  getGlobalClassAccessorDecoratorResultType,
  getGlobalClassAccessorDecoratorTargetType,
  getGlobalClassDecoratorContextType,
  getGlobalClassFieldDecoratorContextType,
  getGlobalClassGetterDecoratorContextType,
  getGlobalClassMethodDecoratorContextType,
  getGlobalClassSetterDecoratorContextType,
  getGlobalTypedPropertyDescriptorType,
} from './checker-globals.js';
import { getDeclarations, getSymbolId, type Symbol, SymbolFlags } from './symbol.js';

// ---- Checks

/** Resolves the decorators of `node` as calls and checks their return types. */
export function checkDecorators(c: Checker, node: Node): void {
  // Decorators on invalid targets were reported by the grammar checks.
  if (!canHaveDecorators(node) || !hasDecorators(node)) return;
  if (!nodeCanBeDecorated(c.legacyDecorators, node, node.parent, node.parent!.parent)) return;
  checkDecoratorEmitHelpers(c, node);
  checkDecoratorMetadataImports(c, node);
  for (const modifier of getModifiers(node)!.nodes)
    if (modifier.kind === SyntaxKind.Decorator) checkDecorator(c, modifier as Decorator);
}

function firstDecorator(node: Node): Node | undefined {
  for (const modifier of getModifiers(node)!.nodes) if (modifier.kind === SyntaxKind.Decorator) return modifier;
  return undefined;
}

/** The emit helpers the decorators of `node` use (checkExternalEmitHelpers). */
function checkDecoratorEmitHelpers(c: Checker, node: Node): void {
  const decorator = firstDecorator(node);
  if (decorator === undefined) return;
  if (c.legacyDecorators) {
    checkExternalEmitHelpers(c, decorator, ExternalEmitHelpers.Decorate);
    if (node.kind === SyntaxKind.Parameter) checkExternalEmitHelpers(c, decorator, ExternalEmitHelpers.Param);
  } else if (c.languageVersion < ScriptTarget.ESNext) {
    checkExternalEmitHelpers(c, decorator, ExternalEmitHelpers.ESDecorateAndRunInitializers);
    if (node.kind === SyntaxKind.ClassDeclaration) {
      if (getName(node) === undefined || getFirstTransformableStaticClassElement(c, node) !== undefined)
        checkExternalEmitHelpers(c, decorator, ExternalEmitHelpers.SetFunctionName);
    } else if (node.kind !== SyntaxKind.ClassExpression) {
      const name = getName(node)!;
      if (
        name.kind === SyntaxKind.PrivateIdentifier &&
        (node.kind === SyntaxKind.MethodDeclaration ||
          node.kind === SyntaxKind.GetAccessor ||
          node.kind === SyntaxKind.SetAccessor ||
          isAutoAccessorPropertyDeclaration(node))
      )
        checkExternalEmitHelpers(c, decorator, ExternalEmitHelpers.SetFunctionName);
      if (name.kind === SyntaxKind.ComputedPropertyName)
        checkExternalEmitHelpers(c, decorator, ExternalEmitHelpers.PropKey);
    }
  }
}

/**
 * The first element of a class whose emit moves its static elements out of the class body: a decorated
 * element of a class that ECMAScript decorators transform, or a static block, static private element or
 * (without standard class fields) initialized static property when they are transformed.
 */
export function getFirstTransformableStaticClassElement(c: Checker, node: Node): Node | undefined {
  const willTransformStaticElementsOfDecoratedClass =
    !c.legacyDecorators &&
    c.languageVersion < ScriptTarget.ESNext &&
    classOrConstructorParameterIsDecorated(false, node);
  const willTransformPrivateElementsOrClassStaticBlocks = c.languageVersion < ScriptTarget.ESNext;
  const willTransformInitializers = !(
    getUseDefineForClassFields(c.compilerOptions) && c.languageVersion >= ScriptTarget.ES2022
  );
  if (!willTransformStaticElementsOfDecoratedClass && !willTransformPrivateElementsOrClassStaticBlocks)
    return undefined;
  for (const member of getMembers(node)!.nodes) {
    if (
      willTransformStaticElementsOfDecoratedClass &&
      classElementOrClassElementParameterIsDecorated(false, member, node)
    )
      return firstDecorator(node) ?? node;
    if (willTransformPrivateElementsOrClassStaticBlocks) {
      if (member.kind === SyntaxKind.ClassStaticBlockDeclaration) return member;
      if (
        isStatic(member) &&
        (isPrivateIdentifierClassElementDeclaration(member) ||
          (willTransformInitializers &&
            member.kind === SyntaxKind.PropertyDeclaration &&
            getInitializer(member) !== undefined))
      )
        return member;
    }
  }
  return undefined;
}

/**
 * Under emitDecoratorMetadata, the emitted metadata of a decorated declaration references the types of its
 * signature at run time. With isolatedModules and an ES module emit, a type imported without `import type`
 * can't be told apart from a value import in one file, so it is an error (TS1272).
 */
function checkDecoratorMetadataImports(c: Checker, node: Node): void {
  const options = c.compilerOptions;
  if (options.emitDecoratorMetadata !== true || options.verbatimModuleSyntax === true) return;
  if ((node.flags & NodeFlags.Ambient) !== 0 && node.kind !== SyntaxKind.PropertyDeclaration) return;
  checkExternalEmitHelpers(c, firstDecorator(node)!, ExternalEmitHelpers.Metadata);
  if (!c.isolatedModules || getEmitModuleKind(options) < ModuleKind.ES2015) return;
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration: {
      const constructor = getFirstConstructorWithBody(node);
      if (constructor !== undefined)
        for (const p of getParameters(constructor)!.nodes) checkMetadataTypeImport(c, parameterTypeNode(p));
      break;
    }
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor: {
      const otherKind = node.kind === SyntaxKind.GetAccessor ? SyntaxKind.SetAccessor : SyntaxKind.GetAccessor;
      const otherAccessor = getDeclarationOfKind(getSymbolOfDeclaration(c, node)!, otherKind);
      checkMetadataTypeImport(c, getAnnotatedAccessorTypeNode(node) ?? getAnnotatedAccessorTypeNode(otherAccessor));
      break;
    }
    case SyntaxKind.MethodDeclaration:
      for (const p of getParameters(node)!.nodes) checkMetadataTypeImport(c, parameterTypeNode(p));
      checkMetadataTypeImport(c, getType(node));
      break;
    case SyntaxKind.PropertyDeclaration:
      checkMetadataTypeImport(c, getType(node));
      break;
    case SyntaxKind.Parameter: {
      checkMetadataTypeImport(c, parameterTypeNode(node));
      const signature = node.parent!;
      for (const p of getParameters(signature)!.nodes) checkMetadataTypeImport(c, parameterTypeNode(p));
      checkMetadataTypeImport(c, getType(signature));
      break;
    }
  }
}

/** The type a parameter's metadata serializes: the element type of a rest parameter. */
function parameterTypeNode(node: Node): Node | undefined {
  const typeNode = getType(node);
  return getDotDotDotToken(node) !== undefined ? getRestParameterElementType(typeNode) : typeNode;
}

function checkMetadataTypeImport(c: Checker, typeNode: Node | undefined): void {
  const typeName = entityNameForDecoratorMetadata(c, typeNode);
  if (typeName === undefined || (typeName.kind !== SyntaxKind.Identifier && typeName.kind !== SyntaxKind.QualifiedName))
    return;
  const rootName = getFirstIdentifier(typeName);
  const meaning =
    (typeName.kind === SyntaxKind.Identifier ? SymbolFlags.Type : SymbolFlags.Namespace) | SymbolFlags.Alias;
  const rootSymbol = resolveName(c, rootName, getText(rootName), meaning, undefined, true, false);
  if (rootSymbol === undefined || (rootSymbol.flags & SymbolFlags.Alias) === 0 || symbolIsValue(c, rootSymbol)) return;
  if (getDeclarations(rootSymbol).some(isTypeOnlyImportOrExportDeclaration)) return;
  const diagnostic = c.error(
    typeName,
    Diagnostics.A_type_referenced_in_a_decorated_signature_must_be_imported_with_import_type_or_a_namespace_import_when_isolatedModules_and_emitDecoratorMetadata_are_enabled,
  );
  const aliasDeclaration = getDeclarations(rootSymbol).find(isAliasSymbolDeclaration);
  if (aliasDeclaration !== undefined)
    diagnostic.addRelatedInfo(
      createDiagnosticForNode(aliasDeclaration, Diagnostics.X_0_was_imported_here, [getText(rootName)]),
    );
}

/** The entity name the metadata of a type node references, as the metadata serializer chooses it. */
function entityNameForDecoratorMetadata(c: Checker, node: Node | undefined): Node | undefined {
  if (node === undefined) return undefined;
  switch (node.kind) {
    case SyntaxKind.IntersectionType:
      return entityNameForDecoratorMetadataFromTypes(c, (node as IntersectionTypeNode).types.nodes);
    case SyntaxKind.UnionType:
      return entityNameForDecoratorMetadataFromTypes(c, (node as UnionTypeNode).types.nodes);
    case SyntaxKind.ConditionalType:
      return entityNameForDecoratorMetadataFromTypes(c, [
        (node as ConditionalTypeNode).trueType,
        (node as ConditionalTypeNode).falseType,
      ]);
    case SyntaxKind.ParenthesizedType:
    case SyntaxKind.NamedTupleMember:
      return entityNameForDecoratorMetadata(c, getType(node));
    case SyntaxKind.TypeReference:
      return (node as TypeReferenceNode).typeName;
  }
  return undefined;
}

/** The one identifier all of `types` reference, skipping `never` (and `null` and `undefined` without strictNullChecks). */
function entityNameForDecoratorMetadataFromTypes(c: Checker, types: readonly Node[]): Node | undefined {
  let common: Node | undefined;
  for (const typeNode of types) {
    if (typeNode.kind === SyntaxKind.NeverKeyword) continue;
    if (
      !c.strictNullChecks &&
      ((typeNode.kind === SyntaxKind.LiteralType &&
        (typeNode as LiteralTypeNode).literal.kind === SyntaxKind.NullKeyword) ||
        typeNode.kind === SyntaxKind.UndefinedKeyword)
    )
      continue;
    const name = entityNameForDecoratorMetadata(c, typeNode);
    if (name === undefined) return undefined;
    if (common === undefined) common = name;
    else if (
      common.kind !== SyntaxKind.Identifier ||
      name.kind !== SyntaxKind.Identifier ||
      getText(common) !== getText(name)
    )
      return undefined;
  }
  return common;
}

function checkDecorator(c: Checker, node: Decorator): void {
  const signature = getResolvedSignature(c, node, CheckMode.Normal);
  checkDeprecatedSignature(c, signature, node);
  const returnType = getReturnTypeOfSignature(c, signature);
  if ((returnType.flags & TypeFlags.Any) !== 0) return;
  // Without a signature, the grammar checks reported an error.
  const decoratorSignature = getDecoratorCallSignature(c, node);
  if (decoratorSignature === undefined) return;
  const expectedReturnType = resolvedReturnTypeOf(c, decoratorSignature);
  if (expectedReturnType === undefined) return;
  const parent = node.parent!;
  const headMessage =
    parent.kind === SyntaxKind.Parameter || (parent.kind === SyntaxKind.PropertyDeclaration && c.legacyDecorators)
      ? Diagnostics.Decorator_function_return_type_is_0_but_is_expected_to_be_void_or_any
      : Diagnostics.Decorator_function_return_type_0_is_not_assignable_to_type_1;
  checkTypeAssignableTo(c, returnType, expectedReturnType, node.expression, headMessage);
}

export function hasDecorators(node: Node): boolean {
  const modifiers = getModifiers(node);
  if (modifiers === undefined) return false;
  for (const modifier of modifiers.nodes) if (modifier.kind === SyntaxKind.Decorator) return true;
  return false;
}

/** Whether `node` is a valid decorator target. */
export function nodeCanBeDecorated(
  legacy: boolean,
  node: Node,
  parent: Node | undefined,
  grandparent: Node | undefined,
): boolean {
  const name = getName(node);
  // Legacy decorators don't support private names.
  if (legacy && name !== undefined && name.kind === SyntaxKind.PrivateIdentifier) return false;
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
      return true;
    case SyntaxKind.ClassExpression:
      return !legacy;
    case SyntaxKind.PropertyDeclaration:
      return (
        parent !== undefined &&
        (legacy
          ? parent.kind === SyntaxKind.ClassDeclaration
          : isClassLike(parent) && !hasSyntacticModifier(node, ModifierFlags.Abstract | ModifierFlags.Ambient))
      );
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodDeclaration:
      return (
        parent !== undefined &&
        getBody(node) !== undefined &&
        (legacy ? parent.kind === SyntaxKind.ClassDeclaration : isClassLike(parent))
      );
    case SyntaxKind.Parameter:
      if (!legacy || parent === undefined || getBody(parent) === undefined) return false;
      return (
        (parent.kind === SyntaxKind.Constructor ||
          parent.kind === SyntaxKind.MethodDeclaration ||
          parent.kind === SyntaxKind.SetAccessor) &&
        getThisParameter(parent) !== node &&
        grandparent !== undefined &&
        grandparent.kind === SyntaxKind.ClassDeclaration
      );
  }
  return false;
}

// ---- Resolution

/** Whether every signature takes fewer parameters than the decorator receives, as `@f` for `@f()`. */
export function isPotentiallyUncalledDecorator(c: Checker, decorator: Node, signatures: Signature[]): boolean {
  if (signatures.length === 0) return false;
  for (const sig of signatures)
    if (
      sig.minArgumentCount !== 0 ||
      sig.hasRestParameter() ||
      sig.parameters.length >= getDecoratorArgumentCount(c, decorator, sig)
    )
      return false;
  return true;
}

export function getUncalledDecoratorText(node: Decorator): string {
  return getSourceTextOfNode(getSourceFileOfNode(node), node.expression);
}

/** The head message of errors resolving a decorator as a call. */
export function getDiagnosticHeadMessageForDecoratorResolution(node: Node): DiagnosticMessage {
  switch (node.parent!.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return Diagnostics.Unable_to_resolve_signature_of_class_decorator_when_called_as_an_expression;
    case SyntaxKind.Parameter:
      return Diagnostics.Unable_to_resolve_signature_of_parameter_decorator_when_called_as_an_expression;
    case SyntaxKind.PropertyDeclaration:
      return Diagnostics.Unable_to_resolve_signature_of_property_decorator_when_called_as_an_expression;
  }
  return Diagnostics.Unable_to_resolve_signature_of_method_decorator_when_called_as_an_expression;
}

/** The number of arguments the runtime passes to a decorator. */
export function getDecoratorArgumentCount(c: Checker, node: Node, signature: Signature): number {
  if (!c.legacyDecorators) return Math.min(Math.max(getParameterCount(c, signature), 1), 2);
  switch (node.parent!.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      return 1;
    case SyntaxKind.PropertyDeclaration:
      return hasSyntacticModifier(node.parent!, ModifierFlags.Accessor) ? 3 : 2;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      // Decorators with only two parameters get only two arguments.
      return getParameterCount(c, signature) <= 2 ? 2 : 3;
  }
  return 3;
}

/** The parameter types of a decorator's call, one synthetic argument each. */
export function getEffectiveDecoratorArgumentTypes(c: Checker, node: Node): Type[] {
  const signature = getDecoratorCallSignature(c, node);
  if (signature === undefined) throw new Error('decorator signature not found');
  const types: Type[] = [];
  for (const param of signature.parameters) types.push(getTypeOfSymbol(c, param));
  return types;
}

// ---- Decorator call signatures

/** The signature the runtime calls a decorator with, or undefined for an invalid target. */
export function getDecoratorCallSignature(c: Checker, decorator: Node): Signature | undefined {
  const node = decorator.parent!;
  const links = c.nodeLinks(node);
  if (links.decoratorSignature === undefined) {
    links.decoratorSignature = c.anySignature;
    const signature = c.legacyDecorators
      ? getLegacyDecoratorCallSignature(c, node)
      : getESDecoratorCallSignature(c, node);
    if (signature !== undefined) links.decoratorSignature = signature;
  }
  return links.decoratorSignature === c.anySignature ? undefined : links.decoratorSignature;
}

function getLegacyDecoratorCallSignature(c: Checker, node: Node): Signature | undefined {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression: {
      // The target of a class decorator is the constructor side of the class.
      const targetType = getTypeOfSymbol(c, getSymbolOfDeclaration(c, node)!);
      const targetParam = newParameter(c, 'target', targetType);
      return newCallSignature(c, [targetParam], getUnionType(c, [targetType, c.voidType]));
    }
    case SyntaxKind.Parameter: {
      const fn = node.parent!;
      if (
        fn.kind !== SyntaxKind.Constructor &&
        !(fn.kind === SyntaxKind.MethodDeclaration || (fn.kind === SyntaxKind.SetAccessor && isClassLike(fn.parent!)))
      )
        return undefined;
      const thisParameter = getThisParameter(fn);
      if (thisParameter === node) return undefined;
      const index = getParameters(fn)!.nodes.indexOf(node) - (thisParameter !== undefined ? 1 : 0);
      // A parameter decorator gets the target, the property key and the parameter index.
      let targetType: Type;
      let keyType: Type;
      if (fn.kind === SyntaxKind.Constructor) {
        targetType = getTypeOfSymbol(c, getSymbolOfDeclaration(c, fn.parent!)!);
        keyType = c.undefinedType;
      } else {
        targetType = getParentTypeOfClassElement(c, fn);
        keyType = getClassElementPropertyKeyType(c, fn);
      }
      const indexType = getNumberLiteralType(c, index);
      return newCallSignature(
        c,
        [
          newParameter(c, 'target', targetType),
          newParameter(c, 'propertyKey', keyType),
          newParameter(c, 'parameterIndex', indexType),
        ],
        c.voidType,
      );
    }
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.PropertyDeclaration: {
      if (!isClassLike(node.parent!)) return undefined;
      // Method and accessor decorators get two or three arguments, property decorators two.
      const targetParam = newParameter(c, 'target', getParentTypeOfClassElement(c, node));
      const keyParam = newParameter(c, 'propertyKey', getClassElementPropertyKeyType(c, node));
      const isProperty = node.kind === SyntaxKind.PropertyDeclaration;
      const returnType = isProperty ? c.voidType : newTypedPropertyDescriptorType(c, getTypeOfDeclaration(c, node));
      if (!isProperty || hasSyntacticModifier(node, ModifierFlags.Accessor)) {
        const descriptorType = newTypedPropertyDescriptorType(c, getTypeOfDeclaration(c, node));
        const descriptorParam = newParameter(c, 'descriptor', descriptorType);
        return newCallSignature(c, [targetParam, keyParam, descriptorParam], getUnionType(c, [returnType, c.voidType]));
      }
      return newCallSignature(c, [targetParam, keyParam], getUnionType(c, [returnType, c.voidType]));
    }
  }
  return undefined;
}

// An ES decorator gets a `target` value (the constructor, method, getter or setter, an
// `{ get, set }` object for auto-accessors and `undefined` for fields) and a `context` with
// details of the decorated element. It may return a replacement for the target.
function getESDecoratorCallSignature(c: Checker, node: Node): Signature | undefined {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression: {
      const targetType = getTypeOfSymbol(c, getSymbolOfDeclaration(c, node)!);
      const contextType = tryCreateTypeReference(c, getGlobalClassDecoratorContextType(c), [targetType]);
      return newESDecoratorCallSignature(c, targetType, contextType, targetType);
    }
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor: {
      if (!isClassLike(node.parent!)) return undefined;
      const valueType =
        node.kind === SyntaxKind.MethodDeclaration
          ? getOrCreateTypeFromSignature(c, getSignatureFromDeclaration(c, node))
          : getTypeOfDeclaration(c, node);
      const thisType = getThisTypeOfClassElement(c, node);
      // Getters are decorated as `() => value` and setters as `(value) => void`.
      const targetType =
        node.kind === SyntaxKind.GetAccessor
          ? newFunctionType(c, [], valueType)
          : node.kind === SyntaxKind.SetAccessor
            ? newFunctionType(c, [newParameter(c, 'value', valueType)], c.voidType)
            : valueType;
      const contextType = newClassMemberDecoratorContextTypeForNode(c, node, thisType, valueType);
      return newESDecoratorCallSignature(c, targetType, contextType, targetType);
    }
    case SyntaxKind.PropertyDeclaration: {
      if (!isClassLike(node.parent!)) return undefined;
      const valueType = getTypeOfDeclaration(c, node);
      const thisType = getThisTypeOfClassElement(c, node);
      const isAutoAccessor = hasSyntacticModifier(node, ModifierFlags.Accessor);
      // Fields are installed when initialized, so their target is `undefined`.
      const targetType = isAutoAccessor
        ? tryCreateTypeReference(c, getGlobalClassAccessorDecoratorTargetType(c), [thisType, valueType])
        : c.undefinedType;
      // Fields return an initializer mutator; auto-accessors may also replace the getter and setter.
      const returnType = isAutoAccessor
        ? tryCreateTypeReference(c, getGlobalClassAccessorDecoratorResultType(c), [thisType, valueType])
        : newFunctionTypeWithThis(
            c,
            newParameter(c, 'this', thisType),
            [newParameter(c, 'value', valueType)],
            valueType,
          );
      const contextType = newClassMemberDecoratorContextTypeForNode(c, node, thisType, valueType);
      return newESDecoratorCallSignature(c, targetType, contextType, returnType);
    }
  }
  return undefined;
}

function getThisTypeOfClassElement(c: Checker, node: Node): Type {
  const classSymbol = getSymbolOfDeclaration(c, node.parent!)!;
  return hasStaticModifier(node) ? getTypeOfSymbol(c, classSymbol) : getDeclaredTypeOfClassOrInterface(c, classSymbol);
}

function newClassMemberDecoratorContextTypeForNode(c: Checker, node: Node, thisType: Type, valueType: Type): Type {
  const isStaticMember = hasStaticModifier(node);
  const name = getName(node)!;
  const isPrivate = name.kind === SyntaxKind.PrivateIdentifier;
  const nameType = isPrivate
    ? getStringLiteralType(c, getText(name))
    : (getLiteralTypeFromPropertyName(c, name) ?? c.neverType);
  let globalType: Type;
  switch (node.kind) {
    case SyntaxKind.MethodDeclaration:
      globalType = getGlobalClassMethodDecoratorContextType(c);
      break;
    case SyntaxKind.GetAccessor:
      globalType = getGlobalClassGetterDecoratorContextType(c);
      break;
    case SyntaxKind.SetAccessor:
      globalType = getGlobalClassSetterDecoratorContextType(c);
      break;
    default:
      globalType = hasSyntacticModifier(node, ModifierFlags.Accessor)
        ? getGlobalClassAccessorDecoratorContextType(c)
        : getGlobalClassFieldDecoratorContextType(c);
  }
  const contextType = tryCreateTypeReference(c, globalType, [thisType, valueType]);
  const overrideType = getClassMemberDecoratorContextOverrideType(c, nameType, isPrivate, isStaticMember);
  return getIntersectionType(c, [contextType, overrideType]);
}

/** A type like `{ name: "foo", private: false, static: true }` intersected with a member's context type. */
function getClassMemberDecoratorContextOverrideType(
  c: Checker,
  nameType: Type,
  isPrivate: boolean,
  isStaticMember: boolean,
): Type {
  const key = 'decoratorContext:' + (isPrivate ? 'p' : '') + (isStaticMember ? 's' : '') + ':' + nameType.id;
  const cached = c.cachedTypes.get(key);
  if (cached !== undefined) return cached;
  const members = new Map<string, Symbol>();
  members.set('name', newProperty(c, 'name', nameType));
  members.set('private', newProperty(c, 'private', isPrivate ? c.trueType : c.falseType));
  members.set('static', newProperty(c, 'static', isStaticMember ? c.trueType : c.falseType));
  const overrideType = createAnonymousType(c, undefined, members, [], [], []);
  c.cachedTypes.set(key, overrideType);
  return overrideType;
}

function newESDecoratorCallSignature(
  c: Checker,
  targetType: Type,
  contextType: Type,
  nonOptionalReturnType: Type,
): Signature {
  const targetParam = newParameter(c, 'target', targetType);
  const contextParam = newParameter(c, 'context', contextType);
  return newCallSignature(c, [targetParam, contextParam], getUnionType(c, [nonOptionalReturnType, c.voidType]));
}

function getParentTypeOfClassElement(c: Checker, node: Node): Type {
  const classSymbol = getSymbolOfDeclaration(c, node.parent!)!;
  return isStatic(node) ? getTypeOfSymbol(c, classSymbol) : getDeclaredTypeOfSymbol(c, classSymbol);
}

function getClassElementPropertyKeyType(c: Checker, element: Node): Type {
  const name = getName(element)!;
  switch (name.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.StringLiteral:
      return getStringLiteralType(c, getText(name));
    case SyntaxKind.ComputedPropertyName: {
      const nameType = checkComputedPropertyName(c, name);
      return isTypeAssignableToKind(c, nameType, TypeFlags.ESSymbolLike) ? nameType : c.stringType;
    }
  }
  return c.errorType;
}

function getTypeOfDeclaration(c: Checker, node: Node): Type {
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol !== undefined ? getTypeOfSymbol(c, symbol) : c.errorType;
}

function newTypedPropertyDescriptorType(c: Checker, propertyType: Type): Type {
  return createTypeFromGenericGlobalType(c, getGlobalTypedPropertyDescriptorType(c), [propertyType]);
}

// ---- Synthetic symbols and signatures

function newParameter(c: Checker, name: string, t: Type): Symbol {
  const symbol = c.newSymbol(SymbolFlags.FunctionScopedVariable, name);
  c.symbolTypes.set(getSymbolId(symbol), t);
  return symbol;
}

function newProperty(c: Checker, name: string, t: Type): Symbol {
  const symbol = c.newSymbol(SymbolFlags.Property, name);
  c.symbolTypes.set(getSymbolId(symbol), t);
  return symbol;
}

/** A call signature declared by a synthetic `(...) => any` type, so that it prints as a function type. */
function newCallSignature(c: Checker, parameters: Symbol[], returnType: Type): Signature {
  return newCallSignatureWithThis(c, undefined, parameters, returnType);
}

function newCallSignatureWithThis(
  c: Checker,
  thisParameter: Symbol | undefined,
  parameters: Symbol[],
  returnType: Type,
): Signature {
  const declaration = new FunctionTypeNode(
    undefined,
    new NodeList(0, 0, []),
    new KeywordTypeNode(SyntaxKind.AnyKeyword),
  );
  return c.newSignature(SignatureFlags.None, declaration, [], thisParameter, parameters, returnType, parameters.length);
}

function newFunctionType(c: Checker, parameters: Symbol[], returnType: Type): Type {
  return getOrCreateTypeFromSignature(c, newCallSignature(c, parameters, returnType));
}

function newFunctionTypeWithThis(c: Checker, thisParameter: Symbol, parameters: Symbol[], returnType: Type): Type {
  return getOrCreateTypeFromSignature(c, newCallSignatureWithThis(c, thisParameter, parameters, returnType));
}

// ---- Utilities

function getThisParameter(signature: Node): Node | undefined {
  const parameters = getParameters(signature);
  if (parameters === undefined || parameters.nodes.length === 0) return undefined;
  const first = parameters.nodes[0]!;
  const name = getName(first);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this' ? first : undefined;
}
