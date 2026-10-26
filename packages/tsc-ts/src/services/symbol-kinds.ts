// What kind of entity a symbol is, for completion item kinds, like tsgo's lsutil symbol display.
import type { Node } from '../compiler/ast.js';
import { getDeclarationOfKind, getCombinedNodeFlags } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { getTypeOfSymbolAtLocation } from '../compiler/checker-services.js';
import { getNonNullableType } from '../compiler/checker-flow.js';
import { isThisInTypeQuery } from '../compiler/checker-expressions.js';
import { NodeFlags } from '../compiler/ast.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { getCallSignatures, getRootSymbols } from './completion-checker.js';
import { findAncestorOrQuit, FindAncestorResult, isFunctionBlock } from './completion-utilities.js';
import { CheckFlags, declarationCount, getDeclarations, type Symbol, SymbolFlags } from '../compiler/symbol.js';

export const enum ScriptElementKind {
  Unknown,
  Warning,
  Keyword,
  ScriptElement,
  ModuleElement,
  ClassElement,
  LocalClassElement,
  InterfaceElement,
  TypeElement,
  EnumElement,
  EnumMemberElement,
  VariableElement,
  LocalVariableElement,
  VariableUsingElement,
  VariableAwaitUsingElement,
  FunctionElement,
  LocalFunctionElement,
  MemberFunctionElement,
  MemberGetAccessorElement,
  MemberSetAccessorElement,
  MemberVariableElement,
  MemberAccessorVariableElement,
  ConstructorImplementationElement,
  CallSignatureElement,
  IndexSignatureElement,
  ConstructSignatureElement,
  ParameterElement,
  TypeParameterElement,
  PrimitiveType,
  Label,
  Alias,
  ConstElement,
  LetElement,
  Directory,
  ExternalModuleName,
  String,
  Link,
  LinkName,
  LinkText,
}

/** LSP completion item kinds. */
export const enum CompletionItemKind {
  Text = 1,
  Method = 2,
  Function = 3,
  Constructor = 4,
  Field = 5,
  Variable = 6,
  Class = 7,
  Interface = 8,
  Module = 9,
  Property = 10,
  Unit = 11,
  Value = 12,
  Enum = 13,
  Keyword = 14,
  Snippet = 15,
  Color = 16,
  File = 17,
  Reference = 18,
  Folder = 19,
  EnumMember = 20,
  Constant = 21,
}

/** The kind of `symbol` at `location`. Without a checker, from the symbol's flags and declarations alone. */
export function getSymbolKind(c: Checker | undefined, symbol: Symbol, location: Node): ScriptElementKind {
  const result = getSymbolKindOfConstructorPropertyMethodAccessorFunctionOrVar(c, symbol, location);
  if (result !== ScriptElementKind.Unknown) return result;
  const flags = symbol.combinedLocalAndExportSymbolFlags();
  if ((flags & SymbolFlags.Class) !== 0)
    return getDeclarationOfKind(symbol, SyntaxKind.ClassExpression) !== undefined
      ? ScriptElementKind.LocalClassElement
      : ScriptElementKind.ClassElement;
  if ((flags & SymbolFlags.Enum) !== 0) return ScriptElementKind.EnumElement;
  if ((flags & SymbolFlags.TypeAlias) !== 0) return ScriptElementKind.TypeElement;
  if ((flags & SymbolFlags.Interface) !== 0) return ScriptElementKind.InterfaceElement;
  if ((flags & SymbolFlags.TypeParameter) !== 0) return ScriptElementKind.TypeParameterElement;
  if ((flags & SymbolFlags.EnumMember) !== 0) return ScriptElementKind.EnumMemberElement;
  if ((flags & SymbolFlags.Alias) !== 0) return ScriptElementKind.Alias;
  if ((flags & SymbolFlags.Module) !== 0) return ScriptElementKind.ModuleElement;
  return ScriptElementKind.Unknown;
}

