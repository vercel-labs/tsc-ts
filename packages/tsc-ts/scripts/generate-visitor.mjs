// Generates node update functions (src/compiler/printer/factory-base.ts) and the transform
// visitor's child traversal (src/compiler/transformers/visitor-base.ts) from the node classes in
// src/compiler/ast.ts and tsgo's generated factory and visitor in internal/ast/ast_generated.go.
//
// Usage: node scripts/generate-visitor.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const goAst = resolve(root, '../../upstream/TypeScript/tsc/internal/ast');
const tsAst = readFileSync(join(root, 'src/compiler/ast.ts'), 'utf8');
const go = readFileSync(join(goAst, 'ast_generated.go'), 'utf8') + readFileSync(join(goAst, 'ast.go'), 'utf8');

// Node classes: fields with types, and constructor parameters in order.
const classes = new Map();
for (const match of tsAst.matchAll(/^export class (\w+) extends Node \{\n([\s\S]*?)\n\}\n/gm)) {
  const [, name, body] = match;
  const fields = new Map();
  for (const f of body.matchAll(/^ {2}(?:readonly )?(\w+): ([^;]+);$/gm)) fields.set(f[1], f[2]);
  const ctor = /^ {2}constructor\(([\s\S]*?)\) \{\n([\s\S]*?)\n {2}\}/m.exec(body);
  if (ctor === null) continue;
  const params = ctor[1]
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => {
      const [paramName, type] = p.split(/:\s*/);
      // The field a parameter initializes: `this.field = param`.
      const assign = new RegExp(`this\\.(\\w+) = ${paramName}\\b`).exec(ctor[2]);
      return { name: paramName, type, field: assign ? assign[1] : paramName };
    });
  classes.set(name, { name, fields, params });
}

const lower = (s) => s.toLowerCase();
function tsField(cls, goField) {
  for (const name of cls.fields.keys()) if (lower(name) === lower(goField)) return name;
  if (goField === 'Type' || goField === 'typeNode') return 'type';
  if (goField === 'Flags') return 'flags';
  throw new Error(`no field ${goField} on ${cls.name}`);
}

// Kinds per class, from the Go constructors.
const kinds = new Map();
for (const m of go.matchAll(
  /^func \(f \*NodeFactory\) New\w+\([^)]*\) \*Node \{\n\tdata := (?:&(\w+)\{\}|f\.(\w+)Arena\.New\(\))[\s\S]*?f\.newNode\((\w+), data\)/gm,
)) {
  let cls = m[1] ?? m[2].charAt(0).toUpperCase() + m[2].slice(1);
  if (!classes.has(cls)) continue;
  const kind = m[3] === 'kind' ? undefined : m[3].replace(/^Kind/, '');
  if (kind === undefined) continue;
  if (!kinds.has(cls)) kinds.set(cls, new Set());
  kinds.get(cls).add(kind);
}
const multiKinds = {
  ForInOrOfStatement: ['ForInStatement', 'ForOfStatement'],
  CaseOrDefaultClause: ['CaseClause', 'DefaultClause'],
  BindingPattern: ['ObjectBindingPattern', 'ArrayBindingPattern'],
  JSDocParameterOrPropertyTag: ['JSDocParameterTag', 'JSDocPropertyTag'],
};
for (const [cls, list] of Object.entries(multiKinds)) kinds.set(cls, new Set(list));

