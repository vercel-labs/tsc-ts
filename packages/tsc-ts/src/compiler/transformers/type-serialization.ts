// How decorator metadata serializes a type reference, answered from syntax and the binder's
// symbols. The checker answers from the referenced type itself; this follows its rules for
// what syntax shows: classes, enums, interfaces, type aliases and type parameters, through
// imports. Types only the checker can compute (conditional, mapped and indexed access types,
// inherited members) serialize as `Object`.
import {
  ArrayTypeNode,
  EnumDeclaration,
  Identifier,
  ImportClause,
  InterfaceDeclaration,
  LiteralTypeNode,
  type Node,
  ParenthesizedTypeNode,
  PrefixUnaryExpression,
  QualifiedName,
  TypeAliasDeclaration,
  TypeLiteralNode,
  TypeOperatorNode,
  TypeParameterDeclaration,
  TypeReferenceNode,
  UnionTypeNode,
  VariableDeclaration,
  getIsTypeOnly,
  getText,
} from '../ast.js';
import { getStrictOptionValue } from '../options.js';
import { SyntaxKind } from '../syntax-kind.js';
import { ConstantKind, type ReferenceResolver } from './reference-resolver.js';
import { declarationAt, declarationCount, getDeclarations, Symbol, SymbolFlags } from '../symbol.js';

/** What a type reference in decorator metadata serializes to. */
export const enum TypeReferenceSerializationKind {
  /** Unresolved: emitted with a guard in case it's undefined at runtime. */
  Unknown,
  /** A class, or a value with construct signatures: emitted as its name. */
  TypeWithConstructSignatureAndValue,
  VoidNullableOrNeverType,
  NumberLikeType,
  BigIntLikeType,
  StringLikeType,
  BooleanType,
  ArrayLikeType,
  ESSymbolType,
  Promise,
  TypeWithCallSignature,
  ObjectType,
}

/** What an unresolvable alias resolves to, as the checker's unknown symbol. */
const unknownSymbol = new Symbol(SymbolFlags.All, 'unknown');

/** Nested type aliases followed before giving up. */
const maxDepth = 16;

export function getTypeReferenceSerializationKind(
  resolver: ReferenceResolver,
  typeName: Node,
  location: Node | undefined,
): TypeReferenceSerializationKind {
  if (location === undefined) return TypeReferenceSerializationKind.Unknown;
  // The value must be reachable at runtime.
  let isTypeOnly = false;
  if (typeName instanceof QualifiedName) {
    const root = resolveEntityName(resolver, getFirstIdentifier(typeName), SymbolFlags.Value, true, location);
    if (root !== undefined && root !== unknownSymbol && declarationCount(root) > 0) {
      isTypeOnly = true;
      for (const declaration of getDeclarations(root))
        if (!isTypeOnlyImportOrExportDeclaration(declaration)) {
          isTypeOnly = false;
          break;
        }
    }
  }
  const valueSymbol = resolveEntityName(resolver, typeName, SymbolFlags.Value, true, location);
  const resolvedValue = valueSymbol === undefined ? undefined : resolveAlias(resolver, valueSymbol);
  if (valueSymbol !== undefined && isTypeOnlyAlias(resolver, valueSymbol)) isTypeOnly = true;
  const typeSymbol = resolveEntityName(resolver, typeName, SymbolFlags.Type, true, location);
  const resolvedType = typeSymbol === undefined ? undefined : resolveAlias(resolver, typeSymbol);
  if (typeSymbol !== undefined && isTypeOnlyAlias(resolver, typeSymbol)) isTypeOnly = true;

  if (resolvedValue !== undefined && resolvedValue === resolvedType && isConstructorSymbol(resolver, resolvedValue))
    return isTypeOnly
      ? TypeReferenceSerializationKind.TypeWithCallSignature
      : TypeReferenceSerializationKind.TypeWithConstructSignatureAndValue;
  if (resolvedType === undefined || resolvedType === unknownSymbol)
    return isTypeOnly ? TypeReferenceSerializationKind.ObjectType : TypeReferenceSerializationKind.Unknown;
  return new TypeClassifier(resolver).ofSymbol(resolvedType, 0);
}

function resolveAlias(resolver: ReferenceResolver, symbol: Symbol): Symbol {
  if ((symbol.flags & SymbolFlags.Alias) === 0) return symbol;
  const target = resolver.resolveAlias(symbol);
  return target === undefined ? unknownSymbol : resolver.getMergedSymbol(target);
}

