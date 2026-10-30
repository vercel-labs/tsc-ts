// Removes TypeScript-only syntax: type annotations and declarations, `declare`d statements,
// type-only imports and exports, and modifiers such as `public` and `readonly`.
import {
  CallExpression,
  ClassDeclaration,
  ClassExpression,
  ConstructorDeclaration,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionWithTypeArguments,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  HeritageClause,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportAttributes,
  ImportEqualsDeclaration,
  ImportSpecifier,
  JsxAttributes,
  JsxOpeningElement,
  JsxSelfClosingElement,
  MethodDeclaration,
  ModifierFlags,
  ModifierList,
  ModuleDeclaration,
  NamedExports,
  NamedImports,
  NewExpression,
  type Node,
  ParameterDeclaration,
  ParenthesizedExpression,
  PartiallyEmittedExpression,
  PropertyDeclaration,
  SetAccessorDeclaration,
  TaggedTemplateExpression,
  VariableDeclaration,
  ArrowFunction,
  getExpression,
  callQuestionDotToken,
} from '../ast.js';
import { nodeIsMissing } from '../ast-utilities.js';
import type { CompilerOptions } from '../options.js';
import { shouldPreserveConstEnums } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { isStatement } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { type TypeScriptFacts } from './subtree-facts.js';
import { Transformer } from './transformer.js';
import {
  getInnermostModuleDeclaration,
  hasDecorators,
  hasSyntacticModifier,
  isInstantiatedModule,
  isJSDocTypeAssertion,
  isParameterPropertyDeclaration,
  isThisParameter,
} from './utilities.js';

export class TypeEraser extends Transformer {
  readonly options: CompilerOptions;
  readonly facts: TypeScriptFacts;
  private parentNode: Node | undefined;
  private currentNode: Node | undefined;

