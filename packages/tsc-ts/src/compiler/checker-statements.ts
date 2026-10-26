// Statements.
import {
  type CaseOrDefaultClause,
  type CatchClause,
  type DoStatement,
  type ForInOrOfStatement,
  type ForStatement,
  type IfStatement,
  type LabeledStatement,
  type Node,
  type ReturnStatement,
  type SwitchStatement,
  type TryStatement,
  type VariableDeclarationList,
  type WhileStatement,
  getExpression,
  getStatements,
  getName,
  NodeFlags,
} from './ast.js';
import { Diagnostics } from './diagnostics.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import { CheckMode, type Type, TypeFlags } from './checker-types.js';
import {
  getReturnTypeFromAnnotation,
  getReturnTypeOfSignature,
  getSignatureFromDeclaration,
} from './checker-signatures.js';
import {
  checkExpression,
  checkExpressionCached,
  checkNonNullExpression,
  checkTypeAssignableToAndOptionallyElaborate,
} from './checker-expressions.js';
import { IterationUse, checkIteratedTypeOrElementType } from './checker-iteration.js';
import { checkDestructuringAssignment } from './checker-destructuring.js';
import {
  checkReferenceExpression,
  checkTestingKnownTruthyType,
  checkTruthinessExpression,
  isTypeEqualityComparableTo,
} from './checker-operators.js';
import { checkTypeComparableTo, isTypeAssignableTo } from './relations.js';
import { isReachableFlowNode } from './checker-narrowing.js';
import { getIndexType, isTypeAssignableToKindEx as isTypeAssignableToKind } from './checker-type-operators.js';
import { getExtractStringType } from './checker-symbol-types.js';
import { checkSourceElement } from './checker-source-file.js';
import { checkVariableDeclarationList, checkVariableLikeDeclaration } from './checker-declarations.js';
import { checkReturnExpression, isUnwrappedReturnTypeUndefinedVoidOrAny } from './checker-functions.js';
import { unwrapReturnType } from './checker-iteration.js';
import { FunctionFlags, getFunctionFlags, isBindingPattern } from './checker-utilities.js';
import { getContainingFunctionOrClassStaticBlock } from './checker-grammar.js';
import { ScriptTarget } from './options.js';
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import { typeToString } from './type-printer.js';
import { TypeFacts, getNonNullableType, hasTypeFacts } from './checker-flow.js';

export function checkBlock(c: Checker, node: Node): void {
  for (const s of getStatements(node)!.nodes) checkSourceElement(c, s);
}

export function checkExpressionStatement(c: Checker, node: Node): void {
  checkExpression(c, getExpression(node)!);
}

export function checkIfStatement(c: Checker, node: Node): void {
  const s = node as IfStatement;
  const t = checkTruthinessExpression(c, s.expression, CheckMode.Normal);
  checkTestingKnownTruthyType(c, s.expression, t, s.thenStatement);
  checkSourceElement(c, s.thenStatement);
  if (s.thenStatement.kind === SyntaxKind.EmptyStatement)
    c.error(s.thenStatement, Diagnostics.The_body_of_an_if_statement_cannot_be_the_empty_statement);
  checkSourceElement(c, s.elseStatement);
}

export function checkDoStatement(c: Checker, node: Node): void {
  const s = node as DoStatement;
  checkSourceElement(c, s.statement);
  checkTruthinessExpression(c, s.expression, CheckMode.Normal);
}

export function checkWhileStatement(c: Checker, node: Node): void {
  const s = node as WhileStatement;
  checkTruthinessExpression(c, s.expression, CheckMode.Normal);
  checkSourceElement(c, s.statement);
}

export function checkForStatement(c: Checker, node: Node): void {
  const s = node as ForStatement;
  const initializer = s.initializer;
  if (initializer !== undefined) {
    if (initializer.kind === SyntaxKind.VariableDeclarationList) checkVariableDeclarationList(c, initializer);
    else checkExpression(c, initializer);
  }
  if (s.condition !== undefined) checkTruthinessExpression(c, s.condition, CheckMode.Normal);
  if (s.incrementor !== undefined) checkExpression(c, s.incrementor);
  checkSourceElement(c, s.statement);
}

