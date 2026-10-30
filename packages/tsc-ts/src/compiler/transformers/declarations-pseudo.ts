// Pseudo-types: the types of declarations as far as syntax decides them, following tsgo's
// pseudochecker and the isolatedDeclarations rules. Annotations, literals, `as const` values
// and function expressions with annotated returns have pseudo-types; everything else is
// "inferred" and needs the checker.
import {
  ArrayLiteralExpression,
  ArrowFunction,
  FunctionExpression,
  MethodDeclaration,
  ModifierFlags,
  type NodeList,
  GetAccessorDeclaration,
  type Node,
  NodeFlags,
  NodeVisitor,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PrefixUnaryExpression,
  PropertyAssignment,
  PropertyDeclaration,
  ReturnStatement,
  SetAccessorDeclaration,
  TypeReferenceNode,
  VariableDeclaration,
  UnionTypeNode,
  IntersectionTypeNode,
  getAsteriskToken,
  getBody,
  getExpression,
  getName,
  getParameters,
  getPostfixToken,
  getSymbol,
  getType,
  getTypeParameters,
  propertyAssignmentPostfixToken,
} from '../ast.js';
import { isFunctionLike, nodeIsMissing } from '../ast-utilities.js';
import { getCombinedNodeFlags, hasSyntacticModifier, isIdentifierNamed } from '../binder-utilities.js';
import type { NameResolver } from '../name-resolver.js';
import { SyntaxKind } from '../syntax-kind.js';
import { getAllAccessorDeclarations } from './declarations-diagnostics.js';
import { declarationCount, getDeclarations, type Symbol, SymbolFlags } from '../symbol.js';

export const enum PseudoTypeKind {
  /** The type an annotation denotes. */
  Direct,
  /** An expression too complex for syntax; needs the checker. */
  Inferred,
  /** A declaration or signature with no syntactic type; needs the checker. */
  NoResult,
  /** A literal whose type depends on whether it's in a const context. */
  MaybeConstLocation,
  Union,
  Undefined,
  Null,
  Any,
  String,
  Number,
  BigInt,
  Boolean,
  False,
  True,
  /** A function or arrow function expression. */
  SingleCallSignature,
  /** An `as const` array. */
  Tuple,
  ObjectLiteral,
  StringLiteral,
  NumericLiteral,
  BigIntLiteral,
}

export class PseudoType {
  readonly kind: PseudoTypeKind;

  constructor(kind: PseudoTypeKind) {
    this.kind = kind;
  }
}

export class DirectType extends PseudoType {
  readonly typeNode: Node;

  constructor(typeNode: Node) {
    super(PseudoTypeKind.Direct);
    this.typeNode = typeNode;
  }
}

export class InferredType extends PseudoType {
  readonly expression: Node;
  /** Nodes to report isolatedDeclarations errors on, such as spreads; the expression if empty. */
  readonly errorNodes: Node[];
  readonly isSignatureReturn: boolean;

  constructor(expression: Node, isSignatureReturn: boolean, errorNodes: Node[]) {
    super(PseudoTypeKind.Inferred);
    this.expression = expression;
    this.isSignatureReturn = isSignatureReturn;
    this.errorNodes = errorNodes;
  }
}

export class NoResultType extends PseudoType {
  readonly declaration: Node;

  constructor(declaration: Node) {
    super(PseudoTypeKind.NoResult);
    this.declaration = declaration;
  }
}

export class MaybeConstType extends PseudoType {
  readonly node: Node;
  readonly constType: PseudoType;
  readonly regularType: PseudoType;

  constructor(node: Node, constType: PseudoType, regularType: PseudoType) {
    super(PseudoTypeKind.MaybeConstLocation);
    this.node = node;
    this.constType = constType;
    this.regularType = regularType;
  }
}

export class UnionType extends PseudoType {
  readonly types: PseudoType[];

  constructor(types: PseudoType[]) {
    super(PseudoTypeKind.Union);
    this.types = types;
  }
}

export class PseudoParameter {
  readonly rest: boolean;
  readonly name: Node;
  readonly optional: boolean;
  readonly type: PseudoType;

  constructor(rest: boolean, name: Node, optional: boolean, type: PseudoType) {
    this.rest = rest;
    this.name = name;
    this.optional = optional;
    this.type = type;
  }
}

