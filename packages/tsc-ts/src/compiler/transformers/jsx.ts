// Transforms JSX into calls of the JSX factory (`jsx: react`) or of the automatic runtime
// (`react-jsx`, `react-jsxdev`), importing the runtime's functions.
import {
  BindingElement,
  BindingPattern,
  Identifier,
  ImportClause,
  ImportDeclaration,
  ImportSpecifier,
  JsxAttribute,
  JsxElement,
  JsxExpression,
  JsxFragment,
  JsxNamespacedName,
  JsxSelfClosingElement,
  JsxSpreadAttribute,
  JsxText,
  ModuleDeclaration,
  NamedImports,
  type Node,
  NodeFlags,
  type NodeList,
  ObjectLiteralExpression,
  PropertyAssignment,
  QualifiedName,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  ArrayLiteralExpression,
  VariableDeclaration,
  getTagName,
  getText,
} from '../ast.js';
import { isExternalOrCommonJSModule } from '../binder-utilities.js';
import { isLineBreak, isWhiteSpaceSingleLine } from '../character-codes.js';
import { type CompilerOptions, JsxEmit, ScriptTarget, getEmitScriptTarget } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import type { NodeFactory } from '../printer/factory.js';
import { isPrologueDirective, lineOf } from '../printer/utilities.js';
import { getJSXImplicitImportBase, getJSXRuntimeImport } from '../program-utilities.js';
import { isIdentifierText, skipTrivia } from '../scanner.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import type { EmitResolver } from './emit-resolver.js';
import { entities } from './jsx-entities.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { isExternalModule } from './utilities.js';

/** The names imported from one runtime module, by imported name. */
class RuntimeImports {
  readonly source: string;
  readonly specifiers: Map<string, ImportSpecifier>;

  constructor(source: string) {
    this.source = source;
    this.specifiers = new Map<string, ImportSpecifier>();
  }

  /** The specifiers ordered by imported name, then local name. */
  sorted(): ImportSpecifier[] {
    const result: ImportSpecifier[] = [];
    for (const specifier of this.specifiers.values()) result.push(specifier);
    result.sort(compareSpecifiers);
    return result;
  }
}

