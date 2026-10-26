// Declaration emit errors: names that can't be written in a declaration file, and types that
// `isolatedDeclarations` can't write without inference.
import {
  CallExpression,
  HeritageClause,
  type Node,
  ParameterDeclaration,
  SetAccessorDeclaration,
  getInitializer,
  getName,
  getParameters,
  getSymbol,
  getType,
} from '../ast.js';
import {
  declarationNameToString,
  getErrorRangeForNode,
  getNameOfDeclaration,
  getSourceFileOfNode,
  getSourceTextOfNode,
  hasSyntacticModifier,
  isEntityNameExpression,
  isStatic,
} from '../binder-utilities.js';
import { isFunctionLikeDeclarationKind } from '../ast-utilities.js';
import { Diagnostic, type DiagnosticMessage, Diagnostics } from '../diagnostics.js';
import { ModifierFlags } from '../ast.js';
import { isStatement } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isPartOfTypeNode } from './alias-references.js';
import { isParameterPropertyDeclaration } from './utilities.js';
import { SymbolAccessibility, type SymbolAccessibilityResult } from './declarations-resolver.js';
import { getDeclarations } from '../symbol.js';

export function createDiagnosticForNode(node: Node, message: DiagnosticMessage, args: readonly string[]): Diagnostic {
  const file = getSourceFileOfNode(node);
  const range = getErrorRangeForNode(file, node);
  return new Diagnostic(file.diagnosticFile(), range.pos, range.end, message, args);
}

/** The text of a node for messages. */
export function textOfNode(node: Node): string {
  return getSourceTextOfNode(getSourceFileOfNode(node), node);
}

export function nameToString(name: Node | undefined): string {
  return name === undefined ? '(Missing)' : declarationNameToString(getSourceFileOfNode(name), name);
}

export const enum DiagnosticContextKind {
  /** No declaration is being written; reporting is a bug. */
  None,
  /** The type of a declaration. */
  Declaration,
  /** The computed name of a declaration. */
  DeclarationName,
  /** The expression of `export default`. */
  DefaultExport,
  /** A class's `extends` expression, written as a separate `_base` variable. */
  ExtendsExpression,
}

/** Which message an inaccessible name in the declaration being written reports. */
export class DiagnosticContext {
  readonly kind: DiagnosticContextKind;
  readonly node: Node | undefined;
  /** The class name for `ExtendsExpression`. */
  readonly typeName: Node | undefined;

  constructor(kind: DiagnosticContextKind, node: Node | undefined, typeName: Node | undefined) {
    this.kind = kind;
    this.node = node;
    this.typeName = typeName;
  }
}

export const noDiagnosticContext = new DiagnosticContext(DiagnosticContextKind.None, undefined, undefined);

export function declarationContext(node: Node): DiagnosticContext {
  return new DiagnosticContext(DiagnosticContextKind.Declaration, node, undefined);
}

export function declarationNameContext(node: Node): DiagnosticContext {
  return new DiagnosticContext(DiagnosticContextKind.DeclarationName, node, undefined);
}

export class SymbolAccessibilityDiagnostic {
  readonly errorNode: Node;
  readonly message: DiagnosticMessage;
  /** The declaration name passed as the first message argument, if any. */
  readonly typeName: Node | undefined;

  constructor(errorNode: Node, message: DiagnosticMessage, typeName: Node | undefined) {
    this.errorNode = errorNode;
    this.message = message;
    this.typeName = typeName;
  }
}

/** Whether a declaration of this kind can report inaccessible names in its type. */
export function canProduceDiagnostics(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.BindingElement:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.TypeParameter:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.CallExpression:
      return true;
  }
  return false;
}