// Update functions: parameters and the fields they replace.
const updates = new Map();
for (const m of go.matchAll(
  /^func \(f \*NodeFactory\) Update(\w+)\(node \*(\w+), ([^)]*)\) \*Node \{\n\tif (.*) \{/gm,
)) {
  const [, , cls, paramText, condition] = m;
  if (!classes.has(cls) || cls === 'SourceFile') continue;
  const c = classes.get(cls);
  const params = paramText.split(', ').map((p) => p.split(' ')[0]);
  const fields = params.map((p) => {
    const cmp = new RegExp(`(?:${p} != node\\.(\\w+)|core\\.Same\\(${p}, node\\.(\\w+)\\))`).exec(condition);
    if (cmp === null) throw new Error(`no comparison for ${p} in Update${cls}`);
    return tsField(c, cmp[1] ?? cmp[2]);
  });
  updates.set(cls, { params, fields });
}

// Child visits per class.
const visits = new Map();
for (const m of go.matchAll(
  /^func \(node \*(\w+)\) VisitEachChild\(v \*NodeVisitor\) \*Node \{\n\treturn v\.Factory\.Update\w+\(node, (.*)\)\n\}/gm,
)) {
  const [, cls, args] = m;
  if (!classes.has(cls) || !updates.has(cls)) continue;
  visits.set(
    cls,
    args.split(', ').map((arg) => {
      const call = /^v\.(\w+)\(node\.(\w+)\)$/.exec(arg);
      if (call) return { hook: call[1], field: tsField(classes.get(cls), call[2]) };
      const plain = /^node\.(\w+)$/.exec(arg);
      if (plain) return { hook: undefined, field: tsField(classes.get(cls), plain[1]) };
      throw new Error(`unexpected argument ${arg} in ${cls}.VisitEachChild`);
    }),
  );
}
visits.set(
  'JSDocParameterOrPropertyTag',
  [
    'tagName:visitNode',
    'name:visitNode',
    'isBracketed:',
    'typeExpression:visitNode',
    'isNameFirst:',
    'comment:visitNodes',
  ].map((s) => {
    const [field, hook] = s.split(':');
    return { field, hook: hook === '' ? undefined : hook };
  }),
);
if (!updates.has('JSDocParameterOrPropertyTag'))
  updates.set('JSDocParameterOrPropertyTag', {
    params: ['tagName', 'name', 'isBracketed', 'typeExpression', 'isNameFirst', 'comment'],
    fields: ['tagName', 'name', 'isBracketed', 'typeExpression', 'isNameFirst', 'comment'],
  });

const categoryTypes = new Set([
  'Node',
  'Expression',
  'LeftHandSideExpression',
  'Statement',
  'TypeNode',
  'BindingName',
  'ConciseBody',
  'EntityName',
  'ForInitializer',
  'FunctionBody',
  'ImportAttributeName',
  'JSDocFullName',
  'JsxAttributeName',
  'JsxAttributeValue',
  'JsxTagNameExpression',
  'MemberName',
  'ModuleBody',
  'ModuleExportName',
  'ModuleName',
  'ModuleReference',
  'NamedExportBindings',
  'NamedImportBindings',
  'PropertyName',
  'DeclarationName',
  'TemplateLiteral',
  'TemplateMiddleOrTail',
  'TypePredicateParameterName',
]);

// Class-typed fields need a checked narrowing of the visited node.
const narrowed = new Set();
function wrap(type, expr, original) {
  const optional = type.endsWith(' | undefined');
  const base = optional ? type.slice(0, -' | undefined'.length) : type;
  if (base === 'NodeList' || base === 'ModifierList') return optional ? expr : `${expr}!`;
  if (categoryTypes.has(base)) return optional ? expr : `required(${expr}, ${original})`;
  narrowed.add((optional ? 'asOptional:' : 'as:') + base);
  return optional ? `asOptional${base}(${expr})` : `as${base}(${expr}, ${original})`;
}

const hookMethod = {
  visitNode: 'visitNode',
  visitToken: 'visitToken',
  visitNodes: 'visitNodes',
  visitModifiers: 'visitModifiers',
  visitParameters: 'visitParameters',
  visitFunctionBody: 'visitFunctionBody',
  visitIterationBody: 'visitIterationBody',
  visitEmbeddedStatement: 'visitEmbeddedStatement',
  visitTopLevelStatements: 'visitTopLevelStatements',
};

const factoryLines = [];
const visitorCases = [];
const visitedClasses = new Set();
const classImports = new Set();
const typeImports = new Set();
for (const [cls, update] of [...updates].sort((a, b) => a[0].localeCompare(b[0]))) {
  const c = classes.get(cls);
  classImports.add(cls);
  const fieldType = (f) => (f === 'flags' ? 'NodeFlags' : c.fields.get(f));
  const paramDecls = update.params.map((p, i) => `${p === 'arguments' ? 'args' : p}: ${fieldType(update.fields[i])}`);
  for (const f of update.fields) {
    const base = fieldType(f).replace(' | undefined', '').replace('[]', '');
    if (categoryTypes.has(base) || ['NodeFlags', 'TokenFlags', 'SyntaxKind'].includes(base)) typeImports.add(base);
    else if (classes.has(base) && !updates.has(base) && base !== 'Token') typeImports.add(base);
  }
  const paramName = (p) => (p === 'arguments' ? 'args' : p);
  const changed = update.params.map((p, i) => `${paramName(p)} !== node.${update.fields[i]}`).join(' || ');
  const ctorArgs = c.params.map((p) => {
    if (p.name === 'kind') return 'node.kind';
    const i = update.fields.indexOf(p.field);
    if (i >= 0) return paramName(update.params[i]);
    return `node.${p.field === 'flags' ? 'flags' : p.field}`;
  });
  const method = 'update' + cls;
  factoryLines.push(
    `  ${method}(node: ${cls}, ${paramDecls.join(', ')}): ${cls} {`,
    `    if (${changed}) {`,
    `      const updated = new ${cls}(${ctorArgs.join(', ')});`,
    `      this.finishUpdate(updated, node);`,
    `      return updated;`,
    `    }`,
    `    return node;`,
    `  }`,
    '',
  );
  const visit = visits.get(cls);
  if (visit === undefined) continue;
  const args = visit.map((v) => {
    const type = c.fields.get(v.field);
    if (v.hook === undefined) return `node.${v.field}`;
    return wrap(type, `this.${hookMethod[v.hook]}(node.${v.field})`, `node.${v.field}`);
  });
  visitedClasses.add(cls);
  const caseKinds = [...(kinds.get(cls) ?? [cls])];
  visitorCases.push(
    ...caseKinds.map((k) => `      case SyntaxKind.${k}:`),
    `        if (node instanceof ${cls}) return this.factory.${method}(node, ${args.join(', ')});`,
    `        break;`,
  );
}

// Source files are hand-written in ast.ts; the factory copies their metadata.
visitedClasses.add('SourceFile');
visitedClasses.add('Token');
visitorCases.push(
  `      case SyntaxKind.SourceFile:`,
  `        if (node instanceof SourceFile) return this.factory.updateSourceFile(node, this.visitTopLevelStatements(node.statements)!, asToken(this.visitToken(node.endOfFileToken), node.endOfFileToken));`,
  `        break;`,
);
narrowed.add('as:Token');

const header = '// Generated by scripts/generate-visitor.mjs; do not edit.\n';
const astTypes = [...typeImports].filter((t) => t !== 'TokenFlags' && t !== 'SyntaxKind' && t !== 'Node');
const imports = [...classImports, ...astTypes.map((t) => 'type ' + t)].sort().join(',\n  ');
const factory = `${header}import {
  ${imports},
  type ModifierList,
  type Node,
  type NodeList,
  type Token,
} from '../ast.js';
import type { SyntaxKind } from '../syntax-kind.js';
${typeImports.has('TokenFlags') ? "import type { TokenFlags } from '../types.js';" : ''}

/** \`update*\` functions: return the node if no child changed, else a copy with the node's flags, range and original. */
export abstract class NodeFactoryBase {
  protected abstract finishUpdate(updated: Node, original: Node): boolean;

${factoryLines.join('\n').trimEnd()}
}
`;

const narrowFns = [...narrowed].sort().flatMap((entry) => {
  const [fn, cls] = entry.split(':');
  return fn === 'as'
    ? [
        `function as${cls}(node: Node | undefined, original: ${cls}): ${cls} {`,
        `  if (node instanceof ${cls}) return node as ${cls};`,
        `  if (node === undefined) return original;`,
        `  throw new Error('Expected a ${cls}');`,
        '}',
        '',
      ]
    : [
        `function asOptional${cls}(node: Node | undefined): ${cls} | undefined {`,
        `  if (node === undefined) return undefined;`,
        `  if (node instanceof ${cls}) return node as ${cls};`,
        `  throw new Error('Expected a ${cls}');`,
        '}',
        '',
      ];
});
const visitorImports = [...new Set([...visitedClasses, ...[...narrowed].map((entry) => entry.split(':')[1])])]
  .sort()
  .join(',\n  ');
const visitor = `${header}import {
  ${visitorImports},
  type Node,
} from '../ast.js';
import { SyntaxKind } from '../syntax-kind.js';
import { VisitorHooks } from './visitor-hooks.js';

// A removed required child keeps the original, as tsgo's nil child is never printed.
function required(node: Node | undefined, original: Node): Node {
  return node === undefined ? original : node;
}

${narrowFns.join('\n')}
/** Rebuilds a node from its visited children, in tsgo's order and with its traversal hooks. */
export abstract class VisitorBase extends VisitorHooks {
  visitEachChild(node: Node): Node {
    switch (node.kind) {
${visitorCases.join('\n')}
    }
    return node;
  }
}
`;

const factoryPath = join(root, 'src/compiler/printer/factory-base.ts');
const visitorPath = join(root, 'src/compiler/transformers/visitor-base.ts');
writeFileSync(factoryPath, factory);
writeFileSync(visitorPath, visitor);
execFileSync(resolve(root, '../../node_modules/.bin/oxfmt'), [factoryPath, visitorPath], { stdio: 'inherit' });
