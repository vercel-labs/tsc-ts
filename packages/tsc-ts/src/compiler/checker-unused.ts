// Unused identifiers: locals, parameters, imports, private class members and type parameters that
// are declared but never referenced. Errors under noUnusedLocals/noUnusedParameters, suggestions
// otherwise. References are recorded in `SymbolLinks.referenceKinds` by name resolution and by
// `markPropertyAsReferenced`.
import {
  type BinaryExpression,
  type ForInOrOfStatement,
  type ImportClause,
  type InferTypeNode,
  ModifierFlags,
  type Node,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  type ShorthandPropertyAssignment,
  type VariableDeclarationList,
  NodeFlags,
  NodeVisitor,
  type SourceFile,
  type TypeAliasDeclaration,
  getBody,
  getDotDotDotToken,
  getElements,
  getExpression,
  getLocals,
  getMembers,
  getName,
  getParameters,
  getPropertyName,
  getSymbol,
  getText,
  getTypeParameters,
} from './ast.js';
import {
  isAmbientModule,
  isAssignmentOperator,
  isGlobalScopeAugmentation,
  isTypeDeclaration,
} from './ast-utilities.js';
import {
  getCombinedNodeFlags,
  getModifierFlags,
  getRootDeclaration,
  getSourceFileOfNode,
  hasSyntacticModifier,
  isExternalOrCommonJSModule,
  isParameterPropertyDeclaration,
} from './binder-utilities.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { Diagnostic, DiagnosticCategory, Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { getMergedSymbol, getSymbolOfDeclaration } from './checker-symbols.js';
import { getResolvedSymbol } from './checker-expressions.js';
import { skipTrivia } from './scanner.js';
import { nodeCanBeDecorated } from './checker-decorators.js';
import { symbolToString } from './type-printer.js';
import type { Type } from './checker-types.js';
import { getLiteralTypeFromPropertyName } from './checker-type-operators.js';
import { getPropertyOfType } from './checker-members.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName } from './checker-utilities.js';
import { CheckFlags, getDeclarations, getSymbolId, type Symbol, SymbolFlags } from './symbol.js';

// ---- References

/** Whether `node` is only written, as the target of `=` or of a for-in/of initializer. */
export function isWriteOnlyAccess(node: Node): boolean {
  return accessKind(node) === AccessKind.Write;
}

/** Whether `node` is written, possibly also read. */
export function isWriteAccess(node: Node): boolean {
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
      if (binary.left !== node || !isAssignmentOperator(binary.operatorToken.kind)) return AccessKind.Read;
      return binary.operatorToken.kind === SyntaxKind.EqualsToken ? AccessKind.Write : AccessKind.ReadWrite;
    }
    case SyntaxKind.PropertyAccessExpression:
      return (parent as PropertyAccessExpression).name !== node ? AccessKind.Read : accessKind(parent);
    case SyntaxKind.PropertyAssignment: {
      const parentAccess = accessKind(parent.parent!);
      // In `({ x: name } = { x: 1 })`, the left `x` is a read and `name` a write.
      return node === (parent as PropertyAssignment).name ? reverseAccessKind(parentAccess) : parentAccess;
    }
    case SyntaxKind.ShorthandPropertyAssignment:
      // The local variable is the one accessed: public properties aren't checked for use.
      return node === (parent as ShorthandPropertyAssignment).objectAssignmentInitializer
        ? AccessKind.Read
        : accessKind(parent.parent!);
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return node === (parent as ForInOrOfStatement).initializer ? AccessKind.Write : AccessKind.Read;
  }
  return AccessKind.Read;
}

function reverseAccessKind(kind: AccessKind): AccessKind {
  switch (kind) {
    case AccessKind.Read:
      return AccessKind.Write;
    case AccessKind.Write:
      return AccessKind.Read;
  }
  return AccessKind.ReadWrite;
}

/** Whether `name` refers to the class or object `parent` itself, as `this` or its own name does. */
export function isSelfTypeAccess(c: Checker, name: Node, parent: Symbol | undefined): boolean {
  if (name.kind === SyntaxKind.ThisKeyword) return true;
  if (parent === undefined || !isEntityNameExpression(name)) return false;
  return parent === getResolvedSymbol(c, getFirstIdentifierOfExpression(name));
}

function isEntityNameExpression(node: Node): boolean {
  let current = node;
  while (current.kind === SyntaxKind.PropertyAccessExpression) {
    if (getName(current)!.kind !== SyntaxKind.Identifier) return false;
    current = (current as PropertyAccessExpression).expression;
  }
  return current.kind === SyntaxKind.Identifier;
}