/** The diagnostic for an inaccessible name, or undefined if this kind of context reports none. */
export function getSymbolAccessibilityDiagnostic(
  context: DiagnosticContext,
  result: SymbolAccessibilityResult,
): SymbolAccessibilityDiagnostic | undefined {
  const node = context.node;
  switch (context.kind) {
    case DiagnosticContextKind.None:
      throw new Error('Diagnostic emitted without context');
    case DiagnosticContextKind.DefaultExport:
      return new SymbolAccessibilityDiagnostic(
        node!,
        Diagnostics.Default_export_of_the_module_has_or_is_using_private_name_0,
        undefined,
      );
    case DiagnosticContextKind.ExtendsExpression:
      return new SymbolAccessibilityDiagnostic(
        node!,
        Diagnostics.X_extends_clause_of_exported_class_0_has_or_is_using_private_name_1,
        context.typeName,
      );
    case DiagnosticContextKind.DeclarationName:
      if (node!.kind === SyntaxKind.GetAccessor || node!.kind === SyntaxKind.SetAccessor)
        return simple(node!, accessorNameMessage(node!, result));
      if (node!.kind === SyntaxKind.MethodDeclaration || node!.kind === SyntaxKind.MethodSignature)
        return simple(node!, methodNameMessage(node!, result));
      return forDeclaration(node!, result);
    case DiagnosticContextKind.Declaration:
      return forDeclaration(node!, result);
  }
}

function simple(node: Node, message: DiagnosticMessage | undefined): SymbolAccessibilityDiagnostic | undefined {
  return message === undefined
    ? undefined
    : new SymbolAccessibilityDiagnostic(node, message, getNameOfDeclaration(node));
}

function forDeclaration(node: Node, result: SymbolAccessibilityResult): SymbolAccessibilityDiagnostic | undefined {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.BindingElement:
    case SyntaxKind.Constructor:
      return simple(node, variableTypeMessage(node, result));
    case SyntaxKind.SetAccessor:
    case SyntaxKind.GetAccessor: {
      const name = getNameOfDeclaration(node);
      const message = accessorTypeMessage(node, result);
      return name === undefined ? undefined : new SymbolAccessibilityDiagnostic(name, message, name);
    }
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.IndexSignature: {
      const name = getNameOfDeclaration(node);
      return new SymbolAccessibilityDiagnostic(name ?? node, returnTypeMessage(node, result), undefined);
    }
    case SyntaxKind.Parameter:
      if (
        isParameterPropertyDeclaration(node, node.parent) &&
        hasSyntacticModifier(node.parent!, ModifierFlags.Private)
      )
        return simple(node, variableTypeMessage(node, result));
      return simple(node, parameterTypeMessage(node, result));
    case SyntaxKind.TypeParameter:
      return simple(node, typeParameterConstraintMessage(node));
    case SyntaxKind.ExpressionWithTypeArguments:
      return heritageDiagnostic(node);
    case SyntaxKind.ImportEqualsDeclaration:
      return simple(node, Diagnostics.Import_declaration_0_is_using_private_name_1);
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration: {
      const message =
        result.errorModuleName !== ''
          ? Diagnostics.Exported_type_alias_0_has_or_is_using_private_name_1_from_module_2
          : Diagnostics.Exported_type_alias_0_has_or_is_using_private_name_1;
      const type = getType(node);
      return new SymbolAccessibilityDiagnostic(type ?? node, message, getName(node));
    }
    case SyntaxKind.CallExpression: {
      // `Object.defineProperty(exports, "name", …)` in JavaScript.
      const name = node instanceof CallExpression ? node.arguments.nodes[1]! : node;
      return new SymbolAccessibilityDiagnostic(
        name,
        byModuleName(
          result,
          Diagnostics.Exported_variable_0_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
          Diagnostics.Exported_variable_0_has_or_is_using_name_1_from_private_module_2,
          Diagnostics.Exported_variable_0_has_or_is_using_private_name_1,
        ),
        name,
      );
    }
  }
  throw new Error('Attempted to set a declaration diagnostic context for unhandled node kind');
}

function heritageDiagnostic(node: Node): SymbolAccessibilityDiagnostic {
  const clause = node.parent!;
  const declaration = clause.parent!;
  let message: DiagnosticMessage;
  if (declaration.kind === SyntaxKind.ClassDeclaration) {
    if (clause instanceof HeritageClause && clause.token === SyntaxKind.ImplementsKeyword)
      message = Diagnostics.Implements_clause_of_exported_class_0_has_or_is_using_private_name_1;
    else if (getName(declaration) !== undefined)
      message = Diagnostics.X_extends_clause_of_exported_class_0_has_or_is_using_private_name_1;
    else message = Diagnostics.X_extends_clause_of_exported_class_has_or_is_using_private_name_0;
  } else message = Diagnostics.X_extends_clause_of_exported_interface_0_has_or_is_using_private_name_1;
  return new SymbolAccessibilityDiagnostic(node, message, getNameOfDeclaration(declaration));
}

