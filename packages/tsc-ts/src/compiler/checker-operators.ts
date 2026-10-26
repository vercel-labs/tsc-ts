// Operator checking: unary, binary, conditional, `delete`, and truthiness and nullishness tests.
import { ExternalEmitHelpers, checkExternalEmitHelpers } from './checker-emit-helpers.js';
import { skipTrivia } from './scanner.js';
import {
  type BinaryExpression,
  type ConditionalExpression,
  type IfStatement,
  type Node,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  NodeFlags,
  NodeVisitor,
  getExpression,
  getText,
} from './ast.js';
import {
  getContainingClass,
  getSourceFileOfNode,
  getSourceTextOfNode,
  isAccessExpression,
  isEntityNameExpression,
  skipParentheses,
} from './binder-utilities.js';
import { type Diagnostic, type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import { isAssignmentOperator, isInJSFile } from './ast-utilities.js';
import { ScriptTarget, getUseDefineForClassFields } from './options.js';
import { tokenToString } from './scanner.js';
import { type Symbol, SymbolFlags, internalSymbolNamePrefix } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { type Checker, createDiagnosticForNode } from './checker.js';
import {
  CheckMode,
  type LiteralType,
  type Signature,
  SignatureFlags,
  SignatureKind,
  type Type,
  TypeFlags,
  TypeFormatFlags,
} from './checker-types.js';
import {
  getResolvedSignature,
  isUntypedFunctionCall,
  resolveCall,
  resolveErrorCall,
  resolveUntypedCall,
} from './checker-calls.js';
import { getReturnTypeOfSignature } from './checker-signatures.js';
import { getApparentType } from './checker-members.js';
import {
  filterType,
  getBaseTypeOfLiteralType,
  getBaseTypeOfLiteralTypeForComparison,
  getBigIntLiteralType,
  getFreshTypeOfLiteralType,
  getNumberLiteralType,
  getUnionType,
  getUnionTypeEx,
  isEmptyAnonymousObjectType,
  isErrorType,
  someType,
  typesOf,
  UnionReduction,
} from './checker-type-factory.js';
import {
  getBaseConstraintOrType,
  getPropertyOfType,
  getSignaturesOfType,
  getTypeOfPropertyOfType,
} from './checker-members.js';
import { getExportSymbolOfValueSymbolIfExported, getGlobalValueSymbol, getMergedSymbol } from './checker-symbols.js';
import { getTypeOfSymbol, isReadonlySymbol } from './checker-symbol-types.js';
import { TypeFacts, getNonNullableType, getTypeFacts, hasTypeFacts } from './checker-flow.js';
import {
  areTypesComparable,
  checkTypeAssignableTo,
  getTypeNamesForErrorDisplay,
  isTypeAssignableTo,
  isTypeComparableTo,
  isExactOptionalPropertyMismatch,
  isTypeSubtypeOf,
} from './relations.js';
import { checkTypeRelatedToAndOptionallyElaborate } from './checker-elaboration.js';
import { isTypeAssignableToKindEx } from './checker-type-operators.js';
import { typeToString } from './type-printer.js';
import { getPropertyNameFromType, isTypeUsableAsPropertyName, maybeTypeOfKind } from './checker-utilities.js';
import { getAwaitedTypeNoAlias, getAwaitedTypeOfPromise } from './checker-iteration.js';
import {
  checkExpression,
  checkExpressionEx,
  checkNonNullType,
  checkPropertyAccessExpression,
  entityNameToString,
  getResolvedSymbol,
  getTypeOfExpression,
  parseBigIntText,
} from './checker-expressions.js';
import { checkDestructuringAssignment } from './checker-destructuring.js';
import { EvaluatedKind, evaluate } from './checker-evaluator.js';
import { reportNonexistentProperty } from './checker-property-access.js';
import { isUndefinedAssignmentToCommonJSExport } from './checker-javascript.js';
import { getSymbolAtLocationWorker } from './checker-services.js';

// ---- Unary operators

export function checkPrefixUnaryExpression(c: Checker, node: PrefixUnaryExpression): Type {
  const operandType = checkExpression(c, node.operand);
  if (operandType === c.silentNeverType) return c.silentNeverType;
  switch (node.operand.kind) {
    case SyntaxKind.NumericLiteral:
      if (node.operator === SyntaxKind.MinusToken)
        return getFreshTypeOfLiteralType(c, getNumberLiteralType(c, -Number(getText(node.operand))));
      if (node.operator === SyntaxKind.PlusToken)
        return getFreshTypeOfLiteralType(c, getNumberLiteralType(c, Number(getText(node.operand))));
      break;
    case SyntaxKind.BigIntLiteral:
      if (node.operator === SyntaxKind.MinusToken) {
        const value = parseBigIntText(getText(node.operand));
        return getFreshTypeOfLiteralType(c, getBigIntLiteralType(c, value === '0' ? '0' : '-' + value));
      }
      break;
  }
  switch (node.operator) {
    case SyntaxKind.PlusToken:
    case SyntaxKind.MinusToken:
    case SyntaxKind.TildeToken:
      checkNonNullType(c, operandType, node.operand);
      if (maybeTypeOfKindConsideringBaseConstraint(c, operandType, TypeFlags.ESSymbolLike))
        c.error(
          node.operand,
          Diagnostics.The_0_operator_cannot_be_applied_to_type_symbol,
          tokenToString(node.operator),
        );
      if (node.operator === SyntaxKind.PlusToken) {
        if (maybeTypeOfKindConsideringBaseConstraint(c, operandType, TypeFlags.BigIntLike))
          c.error(
            node.operand,
            Diagnostics.Operator_0_cannot_be_applied_to_type_1,
            tokenToString(node.operator),
            typeToString(c, getBaseTypeOfLiteralType(c, operandType)),
          );
        return c.numberType;
      }
      return getUnaryResultType(c, operandType);
    case SyntaxKind.ExclamationToken: {
      checkTruthinessOfType(c, operandType, node.operand);
      const facts = getTypeFacts(c, operandType, TypeFacts.Truthy | TypeFacts.Falsy);
      if (facts === TypeFacts.Truthy) return c.falseType;
      if (facts === TypeFacts.Falsy) return c.trueType;
      return c.booleanType;
    }
    case SyntaxKind.PlusPlusToken:
    case SyntaxKind.MinusMinusToken:
      checkIncrementOperand(c, node.operand, operandType);
      return getUnaryResultType(c, operandType);
  }
  return c.errorType;
}

export function checkPostfixUnaryExpression(c: Checker, node: PostfixUnaryExpression): Type {
  const operandType = checkExpression(c, node.operand);
  if (operandType === c.silentNeverType) return c.silentNeverType;
  checkIncrementOperand(c, node.operand, operandType);
  return getUnaryResultType(c, operandType);
}

function checkIncrementOperand(c: Checker, operand: Node, operandType: Type): void {
  const ok = checkArithmeticOperandType(
    c,
    operand,
    checkNonNullType(c, operandType, operand),
    Diagnostics.An_arithmetic_operand_must_be_of_type_any_number_bigint_or_an_enum_type,
    false,
  );
  // Only checked when the operand type is fine, to avoid cascading errors.
  if (ok)
    checkReferenceExpression(
      c,
      operand,
      Diagnostics.The_operand_of_an_increment_or_decrement_operator_must_be_a_variable_or_a_property_access,
      Diagnostics.The_operand_of_an_increment_or_decrement_operator_may_not_be_an_optional_property_access,
    );
}

function getUnaryResultType(c: Checker, operandType: Type): Type {
  if (maybeTypeOfKind(operandType, TypeFlags.BigIntLike)) {
    return isTypeAssignableToKind(c, operandType, TypeFlags.AnyOrUnknown) ||
      maybeTypeOfKind(operandType, TypeFlags.NumberLike)
      ? c.numberOrBigIntType
      : c.bigintType;
  }
  return c.numberType;
}

export function checkDeleteExpression(c: Checker, node: Node): Type {
  checkExpression(c, getExpression(node)!);
  const expr = skipParentheses(getExpression(node)!);
  if (!isAccessExpression(expr)) {
    c.error(expr, Diagnostics.The_operand_of_a_delete_operator_must_be_a_property_reference);
    return c.booleanType;
  }
  if (
    expr.kind === SyntaxKind.PropertyAccessExpression &&
    (expr as PropertyAccessExpression).name.kind === SyntaxKind.PrivateIdentifier
  )
    c.error(expr, Diagnostics.The_operand_of_a_delete_operator_cannot_be_a_private_identifier);
  const resolved = c.resolvedSymbols.get(expr.id);
  if (resolved !== undefined) {
    const symbol = getExportSymbolOfValueSymbolIfExported(c, resolved);
    if (isReadonlySymbol(c, symbol))
      c.error(expr, Diagnostics.The_operand_of_a_delete_operator_cannot_be_a_read_only_property);
    else checkDeleteExpressionMustBeOptional(c, expr, symbol);
  }
  return c.booleanType;
}

function checkDeleteExpressionMustBeOptional(c: Checker, expr: Node, symbol: Symbol): void {
  const t = getTypeOfSymbol(c, symbol);
  if (!c.strictNullChecks || (t.flags & (TypeFlags.AnyOrUnknown | TypeFlags.Never)) !== 0) return;
  const isOptional = c.exactOptionalPropertyTypes
    ? (symbol.flags & SymbolFlags.Optional) !== 0
    : hasTypeFacts(c, t, TypeFacts.IsUndefined);
  if (!isOptional) c.error(expr, Diagnostics.The_operand_of_a_delete_operator_must_be_optional);
}

/** Reports a grammar error unless the file already has syntax errors. */
export function grammarErrorOnNode(c: Checker, node: Node, message: DiagnosticMessage, ...args: string[]): boolean {
  if (getSourceFileOfNode(node).diagnostics.length !== 0) return false;
  c.error(node, message, ...args);
  return true;
}

// ---- Arithmetic helpers

function isTypeAssignableToKind(c: Checker, t: Type, kind: TypeFlags): boolean {
  return isTypeAssignableToKindEx(c, t, kind, false);
}

export function allTypesAssignableToKind(c: Checker, t: Type, kind: TypeFlags): boolean {
  if ((t.flags & TypeFlags.Union) !== 0) {
    for (const u of typesOf(t)) if (!allTypesAssignableToKind(c, u, kind)) return false;
    return true;
  }
  return isTypeAssignableToKind(c, t, kind);
}

function maybeTypeOfKindConsideringBaseConstraint(c: Checker, t: Type, kind: TypeFlags): boolean {
  return maybeTypeOfKind(t, kind) || maybeTypeOfKind(getBaseConstraintOrType(c, t), kind);
}

function isTypeAny(t: Type): boolean {
  return (t.flags & TypeFlags.Any) !== 0;
}

export function errorAndMaybeSuggestAwait(
  c: Checker,
  location: Node,
  maybeMissingAwait: boolean,
  message: DiagnosticMessage,
  args: string[],
): Diagnostic {
  // The related information goes on the reported diagnostic after it is added, as tsgo attaches it,
  // so a later equal report compares unequal to it and is kept.
  const diagnostic = c.error(location, message, ...args);
  if (maybeMissingAwait)
    diagnostic.addRelatedInfo(createDiagnosticForNode(location, Diagnostics.Did_you_forget_to_use_await, []));
  return diagnostic;
}

function checkArithmeticOperandType(
  c: Checker,
  operand: Node,
  t: Type,
  message: DiagnosticMessage,
  isAwaitValid: boolean,
): boolean {
  if (isTypeAssignableTo(c, t, c.numberOrBigIntType)) return true;
  const awaitedType = isAwaitValid ? getAwaitedTypeOfPromise(c, t) : undefined;
  errorAndMaybeSuggestAwait(
    c,
    operand,
    awaitedType !== undefined && isTypeAssignableTo(c, awaitedType, c.numberOrBigIntType),
    message,
    [],
  );
  return false;
}

/** Whether `expr` can be assigned to; reports `invalidReference` or `invalidOptionalChain` otherwise. */
export function checkReferenceExpression(
  c: Checker,
  expr: Node,
  invalidReference: DiagnosticMessage,
  invalidOptionalChain: DiagnosticMessage,
): boolean {
  const node = skipAssertionsAndParentheses(expr);
  if (node.kind !== SyntaxKind.Identifier && !isAccessExpression(node)) {
    c.error(expr, invalidReference);
    return false;
  }
  if ((node.flags & NodeFlags.OptionalChain) !== 0) {
    c.error(expr, invalidOptionalChain);
    return false;
  }
  return true;
}

function skipAssertionsAndParentheses(nodeIn: Node): Node {
  let node = nodeIn;
  while (
    node.kind === SyntaxKind.ParenthesizedExpression ||
    node.kind === SyntaxKind.TypeAssertionExpression ||
    node.kind === SyntaxKind.AsExpression ||
    node.kind === SyntaxKind.SatisfiesExpression ||
    node.kind === SyntaxKind.NonNullExpression
  )
    node = getExpression(node)!;
  return node;
}

/** `node` without parentheses, type assertions, `satisfies` and non-null assertions. */
export function skipOuterExpressions(nodeIn: Node): Node {
  let node = nodeIn;
  while (
    node.kind === SyntaxKind.ParenthesizedExpression ||
    node.kind === SyntaxKind.TypeAssertionExpression ||
    node.kind === SyntaxKind.AsExpression ||
    node.kind === SyntaxKind.SatisfiesExpression ||
    node.kind === SyntaxKind.NonNullExpression ||
    node.kind === SyntaxKind.ExpressionWithTypeArguments ||
    node.kind === SyntaxKind.PartiallyEmittedExpression
  )
    node = getExpression(node)!;
  return node;
}

// ---- Binary operators

export function checkBinaryExpression(c: Checker, node: BinaryExpression, checkMode: CheckMode): Type {
  const left = node.left;
  const right = node.right;
  const operator = node.operatorToken.kind;
  if (
    operator === SyntaxKind.EqualsToken &&
    (left.kind === SyntaxKind.ObjectLiteralExpression || left.kind === SyntaxKind.ArrayLiteralExpression)
  )
    return checkDestructuringAssignment(
      c,
      left,
      checkExpressionEx(c, right, checkMode),
      checkMode,
      right.kind === SyntaxKind.ThisKeyword,
    );
  const leftType = checkExpressionEx(c, left, checkMode);
  const rightType = checkExpressionEx(c, right, checkMode);
  if (isLogicalOrCoalescingOperator(operator)) {
    let parent = node.parent!;
    while (
      parent.kind === SyntaxKind.ParenthesizedExpression ||
      (parent.kind === SyntaxKind.BinaryExpression &&
        isLogicalOrCoalescingOperator((parent as BinaryExpression).operatorToken.kind))
    )
      parent = parent.parent!;
    if (operator === SyntaxKind.AmpersandAmpersandToken || parent.kind === SyntaxKind.IfStatement)
      checkTestingKnownTruthyType(
        c,
        left,
        leftType,
        parent.kind === SyntaxKind.IfStatement ? (parent as IfStatement).thenStatement : undefined,
      );
    if (operator !== SyntaxKind.QuestionQuestionToken) checkTruthinessOfType(c, leftType, left);
  }
  return checkBinaryLikeExpressionWorker(c, node, left, operator, right, leftType, rightType, checkMode);
}

function isLogicalOrCoalescingOperator(operator: SyntaxKind): boolean {
  return (
    operator === SyntaxKind.AmpersandAmpersandToken ||
    operator === SyntaxKind.BarBarToken ||
    operator === SyntaxKind.QuestionQuestionToken
  );
}

function checkBinaryLikeExpressionWorker(
  c: Checker,
  errorNode: BinaryExpression,
  left: Node,
  operator: SyntaxKind,
  right: Node,
  leftTypeIn: Type,
  rightTypeIn: Type,
  checkMode: CheckMode,
): Type {
  let leftType = leftTypeIn;
  let rightType = rightTypeIn;
  switch (operator) {
    case SyntaxKind.AsteriskToken:
    case SyntaxKind.AsteriskAsteriskToken:
    case SyntaxKind.AsteriskEqualsToken:
    case SyntaxKind.AsteriskAsteriskEqualsToken:
    case SyntaxKind.SlashToken:
    case SyntaxKind.SlashEqualsToken:
    case SyntaxKind.PercentToken:
    case SyntaxKind.PercentEqualsToken:
    case SyntaxKind.MinusToken:
    case SyntaxKind.MinusEqualsToken:
    case SyntaxKind.LessThanLessThanToken:
    case SyntaxKind.LessThanLessThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case SyntaxKind.BarToken:
    case SyntaxKind.BarEqualsToken:
    case SyntaxKind.CaretToken:
    case SyntaxKind.CaretEqualsToken:
    case SyntaxKind.AmpersandToken:
    case SyntaxKind.AmpersandEqualsToken: {
      if (leftType === c.silentNeverType || rightType === c.silentNeverType) return c.silentNeverType;
      leftType = checkNonNullType(c, leftType, left);
      rightType = checkNonNullType(c, rightType, right);
      // Bitwise operators on two booleans suggest the logical operator.
      if ((leftType.flags & TypeFlags.BooleanLike) !== 0 && (rightType.flags & TypeFlags.BooleanLike) !== 0) {
        const suggested = getSuggestedBooleanOperator(operator);
        if (suggested !== SyntaxKind.Unknown) {
          c.error(
            errorNode.operatorToken,
            Diagnostics.The_0_operator_is_not_allowed_for_boolean_types_Consider_using_1_instead,
            tokenToString(operator),
            tokenToString(suggested),
          );
          return c.numberType;
        }
      }
      const leftOk = checkArithmeticOperandType(
        c,
        left,
        leftType,
        Diagnostics.The_left_hand_side_of_an_arithmetic_operation_must_be_of_type_any_number_bigint_or_an_enum_type,
        true,
      );
      const rightOk = checkArithmeticOperandType(
        c,
        right,
        rightType,
        Diagnostics.The_right_hand_side_of_an_arithmetic_operation_must_be_of_type_any_number_bigint_or_an_enum_type,
        true,
      );
      let resultType: Type;
      if (
        (isTypeAssignableToKind(c, leftType, TypeFlags.AnyOrUnknown) &&
          isTypeAssignableToKind(c, rightType, TypeFlags.AnyOrUnknown)) ||
        (!maybeTypeOfKind(leftType, TypeFlags.BigIntLike) && !maybeTypeOfKind(rightType, TypeFlags.BigIntLike))
      )
        resultType = c.numberType;
      else if (bothAreBigIntLike(c, leftType, rightType)) {
        if (
          operator === SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
          operator === SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken
        )
          reportOperatorError(c, leftType, operator, rightType, errorNode, RelatedCheck.None);
        else if (
          (operator === SyntaxKind.AsteriskAsteriskToken || operator === SyntaxKind.AsteriskAsteriskEqualsToken) &&
          c.languageVersion < ScriptTarget.ES2016
        )
          c.error(
            errorNode,
            Diagnostics.Exponentiation_cannot_be_performed_on_bigint_values_unless_the_target_option_is_set_to_es2016_or_later,
          );
        resultType = c.bigintType;
      } else {
        reportOperatorError(c, leftType, operator, rightType, errorNode, RelatedCheck.BothBigIntLike);
        resultType = c.errorType;
      }
      if (leftOk && rightOk) {
        checkAssignmentOperator(c, left, operator, right, leftType, resultType);
        if (isShiftOperator(operator)) checkShiftAmount(c, left, operator, right, errorNode);
      }
      return resultType;
    }
    case SyntaxKind.PlusToken:
    case SyntaxKind.PlusEqualsToken: {
      if (leftType === c.silentNeverType || rightType === c.silentNeverType) return c.silentNeverType;
      if (
        !isTypeAssignableToKind(c, leftType, TypeFlags.StringLike) &&
        !isTypeAssignableToKind(c, rightType, TypeFlags.StringLike)
      ) {
        leftType = checkNonNullType(c, leftType, left);
        rightType = checkNonNullType(c, rightType, right);
      }
      let resultType: Type | undefined = undefined;
      if (
        isTypeAssignableToKindEx(c, leftType, TypeFlags.NumberLike, true) &&
        isTypeAssignableToKindEx(c, rightType, TypeFlags.NumberLike, true)
      )
        resultType = c.numberType;
      else if (
        isTypeAssignableToKindEx(c, leftType, TypeFlags.BigIntLike, true) &&
        isTypeAssignableToKindEx(c, rightType, TypeFlags.BigIntLike, true)
      )
        resultType = c.bigintType;
      else if (
        isTypeAssignableToKindEx(c, leftType, TypeFlags.StringLike, true) ||
        isTypeAssignableToKindEx(c, rightType, TypeFlags.StringLike, true)
      )
        resultType = c.stringType;
      else if (isTypeAny(leftType) || isTypeAny(rightType))
        resultType = isErrorType(c, leftType) || isErrorType(c, rightType) ? c.errorType : c.anyType;
      // Symbols are not allowed at all in arithmetic expressions.
      if (resultType !== undefined && !checkForDisallowedESSymbolOperand(c, left, right, leftType, rightType, operator))
        return resultType;
      if (resultType === undefined) {
        reportOperatorError(c, leftType, operator, rightType, errorNode, RelatedCheck.CloseEnoughForPlus);
        return c.anyType;
      }
      if (operator === SyntaxKind.PlusEqualsToken)
        checkAssignmentOperator(c, left, operator, right, leftType, resultType);
      return resultType;
    }
    case SyntaxKind.LessThanToken:
    case SyntaxKind.GreaterThanToken:
    case SyntaxKind.LessThanEqualsToken:
    case SyntaxKind.GreaterThanEqualsToken:
      if (checkForDisallowedESSymbolOperand(c, left, right, leftType, rightType, operator)) {
        leftType = getBaseTypeOfLiteralTypeForComparison(c, checkNonNullType(c, leftType, left));
        rightType = getBaseTypeOfLiteralTypeForComparison(c, checkNonNullType(c, rightType, right));
        if (!isRelated(c, RelatedCheck.Comparable, leftType, rightType))
          reportOperatorError(c, leftType, operator, rightType, errorNode, RelatedCheck.Comparable);
      }
      return c.booleanType;
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
      // Flow analysis may check operands with temporarily narrower types; only report in normal checks.
      if ((checkMode & CheckMode.TypeOnly) === 0) {
        if (
          (isLiteralExpressionOfObject(left) || isLiteralExpressionOfObject(right)) &&
          (!isInJSFile(left) ||
            operator === SyntaxKind.EqualsEqualsEqualsToken ||
            operator === SyntaxKind.ExclamationEqualsEqualsToken)
        ) {
          const eqType = operator === SyntaxKind.EqualsEqualsToken || operator === SyntaxKind.EqualsEqualsEqualsToken;
          c.error(
            errorNode,
            Diagnostics.This_condition_will_always_return_0_since_JavaScript_compares_objects_by_reference_not_value,
            eqType ? 'false' : 'true',
          );
        }
        checkNaNEquality(c, errorNode, operator, left, right);
        if (!isRelated(c, RelatedCheck.EqualityComparable, leftType, rightType))
          reportOperatorError(c, leftType, operator, rightType, errorNode, RelatedCheck.EqualityComparable);
      }
      return c.booleanType;
    case SyntaxKind.InstanceOfKeyword:
      return checkInstanceOfExpression(c, left, right, leftType, rightType, checkMode);
    case SyntaxKind.InKeyword:
      return checkInExpression(c, left, right, leftType, rightType);
    case SyntaxKind.AmpersandAmpersandToken:
    case SyntaxKind.AmpersandAmpersandEqualsToken: {
      let resultType = leftType;
      if (hasTypeFacts(c, leftType, TypeFacts.Truthy))
        resultType = getUnionType(c, [
          extractDefinitelyFalsyTypes(c, c.strictNullChecks ? leftType : getBaseTypeOfLiteralType(c, rightType)),
          rightType,
        ]);
      if (operator === SyntaxKind.AmpersandAmpersandEqualsToken)
        checkAssignmentOperator(c, left, operator, right, leftType, rightType);
      return resultType;
    }
    case SyntaxKind.BarBarToken:
    case SyntaxKind.BarBarEqualsToken: {
      let resultType = leftType;
      if (hasTypeFacts(c, leftType, TypeFacts.Falsy))
        resultType = getUnionTypeEx(
          c,
          [getNonNullableType(c, removeDefinitelyFalsyTypes(c, leftType)), rightType],
          UnionReduction.Subtype,
          undefined,
          undefined,
        );
      if (operator === SyntaxKind.BarBarEqualsToken)
        checkAssignmentOperator(c, left, operator, right, leftType, rightType);
      return resultType;
    }
    case SyntaxKind.QuestionQuestionToken:
    case SyntaxKind.QuestionQuestionEqualsToken: {
      if (operator === SyntaxKind.QuestionQuestionToken) checkNullishCoalesceOperands(c, left, right);
      let resultType = leftType;
      if (hasTypeFacts(c, leftType, TypeFacts.EQUndefinedOrNull))
        resultType = getUnionTypeEx(
          c,
          [getNonNullableType(c, leftType), rightType],
          UnionReduction.Subtype,
          undefined,
          undefined,
        );
      if (operator === SyntaxKind.QuestionQuestionEqualsToken)
        checkAssignmentOperator(c, left, operator, right, leftType, rightType);
      return resultType;
    }
    case SyntaxKind.EqualsToken:
      checkAssignmentOperator(c, left, operator, right, leftType, rightType);
      return rightType;
    case SyntaxKind.CommaToken:
      if (
        c.compilerOptions.allowUnreachableCode !== true &&
        isSideEffectFree(left) &&
        !isIndirectCall(left.parent as BinaryExpression) &&
        !isInMultipleJsxRootsError(left)
      )
        c.error(left, Diagnostics.Left_side_of_comma_operator_is_unused_and_has_no_side_effects);
      return rightType;
  }
  return c.errorType;
}

/** Whether `left` starts inside an "expressions must have one parent element" parse error. */
function isInMultipleJsxRootsError(left: Node): boolean {
  const file = getSourceFileOfNode(left);
  const start = skipTrivia(file.text, left.pos);
  for (const d of file.diagnostics)
    if (d.message === Diagnostics.JSX_expressions_must_have_one_parent_element && d.pos <= start && start < d.end)
      return true;
  return false;
}

function getSuggestedBooleanOperator(operator: SyntaxKind): SyntaxKind {
  switch (operator) {
    case SyntaxKind.BarToken:
    case SyntaxKind.BarEqualsToken:
      return SyntaxKind.BarBarToken;
    case SyntaxKind.CaretToken:
    case SyntaxKind.CaretEqualsToken:
      return SyntaxKind.ExclamationEqualsEqualsToken;
    case SyntaxKind.AmpersandToken:
    case SyntaxKind.AmpersandEqualsToken:
      return SyntaxKind.AmpersandAmpersandToken;
  }
  return SyntaxKind.Unknown;
}

function bothAreBigIntLike(c: Checker, left: Type, right: Type): boolean {
  return (
    isTypeAssignableToKind(c, left, TypeFlags.BigIntLike) && isTypeAssignableToKind(c, right, TypeFlags.BigIntLike)
  );
}

/** Returns true when neither operand is a symbol; reports the offending one otherwise. */
function checkForDisallowedESSymbolOperand(
  c: Checker,
  left: Node,
  right: Node,
  leftType: Type,
  rightType: Type,
  operator: SyntaxKind,
): boolean {
  let offending: Node | undefined = undefined;
  if (maybeTypeOfKindConsideringBaseConstraint(c, leftType, TypeFlags.ESSymbolLike)) offending = left;
  else if (maybeTypeOfKindConsideringBaseConstraint(c, rightType, TypeFlags.ESSymbolLike)) offending = right;
  if (offending === undefined) return true;
  c.error(offending, Diagnostics.The_0_operator_cannot_be_applied_to_type_symbol, tokenToString(operator));
  return false;
}

/** The relation an operator error tests before reporting, which also picks how operand types display. */
const enum RelatedCheck {
  None,
  BothBigIntLike,
  CloseEnoughForPlus,
  Comparable,
  EqualityComparable,
}

function isRelated(c: Checker, check: RelatedCheck, left: Type, right: Type): boolean {
  switch (check) {
    case RelatedCheck.BothBigIntLike:
      return bothAreBigIntLike(c, left, right);
    case RelatedCheck.CloseEnoughForPlus: {
      const kind = TypeFlags.NumberLike | TypeFlags.BigIntLike | TypeFlags.StringLike | TypeFlags.AnyOrUnknown;
      return isTypeAssignableToKind(c, left, kind) && isTypeAssignableToKind(c, right, kind);
    }
    case RelatedCheck.Comparable: {
      if (isTypeAny(left) || isTypeAny(right)) return true;
      const leftNumeric = isTypeAssignableTo(c, left, c.numberOrBigIntType);
      const rightNumeric = isTypeAssignableTo(c, right, c.numberOrBigIntType);
      return (leftNumeric && rightNumeric) || (!leftNumeric && !rightNumeric && areTypesComparable(c, left, right));
    }
    case RelatedCheck.EqualityComparable:
      return isTypeEqualityComparableTo(c, left, right) || isTypeEqualityComparableTo(c, right, left);
  }
  return false;
}

export function isTypeEqualityComparableTo(c: Checker, source: Type, target: Type): boolean {
  return (target.flags & TypeFlags.Nullable) !== 0 || isTypeComparableTo(c, source, target);
}

function reportOperatorError(
  c: Checker,
  leftType: Type,
  operator: SyntaxKind,
  rightType: Type,
  errorNode: Node,
  check: RelatedCheck,
): void {
  let wouldWorkWithAwait = false;
  let effectiveLeft = leftType;
  let effectiveRight = rightType;
  if (check !== RelatedCheck.None) {
    const awaitedLeft = getAwaitedTypeNoAlias(c, leftType);
    const awaitedRight = getAwaitedTypeNoAlias(c, rightType);
    wouldWorkWithAwait =
      !(awaitedLeft === leftType && awaitedRight === rightType) &&
      awaitedLeft !== undefined &&
      awaitedRight !== undefined &&
      isRelated(c, check, awaitedLeft, awaitedRight);
    if (!wouldWorkWithAwait) {
      // Literal operands display as their base types when those are unrelated too.
      const leftBase = getBaseTypeOfLiteralType(c, leftType);
      const rightBase = getBaseTypeOfLiteralType(c, rightType);
      if (!isRelated(c, check, leftBase, rightBase)) {
        effectiveLeft = leftBase;
        effectiveRight = rightBase;
      }
    }
  }
  const [leftStr, rightStr] = getTypeNamesForErrorDisplay(c, effectiveLeft, effectiveRight);
  switch (operator) {
    case SyntaxKind.EqualsEqualsEqualsToken:
    case SyntaxKind.EqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsEqualsToken:
    case SyntaxKind.ExclamationEqualsToken:
      errorAndMaybeSuggestAwait(
        c,
        errorNode,
        wouldWorkWithAwait,
        Diagnostics.This_comparison_appears_to_be_unintentional_because_the_types_0_and_1_have_no_overlap,
        [leftStr, rightStr],
      );
      return;
  }
  errorAndMaybeSuggestAwait(
    c,
    errorNode,
    wouldWorkWithAwait,
    Diagnostics.Operator_0_cannot_be_applied_to_types_1_and_2,
    [tokenToString(operator), leftStr, rightStr],
  );
}

function checkAssignmentOperator(
  c: Checker,
  left: Node,
  operator: SyntaxKind,
  right: Node,
  leftType: Type,
  rightType: Type,
): void {
  if (!isAssignmentOperator(operator)) return;
  if (isUndefinedAssignmentToCommonJSExport(c, left, rightType)) return;
  // A getter's type can be a subtype of its setter's, so compound assignments check against the setter.
  let targetType = leftType;
  if (
    operator >= SyntaxKind.FirstCompoundAssignment &&
    operator <= SyntaxKind.LastCompoundAssignment &&
    left.kind === SyntaxKind.PropertyAccessExpression
  )
    targetType = checkPropertyAccessExpression(c, left as PropertyAccessExpression, true);
  // Assignability is only checked when the target is a reference, to avoid cascading errors.
  if (
    checkReferenceExpression(
      c,
      left,
      Diagnostics.The_left_hand_side_of_an_assignment_expression_must_be_a_variable_or_a_property_access,
      Diagnostics.The_left_hand_side_of_an_assignment_expression_may_not_be_an_optional_property_access,
    )
  ) {
    let headMessage: DiagnosticMessage | undefined = undefined;
    if (
      c.exactOptionalPropertyTypes &&
      left.kind === SyntaxKind.PropertyAccessExpression &&
      maybeTypeOfKind(rightType, TypeFlags.Undefined)
    ) {
      const access = left as PropertyAccessExpression;
      const target = getTypeOfPropertyOfType(c, getTypeOfExpression(c, access.expression), getText(access.name));
      if (isExactOptionalPropertyMismatch(c, rightType, target))
        headMessage =
          Diagnostics.Type_0_is_not_assignable_to_type_1_with_exactOptionalPropertyTypes_Colon_true_Consider_adding_undefined_to_the_type_of_the_target;
    }
    checkTypeRelatedToAndOptionallyElaborate(
      c,
      rightType,
      targetType,
      c.assignableRelation,
      left,
      right,
      headMessage,
      undefined,
    );
  }
}

function isLiteralExpressionOfObject(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.FunctionExpression:
      return true;
  }
  return false;
}

