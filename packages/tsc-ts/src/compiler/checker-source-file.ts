// File-level checking: `checkSourceFile`, the statement/declaration dispatch and deferred checks.
//
// Extension points, by syntactic area:
// - statements: checker-statements.ts (`checkBlock`, `checkIfStatement`, ...)
// - declarations: checker-declarations.ts (variables, functions, aliases, enums, namespaces)
// - imports and exports: checker-modules.ts
// - classes and interfaces: checker-classes.ts
// - expressions: checker-expressions.ts (`checkExpression`), calls in checker-calls.ts
// - JSX: checker-jsx.ts
// - grammar: checker-grammar.ts (checks the parser leaves to the checker)
// - type nodes: `checkTypeNode` below
import { checkPendingExternalEmitHelpers } from './checker-emit-helpers.js';
import { resolveUntypedCall } from './checker-calls.js';
import {
  type ImportTypeNode,
  type MappedTypeNode,
  type TemplateLiteralTypeNode,
  type TemplateLiteralTypeSpan,
  type JSDoc,
  type Node,
  type NodeList,
  NodeVisitor,
  type SourceFile,
  type TypePredicateNode,
  type IndexedAccessTypeNode,
  type TupleTypeNode,
  getComment,
  getElements,
  getExpression,
  getName,
  getParameters,
  getText,
  getNodeId,
  getStatements,
  getType,
  getTypeParameters,
  type HeritageClause,
  getHeritageClauses,
  getFlowNode,
  NodeFlags,
} from './ast.js';
import { SyntaxKind } from './syntax-kind.js';
import {
  getSourceFileOfNode,
  isEnumConst,
  isExternalOrCommonJSModule,
  isPotentiallyExecutableNode,
} from './binder-utilities.js';
import type { Checker } from './checker.js';
import { ElementFlags, type MappedType, NodeCheckFlags, TypePredicateKind } from './checker-types.js';
import { getSignatureFromDeclaration, getTypePredicateOfSignature } from './checker-signatures.js';
import { getConstraintTypeFromMappedType, getNameTypeFromMappedType } from './checker-type-operators.js';
import { checkTypeAssignableTo, checkTypeRelatedTo } from './relations.js';
import { Diagnostic, chainDiagnostic } from './diagnostics.js';
import { skipTrivia } from './scanner.js';
import { nodeIsMissing } from './ast-utilities.js';
import { getAttachedJSDoc } from './parser.js';
import { shouldPreserveConstEnums } from './options.js';
import { isReachableFlowNode } from './checker-narrowing.js';
import {
  getTupleElementFlags,
  getTypeFromIndexedAccessTypeNode,
  getTypeFromTypeNode,
  isAssertionExpression,
} from './checker-type-nodes.js';
import { isArrayLikeType } from './checker-members.js';
import {
  checkBlock,
  checkDoStatement,
  checkExpressionStatement,
  checkForInStatement,
  checkForOfStatement,
  checkForStatement,
  checkIfStatement,
  checkLabeledStatement,
  checkReturnStatement,
  checkSwitchStatement,
  checkThrowStatement,
  checkTryStatement,
  checkWhileStatement,
} from './checker-statements.js';
import {
  checkEnumDeclaration,
  checkEnumMember,
  checkExternalModuleExports,
  checkFunctionDeclaration,
  checkModuleDeclaration,
  checkTypeAliasDeclaration,
  checkTypeArgumentConstraintsOfReference,
  checkTypeParameter,
  checkTypeParameterDeferred,
  checkTypeParameters,
  checkVariableStatement,
  checkVariableLikeDeclaration,
  checkUnusedRenamedBindingElements,
  isInstantiatedModule,
} from './checker-declarations.js';
import {
  checkExportAssignment,
  checkExportDeclaration,
  checkImportAttributes,
  checkImportDeclaration,
  checkImportEqualsDeclaration,
  resolveJSDocMemberName,
} from './checker-modules.js';
import {
  checkAccessorDeclaration,
  checkClassDeclaration,
  checkClassLikeDeferred,
  checkInterfaceDeclaration,
} from './checker-classes.js';
import { checkJsxElementDeferred } from './checker-jsx.js';
import {
  checkAssertionDeferred,
  checkComputedPropertyName,
  checkExpression,
  checkIndexedAccessIndexType,
  isConstTypeReference,
} from './checker-expressions.js';
import { checkFunctionLikeBody } from './checker-functions.js';
import { checkFunctionOrMethodSymbols } from './checker-overloads.js';
import { checkInferTypeParameterDeclarations, checkTypeLiteralMembers } from './checker-heritage.js';
import { checkGrammarSourceFile } from './checker-grammar.js';
import { Diagnostics } from './diagnostic-messages.js';
import { getTypeOfSymbol, reportImplicitAny } from './checker-symbol-types.js';
import { getSymbolOfDeclaration } from './checker-symbols.js';
import { checkUnusedIdentifiers } from './checker-unused.js';
import { checkContextualDeprecations, checkDeprecatedTypeReference } from './checker-deprecation.js';