function byModuleName(
  result: SymbolAccessibilityResult,
  cannotBeNamed: DiagnosticMessage,
  privateModule: DiagnosticMessage,
  nonModule: DiagnosticMessage,
): DiagnosticMessage {
  if (result.errorModuleName === '') return nonModule;
  return result.accessibility === SymbolAccessibility.CannotBeNamed ? cannotBeNamed : privateModule;
}

function byModuleNameOnly(
  result: SymbolAccessibilityResult,
  privateModule: DiagnosticMessage,
  nonModule: DiagnosticMessage,
): DiagnosticMessage {
  return result.errorModuleName !== '' ? privateModule : nonModule;
}

function accessorNameMessage(node: Node, result: SymbolAccessibilityResult): DiagnosticMessage {
  if (isStatic(node))
    return byModuleName(
      result,
      Diagnostics.Public_static_property_0_of_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
      Diagnostics.Public_static_property_0_of_exported_class_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Public_static_property_0_of_exported_class_has_or_is_using_private_name_1,
    );
  if (node.parent!.kind === SyntaxKind.ClassDeclaration)
    return byModuleName(
      result,
      Diagnostics.Public_property_0_of_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
      Diagnostics.Public_property_0_of_exported_class_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Public_property_0_of_exported_class_has_or_is_using_private_name_1,
    );
  return byModuleNameOnly(
    result,
    Diagnostics.Property_0_of_exported_interface_has_or_is_using_name_1_from_private_module_2,
    Diagnostics.Property_0_of_exported_interface_has_or_is_using_private_name_1,
  );
}

function methodNameMessage(node: Node, result: SymbolAccessibilityResult): DiagnosticMessage {
  if (isStatic(node))
    return byModuleName(
      result,
      Diagnostics.Public_static_method_0_of_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
      Diagnostics.Public_static_method_0_of_exported_class_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Public_static_method_0_of_exported_class_has_or_is_using_private_name_1,
    );
  if (node.parent!.kind === SyntaxKind.ClassDeclaration)
    return byModuleName(
      result,
      Diagnostics.Public_method_0_of_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
      Diagnostics.Public_method_0_of_exported_class_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Public_method_0_of_exported_class_has_or_is_using_private_name_1,
    );
  return byModuleNameOnly(
    result,
    Diagnostics.Method_0_of_exported_interface_has_or_is_using_name_1_from_private_module_2,
    Diagnostics.Method_0_of_exported_interface_has_or_is_using_private_name_1,
  );
}

function variableTypeMessage(node: Node, result: SymbolAccessibilityResult): DiagnosticMessage | undefined {
  if (node.kind === SyntaxKind.VariableDeclaration || node.kind === SyntaxKind.BindingElement)
    return byModuleName(
      result,
      Diagnostics.Exported_variable_0_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
      Diagnostics.Exported_variable_0_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Exported_variable_0_has_or_is_using_private_name_1,
    );
  // Constructor parameter properties report as parameters, unless the constructor is private.
  if (
    node.kind === SyntaxKind.PropertyDeclaration ||
    node.kind === SyntaxKind.PropertyAccessExpression ||
    node.kind === SyntaxKind.ElementAccessExpression ||
    node.kind === SyntaxKind.BinaryExpression ||
    node.kind === SyntaxKind.PropertySignature ||
    (node.kind === SyntaxKind.Parameter && hasSyntacticModifier(node.parent!, ModifierFlags.Private))
  ) {
    if (isStatic(node))
      return byModuleName(
        result,
        Diagnostics.Public_static_property_0_of_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
        Diagnostics.Public_static_property_0_of_exported_class_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Public_static_property_0_of_exported_class_has_or_is_using_private_name_1,
      );
    if (node.parent!.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.Parameter)
      return byModuleName(
        result,
        Diagnostics.Public_property_0_of_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
        Diagnostics.Public_property_0_of_exported_class_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Public_property_0_of_exported_class_has_or_is_using_private_name_1,
      );
    return byModuleNameOnly(
      result,
      Diagnostics.Property_0_of_exported_interface_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Property_0_of_exported_interface_has_or_is_using_private_name_1,
    );
  }
  return undefined;
}