function getFirstIdentifierOfExpression(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.PropertyAccessExpression)
    current = (current as PropertyAccessExpression).expression;
  return current;
}

/**
 * Records a use of a private class member. Writes don't count, except to setters, and neither do
 * uses of a method from inside itself.
 */
export function markPropertyAsReferenced(
  c: Checker,
  prop: Symbol,
  nodeForCheckWriteOnly: Node | undefined,
  isSelfTypeAccess: boolean,
): void {
  const declaration = prop.valueDeclaration;
  if ((prop.flags & SymbolFlags.ClassMember) === 0 || declaration === undefined) return;
  const name = getName(declaration);
  if (
    !hasSyntacticModifier(declaration, ModifierFlags.Private) &&
    (name === undefined || name.kind !== SyntaxKind.PrivateIdentifier)
  )
    return;
  if (
    nodeForCheckWriteOnly !== undefined &&
    isWriteOnlyAccess(nodeForCheckWriteOnly) &&
    (prop.flags & SymbolFlags.SetAccessor) === 0
  )
    return;
  if (isSelfTypeAccess && nodeForCheckWriteOnly !== undefined) {
    // A method, getter or setter using itself through `this` doesn't count.
    let containingMethod: Node | undefined = nodeForCheckWriteOnly;
    while (containingMethod !== undefined && !isFunctionLikeDeclaration(containingMethod))
      containingMethod = containingMethod.parent;
    if (containingMethod !== undefined && getSymbol(containingMethod) === prop) return;
  }
  const target = (prop.checkFlags & CheckFlags.Instantiated) !== 0 ? c.symbolTargets.get(getSymbolId(prop))! : prop;
  const id = getSymbolId(target);
  c.symbolReferenceKinds.set(id, c.symbolReferenceKinds.get(id) | SymbolFlags.All);
}

/** Marks the property a destructuring name selects from `objectType` as referenced. */
export function markDestructuredPropertyAsReferenced(
  c: Checker,
  objectType: Type,
  name: Node,
  location: Node | undefined,
  isSelfTypeAccess: boolean,
): void {
  if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern) return;
  const nameType = getLiteralTypeFromPropertyName(c, name);
  if (nameType === undefined || !isTypeUsableAsPropertyName(nameType)) return;
  const prop = getPropertyOfType(c, objectType, getPropertyNameFromType(nameType));
  if (prop !== undefined) markPropertyAsReferenced(c, prop, location, isSelfTypeAccess);
}

function isFunctionLikeDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
      return true;
  }
  return false;
}

// ---- Checks

/** Reports the unused identifiers of a checked file; declaration files have none. */
export function checkUnusedIdentifiers(c: Checker, file: SourceFile): void {
  if (file.isDeclarationFile) return;
  const collector = new PotentiallyUnusedCollector(c.legacyDecorators);
  collector.visitNode(file);
  for (const node of collector.nodes) checkUnusedIdentifiersOfNode(c, node);
}

/** The checked declarations and scopes that can declare unused identifiers. */
class PotentiallyUnusedCollector extends NodeVisitor {
  readonly nodes: Node[] = [];
  private readonly legacyDecorators: boolean;

  constructor(legacyDecorators: boolean) {
    super();
    this.legacyDecorators = legacyDecorators;
  }

  visitNode(node: Node): boolean {
    // The body of a `with` statement isn't checked.
    if (node.kind === SyntaxKind.WithStatement) this.visitNode(getExpression(node)!);
    else if (!this.isUnchecked(node)) node.forEachChild(this);
    if (isPotentiallyUnusedContainer(node)) this.nodes.push(node);
    return false;
  }

  /**
   * Whether the checker skips the children of `node`: a decorator of a declaration that can't be decorated
   * is reported as an error and not checked further. (The expression of a `return` outside a function
   * body, or in a class static block, is still checked.)
   */
  private isUnchecked(node: Node): boolean {
    if (node.kind !== SyntaxKind.Decorator) return false;
    const declaration = node.parent!;
    return !nodeCanBeDecorated(this.legacyDecorators, declaration, declaration.parent, declaration.parent?.parent);
  }
}

function isPotentiallyUnusedContainer(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.SourceFile:
      return isExternalOrCommonJSModule(node as SourceFile);
    case SyntaxKind.Block:
    case SyntaxKind.CaseBlock:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ClassStaticBlockDeclaration: {
      const locals = getLocals(node);
      return locals !== undefined && locals.size !== 0;
    }
    case SyntaxKind.ModuleDeclaration:
      return getBody(node) !== undefined && !isGlobalScopeAugmentation(node);
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration: {
      const type = (node as TypeAliasDeclaration).type;
      return type === undefined || type.kind !== SyntaxKind.IntrinsicKeyword;
    }
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.InferType:
    case SyntaxKind.Constructor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature:
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      return true;
  }
  return false;
}

