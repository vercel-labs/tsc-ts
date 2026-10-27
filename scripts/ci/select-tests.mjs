// Chooses the CI test units (units.mjs) a change needs, from the files it changes since the merge base.
//
// Usage: node scripts/ci/select-tests.mjs (--base <ref> [--head <ref>] | --full) [--out plan.json] [--github-output]
//
// Rules, per changed path (`rules` below):
// - CI configuration, root scripts, package manifests, the lockfile, upstream.json, the oracles, the package script
//   and any path no other rule covers select every unit (the full matrix).
// - packages/tsc-ts/src: the changed lines are classified with the TypeScript parser. Changes inside a function or
//   method select the test files that ran a function of that name in that file; changes to other runtime code at
//   the top level of a module select the test files that loaded the file; const enum changes select every tsc-ts
//   unit; changes to types, imported names, comments and whitespace select nothing (the build type-checks them).
//   Which test file loads and runs what comes from coverage-map.json (coverage-map.mjs). Names the map does not
//   have fall back to the test files that ran any function in the file.
// - Changed test files run. Changed test helpers run the test files that import them, and changed test data runs
//   the test files that refer to its directory.
// - apps/web runs the documentation job. Markdown, lint configuration, code generators and corpus tools select
//   nothing beyond the jobs that always run.
// A smoke set of short units always runs. When a change reaches runtime code of tsc-ts (or the full matrix runs),
// the native twins of the selected units run too, against native builds, in their own shards.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';
import { allUnits, durationOf, pack, root, shardCount } from './units.mjs';

// Short units that cover scanning, parsing, binding, checking, emit and the command line end to end.
export const smoke = [
  'packages/tsc-ts/tests/checker.test.mjs',
  'packages/tsc-ts/tests/projects.test.mjs',
  'packages/tsc-ts/tests/module-resolution.test.mjs',
  'packages/tsc-ts/tests/encoder.test.mjs',
  'packages/tsc-ts/tests/xxh3.test.mjs',
];

// Seconds of tests per shard, and the most shards a run uses.
const target = 330;
const maxShards = { fast: 16, full: 16 };
// Native test shards start after the native build, so they get less time each.
const nativeTarget = 150;
const maxNativeShards = 8;