/**
 * Checks `file` once; diagnostics accumulate in the checker. `checkUnused` also reports unused
 * identifiers, which need the whole file checked first.
 */
export function checkSourceFile(c: Checker, file: SourceFile, checkUnused = false): void {
  const links = c.nodeLinks(file);
  if ((links.flags & NodeCheckFlags.TypeChecked) === 0) {
    links.flags |= NodeCheckFlags.TypeChecked;
    checkSourceFileWorker(c, file);
  }
  if (checkUnused && (links.flags & NodeCheckFlags.UnusedChecked) === 0) {
    links.flags |= NodeCheckFlags.UnusedChecked;
    checkUnusedIdentifiers(c, file);
  }
}

function checkSourceFileWorker(c: Checker, file: SourceFile): void {
  c.fileBeingChecked = file;
  for (const statement of getStatements(file)!.nodes) checkSourceElement(c, statement);
  checkDeferredNodes(c, file);
  if (isExternalOrCommonJSModule(file)) checkExternalModuleExports(c, file);
  if (!file.isDeclarationFile) checkUnusedRenamedBindingElements(c);
  else c.renamedBindingElementsInTypes.length = 0;
  // Grammar checks run last so the types they need are created in tsgo's order.
  checkGrammarSourceFile(c, file);
  // Expressions first checked by grammar checks may defer more nodes.
  checkDeferredNodes(c, file);
  checkPendingExternalEmitHelpers(c, file);
  c.fileBeingChecked = undefined;
  produceDeferredDiagnostics(c);
  // The file's deferred nodes are all checked; later ones are not queued (checkNodeDeferred).
  const links = c.nodeLinks(file);
  links.typeChecked = true;
  links.deferredNodes = undefined;
}

/**
 * Checks the statements `start` to `end` of the declaration file `file`, one of the ranges that several
 * checkers check it in (parallel-check.ts), and returns whether the checker then has diagnostics in the
 * file. The range ending the file also runs the checks of the whole file. The file is not marked checked.
 *
 * When no range finds a diagnostic in the file, checking it whole would find none either: each statement
 * is checked by the checker of its range. Otherwise the file is checked whole (`startParallelCheck`): the
 * diagnostics of the ranges can differ from the file's, where they depend on the order the file's
 * declarations are resolved in. A union type prints its members in the order the checker created them,
 * and a check that a symbol's first declaration runs reports on all its declarations.
 */