function checkUnusedIdentifiersOfNode(c: Checker, node: Node): void {
  switch (node.kind) {
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
      checkUnusedClassMembers(c, node);
      checkUnusedTypeParameters(c, node);
      return;
    case SyntaxKind.SourceFile:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.Block:
    case SyntaxKind.CaseBlock:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ClassStaticBlockDeclaration:
      checkUnusedLocalsAndParameters(c, node);
      return;
    case SyntaxKind.Constructor:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      // Parameters are reported on implementations only, not overloads.
      if (getBody(node) !== undefined) checkUnusedLocalsAndParameters(c, node);
      checkUnusedTypeParameters(c, node);
      return;
    case SyntaxKind.InferType:
      checkUnusedInferTypeParameter(c, node as InferTypeNode);
      return;
  }
  checkUnusedTypeParameters(c, node);
}

const enum UnusedKind {
  Local,
  Parameter,
}

function isReferenced(c: Checker, symbol: Symbol): boolean {
  return c.symbolReferenceKinds.get(getSymbolId(symbol)) !== 0;
}

function referenceKindsOfDeclaration(c: Checker, node: Node): SymbolFlags {
  const symbol = getSymbolOfDeclaration(c, node);
  return symbol === undefined ? SymbolFlags.None : c.symbolReferenceKinds.get(getSymbolId(symbol));
}

function reportUnused(c: Checker, location: Node, kind: UnusedKind, diagnostic: Diagnostic): void {
  if ((location.flags & (NodeFlags.Ambient | NodeFlags.ThisNodeOrAnySubNodesHasError)) !== 0) return;
  const options = c.compilerOptions;
  const isError = kind === UnusedKind.Local ? options.noUnusedLocals === true : options.noUnusedParameters === true;
  if (!isError) diagnostic.category = DiagnosticCategory.Suggestion;
  c.addErrorOrSuggestion(isError, diagnostic);
}

function reportUnusedVariable(c: Checker, location: Node, diagnostic: Diagnostic): void {
  let current = location;
  while (
    current.kind === SyntaxKind.BindingElement ||
    current.kind === SyntaxKind.ObjectBindingPattern ||
    current.kind === SyntaxKind.ArrayBindingPattern
  )
    current = current.parent!;
  reportUnused(c, current, current.kind === SyntaxKind.Parameter ? UnusedKind.Parameter : UnusedKind.Local, diagnostic);
}

function checkUnusedClassMembers(c: Checker, node: Node): void {
  for (const member of getMembers(node)!.nodes) {
    switch (member.kind) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor: {
        // An unused accessor pair is reported on the getter.
        if (member.kind === SyntaxKind.SetAccessor && (getSymbol(member)!.flags & SymbolFlags.GetAccessor) !== 0) break;
        const symbol = getSymbolOfDeclaration(c, member)!;
        const name = getName(member);
        if (
          !isReferenced(c, symbol) &&
          ((getModifierFlags(member) & ModifierFlags.Private) !== 0 ||
            (name !== undefined && name.kind === SyntaxKind.PrivateIdentifier)) &&
          (member.flags & NodeFlags.Ambient) === 0
        )
          reportUnused(
            c,
            member,
            UnusedKind.Local,
            createDiagnosticForNode(name, Diagnostics.X_0_is_declared_but_its_value_is_never_read, [
              symbolToString(c, symbol),
            ]),
          );
        break;
      }
      case SyntaxKind.Constructor:
        for (const parameter of getParameters(member)!.nodes) {
          const symbol = getSymbol(parameter);
          if (
            symbol !== undefined &&
            !isReferenced(c, symbol) &&
            hasSyntacticModifier(parameter, ModifierFlags.Private)
          )
            reportUnused(
              c,
              parameter,
              UnusedKind.Local,
              createDiagnosticForNode(
                getName(parameter),
                Diagnostics.Property_0_is_declared_but_its_value_is_never_read,
                [symbol.name],
              ),
            );
        }
        break;
    }
  }
}