export class JsxTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly facts: SyntaxFacts;
  readonly resolver: EmitResolver;
  private file: SourceFile | undefined;
  /** The automatic runtime's module, or `''` for the classic factory. */
  private importSource: string;
  private fileNameDeclaration: VariableDeclaration | undefined;
  private runtimeImports: RuntimeImports[];
  /** Whether the node being visited is a child of a JSX element. */
  private inChild: boolean;

  constructor(context: EmitContext, options: CompilerOptions, facts: SyntaxFacts, resolver: EmitResolver) {
    super(context);
    this.options = options;
    this.facts = facts;
    this.resolver = resolver;
    this.file = undefined;
    this.importSource = '';
    this.fileNameDeclaration = undefined;
    this.runtimeImports = [];
    this.inChild = false;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsJsx)) return node;
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        this.inChild = false;
        return this.visitSourceFile(node as SourceFile);
      case SyntaxKind.JsxElement:
        return this.visitJsxElement(node as JsxElement);
      case SyntaxKind.JsxSelfClosingElement:
        return this.visitJsxSelfClosingElement(node as JsxSelfClosingElement);
      case SyntaxKind.JsxFragment:
        return this.visitJsxFragment(node as JsxFragment);
      case SyntaxKind.JsxText:
        this.inChild = false;
        return this.visitJsxText(node as JsxText);
      case SyntaxKind.JsxExpression:
        this.inChild = false;
        return this.visitJsxExpression(node as JsxExpression);
    }
    this.inChild = false;
    return this.visitEachChild(node);
  }

  private visitSourceFile(file: SourceFile): Node {
    if (file.isDeclarationFile) return file;
    const context = this.context;
    const factory = this.factory;
    this.file = file;
    this.importSource = getJSXImplicitImportBase(this.options, file);
    this.fileNameDeclaration = undefined;
    this.runtimeImports = [];
    let visited = this.visitEachChild(file) as SourceFile;
    const helpers = context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) context.addEmitHelper(visited, helpers[i]);
    let statements = visited.statements.nodes;
    let updated = false;
    const fileNameDeclaration: VariableDeclaration | undefined = this.fileNameDeclaration;
    if (fileNameDeclaration !== undefined) {
      statements = this.insertAfterPrologue(
        statements,
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(factory.createNodeList([fileNameDeclaration as Node]), NodeFlags.Const),
        ),
      );
      updated = true;
    }
    if (this.runtimeImports.length > 0) {
      const module = isExternalModule(file);
      if (module || isExternalOrCommonJSModule(file)) {
        updated = true;
        for (let i = 0; i < this.runtimeImports.length; i++) {
          const imports = this.runtimeImports[i];
          statements = this.insertAfterPrologue(
            statements,
            module ? this.createImport(imports) : this.createRequire(imports),
          );
        }
      }
    }
    if (updated) visited = factory.updateSourceFile(file, factory.createNodeList(statements), file.endOfFileToken);
    this.file = undefined;
    this.importSource = '';
    this.fileNameDeclaration = undefined;
    this.runtimeImports = [];
    return visited;
  }

  /** `import { jsx as _jsx } from "react/jsx-runtime";` */
  private createImport(imports: RuntimeImports): Node {
    const factory = this.factory;
    const specifiers = imports.sorted();
    const named = factory.created(new NamedImports(factory.createNodeList(specifiers)));
    for (let i = 0; i < specifiers.length; i++) specifiers[i].parent = named;
    const clause = factory.created(new ImportClause(undefined, undefined, named));
    named.parent = clause;
    const declaration = factory.created(
      new ImportDeclaration(
        SyntaxKind.ImportDeclaration,
        undefined,
        clause,
        factory.createStringLiteral(imports.source, TokenFlags.None),
        undefined,
      ),
    );
    clause.parent = declaration;
    return declaration;
  }

  /** `const { jsx: _jsx } = require("react/jsx-runtime");` */
  private createRequire(imports: RuntimeImports): Node {
    const factory = this.factory;
    const specifiers = imports.sorted();
    const elements: Node[] = [];
    for (let i = 0; i < specifiers.length; i++)
      elements.push(
        factory.created(new BindingElement(undefined, specifiers[i].propertyName, specifiers[i].name, undefined)),
      );
    const pattern = factory.created(
      new BindingPattern(SyntaxKind.ObjectBindingPattern, factory.createNodeList(elements)),
    );
    const require = factory.createCallExpression(factory.createIdentifier('require'), [
      factory.createStringLiteral(imports.source, TokenFlags.None),
    ]);
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([factory.createVariableDeclaration(pattern, undefined, undefined, require)]),
        NodeFlags.Const,
      ),
    );
  }

  private insertAfterPrologue(statements: Node[], statement: Node): Node[] {
    let index = 0;
    while (
      index < statements.length &&
      (isPrologueDirective(statements[index]) ||
        (this.context.getEmitFlags(statements[index]) & EmitFlags.CustomPrologue) !== 0)
    )
      index++;
    const result = statements.slice(0, index);
    result.push(statement);
    for (let i = index; i < statements.length; i++) result.push(statements[i]);
    return result;
  }

  /** `_jsxFileName`, declared at the top of the file on first use. */
  private currentFileNameExpression(): Node {
    if (this.fileNameDeclaration === undefined) {
      const factory = this.factory;
      this.fileNameDeclaration = factory.createVariableDeclaration(
        factory.createUniqueName(
          '_jsxFileName',
          GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.FileLevel,
        ),
        undefined,
        undefined,
        factory.createStringLiteral(this.file!.fileName, TokenFlags.None),
      );
    }
    return this.fileNameDeclaration.name;
  }

  /** The local name of `name` imported from the runtime, added to the file's imports on first use. */
  private implicitImport(name: string): Identifier {
    let source = this.importSource;
    if (name !== 'createElement') source = getJSXRuntimeImport(source, this.options);
    let imports: RuntimeImports | undefined = undefined;
    for (let i = 0; i < this.runtimeImports.length; i++)
      if (this.runtimeImports[i].source === source) imports = this.runtimeImports[i];
    if (imports === undefined) {
      imports = new RuntimeImports(source);
      this.runtimeImports.push(imports);
    }
    const existing = imports.specifiers.get(name);
    if (existing !== undefined) return existing.name;
    const factory = this.factory;
    const local = factory.createUniqueName(
      '_' + name,
      GeneratedIdentifierFlags.Optimistic |
        GeneratedIdentifierFlags.FileLevel |
        GeneratedIdentifierFlags.AllowNameSubstitution,
    );
    const specifier = factory.created(new ImportSpecifier(false, factory.createIdentifier(name), local));
    this.resolver.setReferencedImportDeclaration(local, specifier);
    imports.specifiers.set(name, specifier);
    return local;
  }

  private factoryCallee(isStaticChildren: boolean): Identifier {
    if (this.options.jsx === JsxEmit.ReactJSXDev) return this.implicitImport('jsxDEV');
    return this.implicitImport(isStaticChildren ? 'jsxs' : 'jsx');
  }

  private shouldUseCreateElement(attributes: NodeList): boolean {
    return this.importSource === '' || hasKeyAfterPropsSpread(attributes);
  }

  private visitJsxElement(element: JsxElement): Node {
    const opening = element.openingElement;
    const pos = skipTrivia(this.file!.text, element.pos);
    if (this.shouldUseCreateElement(opening.attributes.properties))
      return this.visitCreateElement(opening, opening.attributes.properties, element.children, pos, element.end);
    return this.visitElementJsx(opening, opening.attributes.properties, element.children, pos, element.end);
  }

  private visitJsxSelfClosingElement(element: JsxSelfClosingElement): Node {
    const pos = skipTrivia(this.file!.text, element.pos);
    if (this.shouldUseCreateElement(element.attributes.properties))
      return this.visitCreateElement(element, element.attributes.properties, undefined, pos, element.end);
    return this.visitElementJsx(element, element.attributes.properties, undefined, pos, element.end);
  }

  private visitJsxFragment(fragment: JsxFragment): Node {
    const pos = skipTrivia(this.file!.text, fragment.pos);
    if (this.importSource === '')
      return this.visitFragmentCreateElement(fragment.openingFragment, fragment.children, pos, fragment.end);
    return this.visitFragmentJsx(fragment.children, pos, fragment.end);
  }

  private visitChild(node: Node): Node | undefined {
    const saved = this.inChild;
    this.inChild = true;
    const result = this.visit(node);
    this.inChild = saved;
    return result;
  }

  /** `children: x` or `children: [x, y]`, or undefined when there are none. */
  private childrenProperty(children: Node[]): Node | undefined {
    const factory = this.factory;
    const semantic = getSemanticJsxChildren(children);
    if (semantic.length === 1 && !isSpreadChild(semantic[0])) {
      const result = this.visitChild(semantic[0]);
      return result === undefined
        ? undefined
        : factory.createPropertyAssignment(factory.createIdentifier('children'), result);
    }
    const results: Node[] = [];
    for (let i = 0; i < semantic.length; i++) {
      const result = this.visitChild(semantic[i]);
      if (result === undefined) continue;
      // The array is printed on one line.
      this.context.setEmitFlags(result, this.context.getEmitFlags(result) & ~EmitFlags.StartOnNewLine);
      results.push(result);
    }
    if (results.length === 0) return undefined;
    return factory.createPropertyAssignment(
      factory.createIdentifier('children'),
      factory.created(new ArrayLiteralExpression(factory.createNodeList(results), false)),
    );
  }

  /** The tag of an opening or self-closing element, as an expression. */
  private tagName(element: Node): Node {
    const tagName = getTagName(element)!;
    const factory = this.factory;
    if (tagName instanceof Identifier && isIntrinsicJsxName(tagName.text))
      return factory.createStringLiteral(tagName.text, TokenFlags.None);
    if (tagName instanceof JsxNamespacedName)
      return factory.createStringLiteral(tagName.namespace.text + ':' + tagName.name.text, TokenFlags.None);
    return factory.createExpressionFromEntityName(tagName);
  }

  private visitElementJsx(
    element: Node,
    attributes: NodeList,
    children: NodeList | undefined,
    pos: number,
    end: number,
  ): Node {
    const factory = this.factory;
    const tagName = this.tagName(element);
    const childrenProperty =
      children !== undefined && children.nodes.length > 0 ? this.childrenProperty(children.nodes) : undefined;
    let key: JsxAttribute | undefined = undefined;
    let attrs = attributes.nodes;
    for (let i = 0; i < attrs.length; i++) {
      const attribute = attrs[i];
      if (attribute instanceof JsxAttribute && attribute.name instanceof Identifier && attribute.name.text === 'key') {
        key = attribute;
        attrs = attrs.slice(0, i).concat(attrs.slice(i + 1));
        break;
      }
    }
    let props: Node;
    if (attrs.length > 0) props = this.attributesToObject(attrs, childrenProperty);
    else props = factory.createObjectLiteral(childrenProperty !== undefined ? [childrenProperty] : [], false);
    return this.createJsxCall(tagName, props, key, children, pos, end);
  }

  private visitFragmentJsx(children: NodeList, pos: number, end: number): Node {
    const factory = this.factory;
    let props: Node | undefined = undefined;
    if (children.nodes.length > 0) {
      const property = this.childrenProperty(children.nodes);
      if (property !== undefined) props = factory.createObjectLiteral([property], false);
    }
    if (props === undefined) props = factory.createObjectLiteral([], false);
    return this.createJsxCall(this.implicitImport('Fragment'), props, undefined, children, pos, end);
  }

  /** `_jsx(type, props, key)`, with `jsxDEV`'s static-children flag, source and `this`. */
  private createJsxCall(
    tagName: Node,
    props: Node,
    key: JsxAttribute | undefined,
    children: NodeList | undefined,
    pos: number,
    end: number,
  ): Node {
    const factory = this.factory;
    const semantic = children !== undefined ? getSemanticJsxChildren(children.nodes) : [];
    const isStaticChildren = semantic.length > 1 || (semantic.length === 1 && isSpreadChild(semantic[0]));
    const args: Node[] = [tagName, props];
    if (key !== undefined) args.push(this.attributeInitializer(key.initializer));
    if (this.options.jsx === JsxEmit.ReactJSXDev) {
      const file = this.context.mostOriginal(this.file!);
      if (file instanceof SourceFile) {
        // `jsxDEV(type, props, key, isStaticChildren, source, self)`
        if (key === undefined) args.push(factory.createVoidZero());
        args.push(factory.createKeywordExpression(isStaticChildren ? SyntaxKind.TrueKeyword : SyntaxKind.FalseKeyword));
        const lineStarts = file.lineStarts();
        const line = lineOf(lineStarts, pos);
        args.push(
          factory.createObjectLiteral(
            [
              factory.createPropertyAssignment(factory.createIdentifier('fileName'), this.currentFileNameExpression()),
              factory.createPropertyAssignment(
                factory.createIdentifier('lineNumber'),
                factory.createNumericLiteral(String(line + 1)),
              ),
              factory.createPropertyAssignment(
                factory.createIdentifier('columnNumber'),
                factory.createNumericLiteral(String(pos - lineStarts[line] + 1)),
              ),
            ],
            false,
          ),
        );
        args.push(factory.createThisExpression());
      }
    }
    const call = factory.createCallExpression(this.factoryCallee(isStaticChildren), args);
    call.pos = pos | 0;
    call.end = end | 0;
    if (this.inChild) this.context.addEmitFlags(call, EmitFlags.StartOnNewLine);
    return call;
  }

  /** The props object; below ES2018, spreads become `Object.assign` calls. */
  private attributesToObject(attributes: Node[], childrenProperty: Node | undefined): Node {
    const factory = this.factory;
    if (getEmitScriptTarget(this.options) >= ScriptTarget.ES2018) {
      const props: Node[] = [];
      for (let i = 0; i < attributes.length; i++) {
        const attribute = attributes[i];
        if (attribute instanceof JsxSpreadAttribute) {
          const spread = this.spreadAttributeToProperties(attribute as JsxSpreadAttribute);
          for (let j = 0; j < spread.length; j++) props.push(spread[j]);
        } else props.push(this.attributeToProperty(attribute as JsxAttribute));
      }
      if (childrenProperty !== undefined) props.push(childrenProperty);
      return factory.createObjectLiteral(props, false);
    }
    return this.attributesToAssign(attributes, childrenProperty);
  }

  private attributesToAssign(attributes: Node[], childrenProperty: Node | undefined): Node {
    const factory = this.factory;
    const segments = new AssignSegments();
    for (let i = 0; i < attributes.length; i++) {
      const attribute = attributes[i];
      if (attribute instanceof JsxSpreadAttribute) {
        const expression = attribute.expression;
        // An inline object literal is flattened as if its properties were attributes.
        if (expression instanceof ObjectLiteralExpression && !hasProto(expression)) {
          const properties = expression.properties.nodes;
          for (let j = 0; j < properties.length; j++) {
            const property = properties[j];
            if (property instanceof SpreadAssignment) {
              segments.flush(factory);
              segments.push(this.visit(property.expression));
              continue;
            }
            const visited = this.visit(property);
            if (visited !== undefined) segments.properties.push(visited);
          }
          continue;
        }
        segments.flush(factory);
        segments.push(this.visit(expression));
        continue;
      }
      segments.properties.push(this.attributeToProperty(attribute as JsxAttribute));
    }
    if (childrenProperty !== undefined) segments.properties.push(childrenProperty);
    segments.flush(factory);
    let expressions = segments.expressions;
    // The factory expects a fresh object, so the first argument of `Object.assign` is a literal.
    if (expressions.length > 0 && !(expressions[0] instanceof ObjectLiteralExpression))
      expressions = [factory.createObjectLiteral([], false) as Node].concat(expressions);
    if (expressions.length === 1) return expressions[0];
    return factory.createGlobalMethodCall('Object', 'assign', expressions);
  }

  private spreadAttributeToProperties(attribute: JsxSpreadAttribute): Node[] {
    const expression = attribute.expression;
    if (expression instanceof ObjectLiteralExpression && !hasProto(expression))
      return this.visitArray(expression.properties.nodes);
    const visited = this.visit(expression);
    return [this.factory.created(new SpreadAssignment(visited!))];
  }

  private attributeToProperty(attribute: JsxAttribute): Node {
    const name = this.attributeName(attribute);
    return this.factory.createPropertyAssignment(name, this.attributeInitializer(attribute.initializer));
  }

  /** The attribute's name, quoted when it isn't an identifier. */
  private attributeName(attribute: JsxAttribute): Node {
    const name = attribute.name;
    if (name instanceof Identifier) {
      if (isIdentifierText(name.text)) return name;
      return this.factory.createStringLiteral(name.text, TokenFlags.None);
    }
    const namespaced = name as JsxNamespacedName;
    return this.factory.createStringLiteral(namespaced.namespace.text + ':' + namespaced.name.text, TokenFlags.None);
  }

  private attributeInitializer(node: Node | undefined): Node {
    const factory = this.factory;
    if (node === undefined) return factory.createTrue();
    if (node instanceof StringLiteral) {
      // Recreated so the printer escapes what the JSX string had literally, keeping its quotes.
      const literal = factory.createStringLiteral(decodeEntities(node.text), node.tokenFlags);
      literal.pos = node.pos;
      literal.end = node.end;
      return literal;
    }
    if (node instanceof JsxExpression) {
      if (node.expression === undefined) return factory.createTrue();
      return this.visit(node.expression)!;
    }
    if (
      node.kind === SyntaxKind.JsxElement ||
      node.kind === SyntaxKind.JsxSelfClosingElement ||
      node.kind === SyntaxKind.JsxFragment
    ) {
      this.inChild = false;
      return this.visit(node)!;
    }
    throw new Error('Unhandled JSX attribute initializer');
  }

  // The classic factory

  /** `React`, or `ns.React` when it names an export of an enclosing namespace. */
  private createReactNamespace(namespace: string, parent: Node): Node {
    const factory = this.factory;
    const react = factory.createIdentifier(namespace === '' ? 'React' : namespace);
    // Resolved as if in the parse tree, from the element's scope.
    react.flags &= ~NodeFlags.Synthesized;
    react.parent = this.context.parseNode(parent);
    const container = this.resolver.getReferencedExportContainer(react, false);
    if (container instanceof ModuleDeclaration)
      return factory.createPropertyAccessExpression(factory.createGeneratedNameForNode(container, 0, '', ''), react);
    return react;
  }

  private expressionFromEntityName(entity: Node, parent: Node): Node {
    if (entity instanceof QualifiedName) {
      const left = this.expressionFromEntityName(entity.left, parent);
      return this.factory.createPropertyAccessExpression(left, this.factory.createIdentifier(getText(entity.right)));
    }
    return this.createReactNamespace((entity as Identifier).text, parent);
  }

  private pseudoFactoryExpression(parent: Node, entity: Node | undefined, member: string): Node {
    if (entity !== undefined) return this.expressionFromEntityName(entity, parent);
    const namespace = this.options.reactNamespace;
    return this.factory.createPropertyAccessExpression(
      this.createReactNamespace(namespace !== undefined ? namespace : '', parent),
      this.factory.createIdentifier(member),
    );
  }

  private factoryExpression(parent: Node): Node {
    return this.pseudoFactoryExpression(parent, this.resolver.getJsxFactoryEntity(this.file!), 'createElement');
  }

  private fragmentFactoryExpression(parent: Node): Node {
    return this.pseudoFactoryExpression(parent, this.resolver.getJsxFragmentFactoryEntity(this.file!), 'Fragment');
  }

  private visitCreateElement(
    element: Node,
    attributes: NodeList,
    children: NodeList | undefined,
    pos: number,
    end: number,
  ): Node {
    const factory = this.factory;
    const tagName = this.tagName(element);
    // React wants `null` when there are no attributes.
    const props =
      attributes.nodes.length > 0
        ? this.attributesToObject(attributes.nodes, undefined)
        : factory.createKeywordExpression(SyntaxKind.NullKeyword);
    const callee = this.importSource === '' ? this.factoryExpression(element) : this.implicitImport('createElement');
    return this.createElementCall(callee, tagName, props, children, pos, end);
  }

  private visitFragmentCreateElement(fragment: Node, children: NodeList, pos: number, end: number): Node {
    const tagName = this.fragmentFactoryExpression(fragment);
    const callee = this.factoryExpression(fragment);
    return this.createElementCall(
      callee,
      tagName,
      this.factory.createKeywordExpression(SyntaxKind.NullKeyword),
      children,
      pos,
      end,
    );
  }

  /** `React.createElement(type, props, ...children)` */
  private createElementCall(
    callee: Node,
    tagName: Node,
    props: Node,
    children: NodeList | undefined,
    pos: number,
    end: number,
  ): Node {
    const args: Node[] = [tagName, props];
    if (children !== undefined) {
      const first = args.length;
      for (let i = 0; i < children.nodes.length; i++) {
        const result = this.visitChild(children.nodes[i]);
        if (result !== undefined) args.push(result);
      }
      // Several children each start on a new line.
      if (args.length - first > 1)
        for (let i = first; i < args.length; i++) this.context.addEmitFlags(args[i], EmitFlags.StartOnNewLine);
    }
    const call = this.factory.createCallExpression(callee, args);
    call.pos = pos | 0;
    call.end = end | 0;
    if (this.inChild) this.context.addEmitFlags(call, EmitFlags.StartOnNewLine);
    return call;
  }

  // Children

  private visitJsxText(text: JsxText): Node | undefined {
    const fixed = fixupWhitespaceAndDecodeEntities(text.text);
    return fixed === '' ? undefined : this.factory.createStringLiteral(fixed, TokenFlags.None);
  }

  private visitJsxExpression(expression: JsxExpression): Node | undefined {
    const visited = this.visitNode(expression.expression);
    if (expression.dotDotDotToken !== undefined) return this.factory.created(new SpreadElement(visited!));
    return visited;
  }
}