export function checkSourceFileRange(c: Checker, file: SourceFile, start: number, end: number): boolean {
  const statements = getStatements(file)!.nodes;
  c.fileBeingChecked = file;
  for (let i = start; i < end; i++) checkSourceElement(c, statements[i]!);
  checkDeferredNodes(c, file);
  const whole = end === statements.length;
  if (whole && isExternalOrCommonJSModule(file)) checkExternalModuleExports(c, file);
  c.renamedBindingElementsInTypes.length = 0;
  if (whole) {
    checkGrammarSourceFile(c, file);
    checkDeferredNodes(c, file);
    checkPendingExternalEmitHelpers(c, file);
  }
  c.fileBeingChecked = undefined;
  produceDeferredDiagnostics(c);
  // Deferred nodes of a later range are queued again (checkNodeDeferred).
  c.nodeLinks(file).deferredNodes = undefined;
  return c.diagnostics.forFile(file.fileName).length > 0;
}

/**
 * Reports the deferred diagnostics, in the order they were deferred. Diagnostics deferred while they
 * are reported are dropped.
 */
export function produceDeferredDiagnostics(c: Checker): void {
  const callbacks = c.deferredDiagnostics;
  if (callbacks.length === 0) return;
  const count = callbacks.length;
  for (let i = 0; i < count; i++) callbacks[i]!();
  c.deferredDiagnostics = [];
}

/** Checks a statement, declaration, class member or type node. */
export function checkSourceElement(c: Checker, node: Node | undefined): void {
  if (node === undefined) return;
  const saveCurrentNode = c.currentNode;
  const saveWithinUnreachableCode = c.withinUnreachableCode;
  c.currentNode = node;
  c.instantiationCount = 0;
  checkSourceElementWorker(c, node);
  c.currentNode = saveCurrentNode;
  c.withinUnreachableCode = saveWithinUnreachableCode;
}

/** Reports a statement that can't be reached, with the unreachable statements after it. */
function checkSourceElementUnreachable(c: Checker, node: Node): boolean {
  if (!isPotentiallyExecutableNode(node)) return false;
  if (c.reportedUnreachableNodes.has(node)) return true;
  if (!isSourceElementUnreachable(c, node)) return false;
  c.reportedUnreachableNodes.add(node);
  const file = getSourceFileOfNode(node);
  let endNode = node;
  const parent = node.parent!;
  const statements = getStatements(parent)?.nodes;
  if (statements !== undefined) {
    const offset = statements.indexOf(node);
    if (offset >= 0)
      for (let i = offset + 1; i < statements.length; i++) {
        const next = statements[i]!;
        if (!isPotentiallyExecutableNode(next) || !isSourceElementUnreachable(c, next)) break;
        endNode = next;
        c.reportedUnreachableNodes.add(next);
      }
  }
  // A missing statement starts where it ends, before the trivia of the next token.
  const start = nodeIsMissing(node) ? node.pos : skipTrivia(file.text, node.pos);
  const diagnostic = new Diagnostic(
    file.diagnosticFile(),
    start,
    endNode.end,
    Diagnostics.Unreachable_code_detected,
    [],
  );
  c.addErrorOrSuggestion(c.compilerOptions.allowUnreachableCode === false, diagnostic);
  return true;
}

function isSourceElementUnreachable(c: Checker, node: Node): boolean {
  if ((node.flags & NodeFlags.Unreachable) !== 0) {
    // The binder knows the code is unreachable; const enums only count when preserved.
    if (node.kind === SyntaxKind.EnumDeclaration)
      return !isEnumConst(node) || shouldPreserveConstEnums(c.compilerOptions);
    if (node.kind === SyntaxKind.ModuleDeclaration)
      return isInstantiatedModule(node, shouldPreserveConstEnums(c.compilerOptions));
    return true;
  }
  // Otherwise control flow decides, through assertion calls for example.
  const flowNode = getFlowNode(node);
  return flowNode !== undefined && !isReachableFlowNode(c, flowNode);
}

/** Resolves the `@link` names of a node's JSDoc, which marks what they name referenced. */
export function checkJSDocLinksOfNode(c: Checker, node: Node): void {
  const jsDoc = getAttachedJSDoc(node);
  if (jsDoc !== undefined) for (const d of jsDoc) checkJSDocLinks(c, d);
}