function checkUnusedLocalsAndParameters(c: Checker, node: Node): void {
  const locals = getLocals(node);
  if (locals === undefined) return;
  const variableParents = new Set<Node>();
  const importClauses = new Map<Node, Node[]>();
  for (const local of locals.values()) {
    const referenceKinds = c.symbolReferenceKinds.get(getSymbolId(local));
    if ((local.flags & SymbolFlags.TypeParameter) !== 0) {
      if ((local.flags & SymbolFlags.Variable) === 0 || (referenceKinds & SymbolFlags.Variable) !== 0) continue;
    } else if (
      referenceKinds !== 0 ||
      local.exportSymbol !== undefined ||
      (local.flags & SymbolFlags.ModuleExports) !== 0
    )
      continue;
    for (const declaration of getDeclarations(local)) {
      switch (declaration.kind) {
        case SyntaxKind.VariableDeclaration:
        case SyntaxKind.Parameter:
        case SyntaxKind.BindingElement:
          variableParents.add(getRootDeclaration(declaration).parent!);
          break;
        case SyntaxKind.ImportClause:
        case SyntaxKind.ImportSpecifier:
        case SyntaxKind.NamespaceImport:
          if (!isIdentifierThatStartsWithUnderscore(getName(declaration))) {
            const importClause = importClauseFromImported(declaration);
            const unuseds = importClauses.get(importClause);
            if (unuseds === undefined) importClauses.set(importClause, [declaration]);
            else unuseds.push(declaration);
          }
          break;
        default:
          if (declaration.kind !== SyntaxKind.TypeParameter && !isAmbientModule(declaration))
            reportUnusedLocal(c, declaration, local.name);
      }
    }
  }
  for (const declaration of variableParents) {
    if (declaration.kind === SyntaxKind.VariableDeclarationList)
      reportUnusedVariables(c, declaration, (declaration as VariableDeclarationList).declarations.nodes);
    else reportUnusedVariableDeclarations(c, getParameters(declaration)!.nodes);
  }
  for (const [declaration, unuseds] of importClauses) reportUnusedImports(c, declaration as ImportClause, unuseds);
}

function reportUnusedLocal(c: Checker, node: Node, name: string): void {
  const message = isTypeDeclaration(node)
    ? Diagnostics.X_0_is_declared_but_never_used
    : Diagnostics.X_0_is_declared_but_its_value_is_never_read;
  reportUnused(c, node, UnusedKind.Local, createDiagnosticForNode(getName(node) ?? node, message, [name]));
}

function reportUnusedVariables(c: Checker, node: Node, declarations: readonly Node[]): void {
  if (declarations.length > 1 && areUnreferencedVariableDeclarations(c, declarations))
    reportUnusedVariable(c, node, createDiagnosticForNode(node, Diagnostics.All_variables_are_unused, []));
  else reportUnusedVariableDeclarations(c, declarations);
}

function reportUnusedBindingElements(c: Checker, node: Node): void {
  const declarations = getElements(node)!.nodes;
  if (declarations.length > 1 && areUnreferencedVariableDeclarations(c, declarations))
    reportUnusedVariable(c, node, createDiagnosticForNode(node, Diagnostics.All_destructured_elements_are_unused, []));
  else reportUnusedVariableDeclarations(c, declarations);
}

function reportUnusedVariableDeclarations(c: Checker, declarations: readonly Node[]): void {
  for (const declaration of declarations) {
    const name = getName(declaration);
    if (
      name === undefined ||
      isParameterPropertyDeclaration(declaration, declaration.parent!) ||
      isThisParameter(declaration)
    )
      continue;
    if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
      reportUnusedBindingElements(c, name);
    else if (isUnreferencedVariableDeclaration(c, declaration))
      reportUnusedVariable(
        c,
        declaration,
        createDiagnosticForNode(name, Diagnostics.X_0_is_declared_but_its_value_is_never_read, [getText(name)]),
      );
  }
}

function isThisParameter(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter) return false;
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.Identifier && getText(name) === 'this';
}

function areUnreferencedVariableDeclarations(c: Checker, declarations: readonly Node[]): boolean {
  for (const d of declarations) if (!isUnreferencedVariableDeclaration(c, d)) return false;
  return true;
}

function isUnreferencedVariableDeclaration(c: Checker, node: Node): boolean {
  const name = getName(node);
  if (name === undefined) return true;
  if (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern)
    return areUnreferencedVariableDeclarations(c, getElements(name)!.nodes);
  if ((referenceKindsOfDeclaration(c, node) & SymbolFlags.Variable) !== 0) return false;
  const parent = node.parent!;
  if (node.kind === SyntaxKind.BindingElement && parent.kind === SyntaxKind.ObjectBindingPattern) {
    // In `{ a, ...b }`, `a` counts as used: it removes a property from `b`.
    const elements = getElements(parent)!.nodes;
    const lastElement = elements[elements.length - 1]!;
    if (node !== lastElement && getDotDotDotToken(lastElement) !== undefined) return false;
  }
  const underscoreExempt =
    node.kind === SyntaxKind.Parameter ||
    (node.kind === SyntaxKind.VariableDeclaration &&
      (isForInOrOfStatement(parent.parent!) || (getCombinedNodeFlags(node) & NodeFlags.Using) !== 0)) ||
    (node.kind === SyntaxKind.BindingElement &&
      !(parent.kind === SyntaxKind.ObjectBindingPattern && getPropertyName(node) === undefined));
  return !(underscoreExempt && isIdentifierThatStartsWithUnderscore(name));
}