export class SignatureType extends PseudoType {
  readonly signature: Node;
  readonly parameters: PseudoParameter[];
  readonly typeParameters: Node[];
  readonly returnType: PseudoType;

  constructor(signature: Node, parameters: PseudoParameter[], typeParameters: Node[], returnType: PseudoType) {
    super(PseudoTypeKind.SingleCallSignature);
    this.signature = signature;
    this.parameters = parameters;
    this.typeParameters = typeParameters;
    this.returnType = returnType;
  }
}

export class TupleType extends PseudoType {
  readonly elements: PseudoType[];

  constructor(elements: PseudoType[]) {
    super(PseudoTypeKind.Tuple);
    this.elements = elements;
  }
}

export const enum PseudoMemberKind {
  Method,
  Property,
  SetAccessor,
  GetAccessor,
}

/** A member of an object literal type. */
export class PseudoMember {
  readonly kind: PseudoMemberKind;
  readonly name: Node;
  readonly optional: boolean;
  readonly readonly: boolean;
  /** The method or accessor declaration; undefined for properties. */
  readonly signature: Node | undefined;
  readonly typeParameters: Node[];
  readonly parameters: PseudoParameter[];
  /** The property or get accessor type, or the method's return type. */
  readonly type: PseudoType;

  constructor(
    kind: PseudoMemberKind,
    name: Node,
    optional: boolean,
    readonly: boolean,
    signature: Node | undefined,
    typeParameters: Node[],
    parameters: PseudoParameter[],
    type: PseudoType,
  ) {
    this.kind = kind;
    this.name = name;
    this.optional = optional;
    this.readonly = readonly;
    this.signature = signature;
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.type = type;
  }
}

export class ObjectLiteralType extends PseudoType {
  readonly members: PseudoMember[];

  constructor(members: PseudoMember[]) {
    super(PseudoTypeKind.ObjectLiteral);
    this.members = members;
  }
}

/** A string, numeric or bigint literal type. */
export class LiteralType extends PseudoType {
  readonly node: Node;

  constructor(kind: PseudoTypeKind, node: Node) {
    super(kind);
    this.node = node;
  }
}

export const undefinedType = new PseudoType(PseudoTypeKind.Undefined);
export const nullType = new PseudoType(PseudoTypeKind.Null);
export const anyType = new PseudoType(PseudoTypeKind.Any);
export const stringType = new PseudoType(PseudoTypeKind.String);
export const numberType = new PseudoType(PseudoTypeKind.Number);
export const bigintType = new PseudoType(PseudoTypeKind.BigInt);
export const booleanType = new PseudoType(PseudoTypeKind.Boolean);
export const falseType = new PseudoType(PseudoTypeKind.False);
export const trueType = new PseudoType(PseudoTypeKind.True);

function inferred(expression: Node, isSignatureReturn: boolean): InferredType {
  return new InferredType(expression, isSignatureReturn, []);
}

/** Whether a pseudo-type is inferred without nodes to report errors on. */
function isBareInferred(type: PseudoType): boolean {
  return type instanceof InferredType && type.errorNodes.length === 0;
}

export class PseudoChecker {
  readonly strictNullChecks: boolean;
  /** Global symbols merged across files, by each file's symbol. */
  readonly mergedSymbols: Map<Symbol, Symbol>;

  /** Resolves `undefined`, which a declaration can shadow. */
  readonly names: NameResolver;

  constructor(strictNullChecks: boolean, mergedSymbols: Map<Symbol, Symbol>, names: NameResolver) {
    this.strictNullChecks = strictNullChecks;
    this.mergedSymbols = mergedSymbols;
    this.names = names;
  }

  /** How many `| undefined` additions only the checker can decide; reset by callers. */
  uncertain = 0;

  /** Adds `| undefined` unless the type may already include it; counts the cases that need types to tell. */
  private addUndefined(type: PseudoType): PseudoType {
    if (couldAlreadyReferToUndefined(type) && !definitelyHasUndefined(type)) this.uncertain++;
    return addUndefinedIfDefinitelyRequired(type);
  }

  getMergedSymbol(symbol: Symbol): Symbol {
    return this.mergedSymbols.get(symbol) ?? symbol;
  }