export function checkForInStatement(c: Checker, node: Node): void {
  const s = node as ForInOrOfStatement;
  const expressionType = checkExpression(c, s.expression);
  const rightType = hasTypeFacts(c, expressionType, TypeFacts.IsUndefinedOrNull)
    ? getNonNullableType(c, expressionType)
    : expressionType;
  if (s.initializer.kind === SyntaxKind.VariableDeclarationList) {
    const declarations = (s.initializer as VariableDeclarationList).declarations.nodes;
    if (declarations.length !== 0 && isBindingPattern(getName(declarations[0]!)))
      c.error(
        getName(declarations[0]!)!,
        Diagnostics.The_left_hand_side_of_a_for_in_statement_cannot_be_a_destructuring_pattern,
      );
    for (const d of declarations) checkVariableLikeDeclaration(c, d);
  } else {
    // The variable must be a reference that the keys of the object, as strings, are assignable to.
    const varExpr = s.initializer;
    const leftType = checkExpression(c, varExpr);
    if (varExpr.kind === SyntaxKind.ArrayLiteralExpression || varExpr.kind === SyntaxKind.ObjectLiteralExpression)
      c.error(varExpr, Diagnostics.The_left_hand_side_of_a_for_in_statement_cannot_be_a_destructuring_pattern);
    else if (!isTypeAssignableTo(c, getIndexTypeOrString(c, rightType), leftType))
      c.error(varExpr, Diagnostics.The_left_hand_side_of_a_for_in_statement_must_be_of_type_string_or_any);
    else
      checkReferenceExpression(
        c,
        varExpr,
        Diagnostics.The_left_hand_side_of_a_for_in_statement_must_be_a_variable_or_a_property_access,
        Diagnostics.The_left_hand_side_of_a_for_in_statement_may_not_be_an_optional_property_access,
      );
  }
  if (
    (rightType.flags & TypeFlags.Never) !== 0 ||
    !isTypeAssignableToKind(c, rightType, TypeFlags.NonPrimitive | TypeFlags.InstantiableNonPrimitive, false)
  )
    c.error(
      s.expression,
      Diagnostics.The_right_hand_side_of_a_for_in_statement_must_be_of_type_any_an_object_type_or_a_type_parameter_but_here_has_type_0,
      typeToString(c, rightType),
    );
  checkSourceElement(c, s.statement);
}

function getIndexTypeOrString(c: Checker, t: Type): Type {
  const indexType = getExtractStringType(c, getIndexType(c, t));
  return (indexType.flags & TypeFlags.Never) !== 0 ? c.stringType : indexType;
}

export function checkForOfStatement(c: Checker, node: Node): void {
  const s = node as ForInOrOfStatement;
  // for await..of in an async function before ES2018 uses __asyncValues.
  if (s.awaitModifier !== undefined) {
    const container = getContainingFunctionOrClassStaticBlock(node);
    if (
      (container === undefined || container.kind !== SyntaxKind.ClassStaticBlockDeclaration) &&
      (getFunctionFlags(container) & (FunctionFlags.Invalid | FunctionFlags.Async)) === FunctionFlags.Async &&
      c.languageVersion < ScriptTarget.ES2018
    )
      checkExternalEmitHelpers(c, node, ExternalEmitHelpers.ForAwaitOfIncludes);
  }
  // A declaration checks the right side through its type; an expression is checked as a
  // destructuring assignment or a reference the iterated type must be assignable to.
  if (s.initializer.kind === SyntaxKind.VariableDeclarationList) {
    for (const d of (s.initializer as VariableDeclarationList).declarations.nodes) checkVariableLikeDeclaration(c, d);
  } else {
    const varExpr = s.initializer;
    const iteratedType = checkRightHandSideOfForOf(c, s);
    if (varExpr.kind === SyntaxKind.ArrayLiteralExpression || varExpr.kind === SyntaxKind.ObjectLiteralExpression)
      checkDestructuringAssignment(c, varExpr, iteratedType, CheckMode.Normal, false);
    else {
      const leftType = checkExpression(c, varExpr);
      checkReferenceExpression(
        c,
        varExpr,
        Diagnostics.The_left_hand_side_of_a_for_of_statement_must_be_a_variable_or_a_property_access,
        Diagnostics.The_left_hand_side_of_a_for_of_statement_may_not_be_an_optional_property_access,
      );
      checkTypeAssignableToAndOptionallyElaborate(c, iteratedType, leftType, varExpr, s.expression);
    }
  }
  checkSourceElement(c, s.statement);
}

/** The element type a `for...of` produces. */
export function checkRightHandSideOfForOf(c: Checker, statement: Node): Type {
  const s = statement as ForInOrOfStatement;
  const use = s.awaitModifier !== undefined ? IterationUse.ForAwaitOf : IterationUse.ForOf;
  return checkIteratedTypeOrElementType(c, use, checkNonNullExpression(c, s.expression), c.undefinedType, s.expression);
}