function accessorTypeMessage(node: Node, result: SymbolAccessibilityResult): DiagnosticMessage {
  if (node.kind === SyntaxKind.SetAccessor) {
    // A setter's parameter type is written by the user, so it can always be named.
    if (isStatic(node))
      return byModuleNameOnly(
        result,
        Diagnostics.Parameter_type_of_public_static_setter_0_from_exported_class_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_type_of_public_static_setter_0_from_exported_class_has_or_is_using_private_name_1,
      );
    return byModuleNameOnly(
      result,
      Diagnostics.Parameter_type_of_public_setter_0_from_exported_class_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Parameter_type_of_public_setter_0_from_exported_class_has_or_is_using_private_name_1,
    );
  }
  if (isStatic(node))
    return byModuleName(
      result,
      Diagnostics.Return_type_of_public_static_getter_0_from_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
      Diagnostics.Return_type_of_public_static_getter_0_from_exported_class_has_or_is_using_name_1_from_private_module_2,
      Diagnostics.Return_type_of_public_static_getter_0_from_exported_class_has_or_is_using_private_name_1,
    );
  return byModuleName(
    result,
    Diagnostics.Return_type_of_public_getter_0_from_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
    Diagnostics.Return_type_of_public_getter_0_from_exported_class_has_or_is_using_name_1_from_private_module_2,
    Diagnostics.Return_type_of_public_getter_0_from_exported_class_has_or_is_using_private_name_1,
  );
}

function returnTypeMessage(node: Node, result: SymbolAccessibilityResult): DiagnosticMessage {
  switch (node.kind) {
    case SyntaxKind.ConstructSignature:
      return byModuleNameOnly(
        result,
        Diagnostics.Return_type_of_constructor_signature_from_exported_interface_has_or_is_using_name_0_from_private_module_1,
        Diagnostics.Return_type_of_constructor_signature_from_exported_interface_has_or_is_using_private_name_0,
      );
    case SyntaxKind.CallSignature:
      return byModuleNameOnly(
        result,
        Diagnostics.Return_type_of_call_signature_from_exported_interface_has_or_is_using_name_0_from_private_module_1,
        Diagnostics.Return_type_of_call_signature_from_exported_interface_has_or_is_using_private_name_0,
      );
    case SyntaxKind.IndexSignature:
      return byModuleNameOnly(
        result,
        Diagnostics.Return_type_of_index_signature_from_exported_interface_has_or_is_using_name_0_from_private_module_1,
        Diagnostics.Return_type_of_index_signature_from_exported_interface_has_or_is_using_private_name_0,
      );
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      if (isStatic(node))
        return byModuleName(
          result,
          Diagnostics.Return_type_of_public_static_method_from_exported_class_has_or_is_using_name_0_from_external_module_1_but_cannot_be_named,
          Diagnostics.Return_type_of_public_static_method_from_exported_class_has_or_is_using_name_0_from_private_module_1,
          Diagnostics.Return_type_of_public_static_method_from_exported_class_has_or_is_using_private_name_0,
        );
      if (node.parent!.kind === SyntaxKind.ClassDeclaration)
        return byModuleName(
          result,
          Diagnostics.Return_type_of_public_method_from_exported_class_has_or_is_using_name_0_from_external_module_1_but_cannot_be_named,
          Diagnostics.Return_type_of_public_method_from_exported_class_has_or_is_using_name_0_from_private_module_1,
          Diagnostics.Return_type_of_public_method_from_exported_class_has_or_is_using_private_name_0,
        );
      return byModuleNameOnly(
        result,
        Diagnostics.Return_type_of_method_from_exported_interface_has_or_is_using_name_0_from_private_module_1,
        Diagnostics.Return_type_of_method_from_exported_interface_has_or_is_using_private_name_0,
      );
    case SyntaxKind.FunctionDeclaration:
      return byModuleName(
        result,
        Diagnostics.Return_type_of_exported_function_has_or_is_using_name_0_from_external_module_1_but_cannot_be_named,
        Diagnostics.Return_type_of_exported_function_has_or_is_using_name_0_from_private_module_1,
        Diagnostics.Return_type_of_exported_function_has_or_is_using_private_name_0,
      );
  }
  throw new Error('This is unknown kind for signature');
}