function checkNaNEquality(c: Checker, errorNode: Node, operator: SyntaxKind, left: Node, right: Node): void {
  const isLeftNaN = isGlobalNaN(c, skipParentheses(left));
  const isRightNaN = isGlobalNaN(c, skipParentheses(right));
  if (!isLeftNaN && !isRightNaN) return;
  const err = c.error(
    errorNode,
    Diagnostics.This_condition_will_always_return_0,
    operator === SyntaxKind.EqualsEqualsEqualsToken || operator === SyntaxKind.EqualsEqualsToken ? 'false' : 'true',
  );
  if (isLeftNaN && isRightNaN) return;
  const operatorString =
    operator === SyntaxKind.ExclamationEqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken ? '!' : '';
  const location = isLeftNaN ? right : left;
  const expression = skipParentheses(location);
  const entityName = isEntityNameExpression(expression, false) ? entityNameToString(expression) : '...';
  err.addRelatedInfo(
    createDiagnosticForNode(location, Diagnostics.Did_you_mean_0, [
      operatorString + 'Number.isNaN(' + entityName + ')',
    ]),
  );
}

function isGlobalNaN(c: Checker, expr: Node): boolean {
  if (expr.kind !== SyntaxKind.Identifier || getText(expr) !== 'NaN') return false;
  const globalNaNSymbol = c.globals.get('NaN');
  return globalNaNSymbol !== undefined && getResolvedSymbol(c, expr) === getMergedSymbol(c, globalNaNSymbol);
}

