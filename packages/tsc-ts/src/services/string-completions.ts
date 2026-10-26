// Completions inside string literals: literal types, property names and module specifiers.
import {
  BinaryExpression,
  getArguments,
  getLiteral,
  ElementAccessExpression,
  getElements,
  getExpression,
  getName,
  getPropertyName,
  getText,
  IndexedAccessTypeNode,
  type Node,
  type SourceFile,
  StringLiteral,
  UnionTypeNode,
  CaseBlock,
} from '../compiler/ast.js';
import { getStartOfNode } from '../compiler/astnav.js';
import { isPrivateIdentifierClassElementDeclaration, skipParentheses } from '../compiler/binder-utilities.js';
import type { Checker } from '../compiler/checker.js';
import { getSymbolAtLocation, getTypeAtLocation } from '../compiler/checker-services.js';
import { getIndexInfosOfType, getPropertiesOfType } from '../compiler/checker-members.js';
import { getResolvedSignatureWithCandidates } from './completion-signatures.js';
import { getTypeFromTypeNode } from '../compiler/checker-type-nodes.js';
import { getTypeAtPosition } from '../compiler/checker-signatures.js';
import { getBaseConstraintOfType } from '../compiler/checker-members.js';
import { LiteralType, type Type, TypeFlags } from '../compiler/checker-types.js';
import { typesOf } from '../compiler/checker-type-factory.js';
import type { CompilerOptions } from '../compiler/options.js';
import type { Program } from '../compiler/program.js';
import { escapeString, LiteralTextFlags } from '../compiler/printer/utilities.js';
import type { Symbol } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import { getApparentProperties, getExportsAndPropertiesOfModule } from './completion-checker.js';
import {
  CaseClauseTracker,
  ContextFlags,
  findAncestor,
  getArgumentInfoForCompletions,
  getContextualTypeFromParent,
  isCallLikeExpression,
  isInString,
  isStringLiteralLike,
  type ArgumentInfoForCompletions,
} from './completion-utilities.js';
import {
  CompletionKind,
  type CompletionList,
  createEntry,
  getCompletionEntriesFromSymbols,
  getConstraintOfTypeArgumentProperty,
  getPropertiesForCompletion,
  getPropertiesForObjectExpression,
  newCompletionData,
  SortText,
} from './completions.js';
import { getContextualTypeWithFlags, getTypeArgumentConstraint } from './completion-checker.js';
import {
  getStringLiteralCompletionsFromModuleNames,
  getTripleSlashReferenceCompletions,
  isInReferenceComment,
  type PathCompletion,
} from './path-completions.js';
import { ScriptElementKind } from './symbol-kinds.js';

interface CompletionsFromTypes {
  types: Type[];
  isNewIdentifier: boolean;
}

interface CompletionsFromProperties {
  symbols: Symbol[];
  hasIndexSignature: boolean;
}

interface StringLiteralCompletions {
  fromTypes?: CompletionsFromTypes;
  fromProperties?: CompletionsFromProperties;
  fromPaths?: PathCompletion[];
}

export function getStringLiteralCompletions(
  c: Checker,
  program: Program,
  file: SourceFile,
  position: number,
  contextToken: Node | undefined,
  includeSymbols: boolean,
): CompletionList | undefined {
  if (isInReferenceComment(file, position)) {
    const completions = getTripleSlashReferenceCompletions(program, file, position);
    return completions === undefined ? undefined : convertPathCompletions(completions, file, position);
  }
  if (!isInString(file, position, contextToken)) return undefined;
  if (contextToken === undefined || !isStringLiteralLike(contextToken)) return undefined;
  const entries = getStringLiteralCompletionEntries(c, program, file, contextToken, position);
  return convertStringLiteralCompletions(c, program.options, entries, contextToken, file, position, includeSymbols);
}

function convertStringLiteralCompletions(
  c: Checker,
  options: CompilerOptions,
  completion: StringLiteralCompletions | undefined,
  contextToken: Node,
  file: SourceFile,
  position: number,
  includeSymbols: boolean,
): CompletionList | undefined {
  if (completion === undefined) return undefined;
  if (completion.fromPaths !== undefined) return convertPathCompletions(completion.fromPaths, file, position);
  if (completion.fromProperties !== undefined) {
    const data = newCompletionData(file, contextToken);
    data.symbols = completion.fromProperties.symbols;
    data.completionKind = CompletionKind.String;
    data.isNewIdentifierLocation = completion.fromProperties.hasIndexSignature;
    const { entries } = getCompletionEntriesFromSymbols(c, options, data, contextToken, position, file, includeSymbols);
    return { isIncomplete: false, entries };
  }
  if (completion.fromTypes !== undefined) {
    let quote = 0x22;
    if (contextToken.kind === SyntaxKind.NoSubstitutionTemplateLiteral) quote = 0x60;
    else if (file.text.charCodeAt(getStartOfNode(contextToken, file, false)) === 0x27) quote = 0x27;
    const entries = completion.fromTypes.types.map((t) =>
      createEntry(
        escapeString((t as LiteralType).stringValue, quote, LiteralTextFlags.NeverAsciiEscape),
        '',
        '',
        SortText.LocationPriority,
        ScriptElementKind.String,
        false,
        file,
        position,
      ),
    );
    return { isIncomplete: false, entries };
  }
  return undefined;
}

