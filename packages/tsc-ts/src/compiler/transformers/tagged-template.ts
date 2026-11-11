// Lowers tagged templates with invalid escapes, allowed in tagged templates since ES2018, to
// calls with a `__makeTemplateObject` template object.
import {
  ArrayLiteralExpression,
  type Node,
  NodeFlags,
  NoSubstitutionTemplateLiteral,
  SourceFile,
  TaggedTemplateExpression,
  TemplateExpression,
  TemplateHead,
  TemplateMiddle,
  TemplateSpan,
  TemplateTail,
  newCallExpression,
} from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import { getSourceTextOfNode } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { isExternalModule } from './utilities.js';

export class TaggedTemplateTransformer extends Transformer {
  readonly facts: SyntaxFacts;
  private file: SourceFile | undefined;
  /** `templateObject` variables, declared at the end of a module. */
  private declarations: Node[];

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
    this.file = undefined;
    this.declarations = [];
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsInvalidTemplateEscape)) return node;
    if (node instanceof SourceFile) return this.visitSourceFile(node as SourceFile);
    if (node instanceof TaggedTemplateExpression) return this.visitTaggedTemplate(node as TaggedTemplateExpression);
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    const factory = this.factory;
    this.file = node;
    this.declarations = [];
    let visited = this.visitEachChild(node) as SourceFile;
    if (this.declarations.length > 0) {
      const statements = visited.statements.nodes.slice();
      statements.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(factory.createNodeList(this.declarations.slice()), NodeFlags.None),
        ),
      );
      const list = factory.createNodeList(statements);
      list.pos = node.statements.pos;
      list.end = node.statements.end;
      visited = factory.updateSourceFile(visited, list, visited.endOfFileToken);
    }
    const helpers = this.context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(visited, helpers[i]);
    return visited;
  }

  private visitTaggedTemplate(node: TaggedTemplateExpression): Node {
    const factory = this.factory;
    const tag = this.visitNode(node.tag)!;
    const template = node.template;
    if (!hasInvalidEscape(template)) return this.visitEachChild(node);
    const args: Node[] = [];
    const cooked: Node[] = [];
    const raw: Node[] = [];
    if (template instanceof NoSubstitutionTemplateLiteral) {
      cooked.push(this.cookedString(template.text, template.templateFlags));
      raw.push(this.rawString(template, ''));
    } else if (template instanceof TemplateExpression) {
      const head = template.head;
      cooked.push(this.cookedString(head.text, head.templateFlags));
      raw.push(this.rawString(head, head.rawText));
      const spans = template.templateSpans.nodes;
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i] as TemplateSpan;
        const literal = span.literal;
        if (literal instanceof TemplateMiddle) {
          cooked.push(this.cookedString(literal.text, literal.templateFlags));
          raw.push(this.rawString(literal, literal.rawText));
        } else if (literal instanceof TemplateTail) {
          cooked.push(this.cookedString(literal.text, literal.templateFlags));
          raw.push(this.rawString(literal, literal.rawText));
        }
        args.push(this.visitNode(span.expression)!);
      }
    }
    const helperCall = factory.createTemplateObjectHelper(
      factory.created(new ArrayLiteralExpression(factory.createNodeList(cooked), false)),
      factory.created(new ArrayLiteralExpression(factory.createNodeList(raw), false)),
    );
    // Modules cache the template object; scripts don't, as the variable could clash with other scripts.
    let templateObject: Node = helperCall;
    if (this.file !== undefined && isExternalModule(this.file)) {
      const name = factory.createUniqueName('templateObject', 0);
      this.declarations.push(factory.createVariableDeclaration(name, undefined, undefined, undefined));
      templateObject = factory.createLogicalOr(name, factory.createAssignment(name, helperCall));
    }
    args.unshift(templateObject);
    const call = factory.created(newCallExpression(tag, undefined, undefined, factory.createNodeList(args), 0, false));
    call.pos = node.pos;
    call.end = node.end;
    return call;
  }

  private cookedString(text: string, flags: TokenFlags): Node {
    if ((flags & TokenFlags.IsInvalid) !== 0) return this.factory.createVoidZero();
    return this.factory.createStringLiteral(text, TokenFlags.None);
  }

  /** The raw text of a template literal part, with line terminators normalized to `\n`. */
  private rawString(node: Node, rawText: string): Node {
    let text = rawText;
    if (text === '' && this.file !== undefined) {
      // The source text includes the delimiters: "`" or "}" before and "`" or "${" after.
      text = getSourceTextOfNode(this.file.text, node);
      const last = node.kind === SyntaxKind.NoSubstitutionTemplateLiteral || node.kind === SyntaxKind.TemplateTail;
      text = text.slice(1, text.length - (last ? 1 : 2));
    }
    const literal = this.factory.createStringLiteral(normalizeLineTerminators(text), TokenFlags.None);
    literal.pos = node.pos;
    literal.end = node.end;
    return literal;
  }
}

function hasInvalidEscape(template: Node): boolean {
  if (template instanceof NoSubstitutionTemplateLiteral) return invalid(template.templateFlags);
  if (!(template instanceof TemplateExpression)) return false;
  const head: TemplateHead = template.head;
  if (invalid(head.templateFlags)) return true;
  const spans = template.templateSpans.nodes;
  for (let i = 0; i < spans.length; i++) {
    const literal = (spans[i] as TemplateSpan).literal;
    if (literal instanceof TemplateMiddle && invalid(literal.templateFlags)) return true;
    if (literal instanceof TemplateTail && invalid(literal.templateFlags)) return true;
  }
  return false;
}

function invalid(flags: TokenFlags): boolean {
  return (flags & TokenFlags.ContainsInvalidEscape) !== 0;
}

/** `\r\n` and `\r` as `\n`, as template values and raw values are (ES2015 11.8.6.1). */
function normalizeLineTerminators(text: string): string {
  if (text.indexOf('\r') < 0) return text;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== '\r') result += ch;
    else {
      result += '\n';
      if (i + 1 < text.length && text.charAt(i + 1) === '\n') i++;
    }
  }
  return result;
}