function isTypeOnlyAlias(resolver: ReferenceResolver, symbol: Symbol): boolean {
  return (symbol.flags & SymbolFlags.Alias) !== 0 && resolver.isTypeOnlyAliasChain(symbol);
}

/** The symbol of an identifier or qualified name with `meaning`, looked up from `location`. */
function resolveEntityName(
  resolver: ReferenceResolver,
  name: Node,
  meaning: SymbolFlags,
  dontResolveAlias: boolean,
  location: Node,
): Symbol | undefined {
  let symbol: Symbol | undefined = undefined;
  if (name instanceof Identifier) {
    const found = resolver.resolveName(location, name.text, meaning | SymbolFlags.Alias);
    if (found === undefined) return undefined;
    symbol = resolver.getMergedSymbol(found);
    // An alias counts if what it names has the meaning; an unresolved one might.
    if ((symbol.flags & meaning) === 0 && (symbol.flags & SymbolFlags.Alias) !== 0) {
      const target = resolver.resolveAlias(symbol);
      if (target !== undefined && (resolver.getSymbolFlags(symbol, false, false) & meaning) === 0) return undefined;
    }
  } else if (name instanceof QualifiedName) {
    const namespace = resolveEntityName(resolver, name.left, SymbolFlags.Namespace, false, location);
    if (namespace === undefined) return undefined;
    if (namespace === unknownSymbol) return namespace;
    let member = resolver.getExportOfSymbol(namespace, getText(name.right));
    if (member === undefined && (namespace.flags & SymbolFlags.Alias) !== 0) {
      const target = resolver.resolveAlias(namespace);
      if (target !== undefined) member = resolver.getExportOfSymbol(target, getText(name.right));
    }
    if (member === undefined || (member.flags & (meaning | SymbolFlags.Alias)) === 0) return undefined;
    symbol = member;
  } else return undefined;
  if (!dontResolveAlias) {
    while ((symbol.flags & meaning) === 0 && (symbol.flags & SymbolFlags.Alias) !== 0) {
      const target = resolver.resolveAlias(symbol);
      if (target === undefined) return unknownSymbol;
      symbol = resolver.getMergedSymbol(target);
    }
  }
  return symbol;
}

/** Whether the value of a symbol has construct signatures: a class, or a variable typed with `new` signatures. */
function isConstructorSymbol(resolver: ReferenceResolver, symbol: Symbol): boolean {
  if (symbol === unknownSymbol) return false;
  if ((symbol.flags & SymbolFlags.Class) !== 0) return true;
  if ((symbol.flags & SymbolFlags.Variable) === 0) return false;
  const declaration = symbol.valueDeclaration;
  if (!(declaration instanceof VariableDeclaration) || declaration.type === undefined) return false;
  return hasConstructSignature(resolver, declaration.type, declaration, 0);
}

function hasConstructSignature(resolver: ReferenceResolver, type: Node, location: Node, depth: number): boolean {
  if (depth > maxDepth) return false;
  while (type instanceof ParenthesizedTypeNode) type = type.type;
  if (type.kind === SyntaxKind.ConstructorType) return true;
  if (type instanceof TypeLiteralNode) return hasMember(type.members.nodes, SyntaxKind.ConstructSignature);
  if (type instanceof TypeReferenceNode) {
    const symbol = resolveEntityName(resolver, type.typeName, SymbolFlags.Type, false, location);
    if (symbol === undefined || symbol === unknownSymbol) return false;
    for (let i = 0; i < declarationCount(symbol); i++) {
      const declaration = declarationAt(symbol, i);
      if (
        declaration instanceof InterfaceDeclaration &&
        hasMember(declaration.members.nodes, SyntaxKind.ConstructSignature)
      )
        return true;
      if (declaration instanceof TypeAliasDeclaration)
        return hasConstructSignature(resolver, declaration.type, declaration, depth + 1);
    }
  }
  return false;
}

function hasMember(members: Node[], kind: SyntaxKind): boolean {
  for (let i = 0; i < members.length; i++) if (members[i]!.kind === kind) return true;
  return false;
}

/** Classifies declared types in the checker's order: void-like, boolean, number, bigint, string, tuple, symbol, function, array. */
class TypeClassifier {
  private readonly resolver: ReferenceResolver;
  private readonly strictNullChecks: boolean;

  constructor(resolver: ReferenceResolver) {
    this.resolver = resolver;
    this.strictNullChecks = getStrictOptionValue(resolver.options, resolver.options.strictNullChecks);
  }