  getReturnTypeOfSignature(signature: Node): PseudoType {
    if (signature.kind === SyntaxKind.GetAccessor) return this.getTypeOfAccessor(signature);
    return this.createReturnFromSignature(signature);
  }

  getTypeOfAccessor(accessor: Node): PseudoType {
    const accessors = getAllAccessorDeclarations(accessor);
    const annotation = this.getAccessorAnnotation(accessor, accessors.firstAccessor, accessors.secondAccessor);
    if (annotation !== undefined && annotation.kind !== SyntaxKind.TypePredicate) return new DirectType(annotation);
    const getter = accessors.getAccessor;
    if (getter !== undefined) {
      const result = this.createReturnFromSignature(getter);
      if (result instanceof InferredType && result.errorNodes.length === 0) {
        // The error is reported on the accessors.
        const errorNodes = [getter];
        if (accessors.setAccessor !== undefined) errorNodes.push(accessors.setAccessor);
        return new InferredType(result.expression, result.isSignatureReturn, errorNodes);
      }
      return result;
    }
    return new NoResultType(accessor);
  }

  private getAccessorAnnotation(node: Node, first: Node, second: Node | undefined): Node | undefined {
    let annotation = accessorAnnotation(node);
    if (annotation === undefined && node !== first) annotation = accessorAnnotation(first);
    if (annotation === undefined && second !== undefined && node !== second) annotation = accessorAnnotation(second);
    return annotation;
  }

  getTypeOfExpression(node: Node): PseudoType {
    return this.typeFromExpression(node);
  }

  getTypeOfDeclaration(node: Node): PseudoType {
    switch (node.kind) {
      case SyntaxKind.Parameter:
        if (node instanceof ParameterDeclaration) {
          const narrowed: ParameterDeclaration = node;
          return this.typeFromParameter(narrowed);
        }
        break;
      case SyntaxKind.VariableDeclaration:
        if (node instanceof VariableDeclaration) {
          const narrowed: VariableDeclaration = node;
          return this.typeFromVariable(narrowed);
        }
        break;
      case SyntaxKind.PropertySignature:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.JSDocPropertyTag:
        return this.typeFromProperty(node);
      case SyntaxKind.ExportAssignment:
        return this.typeFromExpression(getExpression(node)!);
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
      case SyntaxKind.BinaryExpression: {
        const type = getType(node);
        return type !== undefined ? new DirectType(type) : new NoResultType(node);
      }
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
        return this.typeFromPropertyAssignment(node);
    }
    return new NoResultType(node);
  }

  private typeFromPropertyAssignment(node: Node): PseudoType {
    const annotation = getType(node);
    if (annotation !== undefined) return new DirectType(annotation);
    if (node instanceof PropertyAssignment) {
      const result = this.typeFromExpression(node.initializer);
      if (!isBareInferred(result)) return result;
    }
    return new NoResultType(node);
  }

  private typeFromProperty(node: Node): PseudoType {
    const annotation = getType(node);
    if (annotation !== undefined) return new DirectType(annotation);
    // A property declared more than once has the type of its first declaration; only the checker
    // knows which, so the type is still written from this one but counted as uncertain.
    const symbol = getSymbol(node);
    if (symbol !== undefined && declarationCount(symbol) > 1) this.uncertain++;
    if (node instanceof PropertyDeclaration) {
      const initializer = node.initializer;
      if (initializer !== undefined && !isContextuallyTyped(node)) {
        // Readonly template literals may become literal types, so they aren't inferred.
        if (hasSyntacticModifier(node, ModifierFlags.Readonly) && initializer.kind === SyntaxKind.TemplateExpression)
          return new NoResultType(node);
        const result = this.typeFromExpression(initializer);
        if (!isBareInferred(result)) {
          const postfix = node.postfixToken;
          // `x? = value` has `| undefined` in its type.
          if (
            result.kind !== PseudoTypeKind.Direct &&
            postfix !== undefined &&
            postfix.kind === SyntaxKind.QuestionToken
          )
            return this.addUndefined(result);
          return result;
        }
      }
    }
    return new NoResultType(node);
  }