export function checkReturnStatement(c: Checker, node: Node): void {
  const s = node as ReturnStatement;
  // The expression is checked also where a return statement is a grammar error.
  const exprNode = s.expression;
  const exprType = exprNode !== undefined ? checkExpressionCached(c, exprNode) : c.undefinedType;
  const container = getContainingFunction(node);
  // Returns outside functions and in static blocks are grammar errors.
  if (container === undefined) return;
  const signature = getSignatureFromDeclaration(c, container);
  const returnType = getReturnTypeOfSignature(c, signature);
  const functionFlags = getFunctionFlags(container);
  if (c.strictNullChecks || exprNode !== undefined || (returnType.flags & TypeFlags.Never) !== 0) {
    if (container.kind === SyntaxKind.SetAccessor) {
      if (exprNode !== undefined) c.error(node, Diagnostics.Setters_cannot_return_a_value);
    } else if (container.kind === SyntaxKind.Constructor) {
      if (
        exprNode !== undefined &&
        !checkTypeAssignableToAndOptionallyElaborate(c, exprType, returnType, node, exprNode)
      )
        c.error(
          node,
          Diagnostics.Return_type_of_constructor_signature_must_be_assignable_to_the_instance_type_of_the_class,
        );
    } else if (getReturnTypeFromAnnotation(c, container) !== undefined) {
      const unwrappedReturnType = unwrapReturnType(c, returnType, functionFlags);
      checkReturnExpression(c, container, unwrappedReturnType, node, exprNode, exprType, false);
    }
  } else if (
    container.kind !== SyntaxKind.Constructor &&
    c.compilerOptions.noImplicitReturns === true &&
    !isUnwrappedReturnTypeUndefinedVoidOrAny(c, container, returnType)
  )
    // The function has a return type, but this return statement has no expression.
    c.error(node, Diagnostics.Not_all_code_paths_return_a_value);
}

function getContainingFunction(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined) {
    switch (current.kind) {
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
        return current;
      case SyntaxKind.ClassStaticBlockDeclaration:
      case SyntaxKind.SourceFile:
        return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

export function checkSwitchStatement(c: Checker, node: Node): void {
  const s = node as SwitchStatement;
  const expressionType = checkExpression(c, s.expression);
  for (const clause of s.caseBlock.clauses.nodes) {
    const caseClause = clause as CaseOrDefaultClause;
    if (caseClause.expression !== undefined) {
      const caseType = checkExpression(c, caseClause.expression);
      // Without equality comparability, the reversed comparison reports the error.
      if (!isTypeEqualityComparableTo(c, expressionType, caseType))
        checkTypeComparableTo(c, caseType, expressionType, caseClause.expression, undefined);
    }
    for (const statement of caseClause.statements.nodes) checkSourceElement(c, statement);
    if (
      c.compilerOptions.noFallthroughCasesInSwitch === true &&
      caseClause.fallthroughFlowNode !== undefined &&
      isReachableFlowNode(c, caseClause.fallthroughFlowNode)
    )
      c.error(clause, Diagnostics.Fallthrough_case_in_switch);
  }
}

export function checkLabeledStatement(c: Checker, node: Node): void {
  const { label, statement } = node as LabeledStatement;
  // The binder marks the labels that no break or continue statement references.
  if ((label.flags & NodeFlags.Unreachable) !== 0 && c.compilerOptions.allowUnusedLabels !== true)
    c.addErrorOrSuggestion(
      c.compilerOptions.allowUnusedLabels === false,
      createDiagnosticForNode(label, Diagnostics.Unused_label, []),
    );
  checkSourceElement(c, statement);
}

export function checkThrowStatement(c: Checker, node: Node): void {
  const expr = getExpression(node);
  if (expr !== undefined) checkExpression(c, expr);
}

export function checkTryStatement(c: Checker, node: Node): void {
  const s = node as TryStatement;
  checkBlock(c, s.tryBlock);
  const catchClause: CatchClause | undefined = s.catchClause;
  if (catchClause !== undefined) {
    if (catchClause.variableDeclaration !== undefined) checkVariableLikeDeclaration(c, catchClause.variableDeclaration);
    checkBlock(c, catchClause.block);
  }
  if (s.finallyBlock !== undefined) checkBlock(c, s.finallyBlock);
}