function checkSourceElementWorker(c: Checker, node: Node): void {
  checkJSDocLinksOfNode(c, node);
  if (
    !c.withinUnreachableCode &&
    c.compilerOptions.allowUnreachableCode !== true &&
    checkSourceElementUnreachable(c, node)
  )
    c.withinUnreachableCode = true;
  switch (node.kind) {
    // Statements
    case SyntaxKind.Block:
    case SyntaxKind.ModuleBlock:
      checkBlock(c, node);
      return;
    case SyntaxKind.EmptyStatement:
    case SyntaxKind.DebuggerStatement:
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
      return;
    case SyntaxKind.VariableStatement:
      checkVariableStatement(c, node);
      return;
    case SyntaxKind.ExpressionStatement:
      checkExpressionStatement(c, node);
      return;
    case SyntaxKind.IfStatement:
      checkIfStatement(c, node);
      return;
    case SyntaxKind.DoStatement:
      checkDoStatement(c, node);
      return;
    case SyntaxKind.WhileStatement:
      checkWhileStatement(c, node);
      return;
    case SyntaxKind.ForStatement:
      checkForStatement(c, node);
      return;
    case SyntaxKind.ForInStatement:
      checkForInStatement(c, node);
      return;
    case SyntaxKind.ForOfStatement:
      checkForOfStatement(c, node);
      return;
    case SyntaxKind.ReturnStatement:
      checkReturnStatement(c, node);
      return;
    case SyntaxKind.SwitchStatement:
      checkSwitchStatement(c, node);
      return;
    case SyntaxKind.LabeledStatement:
      checkLabeledStatement(c, node);
      return;
    case SyntaxKind.ThrowStatement:
      checkThrowStatement(c, node);
      return;
    case SyntaxKind.TryStatement:
      checkTryStatement(c, node);
      return;
    case SyntaxKind.WithStatement:
      // The body isn't checked: every name in it has type `any`.
      checkExpression(c, getExpression(node)!);
      return;
    // Declarations
    case SyntaxKind.FunctionDeclaration:
      checkFunctionDeclaration(c, node);
      return;
    case SyntaxKind.ClassDeclaration:
      checkClassDeclaration(c, node);
      return;
    case SyntaxKind.InterfaceDeclaration:
      checkInterfaceDeclaration(c, node);
      return;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      checkTypeAliasDeclaration(c, node);
      return;
    case SyntaxKind.EnumDeclaration:
      checkEnumDeclaration(c, node);
      return;
    case SyntaxKind.EnumMember:
      checkEnumMember(c, node);
      return;
    case SyntaxKind.ModuleDeclaration:
      checkModuleDeclaration(c, node);
      return;
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      checkImportDeclaration(c, node);
      return;
    case SyntaxKind.ImportEqualsDeclaration:
      checkImportEqualsDeclaration(c, node);
      return;
    case SyntaxKind.ExportDeclaration:
      checkExportDeclaration(c, node);
      return;
    case SyntaxKind.ExportAssignment:
      checkExportAssignment(c, node);
      return;
    case SyntaxKind.NamespaceExportDeclaration:
    case SyntaxKind.MissingDeclaration:
      return;
    case SyntaxKind.TypeParameter:
      checkTypeParameter(c, node);
      return;
  }
  checkTypeNode(c, node);
}

// ---- JSDoc

/** Resolves the names of `{@link}` tags in a JSDoc comment and its tags, which references them. */
function checkJSDocLinks(c: Checker, jsDoc: Node): void {
  checkJSDocCommentLinks(c, getComment(jsDoc));
  const tags = jsDoc.kind === SyntaxKind.JSDoc ? (jsDoc as JSDoc).tags : undefined;
  if (tags !== undefined) for (const tag of tags.nodes) checkJSDocCommentLinks(c, getComment(tag));
}