  private typeFromVariable(declaration: VariableDeclaration): PseudoType {
    if (declaration.type !== undefined) return new DirectType(declaration.type);
    const initializer = declaration.initializer;
    // As tsgo, the file's own declarations; merged ones are left to the checker's type comparison.
    const symbol = declaration.symbol;
    // A binding pattern has no symbol, and its initializer's type isn't the variable's.
    if (initializer !== undefined && symbol !== undefined && countVariableDeclarations(getDeclarations(symbol)) === 1) {
      if (!isContextuallyTyped(declaration)) {
        // Const template literals may become literal types, so they aren't inferred.
        if (
          (getCombinedNodeFlags(declaration) & NodeFlags.Const) !== 0 &&
          initializer.kind === SyntaxKind.TemplateExpression
        )
          return new NoResultType(declaration);
        const result = this.typeFromExpression(initializer);
        if (!isBareInferred(result)) return result;
      }
    }
    return new NoResultType(declaration);
  }

  /** The return type of a signature; `NoResult` or `Inferred` when unknown. */
  createReturnFromSignature(fn: Node): PseudoType {
    if (isFunctionLike(fn)) {
      const type = getType(fn);
      if (type !== undefined) return new DirectType(type);
    }
    if (isValueSignatureDeclaration(fn)) return this.typeFromSingleReturnExpression(fn);
    return new NoResultType(fn);
  }

  private typeFromSingleReturnExpression(fn: Node): PseudoType {
    let candidate: Node | undefined = undefined;
    const body = getBody(fn);
    if (body !== undefined && !nodeIsMissing(body)) {
      // An async function or generator returns a promise or generator of its returned values.
      if (hasSyntacticModifier(fn, ModifierFlags.Async) || getAsteriskToken(fn) !== undefined)
        return inferred(fn, true);
      if (body.kind === SyntaxKind.Block) {
        const returns = collectReturnStatements(body);
        // Only a single return directly in the body.
        if (returns.length === 1 && returns[0].parent === body) candidate = returns[0].expression;
      } else candidate = body;
    }
    if (candidate !== undefined) {
      if (!isContextuallyTyped(candidate)) return this.typeFromExpression(candidate);
      let type: Node | undefined = undefined;
      if (candidate.kind === SyntaxKind.TypeAssertionExpression || candidate.kind === SyntaxKind.AsExpression)
        type = getType(candidate);
      if (type !== undefined && !isConstTypeReference(type)) return new DirectType(type);
    }
    return inferred(fn, true);
  }

  /** `checkExpression` for pseudo-types. */
  typeFromExpression(node: Node): PseudoType {
    switch (node.kind) {
      case SyntaxKind.OmittedExpression:
        return undefinedType;
      case SyntaxKind.ParenthesizedExpression:
        return this.typeFromExpression(getExpression(node)!);
      case SyntaxKind.Identifier:
        // A declaration named `undefined` shadows it.
        if (isIdentifierNamed(node, 'undefined'))
          return this.names.resolve(node, 'undefined', SymbolFlags.Value, undefined, false, false) === undefined
            ? undefinedType
            : inferred(node, false);
        break;
      case SyntaxKind.NullKeyword:
        return nullType;
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
        return this.typeFromFunctionLikeExpression(node);
      case SyntaxKind.TypeAssertionExpression:
      case SyntaxKind.AsExpression: {
        const type = getType(node)!;
        if (isConstTypeReference(type)) return this.typeFromExpression(getExpression(node)!);
        return new DirectType(type);
      }
      case SyntaxKind.PrefixUnaryExpression:
        if (node instanceof PrefixUnaryExpression) {
          const unary: PrefixUnaryExpression = node;
          if (isSignedNumericLiteral(unary)) return typeFromSignedLiteral(unary);
        }
        break;
      case SyntaxKind.ArrayLiteralExpression:
        if (node instanceof ArrayLiteralExpression) {
          const narrowed: ArrayLiteralExpression = node;
          return this.typeFromArrayLiteral(narrowed);
        }
        break;
      case SyntaxKind.ObjectLiteralExpression:
        if (node instanceof ObjectLiteralExpression) {
          const narrowed: ObjectLiteralExpression = node;
          return this.typeFromObjectLiteral(narrowed);
        }
        break;
      case SyntaxKind.ClassExpression:
        return new InferredType(node, false, [node]);
      case SyntaxKind.TemplateExpression:
        // Templates with substitutions aren't literal types, but `as const` would make them one.
        if (isInConstContext(node)) return inferred(node, false);
        return new MaybeConstType(node, inferred(node, false), stringType);
      case SyntaxKind.NumericLiteral:
        return new MaybeConstType(node, new LiteralType(PseudoTypeKind.NumericLiteral, node), numberType);
      case SyntaxKind.NoSubstitutionTemplateLiteral:
      case SyntaxKind.StringLiteral:
        return new MaybeConstType(node, new LiteralType(PseudoTypeKind.StringLiteral, node), stringType);
      case SyntaxKind.BigIntLiteral:
        return new MaybeConstType(node, new LiteralType(PseudoTypeKind.BigIntLiteral, node), bigintType);
      case SyntaxKind.TrueKeyword:
        return new MaybeConstType(node, trueType, booleanType);
      case SyntaxKind.FalseKeyword:
        return new MaybeConstType(node, falseType, booleanType);
    }
    return inferred(node, false);
  }