/** Arguments of `Object.assign`: object literals of consecutive properties and spread expressions. */
class AssignSegments {
  readonly expressions: Node[];
  properties: Node[];

  constructor() {
    this.expressions = [];
    this.properties = [];
  }

  push(expression: Node | undefined): void {
    if (expression !== undefined) this.expressions.push(expression);
  }

  flush(factory: NodeFactory): void {
    if (this.properties.length === 0) return;
    this.expressions.push(factory.createObjectLiteral(this.properties, false));
    this.properties = [];
  }
}

function compareSpecifiers(a: ImportSpecifier, b: ImportSpecifier): number {
  const x = (a.propertyName as Identifier).text;
  const y = (b.propertyName as Identifier).text;
  if (x !== y) return x < y ? -1 : 1;
  const p = a.name.text;
  const q = b.name.text;
  return p === q ? 0 : p < q ? -1 : 1;
}

function isIntrinsicJsxName(name: string): boolean {
  if (name.length === 0) return false;
  const ch = name.charCodeAt(0);
  return (ch >= 0x61 && ch <= 0x7a) || name.indexOf('-') >= 0;
}

function isSpreadChild(node: Node): boolean {
  return node instanceof JsxExpression && node.dotDotDotToken !== undefined;
}

/** Children other than whitespace-only text and empty expressions. */
function getSemanticJsxChildren(children: Node[]): Node[] {
  const result: Node[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child instanceof JsxExpression && child.expression === undefined) continue;
    if (child instanceof JsxText && child.containsOnlyTriviaWhiteSpaces) continue;
    result.push(child);
  }
  return result;
}