  constructor(context: EmitContext, options: CompilerOptions, facts: TypeScriptFacts) {
    super(context);
    this.options = options;
    this.facts = facts;
    this.parentNode = undefined;
    this.currentNode = undefined;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.containsTypeScript(node)) return node;
    if (isStatement(node) && hasSyntacticModifier(node, ModifierFlags.Ambient)) return this.notEmitted(node);
    const grandparent = this.parentNode;
    this.parentNode = this.currentNode;
    this.currentNode = node;
    const result = this.visitWorker(node);
    this.currentNode = this.parentNode;
    this.parentNode = grandparent;
    return result;
  }

  private visitWorker(node: Node): Node | undefined {
    const factory = this.factory;
    switch (node.kind) {
      case SyntaxKind.PublicKeyword:
      case SyntaxKind.PrivateKeyword:
      case SyntaxKind.ProtectedKeyword:
      case SyntaxKind.AbstractKeyword:
      case SyntaxKind.OverrideKeyword:
      case SyntaxKind.ConstKeyword:
      case SyntaxKind.DeclareKeyword:
      case SyntaxKind.ReadonlyKeyword:
      case SyntaxKind.ArrayType:
      case SyntaxKind.TupleType:
      case SyntaxKind.OptionalType:
      case SyntaxKind.RestType:
      case SyntaxKind.TypeLiteral:
      case SyntaxKind.TypePredicate:
      case SyntaxKind.TypeParameter:
      case SyntaxKind.AnyKeyword:
      case SyntaxKind.UnknownKeyword:
      case SyntaxKind.BooleanKeyword:
      case SyntaxKind.StringKeyword:
      case SyntaxKind.NumberKeyword:
      case SyntaxKind.NeverKeyword:
      case SyntaxKind.VoidKeyword:
      case SyntaxKind.SymbolKeyword:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.FunctionType:
      case SyntaxKind.TypeQuery:
      case SyntaxKind.TypeReference:
      case SyntaxKind.UnionType:
      case SyntaxKind.IntersectionType:
      case SyntaxKind.ConditionalType:
      case SyntaxKind.ParenthesizedType:
      case SyntaxKind.ThisType:
      case SyntaxKind.TypeOperator:
      case SyntaxKind.IndexedAccessType:
      case SyntaxKind.MappedType:
      case SyntaxKind.LiteralType:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.JSImportDeclaration:
      case SyntaxKind.NamespaceExportDeclaration:
        return undefined;
      case SyntaxKind.InKeyword:
      case SyntaxKind.OutKeyword:
        if (this.parentNode === undefined || this.parentNode.kind !== SyntaxKind.BinaryExpression) return undefined;
        return this.visitEachChild(node);
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.InterfaceDeclaration:
        return this.notEmitted(node);
      case SyntaxKind.ModuleDeclaration:
        if (node instanceof ModuleDeclaration) {
          if (
            !(node.name instanceof Identifier) ||
            !isInstantiatedModule(node, shouldPreserveConstEnums(this.options)) ||
            getInnermostModuleDeclaration(node).body === undefined
          )
            return this.notEmitted(node);
          return this.visitEachChild(node);
        }
        break;
      case SyntaxKind.ExpressionWithTypeArguments:
        if (node instanceof ExpressionWithTypeArguments)
          return factory.updateExpressionWithTypeArguments(node, this.required(node.expression), undefined);
        break;
      case SyntaxKind.PropertyDeclaration:
        if (node instanceof PropertyDeclaration) {
          const ambientOrAbstract = hasSyntacticModifier(node, ModifierFlags.Ambient | ModifierFlags.Abstract);
          if (ambientOrAbstract && !(this.options.experimentalDecorators === true && hasDecorators(node)))
            return undefined;
          return factory.updatePropertyDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            this.required(node.name),
            undefined,
            undefined,
            this.visitNode(node.initializer),
          );
        }
        break;
      case SyntaxKind.Constructor:
        if (node instanceof ConstructorDeclaration) {
          if (nodeIsMissing(node.body)) return undefined;
          return factory.updateConstructorDeclaration(
            node,
            undefined,
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.visitNode(node.body),
          );
        }
        break;
      case SyntaxKind.MethodDeclaration:
        if (node instanceof MethodDeclaration) {
          if (nodeIsMissing(node.body)) return undefined;
          return factory.updateMethodDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            node.asteriskToken,
            this.required(node.name),
            undefined,
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.visitNode(node.body),
          );
        }
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration) {
          if (nodeIsMissing(node.body) && hasSyntacticModifier(node, ModifierFlags.Abstract)) return undefined;
          return factory.updateGetAccessorDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            this.required(node.name),
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.accessorBody(node.body),
          );
        }
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration) {
          if (nodeIsMissing(node.body) && hasSyntacticModifier(node, ModifierFlags.Abstract)) return undefined;
          return factory.updateSetAccessorDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            this.required(node.name),
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.accessorBody(node.body),
          );
        }
        break;
      case SyntaxKind.VariableDeclaration:
        if (node instanceof VariableDeclaration) {
          const updated = factory.updateVariableDeclaration(
            node,
            this.required(node.name),
            undefined,
            undefined,
            this.visitNode(node.initializer),
          );
          if (node.type !== undefined) this.context.setTypeNode(updated.name, node.type);
          return updated;
        }
        break;
      case SyntaxKind.HeritageClause:
        if (node instanceof HeritageClause) {
          if (node.token === SyntaxKind.ImplementsKeyword) return undefined;
          return factory.updateHeritageClause(node, node.token, this.visitNodes(node.types)!);
        }
        break;
      case SyntaxKind.ClassDeclaration:
        if (node instanceof ClassDeclaration)
          return factory.updateClassDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            this.optionalIdentifier(node.name),
            undefined,
            this.visitNodes(node.heritageClauses),
            this.visitNodes(node.members)!,
          );
        break;
      case SyntaxKind.ClassExpression:
        if (node instanceof ClassExpression)
          return factory.updateClassExpression(
            node,
            this.visitModifiers(node.modifiers),
            this.optionalIdentifier(node.name),
            undefined,
            this.visitNodes(node.heritageClauses),
            this.visitNodes(node.members)!,
          );
        break;
      case SyntaxKind.FunctionDeclaration:
        if (node instanceof FunctionDeclaration) {
          if (nodeIsMissing(node.body)) return this.notEmitted(node);
          return factory.updateFunctionDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            node.asteriskToken,
            this.optionalIdentifier(node.name),
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.visitNode(node.body),
          );
        }
        break;
      case SyntaxKind.FunctionExpression:
        if (node instanceof FunctionExpression)
          return factory.updateFunctionExpression(
            node,
            this.visitModifiers(node.modifiers),
            node.asteriskToken,
            this.optionalIdentifier(node.name),
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.required(node.body),
          );
        break;
      case SyntaxKind.ArrowFunction:
        if (node instanceof ArrowFunction)
          return factory.updateArrowFunction(
            node,
            this.visitModifiers(node.modifiers),
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            node.equalsGreaterThanToken,
            this.required(node.body),
          );
        break;
      case SyntaxKind.Parameter:
        if (node instanceof ParameterDeclaration) return this.visitParameter(node);
        break;
      case SyntaxKind.CallExpression:
        if (node instanceof CallExpression)
          return factory.updateCallExpression(
            node,
            this.required(node.expression),
            callQuestionDotToken(node),
            undefined,
            this.visitNodes(node.arguments)!,
            node.flags,
          );
        break;
      case SyntaxKind.NewExpression:
        if (node instanceof NewExpression)
          return factory.updateNewExpression(
            node,
            this.required(node.expression),
            undefined,
            this.visitNodes(node.arguments),
          );
        break;
      case SyntaxKind.TaggedTemplateExpression:
        if (node instanceof TaggedTemplateExpression)
          return factory.updateTaggedTemplateExpression(
            node,
            this.required(node.tag),
            node.questionDotToken,
            undefined,
            this.required(node.template),
            node.flags,
          );
        break;
      case SyntaxKind.NonNullExpression:
      case SyntaxKind.TypeAssertionExpression:
      case SyntaxKind.AsExpression:
      case SyntaxKind.SatisfiesExpression:
        return this.partiallyEmitted(node, getExpression(node)!);
      case SyntaxKind.ParenthesizedExpression:
        if (node instanceof ParenthesizedExpression && !isJSDocTypeAssertion(node)) {
          const inner = skipParenthesesAndPartiallyEmitted(node.expression);
          if (
            inner.kind === SyntaxKind.TypeAssertionExpression ||
            inner.kind === SyntaxKind.AsExpression ||
            inner.kind === SyntaxKind.SatisfiesExpression
          )
            return this.partiallyEmitted(node, node.expression);
        }
        return this.visitEachChild(node);
      case SyntaxKind.JsxSelfClosingElement:
        if (node instanceof JsxSelfClosingElement)
          return factory.updateJsxSelfClosingElement(
            node,
            this.required(node.tagName),
            undefined,
            this.jsxAttributes(node.attributes),
          );
        break;
      case SyntaxKind.JsxOpeningElement:
        if (node instanceof JsxOpeningElement)
          return factory.updateJsxOpeningElement(
            node,
            this.required(node.tagName),
            undefined,
            this.jsxAttributes(node.attributes),
          );
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration && node.isTypeOnly) return undefined;
        return this.visitEachChild(node);
      case SyntaxKind.ImportDeclaration:
        if (node instanceof ImportDeclaration) {
          if (node.importClause === undefined) return node;
          const clause = this.visitNode(node.importClause);
          if (!(clause instanceof ImportClause)) return undefined;
          return factory.updateImportDeclaration(
            node,
            node.modifiers,
            clause as ImportClause,
            node.moduleSpecifier,
            node.attributes,
          );
        }
        break;
      case SyntaxKind.ImportClause:
        if (node instanceof ImportClause) {
          if (node.phaseModifier === SyntaxKind.TypeKeyword) return undefined;
          let bindings = this.visitNode(node.namedBindings);
          // With a default import, `{}` left by erasing type-only specifiers goes; a `{}` written in the source stays.
          if (
            node.name !== undefined &&
            bindings instanceof NamedImports &&
            bindings.elements.nodes.length === 0 &&
            node.namedBindings instanceof NamedImports &&
            node.namedBindings.elements.nodes.length !== 0
          )
            bindings = undefined;
          if (node.name === undefined && bindings === undefined) return undefined;
          return factory.updateImportClause(node, node.phaseModifier, node.name, bindings);
        }
        break;
      case SyntaxKind.NamedImports:
        if (node instanceof NamedImports) {
          if (node.elements.nodes.length === 0) return node;
          const elements = this.visitNodes(node.elements)!;
          if (this.options.verbatimModuleSyntax !== true && elements.nodes.length === 0) return undefined;
          return factory.updateNamedImports(node, elements);
        }
        break;
      case SyntaxKind.ImportSpecifier:
        return node instanceof ImportSpecifier && node.isTypeOnly ? undefined : node;
      case SyntaxKind.ExportDeclaration:
        if (node instanceof ExportDeclaration) {
          if (node.isTypeOnly) return undefined;
          let clause: Node | undefined = undefined;
          if (node.exportClause !== undefined) {
            clause = this.visitNode(node.exportClause);
            if (clause === undefined) return undefined;
          }
          return factory.updateExportDeclaration(
            node,
            undefined,
            false,
            clause,
            this.visitNode(node.moduleSpecifier),
            node.attributes === undefined ? undefined : this.importAttributes(node.attributes),
          );
        }
        break;
      case SyntaxKind.NamedExports:
        if (node instanceof NamedExports) {
          if (node.elements.nodes.length === 0) return node;
          const elements = this.visitNodes(node.elements)!;
          if (this.options.verbatimModuleSyntax !== true && elements.nodes.length === 0) return undefined;
          return factory.updateNamedExports(node, elements);
        }
        break;
      case SyntaxKind.ExportSpecifier:
        return node instanceof ExportSpecifier && node.isTypeOnly ? undefined : node;
      case SyntaxKind.EnumDeclaration:
        if (hasSyntacticModifier(node, ModifierFlags.Const)) return node;
        return this.visitEachChild(node);
    }
    return this.visitEachChild(node);
  }

  private required(node: Node): Node {
    const visited = this.visitNode(node);
    if (visited === undefined) throw new Error('A required child was removed');
    return visited;
  }

  private optionalIdentifier(node: Identifier | undefined): Identifier | undefined {
    const visited = this.visitNode(node);
    if (visited === undefined) return undefined;
    if (visited instanceof Identifier) return visited as Identifier;
    throw new Error('Expected an identifier');
  }

  private jsxAttributes(node: JsxAttributes): JsxAttributes {
    const visited = this.visitNode(node);
    if (visited instanceof JsxAttributes) return visited as JsxAttributes;
    throw new Error('Expected JSX attributes');
  }

  private importAttributes(node: ImportAttributes): ImportAttributes | undefined {
    const visited = this.visitNode(node);
    if (visited === undefined) return undefined;
    if (visited instanceof ImportAttributes) return visited as ImportAttributes;
    throw new Error('Expected import attributes');
  }

  private accessorBody(body: Node | undefined): Node {
    const visited = this.visitNode(body);
    return visited !== undefined ? visited : this.factory.createBlock([], false);
  }

  private partiallyEmitted(node: Node, expression: Node): PartiallyEmittedExpression {
    const partial = this.factory.created(new PartiallyEmittedExpression(this.required(expression)));
    this.context.setOriginal(partial, node);
    partial.pos = node.pos;
    partial.end = node.end;
    return partial;
  }

  private visitParameter(node: ParameterDeclaration): Node | undefined {
    if (isThisParameter(node)) return undefined;
    let modifiers: ModifierList | undefined = undefined;
    if (isParameterPropertyDeclaration(node, this.parentNode))
      modifiers = this.extractModifiers(node.modifiers, ModifierFlags.ParameterPropertyModifier);
    if (hasDecorators(node) && node.modifiers !== undefined) {
      const decorators: Node[] = [];
      const nodes = node.modifiers.nodes;
      for (let i = 0; i < nodes.length; i++) if (nodes[i].kind === SyntaxKind.Decorator) decorators.push(nodes[i]);
      const visited = this.visitArray(decorators);
      modifiers = this.factory.createModifierList(modifiers === undefined ? visited : modifiers.nodes.concat(visited));
    }
    return this.factory.updateParameterDeclaration(
      node,
      modifiers,
      node.dotDotDotToken,
      this.required(node.name),
      undefined,
      undefined,
      this.visitNode(node.initializer),
    );
  }
}

/** Skips parentheses and partially emitted expressions, keeping assertions. */
function skipParenthesesAndPartiallyEmitted(node: Node): Node {
  for (;;) {
    if (node instanceof ParenthesizedExpression) node = node.expression;
    else if (node instanceof PartiallyEmittedExpression) node = node.expression;
    else return node;
  }
}