function isShiftOperator(operator: SyntaxKind): boolean {
  switch (operator) {
    case SyntaxKind.LessThanLessThanToken:
    case SyntaxKind.LessThanLessThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
    case SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
      return true;
  }
  return false;
}

/** Shifts by 32 or more wrap around; that's an error in enum members and a suggestion elsewhere. */
function checkShiftAmount(c: Checker, left: Node, operator: SyntaxKind, right: Node, errorNode: Node): void {
  const result = evaluate(c, right, right);
  if (result.kind !== EvaluatedKind.Number || Math.abs(result.numberValue) < 32) return;
  let container = right.parent!.parent!;
  while (container.kind === SyntaxKind.ParenthesizedExpression) container = container.parent!;
  const file = getSourceFileOfNode(left);
  c.addErrorOrSuggestion(
    container.kind === SyntaxKind.EnumMember,
    createDiagnosticForNode(errorNode, Diagnostics.This_operation_can_be_simplified_This_shift_is_identical_to_0_1_2, [
      getSourceTextOfNode(file, left),
      tokenToString(operator),
      String(result.numberValue % 32),
    ]),
  );
}

function checkInstanceOfExpression(
  c: Checker,
  left: Node,
  right: Node,
  leftType: Type,
  rightType: Type,
  checkMode: CheckMode,
): Type {
  if (leftType === c.silentNeverType || rightType === c.silentNeverType) return c.silentNeverType;
  // Unknown left operands already reported an error.
  if (!isTypeAny(leftType) && allTypesAssignableToKind(c, leftType, TypeFlags.Primitive))
    c.error(
      left,
      Diagnostics.The_left_hand_side_of_an_instanceof_expression_must_be_of_type_any_an_object_type_or_a_type_parameter,
    );
  // `x instanceof C` is checked as the call `C[Symbol.hasInstance](x)`.
  const signature = getResolvedSignature(c, left.parent!, checkMode);
  if (signature === c.resolvingSignature) return c.silentNeverType;
  checkTypeAssignableTo(
    c,
    getReturnTypeOfSignature(c, signature),
    c.booleanType,
    right,
    Diagnostics.An_object_s_Symbol_hasInstance_method_must_return_a_boolean_value_for_it_to_be_used_on_the_right_hand_side_of_an_instanceof_expression,
  );
  return c.booleanType;
}