// What a change to a path selects; the first matching rule applies.
const rules = [
  [/^apps\/web\//, 'docs'],
  [/(^|\/)[^/]+\.md$|^LICENSE$|^\.(oxfmtrc|oxlintrc)\.json$|^\.gitignore$/, 'nothing'],
  [/^packages\/[^/]+\/(package\.json|tsconfig\.json)$/, 'full'],
  [/^packages\/tsc-ts\/src\//, 'source'],
  [/^packages\/[^/]+\/tests\//, 'tests'],
  [/^packages\/tsc-ts\/scripts\/(pack|build-native|profile-match)\.mjs$/, 'full'],
  // Code generators (their output is checked in) and corpus and benchmark tools, which CI does not run.
  [/^packages\/tsc-ts\/scripts\//, 'nothing'],
  // CI configuration, root scripts and manifests, the lockfile, upstream.json, and anything else.
  [/./, 'full'],
];

const everyUnit = allUnits();
// Selection works on the Node units; native twins are added afterwards (`select`).
const units = everyUnit.filter((unit) => !unit.native);
const unitsOf = (file) => units.filter((unit) => unit.file === file).map((unit) => unit.id);
const tscTsUnits = () => units.filter((unit) => unit.id.startsWith('packages/tsc-ts/')).map((unit) => unit.id);

function git(...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function show(rev, path) {
  try {
    return git('show', `${rev}:${path}`);
  } catch {
    return undefined;
  }
}

/** Changed paths between two commits: `{ status, path, from }`, with renames split into their two paths. */
function changedFiles(base, head) {
  const out = git('diff', '--name-status', '-M', '--no-color', base, head).trim();
  const files = [];
  for (const line of out ? out.split('\n') : []) {
    const [status, a, b] = line.split('\t');
    if (status.startsWith('R') || status.startsWith('C')) {
      files.push({ status: 'D', path: a }, { status: 'A', path: b });
    } else files.push({ status: status[0], path: a });
  }
  return files;
}

/** Changed line numbers of one file: old-side lines and new-side lines. */
function changedLines(base, head, path) {
  const out = git('diff', '-U0', '--no-color', base, head, '--', path);
  const oldLines = new Set();
  const newLines = new Set();
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [o, oc, n, nc] = [
      Number(m[1]),
      m[2] === undefined ? 1 : Number(m[2]),
      Number(m[3]),
      m[4] === undefined ? 1 : Number(m[4]),
    ];
    for (let i = 0; i < oc; i++) oldLines.add(o + i);
    for (let i = 0; i < nc; i++) newLines.add(n + i);
  }
  return { oldLines, newLines };
}

let ts;
function typescript() {
  ts ??= createRequire(join(root, 'package.json'))('typescript');
  return ts;
}

/** The name V8 gives a function-like node, or undefined for anonymous ones. */
function functionName(node) {
  const ts = typescript();
  const text = (name) =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
  if (ts.isConstructorDeclaration(node)) return text(node.parent.name);
  if (node.name) return text(node.name);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    return text(parent.name);
  if (ts.isBinaryExpression(parent))
    return text(ts.isPropertyAccessExpression(parent.left) ? parent.left.name : parent.left);
  return undefined;
}

/**
 * Classifies the code on the given lines of a TypeScript source: `type` (types only), `import` (import and export
 * bindings), `body` (inside the named function or class), `top` (other module-level runtime code) or `const-enum`.
 * A module-level variable counts as the code that refers to it (`exported` results name the exported ones, whose
 * references in other files the caller classifies). With `references`, also classifies the code that refers to
 * those names.
 */
function classify(text, lines, references = []) {
  const ts = typescript();
  const found = [];
  if (lines.size === 0 && references.length === 0) return found;
  const file = ts.createSourceFile('file.ts', text, ts.ScriptTarget.Latest, true);
  const lineOf = (pos) => file.getLineAndCharacterOfPosition(pos).line + 1;
  const touches = (from, to) => {
    for (let line = from; line <= to; line++) if (lines.has(line)) return true;
    return false;
  };
  const hasModifier = (n, kind) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === kind);
  const isFunction = (n) =>
    (ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n)) &&
    n.body !== undefined;
  const isType = (n) =>
    ts.isTypeNode(n) ||
    ts.isInterfaceDeclaration(n) ||
    ts.isTypeAliasDeclaration(n) ||
    (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword) ||
    (ts.isImportDeclaration(n) && n.importClause?.isTypeOnly) ||
    (ts.isImportSpecifier(n) && n.isTypeOnly) ||
    (ts.isExportDeclaration(n) && n.isTypeOnly) ||
    (ts.isFunctionLike(n) && !ts.isFunctionTypeNode(n) && 'body' in n && n.body === undefined) ||
    hasModifier(n, ts.SyntaxKind.DeclareKeyword);
  /** Classifies a node from its ancestors, innermost first. */
  const classifyNode = (node) => {
    let inFunction = false;
    let inner;
    for (let n = node; n !== undefined; n = n.parent) {
      if (n.kind === ts.SyntaxKind.SyntaxList) continue;
      if (!inFunction && isType(n)) return { kind: 'type' };
      if (isFunction(n)) {
        const name = functionName(n);
        if (name !== undefined) return { kind: 'body', name };
        inFunction = true;
      } else if (ts.isClassLike(n)) {
        // Instance members and the declaration itself act through the constructor; static members run at load.
        const isStatic = inner && ts.isClassElement(inner) && hasModifier(inner, ts.SyntaxKind.StaticKeyword);
        if (n.name && !isStatic && !(inner && ts.isClassStaticBlockDeclaration(inner)) && !ts.isDecorator(inner ?? n))
          return { kind: 'body', name: n.name.text };
        return { kind: 'top' };
      } else if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
        // Bindings only matter through the code that uses them; a bare `import './x.js'` runs a module.
        return { kind: ts.isImportDeclaration(n) && n.importClause === undefined ? 'top' : 'import' };
      } else if (ts.isEnumDeclaration(n)) {
        return { kind: hasModifier(n, ts.SyntaxKind.ConstKeyword) ? 'const-enum' : 'top' };
      } else if (
        ts.isVariableStatement(n) &&
        ts.isSourceFile(n.parent) &&
        n.declarationList.declarations.every((d) => ts.isIdentifier(d.name))
      ) {
        const names = n.declarationList.declarations.map((d) => d.name.text);
        return { kind: hasModifier(n, ts.SyntaxKind.ExportKeyword) ? 'exported' : 'variable', names };
      }
      inner = n;
    }
    return { kind: 'top' };
  };
  const identifiers = [];
  const collect = (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node);
    ts.forEachChild(node, collect);
  };
  const variables = new Set();
  const add = (result) => {
    // Code in other files that imports an exported variable is found by the caller (importerUnits).
    if (result.kind === 'exported') found.push(result);
    else if (result.kind !== 'variable') return found.push(result);
    for (const name of result.names) {
      if (variables.has(name)) continue;
      variables.add(name);
      if (identifiers.length === 0) collect(file);
      for (const id of identifiers)
        if (id.text === name && !(ts.isVariableDeclaration(id.parent) && id.parent.name === id)) add(classifyNode(id));
    }
  };
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
    if (!touches(lineOf(node.getStart(file)), lineOf(node.getEnd()))) return;
    const children = node.getChildren(file);
    if (children.length === 0) add(classifyNode(node));
    else for (const child of children) visit(child);
  };
  visit(file);
  if (references.length > 0) add({ kind: 'variable', names: references });
  return found;
}