/** The react `jsx`/`jsxs` functions fall back to `createElement` for a `key` after a spread. */
function hasKeyAfterPropsSpread(attributes: NodeList): boolean {
  let spread = false;
  const nodes = attributes.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const attribute = nodes[i];
    if (attribute instanceof JsxSpreadAttribute) {
      const expression = attribute.expression;
      if (!(expression instanceof ObjectLiteralExpression) || hasSpreadAssignment(expression)) spread = true;
    } else if (
      spread &&
      attribute instanceof JsxAttribute &&
      attribute.name instanceof Identifier &&
      attribute.name.text === 'key'
    )
      return true;
  }
  return false;
}

function hasSpreadAssignment(object: ObjectLiteralExpression): boolean {
  const properties = object.properties.nodes;
  for (let i = 0; i < properties.length; i++) if (properties[i] instanceof SpreadAssignment) return true;
  return false;
}

function hasProto(object: ObjectLiteralExpression): boolean {
  const properties = object.properties.nodes;
  for (let i = 0; i < properties.length; i++) {
    const property = properties[i];
    if (!(property instanceof PropertyAssignment)) continue;
    const name = property.name;
    if (name instanceof StringLiteral && name.text === '__proto__') return true;
    if (name instanceof Identifier && name.text === '__proto__') return true;
  }
  return false;
}