/** The signature of `right[Symbol.hasInstance]` that `left instanceof right` calls, if any. */
export function resolveInstanceofExpression(c: Checker, node: BinaryExpression, checkMode: CheckMode): Signature {
  const right = node.right;
  const rightType = checkExpression(c, right);
  if (!isTypeAny(rightType)) {
    const hasInstanceMethodType = getSymbolHasInstanceMethodOfObjectType(c, rightType);
    if (hasInstanceMethodType !== undefined) {
      const apparentType = getApparentType(c, hasInstanceMethodType);
      if (isErrorType(c, apparentType)) return resolveErrorCall(c, node);
      const callSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Call);
      const constructSignatures = getSignaturesOfType(c, apparentType, SignatureKind.Construct);
      if (
        isUntypedFunctionCall(c, hasInstanceMethodType, apparentType, callSignatures.length, constructSignatures.length)
      )
        return resolveUntypedCall(c, node);
      // Argument errors explain how `left instanceof right` became `right[Symbol.hasInstance](left)`.
      if (callSignatures.length !== 0)
        return resolveCall(
          c,
          node,
          callSignatures,
          checkMode,
          SignatureFlags.None,
          Diagnostics.The_left_hand_side_of_an_instanceof_expression_must_be_assignable_to_the_first_argument_of_the_right_hand_side_s_Symbol_hasInstance_method,
        );
    } else if (
      !typeHasCallOrConstructSignatures(c, rightType) &&
      !isTypeSubtypeOf(c, rightType, c.globalFunctionType)
    ) {
      c.error(
        right,
        Diagnostics.The_right_hand_side_of_an_instanceof_expression_must_be_either_of_type_any_a_class_function_or_other_type_assignable_to_the_Function_interface_type_or_an_object_type_with_a_Symbol_hasInstance_method,
      );
      return resolveErrorCall(c, node);
    }
  }
  return c.anySignature;
}