let coverage;
function coverageMap() {
  coverage ??= JSON.parse(readFileSync(join(root, 'scripts/ci/coverage-map.json'), 'utf8'));
  return coverage;
}

/** Whether a function name occurs in a source file at the commit coverage-map.json was made from. */
const mapTexts = new Map();
function existedAtMap(path, name) {
  if (!mapTexts.has(path)) mapTexts.set(path, show(coverageMap().commit, path));
  const text = mapTexts.get(path);
  return text !== undefined && new RegExp(`\\b${name.replace(/[^\w$]/g, '')}\\b`).test(text);
}

/** The coverage-map.json test indices that classified changes in one source file need, and a description. */
function testsFor(path, found) {
  const map = coverageMap();
  const entry = map.files[path];
  const tests = new Set();
  const why = [];
  if (entry === undefined) return { tests, why: ['not in the coverage map; it runs through the changes importing it'] };
  const strip = (name) => name.replace(/^(get|set) /, '').replace(/^.*\./, '');
  if (found.some((f) => f.kind === 'top')) {
    for (const t of entry.loaded) tests.add(t);
    why.push('module-level code');
  }
  const names = new Set(found.filter((f) => f.kind === 'body').map((f) => f.name));
  if (names.size > 0) {
    const byName = new Map();
    for (const [name, ids] of Object.entries(entry.functions)) {
      const key = strip(name);
      byName.set(key, [...(byName.get(key) ?? []), ...ids]);
    }
    for (const name of names) {
      // A function the map has no test for either existed and no test runs it, or is new since the map was made.
      const ids = byName.get(strip(name)) ?? (existedAtMap(path, name) ? [] : entry.ran);
      for (const t of ids) tests.add(t);
    }
    why.push(`functions ${[...names].slice(0, 5).join(', ')}${names.size > 5 ? ', ...' : ''}`);
  }
  return { tests, why };
}

/**
 * The files that import exported variables of `path` at `head`, with the classified code referring to them there;
 * undefined when a file re-exports from `path`, since its importers are then unknown.
 */
function importerChanges(head, path, names) {
  const out = [];
  const pattern = names.map((n) => `-e${n}`);
  let files;
  try {
    files = git('grep', '-l', '-w', ...pattern, head, '--', 'packages/tsc-ts/src')
      .trim()
      .split('\n');
  } catch {
    return out;
  }
  for (const line of files) {
    const file = line.slice(head.length + 1);
    if (file === path || !file.endsWith('.ts')) continue;
    const text = show(head, file);
    const imported = [];
    for (const m of text.matchAll(/(import|export)\s+(type\s+)?(\*|\{[^}]*\})\s*from\s*'(\.[^']+)'/g)) {
      if (posix.join(posix.dirname(file), m[4]).replace(/\.js$/, '.ts') !== path) continue;
      if (m[1] === 'export') return undefined;
      if (m[2]) continue;
      for (const name of names) if (new RegExp(`\\b${name}\\b`).test(m[3])) imported.push(name);
    }
    if (imported.length === 0) continue;
    const found = classify(text, new Set(), imported).map((f) => (f.kind === 'exported' ? { kind: 'top' } : f));
    out.push({ file, found });
  }
  return out;
}