/**
 * Trims whitespace at the start and end of each line, drops empty lines and joins the rest
 * with spaces, decoding entities. Whitespace next to a tag on the same line is kept.
 */
export function fixupWhitespaceAndDecodeEntities(text: string): string {
  let result = '';
  let initial = true;
  // The first line keeps leading whitespace but is dropped when it is all whitespace.
  let firstNonWhitespace = 0;
  let lastNonWhitespace = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (isLineBreak(ch)) {
      if (firstNonWhitespace !== -1 && lastNonWhitespace !== -1) {
        if (!initial) result += ' ';
        result += decodeEntities(text.substring(firstNonWhitespace, lastNonWhitespace + 1));
        initial = false;
      }
      firstNonWhitespace = -1;
    } else if (!isWhiteSpaceSingleLine(ch)) {
      lastNonWhitespace = i;
      if (firstNonWhitespace === -1) firstNonWhitespace = i;
    }
  }
  if (firstNonWhitespace !== -1) {
    if (!initial) result += ' ';
    result += decodeEntities(text.substring(firstNonWhitespace));
  }
  return result;
}

/** Replaces entities such as `&nbsp;`, `&#123;` and `&#x1F600;` with the characters they encode. */
export function decodeEntities(text: string): string {
  let at = text.indexOf('&');
  if (at < 0) return text;
  let result = '';
  for (;;) {
    result += text.substring(0, at);
    text = text.substring(at);
    let semi = text.indexOf(';');
    if (semi < 0) break;
    // An `&` before the `;` starts no entity of the earlier `&`.
    for (;;) {
      const next = text.substring(1, semi).indexOf('&');
      if (next < 0) break;
      result += text.substring(0, next + 1);
      text = text.substring(next + 1);
      semi -= next + 1;
    }
    const decoded = decodeEntity(text.substring(1, semi));
    result += decoded >= 0 ? codePointToString(decoded) : text.substring(0, semi + 1);
    text = text.substring(semi + 1);
    at = text.indexOf('&');
    if (at < 0) break;
  }
  return result + text;
}