function typeHasCallOrConstructSignatures(c: Checker, t: Type): boolean {
  return (
    getSignaturesOfType(c, t, SignatureKind.Call).length !== 0 ||
    getSignaturesOfType(c, t, SignatureKind.Construct).length !== 0
  );
}

export function getSymbolHasInstanceMethodOfObjectType(c: Checker, t: Type): Type | undefined {
  if (!allTypesAssignableToKind(c, t, TypeFlags.NonPrimitive)) return undefined;
  const prop = getPropertyOfType(c, t, getPropertyNameForKnownSymbolName(c, 'hasInstance'));
  if (prop === undefined) return undefined;
  const propType = getTypeOfSymbol(c, prop);
  return getSignaturesOfType(c, propType, SignatureKind.Call).length !== 0 ? propType : undefined;
}

/** The member name of a well-known symbol such as `Symbol.iterator`. */
export function getPropertyNameForKnownSymbolName(c: Checker, name: string): string {
  const ctor = getGlobalValueSymbol(c, 'Symbol', false);
  if (ctor !== undefined) {
    const uniqueType = getTypeOfPropertyOfType(c, getTypeOfSymbol(c, ctor), name);
    if (uniqueType !== undefined && isTypeUsableAsPropertyName(uniqueType)) return getPropertyNameFromType(uniqueType);
  }
  return internalSymbolNamePrefix + '@' + name;
}