function checkJSDocCommentLinks(c: Checker, comments: NodeList | undefined): void {
  if (comments === undefined) return;
  for (const comment of comments.nodes)
    if (
      comment.kind === SyntaxKind.JSDocLink ||
      comment.kind === SyntaxKind.JSDocLinkCode ||
      comment.kind === SyntaxKind.JSDocLinkPlain
    )
      resolveJSDocMemberName(c, getName(comment));
}

// ---- Type nodes

/** Resolves every type reference in a type annotation, reporting unresolved names and constraint errors. */
export function checkTypeNodeIfPresent(c: Checker, node: Node | undefined): void {
  if (node !== undefined) checkTypeNode(c, node);
}

/** Implicit `any` return types of signatures without annotations. */
function checkSignatureMember(c: Checker, node: Node): void {
  if (getType(node) !== undefined || !c.noImplicitAny) return;
  if (node.kind === SyntaxKind.MethodSignature) reportImplicitAny(c, node, c.anyType);
  else if (node.kind === SyntaxKind.CallSignature)
    c.error(node, Diagnostics.Call_signature_which_lacks_return_type_annotation_implicitly_has_an_any_return_type);
  else
    c.error(node, Diagnostics.Construct_signature_which_lacks_return_type_annotation_implicitly_has_an_any_return_type);
}

function checkTypeNode(c: Checker, node: Node): void {
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  c.instantiationCount = 0;
  checkTypeNodeWorker(c, node);
  c.currentNode = saveCurrentNode;
}

function isTypeReferenceHeritageElement(node: Node): boolean {
  const clause = node.parent;
  if (clause === undefined || clause.kind !== SyntaxKind.HeritageClause) return false;
  const token = (clause as HeritageClause).token;
  if ((token === SyntaxKind.ImplementsKeyword) === (clause.parent!.kind === SyntaxKind.InterfaceDeclaration))
    return false;
  // Only the first clause of each kind counts.
  for (const other of getHeritageClauses(clause.parent!)!.nodes)
    if ((other as HeritageClause).token === token) return other === clause;
  return false;
}

function checkTypeNodeWorker(c: Checker, node: Node): void {
  switch (node.kind) {
    case SyntaxKind.TypePredicate:
      checkTypePredicate(c, node as TypePredicateNode);
      return;
    case SyntaxKind.MethodSignature:
    case SyntaxKind.CallSignature:
    case SyntaxKind.ConstructSignature: {
      checkTypeParameters(c, getTypeParameters(node));
      checkSignatureMember(c, node);
      const name = getName(node);
      if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
      break;
    }
    case SyntaxKind.FunctionType:
    case SyntaxKind.ConstructorType:
      checkTypeParameters(c, getTypeParameters(node));
      break;
    case SyntaxKind.TypeReference:
    case SyntaxKind.ImportType: {
      // `const` in `x as const` is not checked as a type: its type is the type of `x`.
      if (isConstTypeReference(node) && isAssertionExpression(node.parent!)) break;
      const type = getTypeFromTypeNode(c, node);
      checkTypeArgumentConstraintsOfReference(c, node, type);
      checkDeprecatedTypeReference(c, node, type);
      if (node.kind === SyntaxKind.ImportType) checkImportAttributes(c, node);
      break;
    }
    case SyntaxKind.IndexedAccessType:
      // The indexed access type itself, not the substitution type of a conditional type's true branch.
      checkIndexedAccessIndexType(c, getTypeFromIndexedAccessTypeNode(c, node as IndexedAccessTypeNode), node);
      break;
    case SyntaxKind.TupleType:
      checkTupleRestElements(c, node as TupleTypeNode);
      getTypeFromTypeNode(c, node);
    case SyntaxKind.ExpressionWithTypeArguments:
      // Implemented types and interface base types are type references; class base types are
      // checked with the base constructor's type parameters.
      if (isTypeReferenceHeritageElement(node))
        checkTypeArgumentConstraintsOfReference(c, node, getTypeFromTypeNode(c, node));
      break;
    case SyntaxKind.TypeQuery:
    case SyntaxKind.TypeOperator:
    case SyntaxKind.LiteralType:
    case SyntaxKind.ThisType:
      getTypeFromTypeNode(c, node);
      break;
  }
  // Type arguments of an import type are only resolved with its type.
  if (node.kind === SyntaxKind.ImportType) {
    checkTypeNode(c, (node as ImportTypeNode).argument);
    return;
  }
  // Type arguments of a type query are checked with its type.
  if (node.kind === SyntaxKind.TypeQuery) return;
  if (node.kind === SyntaxKind.MappedType) {
    checkMappedType(c, node as MappedTypeNode);
    return;
  }
  if (node.kind === SyntaxKind.TemplateLiteralType) {
    checkTemplateLiteralType(c, node as TemplateLiteralTypeNode);
    return;
  }
  node.forEachChild(c.typeNodeVisitor);
  // Unions and intersections are resolved after their constituents.
  if (node.kind === SyntaxKind.UnionType || node.kind === SyntaxKind.IntersectionType) getTypeFromTypeNode(c, node);
  if (node.kind === SyntaxKind.MethodSignature) checkFunctionOrMethodSymbols(c, node);
  else if (node.kind === SyntaxKind.TypeLiteral) checkTypeLiteralMembers(c, node);
}

