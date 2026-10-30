// Printing types, symbols, signatures and type predicates as text, as tsgo does: the node builder
// writes their nodes and the printer prints them.
import type { Node } from './ast.js';
import type { Checker } from './checker.js';
import { getBaseTypeOfEnumLikeType, getRegularTypeOfLiteralType, typesOf } from './checker-type-factory.js';
import { type Signature, SignatureFlags, type Type, TypeFlags, type TypePredicate } from './checker-types.js';
import { NodeBuilder, typeToStringFromTypeNode } from './node-builder.js';
import { symbolToExpression } from './node-builder-names.js';
import { newPseudoChecker } from './node-builder-pseudo.js';
import { Printer, PrinterOptions } from './printer/printer.js';
import { TextWriter } from './printer/text-writer.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import { NodeBuilderFlags, NodeBuilderInternalFlags } from './transformers/declarations-resolver.js';

/** Prints `node` on one line without comments. */
function printSingleLine(b: NodeBuilder, node: Node, neverAsciiEscape: boolean): string {
  const options = new PrinterOptions();
  options.removeComments = true;
  options.neverAsciiEscape = neverAsciiEscape;
  options.newLine = '';
  const writer = new TextWriter('', 0);
  new Printer(options, b.context).write(node, undefined, writer, undefined);
  return writer.getText();
}

/** `t` as text; `flags` are `TypeFormatFlags`. */
export function typeToString(c: Checker, t: Type, enclosingDeclaration?: Node, flags?: number): string {
  // Without explicit flags, unique symbols print as such and aliases from other scopes are used.
  const formatFlags =
    flags ?? NodeBuilderFlags.AllowUniqueESSymbolType | NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope;
  // Prints nested in a serialization depend on its depth (typeToStringFromTypeNode), so only the others are kept.
  if (c.serializationLevel !== 0) return typeToStringFromTypeNode(c, t, enclosingDeclaration, formatFlags) ?? '';
  // The variance check in progress names the marker types (`sub-T`, `super-T`) after its type parameter.
  const variance = c.varianceTypeParameter;
  const key =
    String(t.id) +
    ',' +
    String(enclosingDeclaration === undefined ? 0 : enclosingDeclaration.id) +
    ',' +
    String(formatFlags) +
    ',' +
    String(variance === undefined ? 0 : variance.id);
  const cached = c.typeStrings.get(key);
  if (cached !== undefined) return cached;
  // A print that creates no types reads only types that exist and settled state, so printing again gives the same
  // text and creates nothing; prints that create types run each time, as in tsgo, so type ids stay in tsgo's order.
  const typeCount = c.typeCount;
  const text = typeToStringFromTypeNode(c, t, enclosingDeclaration, formatFlags) ?? '';
  if (c.typeCount === typeCount) c.typeStrings.set(key, text);
  return text;
}

/** `symbol` as text: the expression naming it, as seen from `enclosingDeclaration` if given. */
export function symbolToString(
  c: Checker,
  symbol: Symbol,
  enclosingDeclaration?: Node,
  internalFlags: NodeBuilderInternalFlags = NodeBuilderInternalFlags.None,
): string {
  // Kept as typeToString keeps type prints: outside serializations, when printing created no types.
  const key = String(enclosingDeclaration === undefined ? 0 : enclosingDeclaration.id) + ',' + String(internalFlags);
  const kept = c.serializationLevel === 0 ? c.symbolStrings.get(symbol) : undefined;
  const cached = kept?.get(key);
  if (cached !== undefined) return cached;
  const typeCount = c.typeCount;
  const b = new NodeBuilder(c, enclosingDeclaration, NodeBuilderFlags.IgnoreErrors, internalFlags, undefined);
  const text = printSingleLine(
    b,
    symbolToExpression(b, symbol, SymbolFlags.All),
    enclosingDeclaration !== undefined && enclosingDeclaration.kind === SyntaxKind.SourceFile,
  );
  if (c.serializationLevel === 0 && c.typeCount === typeCount) {
    let byKey = kept;
    if (byKey === undefined) {
      byKey = new Map<string, string>();
      c.symbolStrings.set(symbol, byKey);
    }
    byKey.set(key, text);
  }
  return text;
}

/** `signature` as text: a call or construct signature without its trailing semicolon. */
export function signatureToString(c: Checker, signature: Signature): string {
  const kind =
    (signature.flags & SignatureFlags.Construct) !== 0 ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature;
  const b = new NodeBuilder(
    c,
    undefined,
    NodeBuilderFlags.IgnoreErrors | NodeBuilderFlags.WriteTypeParametersInQualifiedName,
    NodeBuilderInternalFlags.None,
    undefined,
  );
  b.pseudo = newPseudoChecker(c);
  const text = printSingleLine(b, b.signatureToSignatureDeclaration(signature, kind, undefined), true);
  return text.endsWith(';') ? text.substring(0, text.length - 1) : text;
}

/** `predicate` as text, like `x is T`. */
export function typePredicateToString(c: Checker, predicate: TypePredicate): string {
  const b = new NodeBuilder(
    c,
    undefined,
    NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
      NodeBuilderFlags.IgnoreErrors |
      NodeBuilderFlags.WriteTypeParametersInQualifiedName,
    NodeBuilderInternalFlags.None,
    undefined,
  );
  b.pseudo = newPseudoChecker(c);
  return printSingleLine(b, b.typePredicateToTypePredicateNode(predicate), false);
}

/** Union constituents as printed: enum and boolean literal runs collapse, null and undefined go last. */
export function formatUnionTypes(c: Checker, types: readonly Type[], expandingEnum: boolean): Type[] {
  const result: Type[] = [];
  let flags = 0;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    flags |= t.flags;
    if ((t.flags & TypeFlags.Nullable) !== 0) continue;
    if ((t.flags & TypeFlags.BooleanLiteral) !== 0 || (!expandingEnum && (t.flags & TypeFlags.EnumLike) !== 0)) {
      const baseType = (t.flags & TypeFlags.BooleanLiteral) !== 0 ? c.booleanType : getBaseTypeOfEnumLikeType(c, t);
      if ((baseType.flags & TypeFlags.Union) !== 0) {
        const baseTypes = typesOf(baseType);
        const count = baseTypes.length;
        if (
          i + count <= types.length &&
          getRegularTypeOfLiteralType(c, types[i + count - 1]!) ===
            getRegularTypeOfLiteralType(c, baseTypes[count - 1]!)
        ) {
          result.push(baseType);
          i += count - 1;
          continue;
        }
      }
    }
    result.push(t);
  }
  if ((flags & TypeFlags.Null) !== 0) result.push(c.nullType);
  if ((flags & TypeFlags.Undefined) !== 0) result.push(c.undefinedType);
  return result;
}