function isForInOrOfStatement(node: Node): boolean {
  return node.kind === SyntaxKind.ForInStatement || node.kind === SyntaxKind.ForOfStatement;
}

function reportUnusedImports(c: Checker, node: ImportClause, unuseds: Node[]): void {
  let declarationCount = node.name !== undefined ? 1 : 0;
  const namedBindings = node.namedBindings;
  if (namedBindings !== undefined) {
    if (namedBindings.kind === SyntaxKind.NamespaceImport) declarationCount++;
    else declarationCount += getElements(namedBindings)!.nodes.length;
  }
  if (declarationCount > 1 && declarationCount === unuseds.length)
    reportUnused(
      c,
      node,
      UnusedKind.Local,
      createDiagnosticForNode(node.parent, Diagnostics.All_imports_in_import_declaration_are_unused, []),
    );
  else for (const unused of unuseds) reportUnusedLocal(c, unused, getText(getName(unused)!));
}

function isIdentifierThatStartsWithUnderscore(node: Node | undefined): boolean {
  return node !== undefined && node.kind === SyntaxKind.Identifier && getText(node).charCodeAt(0) === 0x5f;
}

function importClauseFromImported(node: Node): Node {
  switch (node.kind) {
    case SyntaxKind.ImportClause:
      return node;
    case SyntaxKind.NamespaceImport:
      return node.parent!;
  }
  return node.parent!.parent!;
}

function checkUnusedInferTypeParameter(c: Checker, node: InferTypeNode): void {
  const typeParameter = node.typeParameter;
  if (isUnreferencedTypeParameter(c, typeParameter))
    reportUnused(
      c,
      node,
      UnusedKind.Parameter,
      createDiagnosticForNode(typeParameter.name, Diagnostics.X_0_is_declared_but_never_used, [
        getText(typeParameter.name),
      ]),
    );
}

function areUnreferencedTypeParameters(c: Checker, typeParameters: readonly Node[]): boolean {
  for (const p of typeParameters) if (!isUnreferencedTypeParameter(c, p)) return false;
  return true;
}

function checkUnusedTypeParameters(c: Checker, node: Node): void {
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined && !allDeclarationsInSameSourceFile(symbol)) return;
  const typeParameterList = getTypeParameters(node);
  if (typeParameterList === undefined) return;
  const typeParameters = typeParameterList.nodes;
  if (typeParameters.length > 1 && areUnreferencedTypeParameters(c, typeParameters)) {
    const file = getSourceFileOfNode(node);
    const text = file.text;
    const end = Math.min(text.length, skipTrivia(text, typeParameterList.end) + 1);
    reportUnused(
      c,
      node,
      UnusedKind.Parameter,
      new Diagnostic(file.diagnosticFile(), typeParameterList.pos - 1, end, Diagnostics.All_type_parameters_are_unused),
    );
    return;
  }
  for (const typeParameter of typeParameters)
    if (isUnreferencedTypeParameter(c, typeParameter))
      reportUnused(
        c,
        node,
        UnusedKind.Parameter,
        createDiagnosticForNode(typeParameter, Diagnostics.X_0_is_declared_but_never_used, [
          getText(getName(typeParameter)!),
        ]),
      );
}

function isUnreferencedTypeParameter(c: Checker, typeParameter: Node): boolean {
  const symbol = getSymbol(typeParameter);
  const referenceKinds = symbol === undefined ? 0 : c.symbolReferenceKinds.get(getSymbolId(getMergedSymbol(c, symbol)));
  return (
    (referenceKinds & SymbolFlags.TypeParameter) === 0 && !isIdentifierThatStartsWithUnderscore(getName(typeParameter))
  );
}

function allDeclarationsInSameSourceFile(symbol: Symbol): boolean {
  const declarations = getDeclarations(symbol);
  if (declarations.length <= 1) return true;
  const file = getSourceFileOfNode(declarations[0]!);
  for (let i = 1; i < declarations.length; i++) if (getSourceFileOfNode(declarations[i]!) !== file) return false;
  return true;
}
