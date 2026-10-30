// Declarations whose names collide with names the emitted code uses: `require` and `exports` in CommonJS
// output, `Object`, `Promise` (async functions before ES2017), `WeakMap` and `WeakSet` (downleveled private
// names) and `Reflect` (downleveled `super` in static initializers). These errors are skipped under noEmit.
import { type Node, type SourceFile, NodeFlags, getBody, getMembers, getName, getText } from './ast.js';
import {
  declarationNameToString,
  getRootDeclaration,
  getSourceFileOfNode,
  isClassLike,
  isExternalOrCommonJSModule,
  getModuleInstanceState,
  ModuleInstanceState,
} from './binder-utilities.js';
import type { Checker } from './checker.js';
import { NodeCheckFlags } from './checker-types.js';
import { getDeclarationContainer, isTypeOnlyImportOrExportDeclaration } from './checker-modules.js';
import { getEnclosingBlockScopeContainer } from './checker-declaration-order.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { ModuleKind, ScriptTarget, getEmitModuleKind, getUseDefineForClassFields } from './options.js';
import { moduleKindName } from './program-utilities.js';
import { SyntaxKind } from './syntax-kind.js';

/** An error that is not reported under noEmit, since it is about the emitted code. */
export function errorSkippedOnNoEmit(
  c: Checker,
  node: Node,
  message: DiagnosticMessage,
  ...args: string[]
): Diagnostic {
  const diagnostic = c.error(node, message, ...args);
  diagnostic.skippedOnNoEmit = true;
  return diagnostic;
}

/** Checks the name of a declaration against the names the emitted code reserves. */
export function checkCollisionsForDeclarationName(c: Checker, node: Node, name: Node | undefined): void {
  if (name === undefined) return;
  checkCollisionWithRequireExportsInGeneratedCode(c, node, name);
  checkCollisionWithGlobalObjectInGeneratedCode(c, node, name);
  checkCollisionWithGlobalPromiseInGeneratedCode(c, node, name);
  if (
    c.languageVersion <= ScriptTarget.ES2021 &&
    (needCollisionCheckForIdentifier(node, name, 'WeakMap') || needCollisionCheckForIdentifier(node, name, 'WeakSet'))
  )
    c.deferDiagnostic(node, () => checkWeakMapSetCollision(c, node));
  if (c.languageVersion <= ScriptTarget.ES2021 && needCollisionCheckForIdentifier(node, name, 'Reflect'))
    c.deferDiagnostic(node, () => checkReflectCollision(c, node));
  if (isClassLike(node) && (node.flags & NodeFlags.Ambient) === 0 && getText(name) === 'Object') {
    if (c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(name)) < ModuleKind.ES2015)
      c.error(
        name,
        Diagnostics.Class_name_cannot_be_Object_when_targeting_ES5_and_above_with_module_0,
        moduleKindName(getEmitModuleKind(c.compilerOptions)),
      );
  }
}

function checkCollisionWithRequireExportsInGeneratedCode(c: Checker, node: Node, name: Node): void {
  if (
    !needCollisionCheckForIdentifier(node, name, 'require') &&
    !needCollisionCheckForIdentifier(node, name, 'exports')
  )
    return;
  // ES modules don't use `require` or `exports`.
  if (c.host.getEmitModuleFormatOfFile(getSourceFileOfNode(node)) >= ModuleKind.ES2015) return;
  if (node.kind === SyntaxKind.ModuleDeclaration && getModuleInstanceState(node) !== ModuleInstanceState.Instantiated)
    return;
  const parent = getDeclarationContainer(node);
  if (parent.kind === SyntaxKind.SourceFile && isExternalOrCommonJSModule(parent as SourceFile))
    reportReservedTopLevelName(
      c,
      name,
      Diagnostics.Duplicate_identifier_0_Compiler_reserves_name_1_in_top_level_scope_of_a_module,
    );
}

function checkCollisionWithGlobalObjectInGeneratedCode(c: Checker, node: Node, name: Node): void {
  if (isClassLike(node) || !needCollisionCheckForIdentifier(node, name, 'Object')) return;
  if (node.kind === SyntaxKind.ModuleDeclaration && getModuleInstanceState(node) !== ModuleInstanceState.Instantiated)
    return;
  const parent = getDeclarationContainer(node);
  if (
    parent.kind === SyntaxKind.SourceFile &&
    isExternalOrCommonJSModule(parent as SourceFile) &&
    c.host.getEmitModuleFormatOfFile(parent as SourceFile) === ModuleKind.CommonJS
  )
    reportReservedTopLevelName(
      c,
      name,
      Diagnostics.Duplicate_identifier_0_Compiler_reserves_name_1_in_top_level_scope_of_a_module,
    );
}