function parameterTypeMessage(node: Node, result: SymbolAccessibilityResult): DiagnosticMessage {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.Constructor:
      return byModuleName(
        result,
        Diagnostics.Parameter_0_of_constructor_from_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
        Diagnostics.Parameter_0_of_constructor_from_exported_class_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_constructor_from_exported_class_has_or_is_using_private_name_1,
      );
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.ConstructorType:
      return byModuleNameOnly(
        result,
        Diagnostics.Parameter_0_of_constructor_signature_from_exported_interface_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_constructor_signature_from_exported_interface_has_or_is_using_private_name_1,
      );
    case SyntaxKind.CallSignature:
      return byModuleNameOnly(
        result,
        Diagnostics.Parameter_0_of_call_signature_from_exported_interface_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_call_signature_from_exported_interface_has_or_is_using_private_name_1,
      );
    case SyntaxKind.IndexSignature:
      return byModuleNameOnly(
        result,
        Diagnostics.Parameter_0_of_index_signature_from_exported_interface_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_index_signature_from_exported_interface_has_or_is_using_private_name_1,
      );
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      if (isStatic(parent))
        return byModuleName(
          result,
          Diagnostics.Parameter_0_of_public_static_method_from_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
          Diagnostics.Parameter_0_of_public_static_method_from_exported_class_has_or_is_using_name_1_from_private_module_2,
          Diagnostics.Parameter_0_of_public_static_method_from_exported_class_has_or_is_using_private_name_1,
        );
      if (parent.parent!.kind === SyntaxKind.ClassDeclaration)
        return byModuleName(
          result,
          Diagnostics.Parameter_0_of_public_method_from_exported_class_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
          Diagnostics.Parameter_0_of_public_method_from_exported_class_has_or_is_using_name_1_from_private_module_2,
          Diagnostics.Parameter_0_of_public_method_from_exported_class_has_or_is_using_private_name_1,
        );
      return byModuleNameOnly(
        result,
        Diagnostics.Parameter_0_of_method_from_exported_interface_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_method_from_exported_interface_has_or_is_using_private_name_1,
      );
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression:
      return byModuleName(
        result,
        Diagnostics.Parameter_0_of_exported_function_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
        Diagnostics.Parameter_0_of_exported_function_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_exported_function_has_or_is_using_private_name_1,
      );
    case SyntaxKind.SetAccessor:
    case SyntaxKind.GetAccessor:
      return byModuleName(
        result,
        Diagnostics.Parameter_0_of_accessor_has_or_is_using_name_1_from_external_module_2_but_cannot_be_named,
        Diagnostics.Parameter_0_of_accessor_has_or_is_using_name_1_from_private_module_2,
        Diagnostics.Parameter_0_of_accessor_has_or_is_using_private_name_1,
      );
  }
  throw new Error('Unknown parent for parameter');
}

function typeParameterConstraintMessage(node: Node): DiagnosticMessage {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.ClassDeclaration:
      return Diagnostics.Type_parameter_0_of_exported_class_has_or_is_using_private_name_1;
    case SyntaxKind.InterfaceDeclaration:
      return Diagnostics.Type_parameter_0_of_exported_interface_has_or_is_using_private_name_1;
    case SyntaxKind.MappedType:
      return Diagnostics.Type_parameter_0_of_exported_mapped_object_type_is_using_private_name_1;
    case SyntaxKind.ConstructorType:
    case SyntaxKind.ConstructSignature:
      return Diagnostics.Type_parameter_0_of_constructor_signature_from_exported_interface_has_or_is_using_private_name_1;
    case SyntaxKind.CallSignature:
      return Diagnostics.Type_parameter_0_of_call_signature_from_exported_interface_has_or_is_using_private_name_1;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      if (isStatic(parent))
        return Diagnostics.Type_parameter_0_of_public_static_method_from_exported_class_has_or_is_using_private_name_1;
      if (parent.parent!.kind === SyntaxKind.ClassDeclaration)
        return Diagnostics.Type_parameter_0_of_public_method_from_exported_class_has_or_is_using_private_name_1;
      return Diagnostics.Type_parameter_0_of_method_from_exported_interface_has_or_is_using_private_name_1;
    case SyntaxKind.FunctionType:
    case SyntaxKind.FunctionDeclaration:
      return Diagnostics.Type_parameter_0_of_exported_function_has_or_is_using_private_name_1;
    case SyntaxKind.InferType:
      return Diagnostics.Extends_clause_for_inferred_type_0_has_or_is_using_private_name_1;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      return Diagnostics.Type_parameter_0_of_exported_type_alias_has_or_is_using_private_name_1;
  }
  throw new Error('This is unknown parent for type parameter');
}