function convertPathCompletions(pathCompletions: PathCompletion[], file: SourceFile, position: number): CompletionList {
  const entries = pathCompletions.map((p) => {
    const detail = p.name.endsWith(p.extension) ? p.name : p.name + p.extension;
    return createEntry(p.name, '', '', SortText.LocationPriority, p.kind, false, file, position, detail);
  });
  return { isIncomplete: false, entries };
}

function walkUpParentheses(node: Node): Node {
  let n = node;
  while (n.kind === SyntaxKind.ParenthesizedType || n.kind === SyntaxKind.ParenthesizedExpression) n = n.parent!;
  return n;
}

function getStringLiteralCompletionEntries(
  c: Checker,
  program: Program,
  file: SourceFile,
  node: Node,
  position: number,
): StringLiteralCompletions | undefined {
  const parent = walkUpParentheses(node.parent!);
  switch (parent.kind) {
    case SyntaxKind.LiteralType: {
      const grandparent = walkUpParentheses(parent.parent!);
      if (grandparent.kind === SyntaxKind.ImportType)
        return { fromPaths: getStringLiteralCompletionsFromModuleNames(program, c, file, node) };
      return fromUnionableLiteralType(c, grandparent, parent, position);
    }
    case SyntaxKind.PropertyAssignment: {
      if (parent.parent!.kind === SyntaxKind.ObjectLiteralExpression && getName(parent) === node)
        // Quoted property names of the object literal's contextual type.
        return { fromProperties: stringLiteralCompletionsForObjectLiteral(c, parent.parent!) };
      if (findAncestor(parent.parent, isCallLikeExpression) !== undefined) {
        const uniques = new Set<string>();
        const types = [
          ...getStringLiteralTypes(c, getContextualTypeWithFlags(c, node, ContextFlags.None), uniques),
          ...getStringLiteralTypes(c, getContextualTypeWithFlags(c, node, ContextFlags.Completions), uniques),
        ];
        return toStringLiteralCompletionsFromTypes(types);
      }
      return { fromTypes: fromContextualType(c, ContextFlags.None, node) };
    }
    case SyntaxKind.ElementAccessExpression: {
      const access = parent as ElementAccessExpression;
      if (node === skipParentheses(access.argumentExpression)) {
        // Property names of the accessed object.
        const t = getTypeAtLocation(c, access.expression);
        return { fromProperties: stringLiteralCompletionsFromProperties(c, t) };
      }
      return undefined;
    }
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.JsxAttribute:
      if (!isRequireCallArgument(node) && !isImportCall(parent)) {
        const argumentNode = parent.kind === SyntaxKind.JsxAttribute ? parent.parent! : node;
        const argumentInfo = getArgumentInfoForCompletions(c, argumentNode, position, file);
        // Literal types from the overloads of the call.
        if (argumentInfo === undefined) return undefined;
        const result = getStringLiteralCompletionsFromSignature(c, argumentInfo.invocation, node, argumentInfo);
        if (result !== undefined) return { fromTypes: result };
        return { fromTypes: fromContextualType(c, ContextFlags.None, node) };
      }
      return { fromPaths: getStringLiteralCompletionsFromModuleNames(program, c, file, node) };
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExternalModuleReference:
    case SyntaxKind.JSDocImportTag:
      // Module names: `import * as ns from "|"`, `import x = require("|")`, `export * from "|"`.
      return { fromPaths: getStringLiteralCompletionsFromModuleNames(program, c, file, node) };
    case SyntaxKind.CaseClause: {
      const tracker = new CaseClauseTracker(c, (parent.parent as CaseBlock).clauses.nodes);
      const contextualTypes = fromContextualType(c, ContextFlags.Completions, node);
      if (contextualTypes === undefined) return undefined;
      const literals = contextualTypes.types.filter((t) => !tracker.hasString((t as LiteralType).stringValue));
      return { fromTypes: { types: literals, isNewIdentifier: false } };
    }
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier: {
      // String aliases in `import { "|" } from` and `export { "|" } from`.
      const propertyName = getPropertyName(parent);
      if (propertyName !== undefined && node !== propertyName) return undefined;
      const namedImportsOrExports = parent.parent!;
      const moduleSpecifier =
        namedImportsOrExports.kind === SyntaxKind.NamedImports
          ? namedImportsOrExports.parent!.parent
          : namedImportsOrExports.parent;
      if (moduleSpecifier === undefined) return undefined;
      const moduleSpecifierSymbol = getSymbolAtLocation(c, moduleSpecifier);
      if (moduleSpecifierSymbol === undefined) return undefined;
      const exports = getExportsAndPropertiesOfModule(c, moduleSpecifierSymbol);
      const existing = new Set<string>();
      for (const n of getElements(namedImportsOrExports)!.nodes)
        existing.add(getText(getPropertyName(n) ?? getName(n)!));
      return {
        fromProperties: {
          symbols: exports.filter((e) => e.name !== 'default' && !existing.has(e.name)),
          hasIndexSignature: false,
        },
      };
    }
    case SyntaxKind.BinaryExpression: {
      const binary = parent as BinaryExpression;
      if (binary.operatorToken.kind === SyntaxKind.InKeyword) {
        const t = getTypeAtLocation(c, binary.right);
        const properties = getPropertiesForCompletion(c, t);
        return {
          fromProperties: {
            symbols: properties.filter(
              (s) =>
                s.valueDeclaration === undefined || !isPrivateIdentifierClassElementDeclaration(s.valueDeclaration),
            ),
            hasIndexSignature: false,
          },
        };
      }
      return { fromTypes: fromContextualType(c, ContextFlags.None, node) };
    }
  }
  const result = fromContextualType(c, ContextFlags.Completions, node);
  if (result !== undefined) return { fromTypes: result };
  return { fromTypes: fromContextualType(c, ContextFlags.None, node) };
}

