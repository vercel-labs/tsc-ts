// Binds a file and prints its symbols, bind diagnostics, and optionally flow graph and symbol
// tables, in the format of the reference bind oracle, with UTF-8 offsets.
// Usage: bind FILE [--bench|--bench-bind] [--named] [--tree] [--flow] [--tables] [--resolve]
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  CaseOrDefaultClause,
  ClassStaticBlockDeclaration,
  ConstructorDeclaration,
  ExternalModuleIndicatorOptions,
  Identifier,
  type Node,
  NodeVisitor,
  ParseOptions,
  ReferenceIdentifier,
  ScriptKind,
  SourceFile,
  getEndFlowNode,
  getFlowNode,
  getLocalSymbol,
  getLocals,
  getNextContainer,
  getSymbol,
  getText,
} from '../compiler/ast.js';
import { bindSourceFile } from '../compiler/binder.js';
import { type Diagnostic, Locale } from '../compiler/diagnostics.js';
import { FlowFlags, type FlowNode, FlowReduceLabel, FlowSwitchClause } from '../compiler/flow.js';
import { NameResolver } from '../compiler/name-resolver.js';
import { parseSourceFile } from '../compiler/parser.js';
import { declarationCount, getDeclarations, type Symbol, SymbolFlags, type SymbolTable } from '../compiler/symbol.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import './lowering.js';

const out: string[] = [];

/** UTF-8 offset of each UTF-16 offset; the middle of a surrogate pair maps to its start. */
function utf8Offsets(text: string): Int32Array {
  const offsets = new Int32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = bytes;
    const ch = text.charCodeAt(i);
    if (ch < 0x80) bytes += 1;
    else if (ch < 0x800) bytes += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        offsets[i + 1] = bytes;
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

function hex(n: number, digits: number): string {
  const s = n.toString(16);
  return '0000'.substring(0, digits - s.length) + s;
}

/** Go's `%q` for symbol names; the internal name prefix prints as tsgo's `\xfe` byte. */
function quote(s: string): string {
  let result = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 0x22) result += '\\"';
    else if (ch === 0x5c) result += '\\\\';
    else if (ch === 0x0a) result += '\\n';
    else if (ch === 0x0d) result += '\\r';
    else if (ch === 0x09) result += '\\t';
    else if (ch < 0x20 || ch === 0x7f) result += '\\x' + hex(ch, 2);
    else if (ch === 0xfffe) result += '\\xfe';
    else if (ch >= 0x80 && ch < 0xa0) result += '\\u' + hex(ch, 4);
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < s.length) {
      // Whole surrogate pairs: native strings can't hold lone surrogates.
      result += s.substring(i, i + 2);
      i++;
    } else result += String.fromCharCode(ch);
  }
  return result + '"';
}

/** Orders names by their bytes in tsgo, where the internal prefix is the byte 0xFE. */
function compareNames(a: string, b: string): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function sortKey(name: string): string {
  // UTF-8 bytes as code units, so string comparison is byte order.
  let key = '';
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c === 0xfffe) key += String.fromCharCode(0xfe);
    else if (c < 0x80) key += String.fromCharCode(c);
    else if (c < 0x800) key += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < name.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (name.charCodeAt(++i) - 0xdc00);
      key += String.fromCharCode(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else key += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return key;
}

function sortedNames(table: SymbolTable): string[] {
  const names: string[] = [];
  for (const name of table.keys()) names.push(name);
  names.sort(compareNames);
  return names;
}

function symbolText(symbol: Symbol | undefined): string {
  if (symbol === undefined) return '-';
  return `${quote(symbol.name)}:${symbol.flags}:${declarationCount(symbol)}`;
}

class Printer extends NodeVisitor {
  readonly offsets: Int32Array;
  readonly order: Node[];
  readonly nodeIds: Map<Node, number>;
  readonly symbolIds: Map<Symbol, number>;
  readonly symbols: Symbol[];
  readonly flowIds: Map<FlowNode, number>;
  readonly flows: FlowNode[];
  depth: number;
  printSymbols: boolean;

  constructor(file: SourceFile) {
    super();
    this.offsets = utf8Offsets(file.text);
    this.order = [];
    this.nodeIds = new Map<Node, number>();
    this.symbolIds = new Map<Symbol, number>();
    this.symbols = [];
    this.flowIds = new Map<FlowNode, number>();
    this.flows = [];
    this.depth = 0;
    this.printSymbols = true;
  }

  byte(pos: number): number {
    const offsets = this.offsets;
    return pos < 0 || pos >= offsets.length ? pos : offsets[pos];
  }