// isolatedDeclarations

function relatedSuggestion(kind: SyntaxKind): DiagnosticMessage | undefined {
  switch (kind) {
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionExpression:
      return Diagnostics.Add_a_return_type_to_the_function_expression;
    case SyntaxKind.MethodDeclaration:
      return Diagnostics.Add_a_return_type_to_the_method;
    case SyntaxKind.GetAccessor:
      return Diagnostics.Add_a_return_type_to_the_get_accessor_declaration;
    case SyntaxKind.SetAccessor:
      return Diagnostics.Add_a_type_to_parameter_of_the_set_accessor_declaration;
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ConstructSignature:
      return Diagnostics.Add_a_return_type_to_the_function_declaration;
    case SyntaxKind.Parameter:
      return Diagnostics.Add_a_type_annotation_to_the_parameter_0;
    case SyntaxKind.VariableDeclaration:
      return Diagnostics.Add_a_type_annotation_to_the_variable_0;
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      return Diagnostics.Add_a_type_annotation_to_the_property_0;
    case SyntaxKind.ExportAssignment:
      return Diagnostics.Move_the_expression_in_default_export_to_a_variable_and_add_a_type_annotation_to_it;
  }
  return undefined;
}

function errorByDeclarationKind(kind: SyntaxKind): DiagnosticMessage {
  switch (kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ArrowFunction:
      return Diagnostics.Function_must_have_an_explicit_return_type_annotation_with_isolatedDeclarations;
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.ConstructSignature:
      return Diagnostics.Method_must_have_an_explicit_return_type_annotation_with_isolatedDeclarations;
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return Diagnostics.At_least_one_accessor_must_have_an_explicit_type_annotation_with_isolatedDeclarations;
    case SyntaxKind.Parameter:
      return Diagnostics.Parameter_must_have_an_explicit_type_annotation_with_isolatedDeclarations;
    case SyntaxKind.VariableDeclaration:
      return Diagnostics.Variable_must_have_an_explicit_type_annotation_with_isolatedDeclarations;
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      return Diagnostics.Property_must_have_an_explicit_type_annotation_with_isolatedDeclarations;
    case SyntaxKind.ComputedPropertyName:
      return Diagnostics.Computed_property_names_on_class_or_object_literals_cannot_be_inferred_with_isolatedDeclarations;
    case SyntaxKind.SpreadAssignment:
      return Diagnostics.Objects_that_contain_spread_assignments_can_t_be_inferred_with_isolatedDeclarations;
    case SyntaxKind.ShorthandPropertyAssignment:
      return Diagnostics.Objects_that_contain_shorthand_properties_can_t_be_inferred_with_isolatedDeclarations;
    case SyntaxKind.ArrayLiteralExpression:
      return Diagnostics.Only_const_arrays_can_be_inferred_with_isolatedDeclarations;
    case SyntaxKind.ExportAssignment:
      return Diagnostics.Default_exports_can_t_be_inferred_with_isolatedDeclarations;
    case SyntaxKind.SpreadElement:
      return Diagnostics.Arrays_with_spread_elements_can_t_inferred_with_isolatedDeclarations;
  }
  return Diagnostics.Expression_type_can_t_be_inferred_with_isolatedDeclarations;
}

function related(node: Node, kind: SyntaxKind, name: string): Diagnostic | undefined {
  const message = relatedSuggestion(kind);
  return message === undefined ? undefined : createDiagnosticForNode(node, message, [name]);
}

function isDeclarationEnoughForErrors(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ExportAssignment ||
    isStatement(node) ||
    node.kind === SyntaxKind.VariableDeclaration ||
    node.kind === SyntaxKind.PropertyDeclaration ||
    node.kind === SyntaxKind.Parameter
  );
}

