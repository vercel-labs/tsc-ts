// Generates the node classes and shared-field accessors in src/compiler/ast.ts from
// TypeScript's tools/scripts/tsc/ast.json. Only the marked regions of ast.ts are rewritten.
//
// Usage: node scripts/generate-ast.mjs [--schema PATH] [--check]
//
// With --check, writes nothing and fails if ast.ts differs from what it would write.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nullable } from './ast-nullable.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const schemaAt = args.indexOf('--schema');
const schemaPath =
  schemaAt >= 0 ? resolve(args[schemaAt + 1]) : resolve(root, '../../upstream/TypeScript/tools/scripts/tsc/ast.json');
const check = args.includes('--check');
const astPath = join(root, 'src/compiler/ast.ts');
const oxfmt = resolve(root, '../../node_modules/.bin/oxfmt');

const spec = JSON.parse(readFileSync(schemaPath, 'utf8'));
const bases = spec.bases;
const defs = spec.nodes.definitions;

// Checker-only nodes.
const skipNodes = new Set(['SyntheticExpression']);
// Hand-written in ast.ts.
const handWritten = new Set(['SourceFile', 'JSDocParameterOrPropertyTag']);
// Created only by transforms. scriptc can't narrow to a class a program never constructs, so the
// accessors leave these out until the transforms exist.
const transformOnly = new Set([
  'PartiallyEmittedExpression',
  'SyntheticReferenceExpression',
  'NotEmittedStatement',
  'NotEmittedTypeElement',
  'SyntaxList',
]);
// Kinds sharing one class, which the schema leaves implicit.
const multiKinds = {
  ForInOrOfStatement: ['ForInStatement', 'ForOfStatement'],
  CaseOrDefaultClause: ['CaseClause', 'DefaultClause'],
  BindingPattern: ['ObjectBindingPattern', 'ArrayBindingPattern'],
  JSDocParameterOrPropertyTag: ['JSDocParameterTag', 'JSDocPropertyTag'],
  KeywordExpression: ['NullKeyword', 'TrueKeyword', 'FalseKeyword', 'ThisKeyword', 'SuperKeyword', 'ImportKeyword'],
};
// Literal flags the factory masks, as tsgo's NodeFactory does.
const flagMasks = {
  StringLiteral: 'StringLiteralFlags',
  NumericLiteral: 'NumericLiteralFlags',
  BigIntLiteral: 'NumericLiteralFlags',
  RegularExpressionLiteral: 'RegularExpressionLiteralFlags',
  NoSubstitutionTemplateLiteral: 'TemplateLiteralLikeFlags',
  TemplateHead: 'TemplateLiteralLikeFlags',
  TemplateMiddle: 'TemplateLiteralLikeFlags',
  TemplateTail: 'TemplateLiteralLikeFlags',
};
// Member types that are always one class; other node-valued members are typed by category (`Node` aliases).
const classTypes = new Set([
  'Identifier',
  'Block',
  'CaseBlock',
  'CatchClause',
  'VariableDeclaration',
  'VariableDeclarationList',
  'ImportClause',
  'ImportAttributes',
  'JsxAttributes',
  'JsxOpeningElement',
  'JsxClosingElement',
  'JsxOpeningFragment',
  'JsxClosingFragment',
  'TemplateHead',
  'TypeParameterDeclaration',
  'ExpressionWithTypeArguments',
  'TypeLiteralNode',
]);
const tokenTypes = new Set([
  'AssertsKeyword',
  'AsteriskToken',
  'AwaitKeyword',
  'BinaryOperatorToken',
  'ColonToken',
  'DotDotDotToken',
  'EndOfFile',
  'EqualsGreaterThanToken',
  'EqualsToken',
  'ExclamationToken',
  'QuestionDotToken',
  'QuestionToken',
  'QuestionToken|ExclamationToken',
  'QuestionToken|PlusToken|MinusToken',
  'ReadonlyKeyword|PlusToken|MinusToken',
]);
const scalarTypes = new Set(['bool', 'string', 'TokenFlags', 'NodeFlags', 'ImportPhaseModifierSyntaxKind']);

// Fields the binder sets, which the schema marks Go-only, and their types.
const binderFieldTypes = {
  Symbol: 'Symbol',
  LocalSymbol: 'Symbol',
  Locals: 'SymbolTable',
  NextContainer: 'Node',
  FlowNode: 'FlowNode',
  EndFlowNode: 'FlowNode',
  ReturnFlowNode: 'FlowNode',
  FallthroughFlowNode: 'FlowNode',
};

