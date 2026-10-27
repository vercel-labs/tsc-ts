// The sort orders of imports and named import specifiers, detected from a file as tsgo's lsutil organize-imports
// helpers detect them for auto-imports, with the default preferences (ordinal comparison, case detected, type-only
// specifiers placed as detected).
import {
  CallExpression,
  ExternalModuleReference,
  getModuleSpecifier,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  NamedImports,
  type Node,
  NoSubstitutionTemplateLiteral,
  type SourceFile,
  StringLiteral,
  type VariableDeclaration,
  VariableStatement,
} from '../compiler/ast.js';
import { isExternalModuleNameRelative } from '../compiler/path.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';

export type StringComparer = (a: string, b: string) => number;
export type NodeComparer = (a: Node, b: Node) => number;

/** Where type-only specifiers go among named imports. */
export const enum TypeOrder {
  Last,
  Inline,
  First,
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Case-insensitive, then equal only when the same, as ESLint's `sort-imports` compares. */
function compareStringsIgnoringCase(a: string, b: string): number {
  if (a === b) return 0;
  return compareStrings(a.toLowerCase(), b.toLowerCase());
}

// Case-insensitive first, then case-sensitive, as tsgo tries them.
const comparersToTest: readonly StringComparer[] = [compareStringsIgnoringCase, compareStrings];
const typeOrdersToTest: readonly TypeOrder[] = [TypeOrder.Last, TypeOrder.Inline, TypeOrder.First];

function getModuleSpecifierExpression(statement: Node): Node | undefined {
  if (statement instanceof ImportEqualsDeclaration) {
    const reference = statement.moduleReference;
    return reference.kind === SyntaxKind.ExternalModuleReference
      ? (reference as ExternalModuleReference).expression
      : undefined;
  }
  if (statement instanceof ImportDeclaration) return getModuleSpecifier(statement);
  if (statement instanceof VariableStatement) {
    const declaration = statement.declarationList.declarations.nodes[0] as VariableDeclaration | undefined;
    const initializer = declaration?.initializer;
    if (initializer instanceof CallExpression) return initializer.arguments.nodes[0];
  }
  return undefined;
}

function getExternalModuleName(specifier: Node | undefined): string {
  if (specifier instanceof StringLiteral) return specifier.text;
  if (specifier instanceof NoSubstitutionTemplateLiteral) return specifier.text;
  return '';
}

function compareBooleans(a: boolean, b: boolean): number {
  return a === b ? 0 : a ? 1 : -1;
}

function compareModuleSpecifiers(m1: Node | undefined, m2: Node | undefined, comparer: StringComparer): number {
  const name1 = getExternalModuleName(m1);
  const name2 = getExternalModuleName(m2);
  return (
    compareBooleans(name1 === '', name2 === '') ||
    compareBooleans(isExternalModuleNameRelative(name1), isExternalModuleNameRelative(name2)) ||
    comparer(name1, name2)
  );
}

// Side-effect, type-only, namespace, default and named imports, `import =`, then `require` statements.
function getImportKindOrder(statement: Node): number {
  if (statement instanceof ImportDeclaration) {
    const clause = statement.importClause;
    if (clause === undefined) return 0;
    if (clause.phaseModifier === SyntaxKind.TypeKeyword) return 1;
    if (clause.namedBindings?.kind === SyntaxKind.NamespaceImport) return 2;
    if (clause.name !== undefined) return 3;
    return 4;
  }
  if (statement instanceof ImportEqualsDeclaration) return 5;
  if (statement instanceof VariableStatement) return 6;
  return 7;
}

/** Orders import or require statements by module specifier, then kind. */
export function compareImportsOrRequireStatements(s1: Node, s2: Node, comparer: StringComparer): number {
  return (
    compareModuleSpecifiers(getModuleSpecifierExpression(s1), getModuleSpecifierExpression(s2), comparer) ||
    getImportKindOrder(s1) - getImportKindOrder(s2)
  );
}

function specifierName(node: Node): string {
  return (node as ImportSpecifier).name.text;
}

function isTypeOnlySpecifier(node: Node): boolean {
  return (node as ImportSpecifier).isTypeOnly;
}

function compareImportSpecifiers(s1: Node, s2: Node, comparer: StringComparer, typeOrder: TypeOrder): number {
  switch (typeOrder) {
    case TypeOrder.First:
      return (
        compareBooleans(isTypeOnlySpecifier(s2), isTypeOnlySpecifier(s1)) ||
        comparer(specifierName(s1), specifierName(s2))
      );
    case TypeOrder.Inline:
      return comparer(specifierName(s1), specifierName(s2));
    default:
      return (
        compareBooleans(isTypeOnlySpecifier(s1), isTypeOnlySpecifier(s2)) ||
        comparer(specifierName(s1), specifierName(s2))
      );
  }
}

function specifierComparer(comparer: StringComparer, typeOrder: TypeOrder): NodeComparer {
  return (s1, s2) => compareImportSpecifiers(s1, s2, comparer, typeOrder);
}

/** The index a binary search over sorted elements gives for `value`: where it is, or where it would go. */
export function binarySearchInsertionIndex<T>(
  sorted: readonly T[],
  value: T,
  comparer: (a: T, b: T) => number,
): number {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = low + ((high - low) >> 1);
    const order = comparer(sorted[middle]!, value);
    if (order < 0) low = middle + 1;
    else if (order > 0) high = middle - 1;
    else return middle;
  }
  return low;
}