/** Checks that each span of a template literal type can be written in a template, then its type. */
function checkTemplateLiteralType(c: Checker, node: TemplateLiteralTypeNode): void {
  for (const span of node.templateSpans.nodes) {
    const spanType = (span as TemplateLiteralTypeSpan).type;
    checkTypeNode(c, spanType);
    checkTypeAssignableTo(c, getTypeFromTypeNode(c, spanType), c.templateConstraintType, spanType, undefined);
  }
  getTypeFromTypeNode(c, node);
}

/** Checks a mapped type's parts before its type, which resolves the constraint eagerly. */
function checkMappedType(c: Checker, node: MappedTypeNode): void {
  checkTypeParameter(c, node.typeParameter);
  checkTypeNodeIfPresent(c, node.nameType);
  checkTypeNodeIfPresent(c, node.type);
  if (node.type === undefined) reportImplicitAny(c, node, c.anyType);
  const t = getTypeFromTypeNode(c, node) as MappedType;
  const nameType = getNameTypeFromMappedType(c, t);
  if (nameType !== undefined) checkTypeAssignableTo(c, nameType, c.stringNumberSymbolType, node.nameType, undefined);
  else
    checkTypeAssignableTo(
      c,
      getConstraintTypeFromMappedType(c, t),
      c.stringNumberSymbolType,
      node.typeParameter.constraint,
      undefined,
    );
}

function checkTypePredicate(c: Checker, node: TypePredicateNode): void {
  // The predicate's type is checked also in a position a predicate can't have.
  checkTypeNodeIfPresent(c, node.type);
  const parent = getTypePredicateParent(node);
  if (parent === undefined) {
    c.error(node, Diagnostics.A_type_predicate_is_only_allowed_in_return_type_position_for_functions_and_methods);
    return;
  }
  const signature = getSignatureFromDeclaration(c, parent);
  const typePredicate = getTypePredicateOfSignature(c, signature);
  if (typePredicate === undefined) return;
  if (typePredicate.kind === TypePredicateKind.This || typePredicate.kind === TypePredicateKind.AssertsThis) return;
  const parameterName = node.parameterName;
  if (typePredicate.parameterIndex >= 0) {
    if (signature.hasRestParameter() && typePredicate.parameterIndex === signature.parameters.length - 1)
      c.error(parameterName, Diagnostics.A_type_predicate_cannot_reference_a_rest_parameter);
    else if (typePredicate.type !== undefined) {
      const diagnostics: Diagnostic[] = [];
      if (
        !checkTypeRelatedTo(
          c,
          typePredicate.type,
          getTypeOfSymbol(c, signature.parameters[typePredicate.parameterIndex]!),
          c.assignableRelation,
          node.type,
          undefined,
          diagnostics,
        )
      )
        c.addDiagnostic(
          chainDiagnostic(
            diagnostics[0]!,
            Diagnostics.A_type_predicate_s_type_must_be_assignable_to_its_parameter_s_type,
          ),
        );
    }
    return;
  }
  for (const param of getParameters(parent)!.nodes) {
    const name = getName(param)!;
    if (
      (name.kind === SyntaxKind.ObjectBindingPattern || name.kind === SyntaxKind.ArrayBindingPattern) &&
      checkIfTypePredicateVariableIsDeclaredInBindingPattern(c, name, parameterName, typePredicate.parameterName)
    )
      return;
  }
  c.error(parameterName, Diagnostics.Cannot_find_parameter_0, typePredicate.parameterName);
}