// Members a class holds under another name and type, read through a getter: an identifier stores the name
// of its text, which a scanner interns once per text of a file, and reads `text` from that name.
const storedMembers = {
  Identifier: { text: { field: 'identifierName', fieldType: 'IdentifierName', param: 'name' } },
};

// Fields that only a subclass holds: the parser creates the subclass where the fields can be set,
// and the base class everywhere else. `members` are parser fields, which the subclass's constructor
// takes; `binder` are binder fields. `create` names a function that takes every member and creates
// the subclass when one of `members` is set or the node is in a JavaScript file; `readers` name
// functions that read a member from either class.
const fieldSubclasses = {
  Identifier: {
    name: 'ReferenceIdentifier',
    members: [],
    binder: ['flowNode'],
    doc: [
      '/**',
      ' * An identifier that can be read as a reference, such as an expression or a shorthand property',
      " * name, and so holds the binder's flow node. The parser creates a plain `Identifier` for names",
      ' * whose flow node nothing reads: declaration names, property names and property access names.',
      ' */',
    ],
  },
  CallExpression: {
    name: 'FullCallExpression',
    members: ['questionDotToken', 'typeArguments'],
    binder: ['symbol'],
    create: 'newCallExpression',
    readers: { questionDotToken: 'callQuestionDotToken', typeArguments: 'callTypeArguments' },
    doc: [
      '/**',
      ' * A call with `?.` or type arguments, or in a JavaScript file, where the binder can declare a symbol',
      ' * for it (`Object.defineProperty`). Other calls are a plain `CallExpression`, without these fields.',
      ' */',
    ],
  },
  PropertyAssignment: {
    name: 'FullPropertyAssignment',
    members: ['modifiers', 'postfixToken', 'type'],
    binder: [],
    create: 'newPropertyAssignment',
    readers: {
      modifiers: 'propertyAssignmentModifiers',
      postfixToken: 'propertyAssignmentPostfixToken',
      type: 'propertyAssignmentType',
    },
    doc: [
      '/**',
      ' * A property assignment with modifiers, a `?` or `!`, or a type annotation (which the grammar checker',
      ' * reports), or in a JavaScript file, where JSDoc can give it a type or modifiers. Other property',
      ' * assignments are a plain `PropertyAssignment`, without these fields.',
      ' */',
    ],
  },
};

/** The class holding field `field` of `c`: `c` itself, or the subclass that holds it. */
function fieldHolder(c, field) {
  const sub = fieldSubclasses[c.name];
  return sub !== undefined && (sub.members.includes(field) || sub.binder.includes(field)) ? sub.name : c.name;
}