  ofSymbol(symbol: Symbol, depth: number): TypeReferenceSerializationKind {
    const flags = symbol.flags;
    if ((flags & SymbolFlags.Enum) !== 0) return this.ofEnum(symbol);
    if ((flags & SymbolFlags.EnumMember) !== 0) {
      const declaration = symbol.valueDeclaration;
      if (declaration === undefined) return TypeReferenceSerializationKind.NumberLikeType;
      return this.resolver.getEnumMemberValue(declaration).kind === ConstantKind.String
        ? TypeReferenceSerializationKind.StringLikeType
        : TypeReferenceSerializationKind.NumberLikeType;
    }
    if ((flags & SymbolFlags.Class) !== 0) return TypeReferenceSerializationKind.ObjectType;
    if ((flags & SymbolFlags.TypeAlias) !== 0) {
      for (let i = 0; i < declarationCount(symbol); i++) {
        const declaration = declarationAt(symbol, i);
        if (declaration instanceof TypeAliasDeclaration)
          return this.ofTypeNode(declaration.type, declaration, depth + 1);
      }
      return TypeReferenceSerializationKind.ObjectType;
    }
    if ((flags & SymbolFlags.TypeParameter) !== 0) {
      const declaration = declarationCount(symbol) > 0 ? symbol.declaration! : undefined;
      if (declaration instanceof TypeParameterDeclaration && declaration.constraint !== undefined)
        return this.ofTypeNode(declaration.constraint, declaration, depth + 1);
      return TypeReferenceSerializationKind.ObjectType;
    }
    if ((flags & SymbolFlags.Interface) !== 0) {
      for (let i = 0; i < declarationCount(symbol); i++) {
        const declaration = declarationAt(symbol, i);
        if (
          declaration instanceof InterfaceDeclaration &&
          hasMember(declaration.members.nodes, SyntaxKind.CallSignature)
        )
          return TypeReferenceSerializationKind.TypeWithCallSignature;
      }
    }
    return TypeReferenceSerializationKind.ObjectType;
  }

  /** A union enum of numbers, of strings, or of both; an enum with computed members is numeric. */
  private ofEnum(symbol: Symbol): TypeReferenceSerializationKind {
    let strings = false;
    let numbers = false;
    for (let i = 0; i < declarationCount(symbol); i++) {
      const declaration = declarationAt(symbol, i);
      if (!(declaration instanceof EnumDeclaration)) continue;
      const members = declaration.members.nodes;
      for (let j = 0; j < members.length; j++) {
        if (this.resolver.getEnumMemberValue(members[j]!).kind === ConstantKind.String) strings = true;
        else numbers = true;
      }
    }
    if (strings && numbers) return TypeReferenceSerializationKind.ObjectType;
    return strings ? TypeReferenceSerializationKind.StringLikeType : TypeReferenceSerializationKind.NumberLikeType;
  }

  ofTypeNode(node: Node, location: Node, depth: number): TypeReferenceSerializationKind {
    if (depth > maxDepth) return TypeReferenceSerializationKind.ObjectType;
    while (node instanceof ParenthesizedTypeNode) node = node.type;
    switch (node.kind) {
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
        return TypeReferenceSerializationKind.ObjectType;
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.UndefinedKeyword:
      case SyntaxKind.NeverKeyword:
        return TypeReferenceSerializationKind.VoidNullableOrNeverType;
      case SyntaxKind.BooleanKeyword:
        return TypeReferenceSerializationKind.BooleanType;
      case SyntaxKind.NumberKeyword:
        return TypeReferenceSerializationKind.NumberLikeType;
      case SyntaxKind.BigIntKeyword:
        return TypeReferenceSerializationKind.BigIntLikeType;
      case SyntaxKind.StringKeyword:
      case SyntaxKind.TemplateLiteralType:
        return TypeReferenceSerializationKind.StringLikeType;
      case SyntaxKind.TupleType:
        return TypeReferenceSerializationKind.ArrayLikeType;
      case SyntaxKind.SymbolKeyword:
        return TypeReferenceSerializationKind.ESSymbolType;
      case SyntaxKind.FunctionType:
        return TypeReferenceSerializationKind.TypeWithCallSignature;
      case SyntaxKind.ArrayType:
        return TypeReferenceSerializationKind.ArrayLikeType;
      case SyntaxKind.LiteralType:
        if (node instanceof LiteralTypeNode) return ofLiteral(node.literal);
        break;
      case SyntaxKind.TypeOperator:
        if (node instanceof TypeOperatorNode) {
          if (node.operator === SyntaxKind.UniqueKeyword) return TypeReferenceSerializationKind.ESSymbolType;
          if (node.operator === SyntaxKind.ReadonlyKeyword && node.type instanceof ArrayTypeNode)
            return TypeReferenceSerializationKind.ArrayLikeType;
          if (node.operator === SyntaxKind.ReadonlyKeyword && node.type.kind === SyntaxKind.TupleType)
            return TypeReferenceSerializationKind.ArrayLikeType;
        }
        break;
      case SyntaxKind.TypeLiteral:
        if (node instanceof TypeLiteralNode && hasMember(node.members.nodes, SyntaxKind.CallSignature))
          return TypeReferenceSerializationKind.TypeWithCallSignature;
        break;
      case SyntaxKind.TypeReference:
        if (node instanceof TypeReferenceNode) {
          const symbol = resolveEntityName(this.resolver, node.typeName, SymbolFlags.Type, false, location);
          if (symbol === undefined || symbol === unknownSymbol) return TypeReferenceSerializationKind.ObjectType;
          return this.ofSymbol(symbol, depth + 1);
        }
        break;
      case SyntaxKind.UnionType:
        if (node instanceof UnionTypeNode) return this.ofUnion(node.types.nodes, location, depth);
        break;
    }
    return TypeReferenceSerializationKind.ObjectType;
  }