/** The signature whose return type is the type predicate, if it is in a valid position. */
function getTypePredicateParent(node: Node): Node | undefined {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.CallSignature:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.FunctionType:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      if (getType(parent) === node) return parent;
  }
  return undefined;
}

function checkIfTypePredicateVariableIsDeclaredInBindingPattern(
  c: Checker,
  pattern: Node,
  predicateVariableNode: Node,
  predicateVariableName: string,
): boolean {
  for (const element of getElements(pattern)!.nodes) {
    const name = getName(element);
    if (name === undefined) continue;
    if (name.kind === SyntaxKind.Identifier && getText(name) === predicateVariableName) {
      c.error(
        predicateVariableNode,
        Diagnostics.A_type_predicate_cannot_reference_element_0_in_a_binding_pattern,
        predicateVariableName,
      );
      return true;
    }
    if (
      (name.kind === SyntaxKind.ArrayBindingPattern || name.kind === SyntaxKind.ObjectBindingPattern) &&
      checkIfTypePredicateVariableIsDeclaredInBindingPattern(c, name, predicateVariableNode, predicateVariableName)
    )
      return true;
  }
  return false;
}

/** Checks an accessor of a type literal or interface. */
function checkTypeMemberAccessor(c: Checker, node: Node): void {
  const name = getName(node);
  if (name !== undefined && name.kind === SyntaxKind.ComputedPropertyName) checkComputedPropertyName(c, name);
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getTypeOfSymbol(c, symbol);
  checkFunctionLikeBody(c, node);
  checkAccessorDeclaration(c, node);
}

/** Variadic tuple elements must be array-like. */
function checkTupleRestElements(c: Checker, node: TupleTypeNode): void {
  for (const e of node.elements.nodes) {
    if ((getTupleElementFlags(c, e) & ElementFlags.Variadic) === 0) continue;
    if (!isArrayLikeType(c, getTypeFromTypeNode(c, getType(e)!))) {
      c.error(e, Diagnostics.A_rest_element_type_must_be_an_array_type);
      return;
    }
  }
}

/** Visits the children of a type node; owned by the checker to avoid per-node allocation. */
export class TypeNodeVisitor extends NodeVisitor {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  visitNode(node: Node): boolean {
    // Type members and their parameters are source elements in tsgo, whose JSDoc links count as uses.
    checkJSDocLinksOfNode(this.c, node);
    switch (node.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.QualifiedName:
      case SyntaxKind.StringLiteral:
      case SyntaxKind.NumericLiteral:
        return false;
      case SyntaxKind.Parameter:
        checkVariableLikeDeclaration(this.c, node);
        return false;
      case SyntaxKind.MethodSignature:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
        checkTypeNode(this.c, node);
        return false;
      case SyntaxKind.PropertySignature:
        checkVariableLikeDeclaration(this.c, node);
        return false;
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        checkTypeMemberAccessor(this.c, node);
        return false;
      case SyntaxKind.IndexSignature:
        node.forEachChild(this);
        return false;
      case SyntaxKind.TypeParameter:
        // Lists of signatures are checked as a whole; `infer` and mapped type parameters alone.
        if (node.parent!.kind === SyntaxKind.InferType || node.parent!.kind === SyntaxKind.MappedType)
          checkTypeParameter(this.c, node);
        if (node.parent!.kind === SyntaxKind.InferType) {
          const symbol = getSymbolOfDeclaration(this.c, node);
          if (symbol !== undefined) checkInferTypeParameterDeclarations(this.c, symbol);
        }
        return false;
    }
    if (node.kind >= SyntaxKind.FirstTypeNode && node.kind <= SyntaxKind.LastTypeNode) checkTypeNode(this.c, node);
    else if (node.kind === SyntaxKind.ExpressionWithTypeArguments) checkTypeNode(this.c, node);
    return false;
  }
}