  private typeFromObjectLiteral(node: ObjectLiteralExpression): PseudoType {
    const errorNodes = objectLiteralErrorNodes(node);
    if (errorNodes.length > 0) return new InferredType(node, false, errorNodes);
    const members: PseudoMember[] = [];
    for (const property of node.properties.nodes) {
      switch (property.kind) {
        case SyntaxKind.MethodDeclaration: {
          const postfix = getPostfixToken(property);
          const optional = postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken;
          const fullSignature = getFullSignature(property);
          if (fullSignature !== undefined) {
            members.push(
              new PseudoMember(
                PseudoMemberKind.Property,
                getName(property)!,
                optional,
                false,
                undefined,
                [],
                [],
                new DirectType(fullSignature),
              ),
            );
            break;
          }
          members.push(
            new PseudoMember(
              PseudoMemberKind.Method,
              getName(property)!,
              optional,
              false,
              property,
              nodesOf(getTypeParameters(property)),
              this.cloneParameters(getParameters(property)!.nodes),
              this.createReturnFromSignature(property),
            ),
          );
          break;
        }
        case SyntaxKind.PropertyAssignment: {
          const assignment = property as PropertyAssignment;
          const postfix = propertyAssignmentPostfixToken(assignment);
          members.push(
            new PseudoMember(
              PseudoMemberKind.Property,
              assignment.name,
              postfix !== undefined && postfix.kind === SyntaxKind.QuestionToken,
              false,
              undefined,
              [],
              [],
              this.typeFromExpression(assignment.initializer),
            ),
          );
          break;
        }
        case SyntaxKind.SetAccessor:
        case SyntaxKind.GetAccessor: {
          const member = this.getAccessorMember(property);
          if (member !== undefined) members.push(member);
          break;
        }
      }
    }
    return new ObjectLiteralType(members);
  }

  private getAccessorMember(accessor: Node): PseudoMember | undefined {
    const accessors = getAllAccessorDeclarations(accessor);
    const name = getName(accessor)!;
    const getter = accessors.getAccessor;
    const setter = accessors.setAccessor;
    // With both accessors annotated, their types may differ, so both are kept.
    if (
      getter instanceof GetAccessorDeclaration &&
      getter.type !== undefined &&
      setter instanceof SetAccessorDeclaration &&
      setter.parameters.nodes.length > 0 &&
      getType(setter.parameters.nodes[0]!) !== undefined
    ) {
      if (accessor.kind === SyntaxKind.GetAccessor)
        return new PseudoMember(
          PseudoMemberKind.GetAccessor,
          name,
          false,
          false,
          accessor,
          [],
          [],
          this.getTypeOfAccessor(accessor),
        );
      const parameters = this.cloneParameters((accessor as SetAccessorDeclaration).parameters.nodes);
      return new PseudoMember(PseudoMemberKind.SetAccessor, name, false, false, accessor, [], parameters, anyType);
    }
    // Otherwise the first accessor is a property, `readonly` for a lone getter.
    if (accessor === accessors.firstAccessor)
      return new PseudoMember(
        PseudoMemberKind.Property,
        name,
        false,
        accessor.kind === SyntaxKind.GetAccessor && accessors.secondAccessor === undefined,
        undefined,
        [],
        [],
        this.getTypeOfAccessor(accessor),
      );
    return undefined;
  }