function getSymbolKindOfConstructorPropertyMethodAccessorFunctionOrVar(
  c: Checker | undefined,
  symbol: Symbol,
  location: Node,
): ScriptElementKind {
  const roots = c === undefined ? [symbol] : getRootSymbols(c, symbol);
  // A method from a mapped type stays a method while it still has a call signature.
  if (
    roots.length === 1 &&
    (roots[0].flags & SymbolFlags.Method) !== 0 &&
    (c === undefined ||
      getCallSignatures(c, getNonNullableType(c, getTypeOfSymbolAtLocation(c, symbol, location))).length > 0)
  )
    return ScriptElementKind.MemberFunctionElement;
  if (c !== undefined) {
    if (symbol === c.undefinedSymbol) return ScriptElementKind.VariableElement;
    if (symbol === c.argumentsSymbol) return ScriptElementKind.LocalVariableElement;
    if (location.kind === SyntaxKind.ThisKeyword || isThisInTypeQuery(location))
      return ScriptElementKind.ParameterElement;
  }
  const flags = symbol.combinedLocalAndExportSymbolFlags();
  if ((flags & SymbolFlags.Variable) !== 0) {
    const valueDeclaration = symbol.valueDeclaration;
    if (isFirstDeclarationOfSymbolParameter(symbol)) return ScriptElementKind.ParameterElement;
    if (valueDeclaration !== undefined && isVarConst(valueDeclaration)) return ScriptElementKind.ConstElement;
    if (valueDeclaration !== undefined && isVarUsing(valueDeclaration)) return ScriptElementKind.VariableUsingElement;
    if (valueDeclaration !== undefined && isVarAwaitUsing(valueDeclaration))
      return ScriptElementKind.VariableAwaitUsingElement;
    if (getDeclarations(symbol).some(isLet)) return ScriptElementKind.LetElement;
    return isLocalVariableOrFunction(symbol)
      ? ScriptElementKind.LocalVariableElement
      : ScriptElementKind.VariableElement;
  }
  if ((flags & SymbolFlags.Function) !== 0)
    return isLocalVariableOrFunction(symbol)
      ? ScriptElementKind.LocalFunctionElement
      : ScriptElementKind.FunctionElement;
  // Getters and setters share a symbol, which nearly always has the getter flag.
  if ((flags & SymbolFlags.GetAccessor) !== 0) return ScriptElementKind.MemberGetAccessorElement;
  if ((flags & SymbolFlags.SetAccessor) !== 0) return ScriptElementKind.MemberSetAccessorElement;
  if ((flags & SymbolFlags.Method) !== 0) return ScriptElementKind.MemberFunctionElement;
  if ((flags & SymbolFlags.Constructor) !== 0) return ScriptElementKind.ConstructorImplementationElement;
  if ((flags & SymbolFlags.Signature) !== 0) return ScriptElementKind.IndexSignatureElement;
  if ((flags & SymbolFlags.Property) !== 0) {
    if (c !== undefined && (flags & SymbolFlags.Transient) !== 0 && (symbol.checkFlags & CheckFlags.Synthetic) !== 0) {
      // A union property of non-methods is a property.
      for (const root of roots)
        if ((root.flags & (SymbolFlags.PropertyOrAccessor | SymbolFlags.Variable)) !== 0)
          return ScriptElementKind.MemberVariableElement;
      // A union of methods is a method if it has call signatures.
      const typeOfUnionProperty = getTypeOfSymbolAtLocation(c, symbol, location);
      return getCallSignatures(c, typeOfUnionProperty).length > 0
        ? ScriptElementKind.MemberFunctionElement
        : ScriptElementKind.MemberVariableElement;
    }
    return ScriptElementKind.MemberVariableElement;
  }
  return ScriptElementKind.Unknown;
}

function blockScopeKind(node: Node): NodeFlags {
  return getCombinedNodeFlags(node) & NodeFlags.BlockScoped;
}

function isVarConst(node: Node): boolean {
  return blockScopeKind(node) === NodeFlags.Const;
}