function checkCollisionWithGlobalPromiseInGeneratedCode(c: Checker, node: Node, name: Node): void {
  if (c.languageVersion >= ScriptTarget.ES2017 || !needCollisionCheckForIdentifier(node, name, 'Promise')) return;
  if (node.kind === SyntaxKind.ModuleDeclaration && getModuleInstanceState(node) !== ModuleInstanceState.Instantiated)
    return;
  const parent = getDeclarationContainer(node);
  if (
    parent.kind === SyntaxKind.SourceFile &&
    isExternalOrCommonJSModule(parent as SourceFile) &&
    (parent.flags & NodeFlags.HasAsyncFunctions) !== 0
  )
    reportReservedTopLevelName(
      c,
      name,
      Diagnostics.Duplicate_identifier_0_Compiler_reserves_name_1_in_top_level_scope_of_a_module_containing_async_functions,
    );
}

function reportReservedTopLevelName(c: Checker, name: Node, message: DiagnosticMessage): void {
  const text = declarationNameToString(getSourceFileOfNode(name), name);
  errorSkippedOnNoEmit(c, name, message, text, text);
}

/** Whether the declaration `node` binds `name` where the emitted code could see it. */
function needCollisionCheckForIdentifier(node: Node, identifier: Node, name: string): boolean {
  if (identifier.kind !== SyntaxKind.Identifier || getText(identifier) !== name) return false;
  switch (node.kind) {
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.PropertyAssignment:
      return false;
  }
  if ((node.flags & NodeFlags.Ambient) !== 0) return false;
  if (
    (node.kind === SyntaxKind.ImportClause ||
      node.kind === SyntaxKind.ImportEqualsDeclaration ||
      node.kind === SyntaxKind.ImportSpecifier) &&
    isTypeOnlyImportOrExportDeclaration(node)
  )
    return false;
  const root = getRootDeclaration(node);
  return !(root.kind === SyntaxKind.Parameter && getBody(root.parent!) === undefined);
}

/**
 * A private name downleveled (before ESNext, or without useDefineForClassFields) is emitted with `WeakMap` or
 * `WeakSet`: marks the block scopes around its class.
 */
export function markPrivateIdentifierScope(c: Checker, node: Node): void {
  const name = getName(node);
  if (name === undefined || name.kind !== SyntaxKind.PrivateIdentifier) return;
  if (c.languageVersion >= ScriptTarget.ESNext && getUseDefineForClassFields(c.compilerOptions)) return;
  for (
    let scope = getEnclosingBlockScopeContainer(node);
    scope !== undefined;
    scope = getEnclosingBlockScopeContainer(scope)
  )
    c.nodeLinks(scope).flags |= NodeCheckFlags.ContainsClassWithPrivateIdentifiers;
}

/** `super.x` in a static initializer before ES2022 is emitted with `Reflect`: marks the block scopes around it. */
export function markSuperPropertyInStaticInitializer(c: Checker, node: Node): void {
  for (
    let scope = getEnclosingBlockScopeContainer(node.parent!);
    scope !== undefined;
    scope = getEnclosingBlockScopeContainer(scope)
  )
    if (scope.kind !== SyntaxKind.SourceFile || isExternalOrCommonJSModule(scope as SourceFile))
      c.nodeLinks(scope).flags |= NodeCheckFlags.ContainsSuperPropertyInStaticInitializer;
}

function checkWeakMapSetCollision(c: Checker, node: Node): void {
  const scope = getEnclosingBlockScopeContainer(node);
  if (scope === undefined || (c.nodeLinks(scope).flags & NodeCheckFlags.ContainsClassWithPrivateIdentifiers) === 0)
    return;
  const name = getName(node);
  if (name !== undefined && name.kind === SyntaxKind.Identifier)
    errorSkippedOnNoEmit(
      c,
      node,
      Diagnostics.Compiler_reserves_name_0_when_emitting_private_identifier_downlevel,
      getText(name),
    );
}

function checkReflectCollision(c: Checker, node: Node): void {
  let hasCollision = false;
  if (node.kind === SyntaxKind.ClassExpression) {
    for (const member of getMembers(node)!.nodes)
      if ((c.nodeLinks(member).flags & NodeCheckFlags.ContainsSuperPropertyInStaticInitializer) !== 0) {
        hasCollision = true;
        break;
      }
  } else if (node.kind === SyntaxKind.FunctionExpression)
    hasCollision = (c.nodeLinks(node).flags & NodeCheckFlags.ContainsSuperPropertyInStaticInitializer) !== 0;
  else {
    const scope = getEnclosingBlockScopeContainer(node);
    hasCollision =
      scope !== undefined && (c.nodeLinks(scope).flags & NodeCheckFlags.ContainsSuperPropertyInStaticInitializer) !== 0;
  }
  if (!hasCollision) return;
  const name = getName(node);
  if (name !== undefined && name.kind === SyntaxKind.Identifier)
    errorSkippedOnNoEmit(
      c,
      node,
      Diagnostics.Duplicate_identifier_0_Compiler_reserves_name_1_when_emitting_super_references_in_static_initializers,
      declarationNameToString(getSourceFileOfNode(name), name),
      'Reflect',
    );
}