function measureSortedness<T>(list: readonly T[], comparer: (a: T, b: T) => number): number {
  let unsorted = 0;
  for (let i = 0; i + 1 < list.length; i++) if (comparer(list[i]!, list[i + 1]!) > 0) unsorted++;
  return unsorted;
}

// The comparer under which the lists are closest to sorted, and whether they are sorted under it.
function detectCaseSensitivityBySort(groups: readonly (readonly string[])[]): {
  comparer: StringComparer;
  isSorted: boolean;
} {
  let best: StringComparer | undefined;
  let bestDiff = Number.MAX_SAFE_INTEGER;
  for (const comparer of comparersToTest) {
    let diff = 0;
    for (const list of groups) if (list.length > 1) diff += measureSortedness(list, comparer);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = comparer;
    }
  }
  return { comparer: best ?? comparersToTest[0]!, isSorted: bestDiff === 0 };
}

/** The module specifier order of a file's imports, and whether they are sorted in it. */
export function detectModuleSpecifierOrder(statements: readonly Node[]): {
  comparer: StringComparer;
  isSorted: boolean;
} {
  return detectCaseSensitivityBySort([statements.map((s) => getExternalModuleName(getModuleSpecifierExpression(s)))]);
}

function namedImportsOf(statement: Node): readonly Node[] | undefined {
  if (!(statement instanceof ImportDeclaration)) return undefined;
  const bindings = statement.importClause?.namedBindings;
  if (!(bindings instanceof NamedImports)) return undefined;
  const elements = bindings.elements.nodes;
  return elements.length === 0 ? undefined : elements;
}

// The specifier order of named imports in import declarations: comparer, type order, and whether they are sorted.
function detectNamedImportOrganization(
  statements: readonly Node[],
): { comparer: StringComparer; typeOrder: TypeOrder; isSorted: boolean } | undefined {
  const lists: (readonly Node[])[] = [];
  let bothKinds = false;
  for (const statement of statements) {
    const elements = namedImportsOf(statement);
    if (elements === undefined) continue;
    if (!bothKinds && elements.some(isTypeOnlySpecifier) && elements.some((e) => !isTypeOnlySpecifier(e)))
      bothKinds = true;
    lists.push(elements);
  }
  if (lists.length === 0) return undefined;
  if (!bothKinds) {
    const state = detectCaseSensitivityBySort(lists.map((elements) => elements.map(specifierName)));
    return { comparer: state.comparer, typeOrder: TypeOrder.Last, isSorted: state.isSorted };
  }
  const bestDiff = new Map<TypeOrder, number>(typeOrdersToTest.map((t) => [t, Number.MAX_SAFE_INTEGER]));
  const bestComparer = new Map<TypeOrder, StringComparer>(typeOrdersToTest.map((t) => [t, comparersToTest[0]!]));
  for (const comparer of comparersToTest) {
    const diffs = new Map<TypeOrder, number>(typeOrdersToTest.map((t) => [t, 0]));
    for (const elements of lists) {
      for (const typeOrder of typeOrdersToTest) {
        diffs.set(
          typeOrder,
          diffs.get(typeOrder)! + measureSortedness(elements, specifierComparer(comparer, typeOrder)),
        );
      }
    }
    for (const typeOrder of typeOrdersToTest) {
      if (diffs.get(typeOrder)! < bestDiff.get(typeOrder)!) {
        bestDiff.set(typeOrder, diffs.get(typeOrder)!);
        bestComparer.set(typeOrder, comparer);
      }
    }
  }
  for (const typeOrder of typeOrdersToTest) {
    if (typeOrdersToTest.every((other) => bestDiff.get(other)! >= bestDiff.get(typeOrder)!)) {
      return { comparer: bestComparer.get(typeOrder)!, typeOrder, isSorted: bestDiff.get(typeOrder) === 0 };
    }
  }
  return {
    comparer: bestComparer.get(TypeOrder.Last)!,
    typeOrder: TypeOrder.Last,
    isSorted: bestDiff.get(TypeOrder.Last) === 0,
  };
}

/**
 * The comparer for named import specifiers of an import, detected from the import itself or else from the file's
 * imports, and whether the specifiers are sorted under it (undefined when nothing was detected).
 */
export function getNamedImportSpecifierComparer(
  importDeclaration: Node,
  file: SourceFile,
): { comparer: NodeComparer; isSorted: boolean | undefined } {
  let comparer = specifierComparer(comparersToTest[0]!, TypeOrder.Last);
  let isSorted: boolean | undefined;
  if (importDeclaration instanceof ImportDeclaration) {
    const detected =
      detectNamedImportOrganization([importDeclaration]) ??
      detectNamedImportOrganization(file.statements.nodes.filter((s) => s.kind === SyntaxKind.ImportDeclaration));
    if (detected !== undefined) {
      isSorted = detected.isSorted;
      comparer = specifierComparer(detected.comparer, detected.typeOrder);
    }
  }
  return { comparer, isSorted };
}

/** Whether a clause is `import type`. */
export function isTypeOnlyImportClause(clause: ImportClause): boolean {
  return clause.phaseModifier === SyntaxKind.TypeKeyword;
}