/** The code point an entity name such as `amp` or `#x26` stands for, or -1. */
function decodeEntity(entity: string): number {
  if (entity.length === 0) return -1;
  if (entity.charCodeAt(0) !== 0x23 /* # */) {
    const value = entities.get(entity);
    return value !== undefined ? value : -1;
  }
  let digits = entity.substring(1);
  let hex = false;
  if (digits.length > 0 && digits.charCodeAt(0) === 0x78 /* x */) {
    hex = true;
    digits = digits.substring(1);
  }
  if (digits.length === 0) return -1;
  let value = 0;
  for (let i = 0; i < digits.length; i++) {
    const ch = digits.charCodeAt(i);
    let digit = -1;
    if (ch >= 0x30 && ch <= 0x39) digit = ch - 0x30;
    else if (hex && ch >= 0x61 && ch <= 0x66) digit = ch - 0x61 + 10;
    else if (hex && ch >= 0x41 && ch <= 0x46) digit = ch - 0x41 + 10;
    if (digit < 0) return -1;
    value = value * (hex ? 16 : 10) + digit;
    // Values beyond 32 bits don't parse.
    if (value > 0x7fffffff) return -1;
  }
  return value;
}

function codePointToString(code: number): string {
  // Lone surrogates are kept; values beyond Unicode become U+FFFD.
  if (code > 0x10ffff) return '�';
  if (code >= 0xd800 && code <= 0xdfff) return String.fromCharCode(code);
  return String.fromCodePoint(code);
}