function checkInExpression(c: Checker, left: Node, right: Node, leftType: Type, rightType: Type): Type {
  if (leftType === c.silentNeverType || rightType === c.silentNeverType) return c.silentNeverType;
  if (left.kind === SyntaxKind.PrivateIdentifier) {
    if (c.languageVersion < ScriptTarget.ESNext || !getUseDefineForClassFields(c.compilerOptions))
      checkExternalEmitHelpers(c, left, ExternalEmitHelpers.ClassPrivateFieldIn);
    // With the right side's type known, a private name that doesn't resolve is reported as missing on it.
    if (c.resolvedSymbols.get(left.id) === undefined && getContainingClass(left) !== undefined)
      reportNonexistentProperty(c, left, rightType);
  } else checkTypeAssignableTo(c, checkNonNullType(c, leftType, left), c.stringNumberSymbolType, left, undefined);
  if (checkTypeAssignableTo(c, checkNonNullType(c, rightType, right), c.nonPrimitiveType, right, undefined)) {
    // `{}` is assignable to `object` but may stand for a primitive, as when narrowed from `unknown`.
    if (hasEmptyObjectIntersection(c, rightType))
      c.error(
        right,
        Diagnostics.Type_0_may_represent_a_primitive_value_which_is_not_permitted_as_the_right_operand_of_the_in_operator,
        typeToString(c, rightType),
      );
  }
  return c.booleanType;
}

function hasEmptyObjectIntersection(c: Checker, t: Type): boolean {
  return someType(
    t,
    (u) =>
      u === c.unknownEmptyObjectType ||
      ((u.flags & TypeFlags.Intersection) !== 0 && isEmptyAnonymousObjectType(c, getBaseConstraintOrType(c, u))),
  );
}

// ---- Logical operators

export function removeDefinitelyFalsyTypes(c: Checker, t: Type): Type {
  return filterType(c, t, (u) => hasTypeFacts(c, u, TypeFacts.Truthy));
}

function extractDefinitelyFalsyTypes(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Union) === 0) return getDefinitelyFalsyPartOfType(c, t);
  const types: Type[] = [];
  for (const u of typesOf(t)) types.push(getDefinitelyFalsyPartOfType(c, u));
  return getUnionType(c, types);
}

function getDefinitelyFalsyPartOfType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.String) !== 0) return c.emptyStringType;
  if ((t.flags & TypeFlags.Number) !== 0) return c.zeroType;
  if ((t.flags & TypeFlags.BigInt) !== 0) return c.zeroBigIntType;
  if (
    t === c.regularFalseType ||
    t === c.falseType ||
    (t.flags & (TypeFlags.Void | TypeFlags.Undefined | TypeFlags.Null | TypeFlags.AnyOrUnknown)) !== 0
  )
    return t;
  if ((t.flags & TypeFlags.StringLiteral) !== 0 && (t as LiteralType).stringValue === '') return t;
  if ((t.flags & TypeFlags.NumberLiteral) !== 0 && (t as LiteralType).numberValue === 0) return t;
  if ((t.flags & TypeFlags.BigIntLiteral) !== 0 && (t as LiteralType).stringValue === '0') return t;
  return c.neverType;
}

const enum PredicateSemantics {
  None = 0,
  Always = 1 << 0,
  Never = 1 << 1,
  Sometimes = Always | Never,
}

/** Reports tests of `void` and of expressions that are syntactically always truthy or falsy. */
export function checkTruthinessOfType(c: Checker, t: Type, node: Node): Type {
  if ((t.flags & TypeFlags.Void) !== 0) {
    c.error(node, Diagnostics.An_expression_of_type_void_cannot_be_tested_for_truthiness);
    return t;
  }
  const semantics = getSyntacticTruthySemantics(c, node);
  if (semantics !== PredicateSemantics.Sometimes)
    c.error(
      node,
      semantics === PredicateSemantics.Always
        ? Diagnostics.This_kind_of_expression_is_always_truthy
        : Diagnostics.This_kind_of_expression_is_always_falsy,
    );
  return t;
}