function fieldName(name) {
  if (name.startsWith('JSDoc')) return 'jsdoc' + name.slice(5);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

const paramName = (name) => (name === 'arguments' ? 'args' : name);

function baseField(baseNames, name) {
  for (const bn of baseNames) {
    const b = bases[bn];
    if (b !== undefined && b.fields !== undefined && b.fields[name] !== undefined) return b.fields[name];
  }
  for (const bn of baseNames) {
    const b = bases[bn];
    if (b === undefined) continue;
    const found = baseField(b.extends ?? [], name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function typeName(type) {
  return Array.isArray(type) ? type.join('|') : type;
}

function tsType(type) {
  const t = typeName(type);
  if (t === 'bool') return 'boolean';
  if (t === 'string' || t === 'TokenFlags' || t === 'NodeFlags') return t;
  if (t.startsWith('SyntaxKind.') || t === 'ImportPhaseModifierSyntaxKind') return 'SyntaxKind';
  if (tokenTypes.has(t)) return 'Token';
  return t;
}

/** The binder fields of a node definition, from its bases and its own members. */
function binderFields(def) {
  const result = [];
  const add = (name) => {
    const type = binderFieldTypes[name];
    if (type !== undefined && !result.some((f) => f.name === fieldName(name)))
      result.push({ name: fieldName(name), type });
  };
  const seen = new Set();
  const visit = (names) => {
    for (const bn of names) {
      const b = bases[bn];
      if (b === undefined || seen.has(bn)) continue;
      seen.add(bn);
      visit(b.extends ?? []);
      for (const [name, field] of Object.entries(b.fields ?? {})) if (field.goOnly) add(name);
    }
  };
  visit(def.extends ?? []);
  for (const m of def.members ?? []) if (m.goOnly) add(m.name);
  return result;
}

/** Whether a definition extends `base`, directly or through other bases. */
function extendsBase(names, base) {
  for (const bn of names ?? []) if (bn === base || extendsBase(bases[bn]?.extends, base)) return true;
  return false;
}

/** The node classes, with their kinds and members in factory/visitor order. */
function nodeClasses() {
  const classes = [];
  for (const [name, def] of Object.entries(defs)) {
    if (skipNodes.has(name)) continue;
    const kinds =
      multiKinds[name] ?? (def.kind === undefined ? [name] : Array.isArray(def.kind) ? def.kind : [def.kind]);
    const members = [];
    let hasKindParam = false;
    for (const m of def.members ?? []) {
      let field = m;
      if (m.inherited) {
        if (m.name === 'Kind') {
          hasKindParam = true;
          continue;
        }
        const base = baseField(def.extends, m.name);
        if (base === undefined) throw new Error(`${name}.${m.name}`);
        field = {
          ...base,
          ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'inherited' && k !== 'name')),
        };
      }
      if (field.goOnly) continue;
      if (m.name === 'Flags') {
        members.push({ name: 'flags', isFlags: true, type: 'NodeFlags' });
        continue;
      }
      let type;
      let child = undefined;
      if (field.list === 'NodeList') {
        type = 'NodeList';
        child = 'list';
      } else if (field.list === 'ModifierList') {
        type = 'ModifierList';
        child = 'modifiers';
      } else if (field.list === 'raw') {
        if (field.type === 'string') type = 'string';
        else {
          type = 'Node[]';
          child = 'raw';
        }
      } else {
        type = tsType(field.type);
        const t = typeName(field.type);
        if (!scalarTypes.has(t) && !t.startsWith('SyntaxKind.')) child = 'node';
      }
      const optional = field.optional === true || nullable.has(`${name}.${m.name}`);
      members.push({ name: fieldName(m.name), type, optional, child });
    }
    for (const [member, stored] of Object.entries(storedMembers[name] ?? {})) {
      const i = members.findIndex((m) => m.name === member);
      if (i < 0) throw new Error(`${name}.${member}`);
      members[i] = { ...members[i], ...stored };
    }
    // Literal-like kinds that store no token flags (template literals, JSX text) report none, as
    // TypeScript 7's API does.
    const noTokenFlags =
      extendsBase(def.extends, 'LiteralLikeNodeBase') && !members.some((m) => m.name === 'tokenFlags');
    classes.push({ name, kinds, members, hasKindParam, binder: binderFields(def), noTokenFlags });
  }
  return classes;
}

function emitClass(c) {
  const sub = fieldSubclasses[c.name];
  const isOwn = (name) => sub !== undefined && sub.members.includes(name);
  const baseMembers = c.members.filter((m) => !isOwn(m.name));
  const binder = sub === undefined ? c.binder : c.binder.filter((f) => !sub.binder.includes(f.name));
  const kindLiteral = c.kinds.length === 1 && !c.hasKindParam;
  const type = (m) => `${m.type}${m.optional ? ' | undefined' : ''}`;
  const paramOf = (m) => (m.field ? `${m.param}: ${m.fieldType}` : `${paramName(m.name)}: ${type(m)}`);
  const paramsOf = (members) => [
    ...(kindLiteral ? [] : ['kind: SyntaxKind']),
    ...members.map((m) => (m.isFlags ? 'flags: NodeFlags' : paramOf(m))),
  ];
  const assignment = (m) => {
    if (m.isFlags)
      return c.name === 'VariableDeclarationList'
        ? '    this.flags = flags;'
        : '    this.flags |= flags & NodeFlags.OptionalChain;';
    if (m.type === 'TokenFlags' && flagMasks[c.name] !== undefined)
      return `    this.${m.name} = ${paramName(m.name)} & TokenFlags.${flagMasks[c.name]};`;
    return `    this.${m.field ?? m.name} = ${m.field ? m.param : paramName(m.name)};`;
  };

  // forEachChild and setParentOfChildren over `members`, in their order.
  const childMethods = (members) => {
    const lines = [];
    const children = members.filter((m) => !m.isFlags && m.child !== undefined);
    lines.push(`  forEachChild(${children.length > 0 ? 'v' : '_v'}: NodeVisitor): boolean {`);
    children.forEach((m, i) => {
      const last = i === children.length - 1;
      const f = `this.${m.name}`;
      if (m.child === 'raw') {
        lines.push(
          m.optional
            ? `    if (${f} !== undefined) for (const node of ${f}) if (v.visitNode(node)) return true;`
            : `    for (const node of ${f}) if (v.visitNode(node)) return true;`,
        );
        if (last) lines.push('    return false;');
        return;
      }
      const call =
        m.child === 'node' ? `v.visitNode(${f})` : m.child === 'list' ? `v.visitList(${f})` : `v.visitModifiers(${f})`;
      if (last) lines.push(m.optional ? `    return ${f} !== undefined && ${call};` : `    return ${call};`);
      else
        lines.push(
          m.optional ? `    if (${f} !== undefined && ${call}) return true;` : `    if (${call}) return true;`,
        );
    });
    if (children.length === 0) lines.push('    return false;');
    lines.push('  }');
    lines.push('');
    lines.push('  setParentOfChildren(): void {');
    for (const m of children) {
      const f = `this.${m.name}`;
      const set =
        m.child === 'node'
          ? `${f}.parent = this;`
          : m.child === 'raw'
            ? `setParents(${f}, this);`
            : `setParents(${f}.nodes, this);`;
      lines.push(m.optional || m.child === 'modifiers' ? `    if (${f} !== undefined) ${set}` : `    ${set}`);
    }
    lines.push('  }');
    return lines;
  };

  // copy: `copy` keeps the class type for class-typed members (scriptc can't override with a
  // narrower return type).
  const copyMethod = (cls, members) => {
    const args = [];
    if (!kindLiteral) args.push('this.kind');
    for (const m of members) {
      if (m.isFlags) {
        args.push('this.flags');
        continue;
      }
      const f = `this.${m.field ?? m.name}`;
      const orUndefined = (expr) => (m.optional ? `${f} === undefined ? undefined : ${expr}` : expr);
      if (m.child === 'node')
        args.push(orUndefined(`${f}.${m.type === 'Token' || classTypes.has(m.type) ? 'copy' : 'deepClone'}()`));
      else if (m.child === 'list') args.push(orUndefined(`cloneList(${f})`));
      else if (m.child === 'modifiers') args.push(`${f} === undefined ? undefined : cloneModifiers(${f})`);
      else if (m.child === 'raw') args.push(orUndefined(`cloneNodes(${f})`));
      else args.push(f);
    }
    return [
      `  copy(): ${c.name} {`,
      `    const node = new ${cls}(${args.join(', ')});`,
      '    node.flags = this.flags;',
      '    node.pos = this.pos;',
      '    node.end = this.end;',
      '    return node;',
      '  }',
    ];
  };

  const lines = [];
  const fields = baseMembers.filter((m) => !m.isFlags);
  lines.push(`export class ${c.name} extends Node {`);
  for (const m of fields) {
    const readOnly = m.field === undefined ? '' : 'readonly ';
    const fieldType = m.field === undefined ? type(m) : m.fieldType;
    lines.push(`  ${readOnly}${m.field ?? m.name}: ${fieldType};`);
  }
  if (binder.length > 0) {
    lines.push('  // Set by the binder.');
    for (const f of binder) lines.push(`  ${f.name}: ${f.type} | undefined;`);
  }
  if (fields.length > 0 || binder.length > 0) lines.push('');
  lines.push(`  constructor(${paramsOf(baseMembers).join(', ')}) {`);
  lines.push(`    super(${kindLiteral ? 'SyntaxKind.' + c.kinds[0] : 'kind'});`);
  for (const m of baseMembers) lines.push(assignment(m));
  for (const f of binder) lines.push(`    this.${f.name} = undefined;`);
  lines.push('  }');
  lines.push('');
  for (const m of baseMembers) {
    if (m.field === undefined) continue;
    lines.push(`  get ${m.name}(): ${type(m)} {`);
    lines.push(`    return this.${m.field}.${m.name};`);
    lines.push('  }');
    lines.push('');
  }
  if (c.noTokenFlags) {
    lines.push('  get tokenFlags(): TokenFlags {');
    lines.push('    return TokenFlags.None;');
    lines.push('  }');
    lines.push('');
  }
  lines.push(...childMethods(baseMembers));
  lines.push('');
  lines.push('  deepClone(): Node {');
  lines.push('    return this.copy();');
  lines.push('  }');
  lines.push('');
  lines.push(...copyMethod(c.name, baseMembers));
  lines.push('}');
  if (sub !== undefined) {
    const ownMembers = c.members.filter((m) => isOwn(m.name));
    const ownBinder = c.binder.filter((f) => sub.binder.includes(f.name));
    const paramNames = (members) => paramsOf(members).map((p) => p.slice(0, p.indexOf(':')));
    lines.push('');
    lines.push(...sub.doc);
    lines.push(`export class ${sub.name} extends ${c.name} {`);
    for (const m of ownMembers) lines.push(`  ${m.name}: ${type(m)};`);
    if (ownBinder.length > 0) {
      lines.push('  // Set by the binder.');
      for (const f of ownBinder) lines.push(`  ${f.name}: ${f.type} | undefined;`);
    }
    lines.push('');
    lines.push(`  constructor(${paramsOf(c.members).join(', ')}) {`);
    lines.push(`    super(${paramNames(baseMembers).join(', ')});`);
    for (const m of ownMembers) lines.push(assignment(m));
    for (const f of ownBinder) lines.push(`    this.${f.name} = undefined;`);
    lines.push('  }');
    lines.push('');
    if (ownMembers.length > 0) {
      lines.push(...childMethods(c.members));
      lines.push('');
    }
    lines.push(...copyMethod(sub.name, c.members));
    lines.push('}');
    if (sub.create !== undefined) {
      const own = ownMembers.map((m) => `${paramName(m.name)} !== undefined`);
      lines.push('');
      lines.push(`/** A \`${sub.name}\` when one of its fields is set or \`inJavaScript\`, else a \`${c.name}\`. */`);
      lines.push(
        `export function ${sub.create}(${[...paramsOf(c.members), 'inJavaScript: boolean'].join(', ')}): ${c.name} {`,
      );
      lines.push(`  if (inJavaScript || ${own.join(' || ')})`);
      lines.push(`    return new ${sub.name}(${paramNames(c.members).join(', ')});`);
      lines.push(`  return new ${c.name}(${paramNames(baseMembers).join(', ')});`);
      lines.push('}');
    }
    for (const [field, reader] of Object.entries(sub.readers ?? {})) {
      const m = ownMembers.find((x) => x.name === field);
      lines.push('');
      lines.push(`export function ${reader}(node: ${c.name}): ${type(m)} {`);
      lines.push(`  return node instanceof ${sub.name} ? node.${field} : undefined;`);
      lines.push('}');
    }
  }
  return lines.join('\n');
}

// Fields with an accessor function, like tsgo's Node.Name(), Node.Type(), ….
const accessorFields = [
  'name',
  'modifiers',
  'typeParameters',
  'parameters',
  'type',
  'body',
  'expression',
  'initializer',
  'postfixToken',
  'typeArguments',
  'arguments',
  'members',
  'statements',
  'elements',
  'properties',
  'typeExpression',
  'tagName',
  'comment',
  'isTypeOnly',
  'importClause',
  'moduleSpecifier',
  'dotDotDotToken',
  'asteriskToken',
  'questionToken',
  'text',
  'heritageClauses',
  'label',
  'statement',
  'literal',
  'propertyName',
];
const plainTypes = new Set(['NodeList', 'ModifierList', 'boolean', 'string', 'Node[]']);

function emitAccessors(classes) {
  const result = [];
  for (const field of accessorFields) {
    const holders = [];
    for (const c of classes) {
      if (transformOnly.has(c.name)) continue;
      const m = c.members.find((f) => f.name === field);
      if (m !== undefined) holders.push(c);
    }
    if (holders.length < 2) continue;
    const types = new Set(
      holders.map((c) => {
        const m = c.members.find((f) => f.name === field);
        return plainTypes.has(m.type) ? m.type : 'Node';
      }),
    );
    if (types.size > 1) throw new Error(`mixed accessor types for ${field}`);
    const t = [...types][0];
    const fn = 'get' + field.charAt(0).toUpperCase() + field.slice(1);
    const ret = t === 'boolean' ? 'boolean' : t === 'string' ? 'string' : `${t} | undefined`;
    const fallback = t === 'boolean' ? 'false' : t === 'string' ? "''" : 'undefined';
    const lines = [`export function ${fn}(node: Node): ${ret} {`, '  switch (node.kind) {'];
    for (const c of holders) {
      for (const k of c.kinds) lines.push(`    case SyntaxKind.${k}:`);
      const holder = fieldHolder(c, field);
      lines.push(
        `      if (node instanceof ${holder}) {`,
        `        const holder: ${holder} = node;`,
        `        return holder.${field};`,
        '      }',
      );
      lines.push('      break;');
    }
    lines.push('  }', `  return ${fallback};`, '}');
    result.push(lines.join('\n'));
  }
  return result.join('\n\n');
}

function replaceRegion(text, name, body) {
  const begin = `// #region ${name} (generated by scripts/generate-ast.mjs)\n`;
  const end = `// #endregion ${name}\n`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`missing region ${name} in ast.ts`);
  return text.substring(0, start + begin.length) + '\n' + body + '\n\n' + text.substring(stop);
}

/** Getters and setters for the binder fields, and predicates for the classes that have them. */
function emitBinderAccessors(classes) {
  const result = [];
  const holdersOf = (field) =>
    classes.filter((c) => !transformOnly.has(c.name) && c.binder.some((f) => f.name === field));
  const caseLines = (holders) => holders.flatMap((c) => c.kinds.map((k) => `    case SyntaxKind.${k}:`));
  const predicates = { isDeclarationNode: 'symbol', isLocalsContainer: 'locals' };
  for (const [fn, field] of Object.entries(predicates)) {
    result.push(
      [
        `export function ${fn}(node: Node): boolean {`,
        '  switch (node.kind) {',
        ...caseLines(holdersOf(field)),
        '      return true;',
        '  }',
        '  return false;',
        '}',
      ].join('\n'),
    );
  }
  for (const field of Object.keys(binderFieldTypes).map(fieldName)) {
    const holders = holdersOf(field);
    if (holders.length < 2) continue;
    const type = holders[0].binder.find((f) => f.name === field).type;
    const suffix = field.charAt(0).toUpperCase() + field.slice(1);
    const getter = [`export function get${suffix}(node: Node): ${type} | undefined {`, '  switch (node.kind) {'];
    const setter = [
      `export function set${suffix}(node: Node, value: ${type} | undefined): void {`,
      '  switch (node.kind) {',
    ];
    for (const c of holders) {
      for (const k of c.kinds) {
        getter.push(`    case SyntaxKind.${k}:`);
        setter.push(`    case SyntaxKind.${k}:`);
      }
      // Through typed locals: scriptc reads and writes fields of a narrowed parameter dynamically.
      const holder = fieldHolder(c, field);
      getter.push(
        `      if (node instanceof ${holder}) {`,
        `        const holder: ${holder} = node;`,
        `        return holder.${field};`,
        '      }',
        '      break;',
      );
      setter.push(
        `      if (node instanceof ${holder}) {`,
        `        const target: ${holder} = node;`,
        `        target.${field} = value;`,
        '      }',
        '      break;',
      );
    }
    getter.push('  }', '  return undefined;', '}');
    setter.push('  }', '}');
    result.push(getter.join('\n'), setter.join('\n'));
  }
  return result.join('\n\n');
}

const classes = nodeClasses();
// The hand-written classes' fields, for the accessors.
const handFields = {
  SourceFile: [{ name: 'statements', type: 'NodeList' }],
  JSDocParameterOrPropertyTag: [
    { name: 'tagName', type: 'Identifier' },
    { name: 'name', type: 'EntityName' },
    { name: 'isBracketed', type: 'boolean' },
    { name: 'typeExpression', type: 'TypeNode', optional: true },
    { name: 'comment', type: 'NodeList', optional: true },
  ],
};
for (const c of classes) if (handFields[c.name] !== undefined) c.members = handFields[c.name];
let text = readFileSync(astPath, 'utf8');
text = replaceRegion(
  text,
  'nodes',
  classes
    .filter((c) => !handWritten.has(c.name))
    .map(emitClass)
    .join('\n\n'),
);
text = replaceRegion(text, 'accessors', emitAccessors(classes) + '\n\n' + emitBinderAccessors(classes));
if (check) {
  const formatted = execFileSync(oxfmt, ['--stdin-filepath', astPath], { input: text, encoding: 'utf8' });
  if (formatted !== readFileSync(astPath, 'utf8')) {
    console.error('ast.ts is out of date: run node scripts/generate-ast.mjs');
    process.exitCode = 1;
  }
} else {
  writeFileSync(astPath, text);
  execFileSync(oxfmt, [astPath], { stdio: 'inherit' });
}