  private typeFromArrayLiteral(node: ArrayLiteralExpression): PseudoType {
    if (!isInConstContext(node)) return new InferredType(node, false, [node]);
    for (const element of node.elements.nodes)
      if (element.kind === SyntaxKind.SpreadElement) return new InferredType(node, false, [element]);
    // An `as const` array with a contextual type may or may not be readonly.
    if (isContextuallyTyped(node)) return inferred(node, false);
    const elements: PseudoType[] = [];
    for (const element of node.elements.nodes) elements.push(this.typeFromExpression(element));
    return new TupleType(elements);
  }

  private typeFromFunctionLikeExpression(node: Node): PseudoType {
    const fullSignature = getFullSignature(node);
    if (fullSignature !== undefined) return new DirectType(fullSignature);
    return new SignatureType(
      node,
      this.cloneParameters(getParameters(node)!.nodes),
      nodesOf(getTypeParameters(node)),
      this.createReturnFromSignature(node),
    );
  }

  private typeFromParameter(node: ParameterDeclaration): PseudoType {
    const parent = node.parent!;
    if (parent.kind === SyntaxKind.SetAccessor) return this.getTypeOfAccessor(parent);
    if (node.initializer === undefined)
      return node.type !== undefined ? new DirectType(node.type) : new NoResultType(node);
    const parameters = getParameters(parent)!.nodes;
    return this.typeFromParameterAt(node, parameters.indexOf(node), lastRequiredParameterIndex(parameters));
  }

  private typeFromParameterAt(node: ParameterDeclaration, index: number, lastRequired: number): PseudoType {
    const parent = node.parent!;
    if (parent.kind === SyntaxKind.SetAccessor) return this.getTypeOfAccessor(parent);
    const hasRequiredAfter = index < lastRequired - 1;
    if (node.type !== undefined) {
      const result = new DirectType(node.type);
      // An initialized parameter before a required one has `| undefined` in its type.
      if (this.strictNullChecks && node.initializer !== undefined && hasRequiredAfter) return this.addUndefined(result);
      return result;
    }
    if (node.initializer !== undefined && node.name.kind === SyntaxKind.Identifier && !isContextuallyTyped(node)) {
      let result = this.typeFromExpression(node.initializer);
      // The error is reported on the parameter.
      if (isBareInferred(result)) result = new InferredType((result as InferredType).expression, false, [node]);
      if (!this.strictNullChecks || !hasRequiredAfter) return result;
      return this.addUndefined(result);
    }
    // Types aren't inferred from binding patterns.
    return new NoResultType(node);
  }

  cloneParameters(nodes: Node[]): PseudoParameter[] {
    const result: PseudoParameter[] = [];
    const lastRequired = lastRequiredParameterIndex(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const parameter = nodes[i]! as ParameterDeclaration;
      let optional = parameter.questionToken !== undefined;
      // An initialized parameter is optional when no required one follows.
      if (!optional && parameter.initializer !== undefined) optional = i >= lastRequired - 1;
      result.push(
        new PseudoParameter(
          parameter.dotDotDotToken !== undefined,
          parameter.name,
          optional,
          this.typeFromParameterAt(parameter, i, lastRequired),
        ),
      );
    }
    return result;
  }
}

function nodesOf(list: NodeList | undefined): Node[] {
  return list === undefined ? [] : list.nodes;
}

function accessorAnnotation(node: Node): Node | undefined {
  if (node instanceof GetAccessorDeclaration) return node.type;
  if (node instanceof SetAccessorDeclaration) {
    const parameters = node.parameters.nodes;
    return parameters.length > 0 ? getType(parameters[0]!) : undefined;
  }
  return undefined;
}

function countVariableDeclarations(declarations: readonly Node[]): number {
  if (declarations.length === 1) return 1;
  let count = 0;
  for (const declaration of declarations) if (declaration.kind === SyntaxKind.VariableDeclaration) count++;
  return count;
}

function isValueSignatureDeclaration(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.Constructor:
      return true;
  }
  return false;
}

/** The return statements of a function body, outside nested functions. */
export function collectReturnStatements(body: Node): ReturnStatement[] {
  const collector = new ReturnCollector();
  collector.visitNode(body);
  return collector.statements;
}