  visitNode(node: Node): boolean {
    let line = `${this.depth} ${node.kind} ${this.byte(node.pos)} ${this.byte(node.end)} ${node.flags}`;
    if (this.printSymbols) {
      this.nodeIds.set(node, this.order.length);
      this.order.push(node);
      line += ` ${symbolText(getSymbol(node))} ${symbolText(getLocalSymbol(node))}`;
      const locals = getLocals(node);
      if (locals !== undefined) for (const name of sortedNames(locals)) line += ` ${symbolText(locals.get(name))}`;
    }
    out.push(line);
    this.depth++;
    node.forEachChild(this);
    this.depth--;
    return false;
  }

  diagnostic(label: string, d: Diagnostic): void {
    const pos = this.byte(d.pos);
    out.push(`${label} ${d.code} ${pos} ${this.byte(d.end) - pos} ${d.localize(Locale.Default)}`);
  }

  node(node: Node | undefined): string {
    if (node === undefined) return '-';
    const id = this.nodeIds.get(node);
    return id !== undefined ? String(id) : `?${node.kind}`;
  }

  sym(symbol: Symbol | undefined): string {
    if (symbol === undefined) return '-';
    let id = this.symbolIds.get(symbol);
    if (id === undefined) {
      id = this.symbols.length;
      this.symbolIds.set(symbol, id);
      this.symbols.push(symbol);
    }
    return `#${id}`;
  }

  flow(flow: FlowNode | undefined): string {
    if (flow === undefined) return '-';
    let id = this.flowIds.get(flow);
    if (id === undefined) {
      id = this.flows.length;
      this.flowIds.set(flow, id);
      this.flows.push(flow);
    }
    return `@${id}`;
  }

  table(table: SymbolTable): string {
    const parts: string[] = [];
    for (const name of sortedNames(table)) parts.push(`${quote(name)}=${this.sym(table.get(name))}`);
    return '{' + parts.join(' ') + '}';
  }

  resolveIdentifiers(): void {
    const resolver = new NameResolver({});
    const order = this.order;
    for (let i = 0; i < order.length; i++) {
      const n = order[i]!;
      if (n.kind !== SyntaxKind.Identifier) continue;
      const text = getText(n);
      const value = this.sym(resolver.resolve(n, text, SymbolFlags.Value, undefined, false, false));
      const type = this.sym(resolver.resolve(n, text, SymbolFlags.Type, undefined, false, false));
      const namespace = this.sym(resolver.resolve(n, text, SymbolFlags.Namespace, undefined, false, false));
      out.push(`resolve ${i} ${value} ${type} ${namespace}`);
    }
  }

  tables(file: SourceFile): void {
    out.push(
      `file symbols=${file.symbolCount} cjs=${this.node(file.commonJSModuleIndicator)} module=${this.node(file.externalModuleIndicator)}`,
    );
    const order = this.order;
    for (let i = 0; i < order.length; i++) {
      const n = order[i]!;
      const parts: string[] = [];
      const symbol = getSymbol(n);
      if (symbol !== undefined) parts.push('sym=' + this.sym(symbol));
      const local = getLocalSymbol(n);
      if (local !== undefined) parts.push('local=' + this.sym(local));
      const locals = getLocals(n);
      if (locals !== undefined && locals.size > 0) parts.push('locals=' + this.table(locals));
      const next = getNextContainer(n);
      if (next !== undefined) parts.push('next=' + this.node(next));
      if (parts.length > 0) out.push(`node ${i} ${parts.join(' ')}`);
    }
    const globalExports = file.globalExports;
    if (globalExports !== undefined && globalExports.size > 0) out.push(`global ${this.table(globalExports)}`);
    for (const p of file.patternAmbientModules)
      out.push(`pattern ${quote(p.text)} ${p.starIndex} ${this.sym(p.symbol)}`);
    for (let i = 0; i < this.symbols.length; i++) {
      const s = this.symbols[i]!;
      const declarations: string[] = [];
      for (const d of getDeclarations(s)) declarations.push(this.node(d));
      let line = `symbol #${i} ${quote(s.name)} ${s.flags} decls=[${declarations.join(' ')}] value=${this.node(s.valueDeclaration)} parent=${this.sym(s.parent)} export=${this.sym(s.exportSymbol)}`;
      if (s.members !== undefined && s.members.size > 0) line += ` members=${this.table(s.members)}`;
      if (s.exports !== undefined && s.exports.size > 0) line += ` exports=${this.table(s.exports)}`;
      out.push(line);
    }
  }