function getSyntacticTruthySemantics(c: Checker, nodeIn: Node): PredicateSemantics {
  const node = skipOuterExpressions(nodeIn);
  switch (node.kind) {
    case SyntaxKind.NumericLiteral: {
      // `while (0)` and `while (1)` are idioms.
      const text = getText(node);
      return text === '0' || text === '1' ? PredicateSemantics.Sometimes : PredicateSemantics.Always;
    }
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.RegularExpressionLiteral:
      return PredicateSemantics.Always;
    case SyntaxKind.VoidExpression:
    case SyntaxKind.NullKeyword:
      return PredicateSemantics.Never;
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.StringLiteral:
      return getText(node) !== '' ? PredicateSemantics.Always : PredicateSemantics.Never;
    case SyntaxKind.ConditionalExpression: {
      const cond = node as ConditionalExpression;
      return getSyntacticTruthySemantics(c, cond.whenTrue) | getSyntacticTruthySemantics(c, cond.whenFalse);
    }
    case SyntaxKind.Identifier:
      if (getResolvedSymbol(c, node) === c.undefinedSymbol) return PredicateSemantics.Never;
      break;
  }
  return PredicateSemantics.Sometimes;
}

function checkNullishCoalesceOperands(c: Checker, left: Node, right: Node): void {
  const grandparent = left.parent!.parent!;
  if (grandparent.kind === SyntaxKind.BinaryExpression) {
    const outer = grandparent as BinaryExpression;
    if (outer.left.kind === SyntaxKind.BinaryExpression && outer.operatorToken.kind === SyntaxKind.BarBarToken)
      grammarErrorOnNode(
        c,
        outer.left,
        Diagnostics.X_0_and_1_operations_cannot_be_mixed_without_parentheses,
        tokenToString(SyntaxKind.QuestionQuestionToken),
        tokenToString(outer.operatorToken.kind),
      );
  } else if (left.kind === SyntaxKind.BinaryExpression) {
    const operator = (left as BinaryExpression).operatorToken.kind;
    if (operator === SyntaxKind.BarBarToken || operator === SyntaxKind.AmpersandAmpersandToken)
      grammarErrorOnNode(
        c,
        left,
        Diagnostics.X_0_and_1_operations_cannot_be_mixed_without_parentheses,
        tokenToString(operator),
        tokenToString(SyntaxKind.QuestionQuestionToken),
      );
  } else if (right.kind === SyntaxKind.BinaryExpression) {
    const operator = (right as BinaryExpression).operatorToken.kind;
    if (operator === SyntaxKind.AmpersandAmpersandToken)
      grammarErrorOnNode(
        c,
        right,
        Diagnostics.X_0_and_1_operations_cannot_be_mixed_without_parentheses,
        tokenToString(SyntaxKind.QuestionQuestionToken),
        tokenToString(operator),
      );
  }
  const leftTarget = skipOuterExpressions(left);
  const semantics = getSyntacticNullishnessSemantics(c, leftTarget);
  if (semantics === PredicateSemantics.Always) c.error(leftTarget, Diagnostics.This_expression_is_always_nullish);
  else if (semantics !== PredicateSemantics.Sometimes)
    c.error(leftTarget, Diagnostics.Right_operand_of_is_unreachable_because_the_left_operand_is_never_nullish);
}

function getSyntacticNullishnessSemantics(c: Checker, nodeIn: Node): PredicateSemantics {
  const node = skipOuterExpressions(nodeIn);
  switch (node.kind) {
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.MetaProperty:
    case SyntaxKind.NewExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.ThisKeyword:
      return PredicateSemantics.Sometimes;
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      switch (binary.operatorToken.kind) {
        case SyntaxKind.BarBarToken:
        case SyntaxKind.BarBarEqualsToken:
        case SyntaxKind.AmpersandAmpersandToken:
        case SyntaxKind.AmpersandAmpersandEqualsToken:
          return PredicateSemantics.Sometimes;
        // The right operand decides.
        case SyntaxKind.CommaToken:
        case SyntaxKind.EqualsToken:
        case SyntaxKind.QuestionQuestionToken:
        case SyntaxKind.QuestionQuestionEqualsToken:
          return getSyntacticNullishnessSemantics(c, binary.right);
      }
      return PredicateSemantics.Never;
    }
    case SyntaxKind.ConditionalExpression: {
      const cond = node as ConditionalExpression;
      return getSyntacticNullishnessSemantics(c, cond.whenTrue) | getSyntacticNullishnessSemantics(c, cond.whenFalse);
    }
    case SyntaxKind.NullKeyword:
      return PredicateSemantics.Always;
    case SyntaxKind.Identifier:
      return getResolvedSymbol(c, node) === c.undefinedSymbol
        ? PredicateSemantics.Always
        : PredicateSemantics.Sometimes;
  }
  return PredicateSemantics.Never;
}

// ---- Conditions

export function checkConditionalExpression(c: Checker, node: ConditionalExpression, checkMode: CheckMode): Type {
  const t = checkTruthinessExpression(c, node.condition, checkMode);
  checkTestingKnownTruthyType(c, node.condition, t, node.whenTrue);
  const type1 = checkExpressionEx(c, node.whenTrue, checkMode);
  const type2 = checkExpressionEx(c, node.whenFalse, checkMode);
  return getUnionTypeEx(c, [type1, type2], UnionReduction.Subtype, undefined, undefined);
}

export function checkTruthinessExpression(c: Checker, node: Node, checkMode: CheckMode): Type {
  return checkTruthinessOfType(c, checkExpressionEx(c, node, checkMode), node);
}

/**
 * Reports conditions on functions and promises that are always defined and not used in `body`,
 * which usually means a missing call or `await`. Only under strictNullChecks.
 */
export function checkTestingKnownTruthyType(c: Checker, condExpr: Node, condType: Type, body: Node | undefined): void {
  if (!c.strictNullChecks) return;
  let expr = skipParentheses(condExpr);
  checkTestingKnownTruthyTypeWorker(c, expr, condType, body);
  while (
    expr.kind === SyntaxKind.BinaryExpression &&
    ((expr as BinaryExpression).operatorToken.kind === SyntaxKind.BarBarToken ||
      (expr as BinaryExpression).operatorToken.kind === SyntaxKind.QuestionQuestionToken)
  ) {
    expr = skipParentheses((expr as BinaryExpression).left);
    checkTestingKnownTruthyTypeWorker(c, expr, condType, body);
  }
}

function isLogicalOrCoalescingExpression(node: Node): boolean {
  return (
    node.kind === SyntaxKind.BinaryExpression &&
    isLogicalOrCoalescingOperator((node as BinaryExpression).operatorToken.kind)
  );
}