function isImportCall(node: Node): boolean {
  return node.kind === SyntaxKind.CallExpression && getExpression(node)!.kind === SyntaxKind.ImportKeyword;
}

function isRequireCallArgument(node: Node): boolean {
  const parent = node.parent!;
  if (parent.kind !== SyntaxKind.CallExpression) return false;
  const argumentList = getArguments(parent);
  if (argumentList === undefined) return false;
  const args = argumentList.nodes;
  const callee = getExpression(parent)!;
  return args.length > 0 && args[0] === node && callee.kind === SyntaxKind.Identifier && getText(callee) === 'require';
}

function fromContextualType(c: Checker, contextFlags: ContextFlags, node: Node): CompletionsFromTypes | undefined {
  // `var x: "hi" | "hello" = "|"`
  return toCompletionsFromTypes(
    getStringLiteralTypes(c, getContextualTypeFromParent(c, node, contextFlags), undefined),
  );
}

function toCompletionsFromTypes(types: Type[]): CompletionsFromTypes | undefined {
  return types.length === 0 ? undefined : { types, isNewIdentifier: false };
}

function toStringLiteralCompletionsFromTypes(types: Type[]): StringLiteralCompletions | undefined {
  const result = toCompletionsFromTypes(types);
  return result === undefined ? undefined : { fromTypes: result };
}

function fromUnionableLiteralType(
  c: Checker,
  grandparent: Node,
  parent: Node,
  position: number,
): StringLiteralCompletions | undefined {
  switch (grandparent.kind) {
    case SyntaxKind.CallExpression:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.TypeReference: {
      const typeArgument = findAncestor(parent, (n) => n.parent === grandparent);
      if (typeArgument === undefined) return undefined;
      const t = getTypeArgumentConstraint(c, typeArgument);
      return { fromTypes: { types: getStringLiteralTypes(c, t, undefined), isNewIdentifier: false } };
    }
    case SyntaxKind.IndexedAccessType: {
      // `Foo["|"]`: the apparent property names.
      const access = grandparent as IndexedAccessTypeNode;
      if (!(access.indexType.pos <= position && position <= access.indexType.end)) return undefined;
      const t = getTypeFromTypeNode(c, access.objectType);
      return { fromProperties: stringLiteralCompletionsFromProperties(c, t) };
    }
    case SyntaxKind.UnionType: {
      const result = fromUnionableLiteralType(c, walkUpParentheses(grandparent.parent!), parent, position);
      if (result === undefined) return undefined;
      const alreadyUsedTypes = getAlreadyUsedTypesInStringLiteralUnion(grandparent as UnionTypeNode, parent);
      if (result.fromProperties !== undefined)
        return {
          fromProperties: {
            symbols: result.fromProperties.symbols.filter((s) => !alreadyUsedTypes.includes(s.name)),
            hasIndexSignature: result.fromProperties.hasIndexSignature,
          },
        };
      if (result.fromTypes !== undefined)
        return {
          fromTypes: {
            types: result.fromTypes.types.filter((t) => !alreadyUsedTypes.includes((t as LiteralType).stringValue)),
            isNewIdentifier: false,
          },
        };
      return undefined;
    }
    case SyntaxKind.PropertySignature:
      return {
        fromTypes: {
          types: getStringLiteralTypes(c, getConstraintOfTypeArgumentProperty(c, grandparent), undefined),
          isNewIdentifier: false,
        },
      };
  }
  return undefined;
}