  flowGraph(): void {
    const order = this.order;
    // Identifiers without a flow node, whose flow node tsgo's binder sets but nothing reads; the
    // test leaves theirs out of tsgo's output.
    let plain = '';
    for (let i = 0; i < order.length; i++) {
      const n = order[i]!;
      if (n instanceof Identifier && !(n instanceof ReferenceIdentifier)) plain += ' ' + i;
      const parts: string[] = [];
      const flow = getFlowNode(n);
      if (flow !== undefined) parts.push('flow=' + this.flow(flow));
      const end = getEndFlowNode(n);
      if (end !== undefined) parts.push('end=' + this.flow(end));
      if (n instanceof CaseOrDefaultClause && n.fallthroughFlowNode !== undefined)
        parts.push('fallthrough=' + this.flow(n.fallthroughFlowNode));
      const ret =
        n instanceof ConstructorDeclaration
          ? n.returnFlowNode
          : n instanceof ClassStaticBlockDeclaration
            ? n.returnFlowNode
            : undefined;
      if (ret !== undefined) parts.push('return=' + this.flow(ret));
      if (parts.length > 0) out.push(`flowof ${i} ${parts.join(' ')}`);
    }
    for (let i = 0; i < this.flows.length; i++) {
      const f = this.flows[i]!;
      let line = `flow @${i} ${f.flags}`;
      if (f instanceof FlowSwitchClause)
        line += ` switch=${this.node(f.switchStatement)} ${f.clauseStart} ${f.clauseEnd}`;
      else if (f instanceof FlowReduceLabel)
        line += ` target=${this.flow(f.target)} reduced=[${this.flowList(f.antecedents)} ]`;
      else line += ` node=${this.node(f.node)}`;
      line += ` ante=${this.flow(f.antecedent)}`;
      if ((f.flags & FlowFlags.ReduceLabel) === 0 && f.antecedents !== undefined)
        line += ` antes=[${this.flowList(f.antecedents)} ]`;
      out.push(line);
    }
    if (plain !== '') out.push('plain-identifiers' + plain);
  }

  flowList(list: FlowNode[] | undefined): string {
    let text = '';
    if (list !== undefined) for (const f of list) text += ' ' + this.flow(f);
    return text;
  }
}

const forcedExtensions = ['.cjs', '.cts', '.mjs', '.mts'];

function baseName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

function isDeclarationFileName(name: string): boolean {
  const base = baseName(name);
  if (base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts')) return true;
  return base.endsWith('.ts') && base.includes('.d.');
}

function parse(path: string, text: string, named: boolean): SourceFile {
  if (!named) {
    const options = new ParseOptions('/input.ts', ScriptKind.TS, new ExternalModuleIndicatorOptions(false, false));
    return parseSourceFile('/input.ts', text, options);
  }
  const fileName = '/' + baseName(path);
  let force = false;
  if (!isDeclarationFileName(fileName)) for (const ext of forcedExtensions) if (fileName.endsWith(ext)) force = true;
  const options = new ParseOptions(fileName, ScriptKind.Unknown, new ExternalModuleIndicatorOptions(false, force));
  return parseSourceFile(fileName, text, options);
}

function main(): void {
  const args = process.argv.slice(2);
  const path = args[0];
  const text = readFileSync(path, 'utf8');
  let named = false;
  let tree = false;
  let flows = false;
  let tables = false;
  let bench = false;
  let benchBind = false;
  let resolve = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--named') named = true;
    else if (arg === '--tree') tree = true;
    else if (arg === '--flow') flows = true;
    else if (arg === '--tables') tables = true;
    else if (arg === '--bench') bench = true;
    else if (arg === '--bench-bind') benchBind = true;
    else if (arg === '--resolve') resolve = true;
  }
  if (bench || benchBind) {
    const files: SourceFile[] = [];
    let start = performance.now();
    for (let round = 0; round < 20; round++) {
      if (bench) bindSourceFile(parse(path, text, named));
      else files.push(parse(path, text, named));
    }
    if (benchBind) {
      start = performance.now();
      for (const file of files) bindSourceFile(file);
    }
    console.log(`time ${((performance.now() - start) / 20).toFixed(2)}ms`);
    return;
  }
  const file = parse(path, text, named);
  const printer = new Printer(file);
  if (tree) {
    printer.printSymbols = false;
    printer.visitNode(file);
    for (const d of file.diagnostics) printer.diagnostic('diag', d);
  } else {
    bindSourceFile(file);
    printer.visitNode(file);
    for (const d of file.bindDiagnostics) {
      printer.diagnostic('diag', d);
      if (tables) for (const r of d.relatedInformation) printer.diagnostic('related', r);
    }
    if (resolve) printer.resolveIdentifiers();
    if (tables) printer.tables(file);
    if (flows) printer.flowGraph();
  }
  out.push('');
  process.stdout.write(out.join('\n'));
}

main();