function findNearestDeclaration(node: Node): Node | undefined {
  let result: Node | undefined = node;
  while (result !== undefined && !isDeclarationEnoughForErrors(result)) result = result.parent;
  if (result === undefined || result.kind === SyntaxKind.ExportAssignment) return result;
  if (result.kind === SyntaxKind.ReturnStatement) {
    let fn: Node | undefined = result;
    while (fn !== undefined && !(isFunctionLikeDeclarationKind(fn.kind) && fn.kind !== SyntaxKind.Constructor))
      fn = fn.parent;
    return fn;
  }
  if (isStatement(result)) return undefined;
  return result;
}

function declarationNameText(declaration: Node): string {
  if (declaration.kind === SyntaxKind.ExportAssignment) return '';
  const name = getName(declaration);
  return name === undefined ? '' : textOfNode(name);
}

function addParentDeclarationRelatedInfo(node: Node, diagnostic: Diagnostic): Diagnostic {
  const declaration = findNearestDeclaration(node);
  if (declaration !== undefined)
    diagnostic.addRelatedInfo(related(declaration, declaration.kind, declarationNameText(declaration)));
  return diagnostic;
}

function isOuterExpressionForErrors(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.SatisfiesExpression:
      return true;
  }
  return false;
}

function expressionError(node: Node, message: DiagnosticMessage | undefined): Diagnostic {
  const declaration = findNearestDeclaration(node);
  if (declaration === undefined)
    return createDiagnosticForNode(
      node,
      message ?? Diagnostics.Expression_type_can_t_be_inferred_with_isolatedDeclarations,
      [],
    );
  const name = declarationNameText(declaration);
  // The nearest ancestor that isn't a parenthesis or assertion, unless a statement comes first.
  let parent: Node | undefined = node.parent;
  while (parent !== undefined) {
    if (parent.kind === SyntaxKind.ExportAssignment) break;
    if (isStatement(parent)) {
      parent = undefined;
      break;
    }
    if (!isOuterExpressionForErrors(parent)) break;
    parent = parent.parent;
  }
  if (declaration === parent) {
    const diagnostic = createDiagnosticForNode(node, message ?? errorByDeclarationKind(declaration.kind), []);
    return diagnostic.addRelatedInfo(related(declaration, declaration.kind, name));
  }
  const diagnostic = createDiagnosticForNode(
    node,
    message ?? Diagnostics.Expression_type_can_t_be_inferred_with_isolatedDeclarations,
    [],
  );
  diagnostic.addRelatedInfo(related(declaration, declaration.kind, name));
  return diagnostic.addRelatedInfo(
    createDiagnosticForNode(
      node,
      Diagnostics.Add_satisfies_and_a_type_assertion_to_this_expression_satisfies_T_as_T_to_make_the_type_explicit,
      [],
    ),
  );
}

function accessorTypeError(node: Node): Diagnostic {
  const accessors = getAllAccessorDeclarations(node);
  const parameters = getParameters(node);
  const target =
    node instanceof SetAccessorDeclaration && parameters !== undefined && parameters.nodes.length > 0
      ? parameters.nodes[0]!
      : node;
  const diagnostic = createDiagnosticForNode(target, errorByDeclarationKind(node.kind), []);
  if (accessors.setAccessor !== undefined)
    diagnostic.addRelatedInfo(related(accessors.setAccessor, SyntaxKind.SetAccessor, ''));
  if (accessors.getAccessor !== undefined)
    diagnostic.addRelatedInfo(related(accessors.getAccessor, SyntaxKind.GetAccessor, ''));
  return diagnostic;
}