function isVarUsing(node: Node): boolean {
  return blockScopeKind(node) === NodeFlags.Using;
}

function isVarAwaitUsing(node: Node): boolean {
  return blockScopeKind(node) === NodeFlags.AwaitUsing;
}

function isLet(node: Node): boolean {
  return blockScopeKind(node) === NodeFlags.Let;
}

function isFirstDeclarationOfSymbolParameter(symbol: Symbol): boolean {
  const declaration = declarationCount(symbol) > 0 ? symbol.declaration : undefined;
  return (
    findAncestorOrQuit(declaration, (n) => {
      if (n.kind === SyntaxKind.Parameter) return FindAncestorResult.True;
      if (
        n.kind === SyntaxKind.BindingElement ||
        n.kind === SyntaxKind.ObjectBindingPattern ||
        n.kind === SyntaxKind.ArrayBindingPattern
      )
        return FindAncestorResult.False;
      return FindAncestorResult.Quit;
    }) !== undefined
  );
}

function isLocalVariableOrFunction(symbol: Symbol): boolean {
  // Exported symbols aren't local.
  if (symbol.parent !== undefined) return false;
  for (const declaration of getDeclarations(symbol)) {
    if (declaration.kind === SyntaxKind.FunctionExpression) return true;
    if (declaration.kind !== SyntaxKind.VariableDeclaration && declaration.kind !== SyntaxKind.FunctionDeclaration)
      continue;
    // Declarations inside a function body are local.
    let parent = declaration.parent!;
    while (!isFunctionBlock(parent)) {
      if (parent.kind === SyntaxKind.SourceFile || parent.kind === SyntaxKind.ModuleBlock) break;
      parent = parent.parent!;
    }
    if (isFunctionBlock(parent)) return true;
  }
  return false;
}

/** The completion item kind for a script element kind, as the VS Code TypeScript extension maps it. */
export function getCompletionsSymbolKind(kind: ScriptElementKind): CompletionItemKind {
  switch (kind) {
    case ScriptElementKind.PrimitiveType:
    case ScriptElementKind.Keyword:
      return CompletionItemKind.Keyword;
    case ScriptElementKind.ConstElement:
    case ScriptElementKind.LetElement:
    case ScriptElementKind.VariableElement:
    case ScriptElementKind.LocalVariableElement:
    case ScriptElementKind.Alias:
    case ScriptElementKind.ParameterElement:
      return CompletionItemKind.Variable;
    case ScriptElementKind.MemberVariableElement:
    case ScriptElementKind.MemberGetAccessorElement:
    case ScriptElementKind.MemberSetAccessorElement:
      return CompletionItemKind.Field;
    case ScriptElementKind.FunctionElement:
    case ScriptElementKind.LocalFunctionElement:
      return CompletionItemKind.Function;
    case ScriptElementKind.MemberFunctionElement:
    case ScriptElementKind.ConstructSignatureElement:
    case ScriptElementKind.CallSignatureElement:
    case ScriptElementKind.IndexSignatureElement:
      return CompletionItemKind.Method;
    case ScriptElementKind.EnumElement:
      return CompletionItemKind.Enum;
    case ScriptElementKind.EnumMemberElement:
      return CompletionItemKind.EnumMember;
    case ScriptElementKind.ModuleElement:
    case ScriptElementKind.ExternalModuleName:
      return CompletionItemKind.Module;
    case ScriptElementKind.ClassElement:
    case ScriptElementKind.TypeElement:
      return CompletionItemKind.Class;
    case ScriptElementKind.InterfaceElement:
      return CompletionItemKind.Interface;
    case ScriptElementKind.Warning:
      return CompletionItemKind.Text;
    case ScriptElementKind.ScriptElement:
      return CompletionItemKind.File;
    case ScriptElementKind.Directory:
      return CompletionItemKind.Folder;
    case ScriptElementKind.String:
      return CompletionItemKind.Constant;
  }
  return CompletionItemKind.Property;
}