// ---- Deferred checks

/**
 * Queues a function expression, arrow, accessor, class expression or other deferred node to check with
 * its file, like tsgo: nodes wait in the links of their own source file and are checked when that file
 * is checked, and nodes of files this checker has already checked are not queued again. Checking one
 * file often defers nodes of others (inferring a function's return type checks its body), and those
 * belong to whichever checker checks the other file.
 */
export function checkNodeDeferred(c: Checker, node: Node): void {
  const links = c.nodeLinks(getSourceFileOfNode(node));
  if (links.typeChecked) return;
  const id = getNodeId(node);
  if (c.deferredNodeIds.has(id)) return;
  c.deferredNodeIds.add(id);
  let nodes = links.deferredNodes;
  if (nodes === undefined) {
    nodes = [];
    links.deferredNodes = nodes;
  }
  nodes.push(node);
}

function checkDeferredNodes(c: Checker, file: SourceFile): void {
  const nodes = c.nodeLinks(file).deferredNodes;
  if (nodes === undefined) return;
  // Deferred checks may defer more nodes.
  for (let i = 0; i < nodes.length; i++) checkDeferredNode(c, nodes[i]!);
  nodes.length = 0;
}

/** Resolves the type of an object literal accessor, which reports accessors implicitly typed `any`. */
function checkObjectLiteralAccessorType(c: Checker, node: Node): void {
  if (node.parent!.kind !== SyntaxKind.ObjectLiteralExpression) return;
  const symbol = getSymbolOfDeclaration(c, node);
  if (symbol !== undefined) getTypeOfSymbol(c, symbol);
}

function checkDeferredNode(c: Checker, node: Node): void {
  const saveCurrentNode = c.currentNode;
  c.currentNode = node;
  c.instantiationCount = 0;
  switch (node.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
      // Deferred when overload resolution fails, so that the arguments are checked once.
      resolveUntypedCall(c, node);
      break;
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
      checkFunctionLikeBody(c, node);
      break;
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      checkObjectLiteralAccessorType(c, node);
      checkFunctionLikeBody(c, node);
      if (node.parent!.kind === SyntaxKind.ObjectLiteralExpression) checkAccessorDeclaration(c, node);
      break;
    case SyntaxKind.ClassExpression:
      checkClassLikeDeferred(c, node);
      break;
    case SyntaxKind.ObjectLiteralExpression: {
      // Reported only as suggestions, which are computed when they are asked for (`getSuggestionDiagnostics`).
      const file = getSourceFileOfNode(node);
      const pending = c.objectLiteralsForDeprecations.get(file);
      if (pending === undefined) c.objectLiteralsForDeprecations.set(file, [node]);
      else pending.push(node);
      break;
    }
    case SyntaxKind.JsxAttributes:
      checkContextualDeprecations(c, node);
      break;
    case SyntaxKind.AsExpression:
    case SyntaxKind.TypeAssertionExpression:
      checkAssertionDeferred(c, node);
      break;
    case SyntaxKind.TypeParameter:
      checkTypeParameterDeferred(c, node);
      break;
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
      checkJsxElementDeferred(c, node);
      break;
    case SyntaxKind.VoidExpression:
      checkExpression(c, getExpression(node)!);
      break;
  }
  c.currentNode = saveCurrentNode;
}