/** The units a change to a tsc-ts source file needs, with the reason. */
function sourceUnits(base, head, change, reasons) {
  const { path } = change;
  if (!path.endsWith('.ts')) return reasons.full(`${path}: not a TypeScript source`);
  const { oldLines, newLines } = changedLines(base, head, path);
  const before = change.status === 'A' ? undefined : show(base, path);
  const after = change.status === 'D' ? undefined : show(head, path);
  const found = [
    ...(before === undefined ? [] : classify(before, change.status === 'D' ? allLines(before) : oldLines)),
    ...(after === undefined ? [] : classify(after, change.status === 'A' ? allLines(after) : newLines)),
  ];
  if (found.some((f) => f.kind === 'const-enum')) {
    reasons.native();
    return reasons.add(tscTsUnits(), `${path}: const enum changed`);
  }
  const parts = [{ file: path, found }];
  const exported = [...new Set(found.filter((f) => f.kind === 'exported').flatMap((f) => f.names))];
  if (exported.length > 0) {
    const importers = importerChanges(change.status === 'D' ? base : head, path, exported);
    if (importers === undefined) found.push({ kind: 'top' });
    else parts.push(...importers);
  }
  const map = coverageMap();
  const tests = new Set();
  const why = [];
  for (const part of parts) {
    const result = testsFor(part.file, part.found);
    for (const t of result.tests) tests.add(t);
    if (result.why.length)
      why.push(part.file === path ? result.why.join('; ') : `${posix.basename(part.file)}: ${result.why.join('; ')}`);
  }
  if (why.length === 0) return reasons.note(`${path}: types, comments or whitespace only`);
  reasons.native();
  const files = [...tests].map((t) => map.tests[t]);
  reasons.add(
    files.flatMap((file) => unitsOf(file)),
    `${path} (${why.join('; ')}): ${files.map((f) => posix.basename(f)).join(', ') || 'no test runs it'}`,
  );
}

function allLines(text) {
  return new Set(Array.from({ length: text.split('\n').length }, (_, i) => i + 1));
}