/** The isolatedDeclarations error for a type that needs inference at `node`. */
export function createIsolatedDeclarationError(node: Node, requiresAddingUndefined: boolean): Diagnostic {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent)
    if (current.kind === SyntaxKind.HeritageClause)
      return createDiagnosticForNode(
        node,
        Diagnostics.Extends_clause_can_t_contain_an_expression_with_isolatedDeclarations,
        [],
      );
  if (isPartOfTypeNode(node) || node.kind === SyntaxKind.TypeQuery || isEntityNameExpression(node, false))
    return addParentDeclarationRelatedInfo(
      node,
      createDiagnosticForNode(
        node,
        Diagnostics.Type_containing_private_name_0_can_t_be_used_with_isolatedDeclarations,
        [textOfNode(node)],
      ),
    );
  switch (node.kind) {
    case SyntaxKind.QualifiedName:
      return addParentDeclarationRelatedInfo(
        node,
        createDiagnosticForNode(
          node,
          Diagnostics.Type_containing_private_name_0_can_t_be_used_with_isolatedDeclarations,
          [textOfNode(node)],
        ),
      );
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return accessorTypeError(node);
    case SyntaxKind.ComputedPropertyName:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.SpreadAssignment:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.SpreadElement:
      return addParentDeclarationRelatedInfo(
        node,
        createDiagnosticForNode(node, errorByDeclarationKind(node.kind), []),
      );
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.FunctionDeclaration: {
      const diagnostic = addParentDeclarationRelatedInfo(
        node,
        createDiagnosticForNode(node, errorByDeclarationKind(node.kind), []),
      );
      return diagnostic.addRelatedInfo(related(node, node.kind, ''));
    }
    case SyntaxKind.BindingElement:
      return createDiagnosticForNode(
        node,
        Diagnostics.Binding_elements_with_initializers_can_t_be_exported_directly_with_isolatedDeclarations,
        [],
      );
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.VariableDeclaration: {
      const diagnostic = createDiagnosticForNode(node, errorByDeclarationKind(node.kind), []);
      const name = getName(node);
      return diagnostic.addRelatedInfo(related(node, node.kind, name === undefined ? '' : textOfNode(name)));
    }
    case SyntaxKind.Parameter:
      return parameterError(node, requiresAddingUndefined);
    case SyntaxKind.PropertyAssignment:
      return expressionError(getInitializer(node)!, undefined);
    case SyntaxKind.ClassExpression:
      return expressionError(
        node,
        Diagnostics.Inference_from_class_expressions_is_not_supported_with_isolatedDeclarations,
      );
  }
  return expressionError(node, undefined);
}

function parameterError(node: Node, requiresAddingUndefined: boolean): Diagnostic {
  if (node.parent !== undefined && node.parent.kind === SyntaxKind.SetAccessor) return accessorTypeError(node.parent);
  const initializer = getInitializer(node);
  if (!requiresAddingUndefined && initializer !== undefined) return expressionError(initializer, undefined);
  const message = requiresAddingUndefined
    ? Diagnostics.Declaration_emit_for_this_parameter_requires_implicitly_adding_undefined_to_its_type_This_is_not_supported_with_isolatedDeclarations
    : errorByDeclarationKind(node.kind);
  const diagnostic = createDiagnosticForNode(node, message, []);
  const name = node instanceof ParameterDeclaration ? textOfNode(node.name) : '';
  return diagnostic.addRelatedInfo(related(node, node.kind, name));
}

export class AllAccessorDeclarations {
  readonly firstAccessor: Node;
  readonly secondAccessor: Node | undefined;
  readonly getAccessor: Node | undefined;
  readonly setAccessor: Node | undefined;

  constructor(
    firstAccessor: Node,
    secondAccessor: Node | undefined,
    getAccessor: Node | undefined,
    setAccessor: Node | undefined,
  ) {
    this.firstAccessor = firstAccessor;
    this.secondAccessor = secondAccessor;
    this.getAccessor = getAccessor;
    this.setAccessor = setAccessor;
  }
}

/** The get and set accessors declaring the same property as `accessor`. */
export function getAllAccessorDeclarations(accessor: Node): AllAccessorDeclarations {
  const otherKind = accessor.kind === SyntaxKind.SetAccessor ? SyntaxKind.GetAccessor : SyntaxKind.SetAccessor;
  let other: Node | undefined = undefined;
  const symbol = getSymbol(accessor);
  if (symbol !== undefined)
    for (const declaration of getDeclarations(symbol))
      if (declaration.kind === otherKind) {
        other = declaration;
        break;
      }
  const otherFirst = other !== undefined && other.pos < accessor.pos;
  const isSet = accessor.kind === SyntaxKind.SetAccessor;
  return new AllAccessorDeclarations(
    otherFirst ? other! : accessor,
    otherFirst ? accessor : other,
    isSet ? other : accessor,
    isSet ? accessor : other,
  );
}