class ReturnCollector extends NodeVisitor {
  readonly statements: ReturnStatement[] = [];

  visitNode(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.ReturnStatement:
        if (node instanceof ReturnStatement) this.statements.push(node);
        return false;
      case SyntaxKind.CaseBlock:
      case SyntaxKind.Block:
      case SyntaxKind.IfStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WithStatement:
      case SyntaxKind.SwitchStatement:
      case SyntaxKind.CaseClause:
      case SyntaxKind.DefaultClause:
      case SyntaxKind.LabeledStatement:
      case SyntaxKind.TryStatement:
      case SyntaxKind.CatchClause:
        return node.forEachChild(this);
    }
    return false;
  }
}

function isSignedNumericLiteral(node: PrefixUnaryExpression): boolean {
  const operand = node.operand.kind;
  if (node.operator === SyntaxKind.MinusToken)
    return operand === SyntaxKind.NumericLiteral || operand === SyntaxKind.BigIntLiteral;
  return node.operator === SyntaxKind.PlusToken && operand === SyntaxKind.NumericLiteral;
}

function typeFromSignedLiteral(node: PrefixUnaryExpression): PseudoType {
  const literal = node.operator === SyntaxKind.PlusToken ? node.operand : node;
  if (node.operand.kind === SyntaxKind.BigIntLiteral)
    return new MaybeConstType(node, new LiteralType(PseudoTypeKind.BigIntLiteral, literal), bigintType);
  return new MaybeConstType(node, new LiteralType(PseudoTypeKind.NumericLiteral, literal), numberType);
}

export function isConstTypeReference(node: Node): boolean {
  return (
    node instanceof TypeReferenceNode &&
    (node.typeArguments === undefined || node.typeArguments.nodes.length === 0) &&
    isIdentifierNamed(node.typeName, 'const')
  );
}

function isConstAssertionNode(node: Node): boolean {
  return (
    (node.kind === SyntaxKind.AsExpression || node.kind === SyntaxKind.TypeAssertionExpression) &&
    isConstTypeReference(getType(node)!)
  );
}

/** Whether a nested expression is inside an `as const`, as far as syntax decides. */
export function isInConstContext(node: Node): boolean {
  let current = node.parent;
  while (current !== undefined) {
    switch (current.kind) {
      case SyntaxKind.AsExpression:
      case SyntaxKind.TypeAssertionExpression:
        return isConstAssertionNode(current);
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.ObjectLiteralExpression:
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.SpreadElement:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
      case SyntaxKind.TemplateSpan:
      case SyntaxKind.PrefixUnaryExpression:
        current = current.parent;
        continue;
    }
    return false;
  }
  return false;
}

/** Whether calls, `satisfies` or annotations around a node can change its type. */
function isContextuallyTyped(node: Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    switch (current.kind) {
      case SyntaxKind.CallExpression:
      case SyntaxKind.SatisfiesExpression:
      case SyntaxKind.JsxElement:
      case SyntaxKind.JsxExpression:
        return true;
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.Parameter:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertySignature:
      case SyntaxKind.AsExpression:
      case SyntaxKind.TypeAssertionExpression:
        if (getType(current) !== undefined && !isConstAssertionNode(current)) return true;
        break;
    }
  }
  return false;
}

function objectLiteralErrorNodes(node: ObjectLiteralExpression): Node[] {
  const errorNodes: Node[] = [];
  for (const property of node.properties.nodes) {
    if ((property.flags & NodeFlags.ThisNodeHasError) !== 0) {
      errorNodes.push(property);
      continue;
    }
    if (property.kind === SyntaxKind.ShorthandPropertyAssignment || property.kind === SyntaxKind.SpreadAssignment) {
      errorNodes.push(property);
      continue;
    }
    const name = getName(property)!;
    if ((name.flags & NodeFlags.ThisNodeHasError) !== 0) errorNodes.push(name);
    else if (name.kind === SyntaxKind.PrivateIdentifier) errorNodes.push(property);
    else if (name.kind === SyntaxKind.ComputedPropertyName && !isPrimitiveLiteral(getExpression(name)!))
      errorNodes.push(name);
  }
  return errorNodes;
}