function stringLiteralCompletionsForObjectLiteral(
  c: Checker,
  objectLiteral: Node,
): CompletionsFromProperties | undefined {
  const contextualType = getContextualTypeWithFlags(c, objectLiteral, ContextFlags.None);
  if (contextualType === undefined) return undefined;
  const completionsType = getContextualTypeWithFlags(c, objectLiteral, ContextFlags.Completions);
  return {
    symbols: getPropertiesForObjectExpression(c, contextualType, completionsType, objectLiteral),
    hasIndexSignature: hasIndexSignature(c, contextualType),
  };
}

function stringLiteralCompletionsFromProperties(c: Checker, t: Type): CompletionsFromProperties {
  return {
    symbols: getApparentProperties(c, t).filter(
      (s) => !(s.valueDeclaration !== undefined && isPrivateIdentifierClassElementDeclaration(s.valueDeclaration)),
    ),
    hasIndexSignature: hasIndexSignature(c, t),
  };
}

function getStringLiteralTypes(c: Checker, t: Type | undefined, uniquesIn: Set<string> | undefined): Type[] {
  if (t === undefined) return [];
  const uniques = uniquesIn ?? new Set<string>();
  const skipped = skipConstraint(c, t);
  if ((skipped.flags & TypeFlags.Union) !== 0) {
    const result: Type[] = [];
    for (const u of typesOf(skipped)) result.push(...getStringLiteralTypes(c, u, uniques));
    return result;
  }
  if ((skipped.flags & TypeFlags.StringLiteral) !== 0 && (skipped.flags & TypeFlags.EnumLiteral) === 0) {
    const value = (skipped as LiteralType).stringValue;
    if (!uniques.has(value)) {
      uniques.add(value);
      return [skipped];
    }
  }
  return [];
}

function skipConstraint(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.TypeParameter) !== 0) return getBaseConstraintOfType(c, t) ?? t;
  return t;
}

function getAlreadyUsedTypesInStringLiteralUnion(union: UnionTypeNode, current: Node): string[] {
  const result: string[] = [];
  for (const t of union.types.nodes) {
    if (t === current || t.kind !== SyntaxKind.LiteralType) continue;
    const literal = getLiteral(t);
    if (literal instanceof StringLiteral) result.push(literal.text);
  }
  return result;
}

function hasIndexSignature(c: Checker, t: Type): boolean {
  return getIndexInfosOfType(c, t).length > 0 || getPropertiesOfType(c, t).length < 0;
}

function getStringLiteralCompletionsFromSignature(
  c: Checker,
  call: Node,
  arg: Node,
  argumentInfo: ArgumentInfoForCompletions,
): CompletionsFromTypes | undefined {
  let isNewIdentifier = false;
  const uniques = new Set<string>();
  const editingArgument = isJsxOpeningLikeElementNode(call)
    ? findAncestor(arg.parent, (n) => n.kind === SyntaxKind.JsxAttribute)!
    : arg;
  const candidates = getResolvedSignatureWithCandidates(c, call);
  const types: Type[] = [];
  for (const candidate of candidates) {
    if (!candidate.hasRestParameter() && argumentInfo.argumentCount > candidate.parameters.length) continue;
    let t = getTypeAtPosition(c, candidate, argumentInfo.argumentIndex);
    if (isJsxOpeningLikeElementNode(call)) {
      const propType = getTypeOfPropertyOfType(c, t, getText(getName(editingArgument)!));
      if (propType !== undefined) t = propType;
    }
    isNewIdentifier = isNewIdentifier || (t.flags & TypeFlags.String) !== 0;
    types.push(...getStringLiteralTypes(c, t, uniques));
  }
  if (types.length === 0) return undefined;
  return { types, isNewIdentifier };
}

import { getTypeOfPropertyOfType } from '../compiler/checker-members.js';

function isJsxOpeningLikeElementNode(node: Node): boolean {
  return node.kind === SyntaxKind.JsxOpeningElement || node.kind === SyntaxKind.JsxSelfClosingElement;
}