/** Test files of a package's tests/ directory and the local modules each imports, transitively. */
function testImports(pkg) {
  const dir = join(root, 'packages', pkg, 'tests');
  const direct = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    direct.set(name, { text, imports: [...text.matchAll(/from\s+['"]\.\/([\w.-]+\.mjs)['"]/g)].map((m) => m[1]) });
  }
  const closure = (name, seen = new Set()) => {
    if (seen.has(name) || !direct.has(name)) return seen;
    seen.add(name);
    for (const i of direct.get(name).imports) closure(i, seen);
    return seen;
  };
  return [...direct.keys()]
    .filter((n) => n.endsWith('.test.mjs'))
    .map((n) => {
      const modules = closure(n);
      return {
        file: `packages/${pkg}/tests/${n}`,
        modules,
        text: [...modules].map((m) => direct.get(m).text).join('\n'),
      };
    });
}

/** The units a change below packages/<pkg>/tests needs. */
function testUnits(change, reasons) {
  const [, pkg, rest] = /^packages\/([^/]+)\/tests\/(.*)$/.exec(change.path);
  if (rest.endsWith('.test.mjs')) {
    return reasons.add(unitsOf(change.path), `${change.path}: changed test`);
  }
  const tests = testImports(pkg);
  if (rest.endsWith('.mjs') && !rest.includes('/')) {
    const users = tests.filter((t) => t.modules.has(rest)).map((t) => t.file);
    return reasons.add(users.flatMap(unitsOf), `${change.path}: helper of ${users.length} test files`);
  }
  // Test data: the test files whose sources name its top-level directory or file.
  const top = rest.split('/')[0];
  const users = tests.filter((t) => t.text.includes(top)).map((t) => t.file);
  reasons.add(users.flatMap(unitsOf), `${change.path}: data of ${users.map((f) => posix.basename(f)).join(', ')}`);
}

/** Builds the plan for a list of changes; with `full`, for every unit. */
export function select(base, head, changes, full = false) {
  const chosen = new Set(smoke);
  const notes = full ? ['full matrix requested'] : [];
  let docs = false;
  // Whether the change touches runtime code of tsc-ts, which the native build compiles.
  let native = full;
  const reasons = {
    native() {
      native = true;
    },
    add(ids, why) {
      for (const id of ids) chosen.add(id);
      notes.push(why);
    },
    note(why) {
      notes.push(why);
    },
    full(why) {
      full = true;
      notes.push(`${why}: full matrix`);
    },
  };
  for (const change of changes) {
    const { path } = change;
    const rule = rules.find(([re]) => re.test(path))[1];
    if (rule === 'docs') {
      docs = true;
      notes.push(`${path}: documentation`);
    } else if (rule === 'nothing') notes.push(`${path}: no tests`);
    else if (rule === 'source') sourceUnits(base, head, change, reasons);
    else if (rule === 'tests') testUnits(change, reasons);
    else reasons.full(path);
  }
  if (full) native = true;
  const ids = units.map((u) => u.id).filter((id) => full || chosen.has(id));
  const count = shardCount(ids, target, full ? maxShards.full : maxShards.fast);
  const shards = pack(ids, count).map((s, i) => ({ shard: `${i + 1}/${count}`, seconds: Math.round(s.seconds) }));
  // The native twins of the selected units, when the change reaches the native build.
  const selected = new Set(ids);
  const nativeIds = native
    ? everyUnit.filter((u) => u.native && selected.has(u.id.slice('native:'.length))).map((u) => u.id)
    : [];
  const nativeCount = nativeIds.length === 0 ? 0 : shardCount(nativeIds, nativeTarget, maxNativeShards);
  const nativeShards = pack(nativeIds, nativeCount).map((s, i) => ({
    shard: `${i + 1}/${nativeCount}`,
    seconds: Math.round(s.seconds),
  }));
  if (nativeIds.length > 0) notes.push(`runtime code changed: ${nativeIds.length} native units`);
  return { full, docs: docs || full, units: [...ids, ...nativeIds], shards, nativeShards, notes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const head = option('--head') ?? 'HEAD';
  let plan;
  if (args.includes('--full') || option('--base') === undefined) plan = select(head, head, [], true);
  else {
    try {
      const base = git('merge-base', option('--base'), head).trim();
      plan = select(base, head, changedFiles(base, head));
    } catch (error) {
      // A selection that cannot be computed runs everything.
      console.log(`selection failed, running the full matrix: ${error.stack}`);
      plan = select(head, head, [], true);
    }
  }
  const total = plan.units.reduce((sum, id) => sum + durationOf(id), 0);
  console.log(
    `${plan.full ? 'full matrix' : 'selected'}: ${plan.units.length} of ${everyUnit.length} units, ` +
      `${Math.round(total / 60)} min of tests in ${plan.shards.length} shards and ${plan.nativeShards.length} native ` +
      `shards; documentation ${plan.docs ? 'yes' : 'no'}`,
  );
  for (const note of plan.notes) console.log('  ' + note);
  const out = option('--out');
  if (out) writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
  if (args.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `plan=${JSON.stringify({ units: plan.units })}\nshards=${JSON.stringify(plan.shards.map((s) => s.shard))}\n` +
        `native-shards=${JSON.stringify(plan.nativeShards.map((s) => s.shard))}\n` +
        `native=${plan.nativeShards.length > 0}\ndocs=${plan.docs}\nfull=${plan.full}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Test selection\n\n${plan.full ? 'Full matrix' : 'Selected'}: ${plan.units.length} of ${everyUnit.length} ` +
        `units in ${plan.shards.length} shards and ${plan.nativeShards.length} native shards.\n\n` +
        `${plan.notes.map((n) => `- ${n}`).join('\n')}\n`,
    );
}