function isPrimitiveLiteral(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return true;
    case SyntaxKind.PrefixUnaryExpression: {
      const unary = node as PrefixUnaryExpression;
      return (
        (unary.operator === SyntaxKind.MinusToken || unary.operator === SyntaxKind.PlusToken) &&
        unary.operand.kind === SyntaxKind.NumericLiteral
      );
    }
  }
  return false;
}

/** The index just past the last parameter without `?`, initializer or `...`. */
export function lastRequiredParameterIndex(parameters: Node[]): number {
  for (let i = parameters.length - 1; i >= 0; i--) {
    const parameter = parameters[i]! as ParameterDeclaration;
    if (
      parameter.dotDotDotToken === undefined &&
      parameter.initializer === undefined &&
      parameter.questionToken === undefined
    )
      return i + 1;
  }
  return 0;
}

function typeNodeCouldReferToUndefined(node: Node): boolean {
  let current = node;
  while (current.kind === SyntaxKind.ParenthesizedType) current = getType(current)!;
  switch (current.kind) {
    // These need symbols or types to know.
    case SyntaxKind.TypeReference:
    case SyntaxKind.IndexedAccessType:
    case SyntaxKind.TypeQuery:
    case SyntaxKind.OptionalType:
    case SyntaxKind.RestType:
    case SyntaxKind.ImportType:
    case SyntaxKind.ConditionalType:
    case SyntaxKind.TypeOperator:
    case SyntaxKind.TypePredicate:
    case SyntaxKind.UndefinedKeyword:
      return true;
    case SyntaxKind.UnionType:
    case SyntaxKind.IntersectionType:
      // Intersections are treated like unions, as tsgo does.
      for (const type of typesOf(current)) if (typeNodeCouldReferToUndefined(type)) return true;
      return false;
  }
  return false;
}

/** Whether a pseudo-type may already include `undefined`. */
export function couldAlreadyReferToUndefined(type: PseudoType): boolean {
  if (type instanceof NoResultType || type instanceof InferredType || isUndefinedType(type)) return true;
  if (type instanceof MaybeConstType) return couldAlreadyReferToUndefined(type.regularType);
  if (type instanceof DirectType) return typeNodeCouldReferToUndefined(type.typeNode);
  if (type instanceof UnionType) {
    for (const member of type.types) if (couldAlreadyReferToUndefined(member)) return true;
    return false;
  }
  return false;
}

function isUndefinedType(type: PseudoType): boolean {
  return type.kind === PseudoTypeKind.Undefined || (type instanceof MaybeConstType && isUndefinedType(type.constType));
}

function definitelyHasUndefined(type: PseudoType): boolean {
  if (isUndefinedType(type)) return true;
  if (type instanceof UnionType) {
    for (const member of type.types) if (definitelyHasUndefined(member)) return true;
    return false;
  }
  if (type instanceof DirectType) return typeNodeHasUndefined(type.typeNode);
  return false;
}

function typeNodeHasUndefined(node: Node): boolean {
  if (
    node.kind === SyntaxKind.UndefinedKeyword ||
    node.kind === SyntaxKind.AnyKeyword ||
    node.kind === SyntaxKind.UnknownKeyword
  )
    return true;
  if (node.kind === SyntaxKind.ParenthesizedType) return typeNodeHasUndefined(getType(node)!);
  if (node instanceof UnionTypeNode) {
    for (const member of node.types.nodes) if (typeNodeHasUndefined(member)) return true;
  }
  return false;
}

function addUndefinedIfDefinitelyRequired(type: PseudoType): PseudoType {
  if (couldAlreadyReferToUndefined(type)) return type;
  return new UnionType([type, undefinedType]);
}

/** The members of a union or intersection type node. */
export function typesOf(node: Node): Node[] {
  if (node instanceof UnionTypeNode) return node.types.nodes;
  if (node instanceof IntersectionTypeNode) return node.types.nodes;
  return [];
}

/** The JSDoc `@type` signature of a function expression, arrow function or method. */
function getFullSignature(node: Node): Node | undefined {
  if (node instanceof ArrowFunction) return node.fullSignature;
  if (node instanceof FunctionExpression) return node.fullSignature;
  if (node instanceof MethodDeclaration) return node.fullSignature;
  return undefined;
}