function checkTestingKnownTruthyTypeWorker(c: Checker, condExpr: Node, condType: Type, body: Node | undefined): void {
  const location = isLogicalOrCoalescingExpression(condExpr)
    ? skipParentheses((condExpr as BinaryExpression).right)
    : condExpr;
  if (isLogicalOrCoalescingExpression(location)) {
    checkTestingKnownTruthyType(c, location, condType, body);
    return;
  }
  const t = location !== condExpr ? checkExpression(c, location) : condType;
  if ((t.flags & TypeFlags.EnumLiteral) !== 0 && location.kind === SyntaxKind.PropertyAccessExpression) {
    const leftSymbol = c.resolvedSymbols.get((location as PropertyAccessExpression).expression.id);
    if (leftSymbol !== undefined && (leftSymbol.flags & SymbolFlags.Enum) !== 0) {
      // An enum member with a known value is always truthy or always falsy.
      const value = t as LiteralType;
      const truthy = (t.flags & TypeFlags.StringLiteral) !== 0 ? value.stringValue !== '' : value.numberValue !== 0;
      c.error(location, Diagnostics.This_condition_will_always_return_0, truthy ? 'true' : 'false');
      return;
    }
  }
  const isPropertyExpressionCast =
    location.kind === SyntaxKind.PropertyAccessExpression &&
    isTypeAssertion((location as PropertyAccessExpression).expression);
  if (!hasTypeFacts(c, t, TypeFacts.Truthy) || isPropertyExpressionCast) return;
  // Known-truthy tests are only reported for functions and promises: values from declarations
  // without strictNullChecks would produce too many false positives otherwise.
  const isPromise = getAwaitedTypeOfPromise(c, t) !== undefined;
  if (getSignaturesOfType(c, t, SignatureKind.Call).length === 0 && !isPromise) return;
  let testedNode: Node | undefined = undefined;
  if (location.kind === SyntaxKind.Identifier) testedNode = location;
  else if (location.kind === SyntaxKind.PropertyAccessExpression)
    testedNode = (location as PropertyAccessExpression).name;
  const testedSymbol = testedNode !== undefined ? getSymbolAtLocationWorker(c, testedNode, false) : undefined;
  if (testedSymbol === undefined && !isPromise) return;
  const isUsed =
    testedSymbol !== undefined &&
    ((condExpr.parent!.kind === SyntaxKind.BinaryExpression &&
      isSymbolUsedInBinaryExpressionChain(c, condExpr.parent!, testedSymbol)) ||
      (body !== undefined && isSymbolUsedInConditionBody(c, condExpr, body, testedNode!, testedSymbol)));
  if (isUsed) return;
  if (isPromise)
    errorAndMaybeSuggestAwait(
      c,
      location,
      true,
      Diagnostics.This_condition_will_always_return_true_since_this_0_is_always_defined,
      [typeToString(c, t, undefined, TypeFormatFlags.UseFullyQualifiedType)],
    );
  else
    c.error(
      location,
      Diagnostics.This_condition_will_always_return_true_since_this_function_is_always_defined_Did_you_mean_to_call_it_instead,
    );
}

export function isTypeAssertion(node: Node): boolean {
  const n = skipParentheses(node);
  return n.kind === SyntaxKind.TypeAssertionExpression || n.kind === SyntaxKind.AsExpression;
}

function isSymbolUsedInBinaryExpressionChain(c: Checker, nodeIn: Node, testedSymbol: Symbol): boolean {
  let node = nodeIn;
  while (
    node.kind === SyntaxKind.BinaryExpression &&
    (node as BinaryExpression).operatorToken.kind === SyntaxKind.AmpersandAmpersandToken
  ) {
    if ((node as BinaryExpression).right.forEachChild(new SymbolUseFinder(c, testedSymbol))) return true;
    node = node.parent!;
  }
  return false;
}

/** Finds an identifier referring to a symbol. */
class SymbolUseFinder extends NodeVisitor {
  readonly c: Checker;
  readonly symbol: Symbol;

  constructor(c: Checker, symbol: Symbol) {
    super();
    this.c = c;
    this.symbol = symbol;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.Identifier && getSymbolAtLocationWorker(this.c, node, false) === this.symbol)
      return true;
    return node.forEachChild(this);
  }
}

function isSymbolUsedInConditionBody(
  c: Checker,
  expr: Node,
  body: Node,
  testedNode: Node,
  testedSymbol: Symbol,
): boolean {
  return body.forEachChild(new ConditionBodyUseFinder(c, expr, testedNode, testedSymbol));
}

/** Finds a use of the tested symbol on the same target as in the condition. */
class ConditionBodyUseFinder extends NodeVisitor {
  readonly c: Checker;
  readonly expr: Node;
  readonly testedNode: Node;
  readonly testedSymbol: Symbol;

  constructor(c: Checker, expr: Node, testedNode: Node, testedSymbol: Symbol) {
    super();
    this.c = c;
    this.expr = expr;
    this.testedNode = testedNode;
    this.testedSymbol = testedSymbol;
  }

  visitNode(node: Node): boolean {
    if (node.kind === SyntaxKind.Identifier && getSymbolAtLocationWorker(this.c, node, false) === this.testedSymbol) {
      // A simple identifier test needs no target comparison.
      if (
        this.expr.kind === SyntaxKind.Identifier ||
        (this.testedNode.kind === SyntaxKind.Identifier && this.testedNode.parent!.kind === SyntaxKind.BinaryExpression)
      )
        return true;
      let tested: Node | undefined = this.testedNode.parent;
      let child: Node | undefined = node.parent;
      while (tested !== undefined && child !== undefined) {
        if (tested.kind === SyntaxKind.Identifier && child.kind === SyntaxKind.Identifier)
          return getSymbolAtLocationWorker(this.c, tested, false) === getSymbolAtLocationWorker(this.c, child, false);
        if (tested.kind === SyntaxKind.ThisKeyword && child.kind === SyntaxKind.ThisKeyword) return true;
        if (tested.kind === SyntaxKind.PropertyAccessExpression && child.kind === SyntaxKind.PropertyAccessExpression) {
          if (
            getSymbolAtLocationWorker(this.c, (tested as PropertyAccessExpression).name, false) !==
            getSymbolAtLocationWorker(this.c, (child as PropertyAccessExpression).name, false)
          )
            return false;
          child = getExpression(child);
          tested = getExpression(tested);
        } else if (tested.kind === SyntaxKind.CallExpression && child.kind === SyntaxKind.CallExpression) {
          child = getExpression(child);
          tested = getExpression(tested);
        } else return false;
      }
    }
    return node.forEachChild(this);
  }
}

// ---- Comma operator

/**
 * Whether evaluating `expr` itself has no side effects, as a smell test for discarded values
 * like the left side of a comma.
 */
function isSideEffectFree(expr: Node): boolean {
  const node = skipParentheses(expr);
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxElement:
      return true;
    case SyntaxKind.ConditionalExpression: {
      const cond = node as ConditionalExpression;
      return isSideEffectFree(cond.whenTrue) && isSideEffectFree(cond.whenFalse);
    }
    case SyntaxKind.BinaryExpression: {
      const binary = node as BinaryExpression;
      if (isAssignmentOperator(binary.operatorToken.kind)) return false;
      return isSideEffectFree(binary.left) && isSideEffectFree(binary.right);
    }
    case SyntaxKind.PrefixUnaryExpression:
      switch ((node as PrefixUnaryExpression).operator) {
        case SyntaxKind.ExclamationToken:
        case SyntaxKind.PlusToken:
        case SyntaxKind.MinusToken:
        case SyntaxKind.TildeToken:
          return true;
      }
      return false;
  }
  return false;
}

/** `(0, x.f)(...)` or `(0, eval)(...)`, which call without passing `this`. */
function isIndirectCall(node: BinaryExpression): boolean {
  const left = node.left;
  const right = node.right;
  const parent = node.parent!;
  if (
    parent.kind !== SyntaxKind.ParenthesizedExpression ||
    left.kind !== SyntaxKind.NumericLiteral ||
    getText(left) !== '0'
  )
    return false;
  const grand = parent.parent!;
  const called =
    (grand.kind === SyntaxKind.CallExpression && getExpression(grand) === parent) ||
    grand.kind === SyntaxKind.TaggedTemplateExpression;
  return called && (isAccessExpression(right) || (right.kind === SyntaxKind.Identifier && getText(right) === 'eval'));
}