  /** A union is of a kind when all its members are; without strict null checks, `null` and `undefined` fit any kind. */
  private ofUnion(types: Node[], location: Node, depth: number): TypeReferenceSerializationKind {
    let kind = TypeReferenceSerializationKind.Unknown;
    let nullable = false;
    for (let i = 0; i < types.length; i++) {
      const member = this.ofTypeNode(types[i]!, location, depth + 1);
      if (member === TypeReferenceSerializationKind.VoidNullableOrNeverType) {
        if (types[i]!.kind !== SyntaxKind.NeverKeyword) nullable = true;
        continue;
      }
      if (kind === TypeReferenceSerializationKind.Unknown) kind = member;
      else if (kind !== member) return TypeReferenceSerializationKind.ObjectType;
    }
    if (kind === TypeReferenceSerializationKind.Unknown) return TypeReferenceSerializationKind.VoidNullableOrNeverType;
    if (nullable && this.strictNullChecks) return TypeReferenceSerializationKind.ObjectType;
    switch (kind) {
      case TypeReferenceSerializationKind.BooleanType:
      case TypeReferenceSerializationKind.NumberLikeType:
      case TypeReferenceSerializationKind.BigIntLikeType:
      case TypeReferenceSerializationKind.StringLikeType:
      case TypeReferenceSerializationKind.ESSymbolType:
        return kind;
    }
    return TypeReferenceSerializationKind.ObjectType;
  }
}

function ofLiteral(literal: Node): TypeReferenceSerializationKind {
  switch (literal.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return TypeReferenceSerializationKind.StringLikeType;
    case SyntaxKind.NumericLiteral:
      return TypeReferenceSerializationKind.NumberLikeType;
    case SyntaxKind.BigIntLiteral:
      return TypeReferenceSerializationKind.BigIntLikeType;
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
      return TypeReferenceSerializationKind.BooleanType;
    case SyntaxKind.NullKeyword:
      return TypeReferenceSerializationKind.VoidNullableOrNeverType;
    case SyntaxKind.PrefixUnaryExpression:
      if (literal instanceof PrefixUnaryExpression) return ofLiteral(literal.operand);
      break;
  }
  return TypeReferenceSerializationKind.ObjectType;
}

function getFirstIdentifier(node: Node): Node {
  while (node instanceof QualifiedName) node = node.left;
  return node;
}

/** Whether an alias declaration is type-only, itself or through its import clause. */
function isTypeOnlyImportOrExportDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ExportSpecifier: {
      if (getIsTypeOnly(node)) return true;
      const clause = node.parent === undefined ? undefined : node.parent.parent;
      return clause !== undefined && isTypeOnlyImportClause(clause);
    }
    case SyntaxKind.NamespaceImport:
      return node.parent !== undefined && isTypeOnlyImportClause(node.parent);
    case SyntaxKind.ImportClause:
      return isTypeOnlyImportClause(node);
    case SyntaxKind.ImportEqualsDeclaration:
      return getIsTypeOnly(node);
  }
  return false;
}

function isTypeOnlyImportClause(node: Node): boolean {
  return node instanceof ImportClause && node.phaseModifier === SyntaxKind.TypeKeyword;
}
