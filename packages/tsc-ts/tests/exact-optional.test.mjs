// Compiles projects through tsgo (packages/tsgo/dist/tsgo) and tsc-ts (the Node build, or TSC_TS_BIN)
// with exactOptionalPropertyTypes and the other strict options, and compares stdout, stderr and exit
// status: the messages for undefined written to optional properties, type argument constraints, and
// the types printed in the messages, with the missing properties of widened object literal unions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const root = resolve(import.meta.dirname, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const skip = (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo') || tscTsMissing;

/**
 * TypeScript 7.1's stdout, by project name and variant, for the projects whose printed unions of widened
 * object literals order their missing properties as 7.1 does and tsc 7.0.2 did not (7.0.2 kept one
 * missing property per name). These compare with it instead of tsgo's stdout; stderr and the exit
 * status still compare with tsgo.
 */
const typeScript71 = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/typescript-7.1/exact-optional.json'), 'utf8'),
);

const base = { target: 'ES2025', module: 'NodeNext', strict: true, noEmit: true, types: [], pretty: false };

/** Option combinations every project runs with, on top of `base` and the project's own options. */
const variants = [
  { exactOptionalPropertyTypes: true },
  {
    exactOptionalPropertyTypes: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    noImplicitReturns: true,
  },
  {},
];

/**
 * Projects as `[name, file name, source, options]`, or `[name, files, options]` with the files by name
 * in program order.
 * @type {([string, string, string, Record<string, unknown>?] | [string, Record<string, string>, Record<string, unknown>?])[]}
 */
const projects = [
  [
    'undefined assigned to an optional property',
    'a.ts',
    'interface A { p?: string; q?: number }\ndeclare const a: A;\ndeclare const v: string | undefined;\n' +
      'a.p = v;\na["q"] = v === undefined ? undefined : 1;\na.q = 1;\nexport {};\n',
  ],
  [
    'undefined in an object literal property, a JSX attribute and a JSX child',
    'a.tsx',
    'interface Provider { getId(): string; getGroupId?: () => number }\n' +
      'interface Options { readonly provider?: Provider; readonly label?: string }\n' +
      'declare const b: boolean;\ndeclare const g: (() => number) | undefined;\n' +
      'export function make(): Options {\n' +
      "  return { label: 'x', provider: b ? { getId: () => 'a', getGroupId: g } : undefined };\n}\n" +
      'declare global { namespace JSX { interface Element {} interface IntrinsicElements {} } }\n' +
      'declare function Comp(props: { provider?: Provider }): JSX.Element;\n' +
      "export const e = <Comp provider={b ? { getId: () => 'a', getGroupId: g } : undefined} />;\n" +
      'declare function List(props: { children: [Provider?, Provider?] }): JSX.Element;\n' +
      "export const l = <List>{b ? { getId: () => 'a', getGroupId: g } : undefined}{undefined}</List>;\n",
    { jsx: 'preserve' },
  ],
  [
    'object literal assigned to a discriminated union or undefined',
    'a.ts',
    'interface IMarkdownString { value: string; isTrusted?: boolean }\n' +
      'declare class MarkdownString { value: string; isTrusted: boolean | undefined }\n' +
      "type P = { kind: 'a'; content: IMarkdownString } | { kind: 'b'; x: number };\n" +
      "type Q = { kind: 'a'; content: { v: string } } | { kind: 'b'; x: number } | null;\n" +
      'declare const m: MarkdownString;\ndeclare const n: { v: number };\n' +
      "export const h: P | undefined = { kind: 'a', content: m };\n" +
      "export function f(): P | undefined {\n  return { kind: 'a', content: m };\n}\n" +
      "export const q: Q | undefined = { kind: 'a', content: n };\n",
  ],
  [
    'object literal returned into a discriminated union or undefined with noUncheckedIndexedAccess',
    'a.ts',
    "type Target = { kind: 'a'; value: string } | { kind: 'b'; count: number };\n" +
      'declare const parts: string[];\n' +
      "export function f(i: number): Target | undefined {\n  return { kind: 'a', value: parts[i] };\n}\n" +
      'export function g(i: number): Target | null | undefined {\n' +
      "  const s = parts[i];\n  return { kind: 'a', value: s };\n}\n" +
      'declare const o: { p?: string };\nexport const p: { p?: string } = { p: parts[0] };\n' +
      'export const q: typeof o = o;\n',
    { noUncheckedIndexedAccess: true },
  ],
  [
    'non-null assertion in an optional chain',
    'a.ts',
    'declare const d: { exceptions: { frames: number[] }[] } | undefined;\ndeclare const i: number;\n' +
      'export const x = d?.exceptions[i]!.frames.map((f) => f + 1);\nexport const y: number[] = x;\n' +
      'export const z: number[] = d?.exceptions[i]!.frames;\n' +
      'export const w: { frames?: number[] } = { frames: d?.exceptions[i]!.frames };\n',
  ],
  [
    'type arguments that do not satisfy their constraints',
    'a.ts',
    'interface Base { configuration?: { delay: number } }\n' +
      'export declare class Model implements Base { configuration: { delay: number } | undefined }\n' +
      'interface Manager<S extends Base, U extends Base> { s: S; u: U }\n' +
      'export declare const m: Manager<Model, Model>;\nexport declare const n: Manager<Model, string>;\n' +
      'export declare const o: Manager<string, Model>;\n',
  ],
  [
    'object literal widened once for the members of a union',
    'a.ts',
    'interface RouterConfig {\n' +
      '  location?: { pathname: string; query?: Record<string, string>; state?: unknown };\n' +
      '  route?: string;\n  routes?: string[];\n}\n' +
      'declare function render(o: { initialRouterConfig?: RouterConfig }): void;\n' +
      'function make({ pathname, route, routes, query = {}, state }: {\n' +
      '  pathname: string;\n  query?: Record<string, string | number | string[]>;\n' +
      '  route?: string;\n  routes?: string[];\n  state?: Record<string, unknown>;\n}) {\n' +
      '  return {\n    initialRouterConfig: {\n' +
      '      location: { pathname, query, ...(state ? { state } : {}) },\n' +
      '      ...(route ? { route } : { routes }),\n    },\n  };\n}\n' +
      "render(make({ pathname: '/x' }));\n",
  ],
  [
    'object types with index signatures in a truncated type',
    'a.ts',
    'type Tag = { key: string };\ntype TagCollection = Record<string, Tag>;\n' +
      'declare const arrayAttributes: TagCollection;\ndeclare const booleanAttributes: TagCollection;\n' +
      'declare const numberAttributes: TagCollection;\ndeclare const stringAttributes: TagCollection;\n' +
      'interface BuilderProps {\n  initialQueryFromTheSearchBar: string;\n  searchSource: string;\n' +
      '  onSearch: (q: string) => void;\n  arrayAttributes: TagCollection;\n  booleanAttributes: TagCollection;\n' +
      '  numberAttributes: TagCollection;\n  stringAttributes: TagCollection;\n  caseInsensitive?: boolean;\n}\n' +
      'declare const caseInsensitive: boolean | undefined;\n' +
      'const a = { ...arrayAttributes };\nconst b = { ...booleanAttributes };\n' +
      'const n = { ...numberAttributes };\nconst s = { ...stringAttributes };\n' +
      'export const props: BuilderProps = {\n' +
      "  initialQueryFromTheSearchBar: 'q',\n  searchSource: 'ourlogs',\n  onSearch: (_q: string) => {},\n" +
      '  arrayAttributes: a,\n  booleanAttributes: b,\n  numberAttributes: n,\n  stringAttributes: s,\n' +
      '  caseInsensitive,\n};\n',
  ],
  [
    'missing properties of unions in the body of a function with a return type',
    'a.ts',
    'declare const items: { kind: number; value: string; audience?: string[] }[];\n' +
      'export const first = items.map((_item): number => {\n' +
      '  const parts = items.map(part => {\n' +
      "    if (part.kind === 0) return { type: 'text', value: part.value, audience: part.audience };\n" +
      "    return { type: 'other', value: part.value };\n  });\n  return parts.length;\n});\n" +
      'export function later() {\n  const content = items.map(item => {\n' +
      "    if (item.kind === 0) return { kind: 'text', value: item.value, audience: item.audience };\n" +
      "    if (item.kind === 1) return { kind: 'tsx', value: item.value };\n" +
      "    return { kind: 'data', value: { data: item.value }, audience: item.audience };\n  });\n" +
      '  const n: number = content;\n  return n;\n}\n',
  ],
  [
    'missing properties of unions in the body of a function without a return type',
    'a.ts',
    'declare const items: { kind: number; value: string; audience?: string[] }[];\n' +
      'export const first = items.map((_item) => {\n' +
      '  const parts = items.map(part => {\n' +
      "    if (part.kind === 0) return { type: 'text', value: part.value, audience: part.audience };\n" +
      "    return { type: 'other', value: part.value };\n  });\n  return parts.length;\n});\n" +
      'export function later() {\n  const content = items.map(item => {\n' +
      "    if (item.kind === 0) return { kind: 'text', value: item.value, audience: item.audience };\n" +
      "    if (item.kind === 1) return { kind: 'tsx', value: item.value };\n" +
      "    return { kind: 'data', value: { data: item.value }, audience: item.audience };\n  });\n" +
      '  const n: number = content;\n  return n;\n}\n',
  ],
  [
    'missing properties of unions in for...of statements and in the objects of method calls',
    'a.ts',
    'declare function use(x: unknown): void;\n' +
      "for (const e of [{ key: 'x' }, { key: 'Tab', ctrlKey: true }]) use(e);\n" +
      "[{ key: 'P', metaKey: true }, { key: 'b' }].forEach(init => use(init));\n" +
      "export const events = [{ key: 'P', altKey: true }, { key: 'b' }].map(init => init.key);\n" +
      "const r = [{ key: 'r' }, { key: 'P', ctrlKey: true, metaKey: true, altKey: true }];\n" +
      'export const n: number = r;\n',
  ],
  [
    'object literals of the same type in a union',
    'a.ts',
    'interface M { maxInputTokens: number; maxContextWindowTokens?: number; configurationSchema?: string }\n' +
      'declare function createModel(x?: Partial<M>): M;\n' +
      'interface P { capture?: { prompts?: boolean; responses?: boolean } }\n' +
      'export const results = [\n  { maxInputTokens: 100, maxContextWindowTokens: 100 },\n  { maxInputTokens: 50 },\n' +
      '  { maxInputTokens: 0, maxContextWindowTokens: 0 },\n' +
      '].map(limits => createModel({ ...limits, configurationSchema: undefined }));\n' +
      'for (const r of [\n  { policy: { capture: { prompts: false } } },\n  { policy: { capture: { responses: false } } },\n' +
      '  { policy: { capture: { prompts: true } } },\n] satisfies { policy: P }[]) {\n  const n: number = r.policy;\n  createModel({ maxInputTokens: n });\n}\n',
  ],
  [
    'as const literals and binding patterns in for...of statements',
    'a.ts',
    'declare function use(...x: unknown[]): void;\n' +
      "for (const [n, v] of [['a', { k: 1, branch: 'x' }], ['b', { k: 2 }]] as const) use(n, v);\n" +
      "for (const v of [{ k: 1, tag: 'x' }, { k: 2 }] as const) use(v);\n" +
      "for (const { v } of [{ v: { k: 1, mark: 'x' } }, { v: { k: 2 } }]) use(v);\n" +
      "for (const [n, v] of [['a', { k: 1, flag: 'x' }], ['b', { k: 2 }]]) use(n, v);\n" +
      "const r = [{ k: 1 }, { k: 2, branch: 'y', tag: 'y', mark: 'y', flag: 'y' }];\n" +
      'export const q: number = r;\n',
  ],
  [
    'object literals in spread array literals',
    'a.ts',
    'declare const local: boolean;\n' +
      "export const properties = [\n  { gallery: true },\n  { version: '1.0.0' },\n" +
      '  ...(local ? [{ localOnly: true }, { localOnly: false }] : []),\n];\n' +
      'const changes = [{ gallery: true }, { localOnly: true, gallery: false }];\n' +
      'export const n: number = changes;\n',
  ],
  [
    'missing properties across the files that tsgo checks with one checker',
    {
      'a.ts': "declare const c: boolean;\nexport const first = c ? { k: 1 } : { k: 2, extra: 'a' };\n",
      'b.ts': 'export const b = 1;\n',
      'c.ts': 'export const c = 1;\n',
      'd.ts': 'export const d = 1;\n',
      'e.ts':
        "declare const c: boolean;\nconst late = c ? { k: 1 } : { k: 2, extra: 'b' };\nexport const n: number = late;\n",
      'f.ts':
        "declare const c: boolean;\nconst late = c ? { k: 1 } : { k: 2, extra: 'b' };\nexport const n: number = late;\n",
    },
  ],
  [
    'object literals of the same type through members of an imported and a local enum',
    {
      'e.ts': 'export enum E { A, B, C }\n',
      'a.ts':
        "import { E } from './e';\nenum L { X, Y, Z }\n" +
        'function imported(x: number) {\n' +
        "  if (x === 0) return { before: 'a', after: 'b', action: { kind: E.C, text: ' ' } };\n" +
        "  if (x === 1) return { previous: 'c', before: 'd', action: { kind: E.B } };\n" +
        "  return { before: 'e', after: 'f', action: { kind: E.A, text: '-' } };\n}\n" +
        'function local(x: number) {\n' +
        "  if (x === 0) return { first: 'a', second: 'b', mode: L.Z };\n" +
        "  if (x === 1) return { other: 'c', first: 'd', mode: L.Y };\n" +
        "  return { first: 'e', second: 'f', mode: L.X };\n}\n" +
        'export const m: number = imported(0);\nexport const n: number = local(0);\n',
    },
  ],
];

/** Compiles the project in a fresh directory; returns the output and exit status. */
function run(command, files) {
  const cwd = tempDir('tsc-ts-exact-optional-');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(cwd, path), content);
  const env = { PATH: process.env.PATH ?? '', TSC_TS_BUNDLED_LIBS: bundledLibs, NO_COLOR: '1' };
  return new Promise((done) => {
    execFile(command[0], [...command.slice(1), '-p', '.'], { cwd, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      done({ stdout, stderr, status });
    });
  });
}

test('diagnostics with exactOptionalPropertyTypes match tsgo', { skip, timeout: 300_000 }, async (t) => {
  const failures = [];
  let runs = 0;
  for (const [name, fileOrFiles, ...rest] of projects) {
    const sources = typeof fileOrFiles === 'string' ? { [fileOrFiles]: rest.shift() } : fileOrFiles;
    const options = rest[0] ?? {};
    for (const variant of variants) {
      const compilerOptions = { ...base, ...options, ...variant };
      const files = {
        ...sources,
        'tsconfig.json': JSON.stringify({ compilerOptions, files: Object.keys(sources) }),
      };
      const [expected, actual] = await Promise.all([run([tsgo], files), run(tscTs, files)]);
      runs++;
      // Each project has errors in the variants with exactOptionalPropertyTypes.
      if (variant.exactOptionalPropertyTypes) assert.notEqual(expected.stdout, '', `${name}: tsgo reports errors`);
      const label = `${name} ${JSON.stringify(variant)}`;
      const expectedStdout = typeScript71[label] ?? expected.stdout;
      if (expectedStdout !== actual.stdout)
        failures.push(`${label}: stdout\n--- expected\n${expectedStdout}--- ours\n${actual.stdout}`);
      if (expected.stderr !== actual.stderr) failures.push(`${label}: stderr ${actual.stderr}`);
      if (expected.status !== actual.status)
        failures.push(`${label}: status tsgo ${expected.status}, ours ${actual.status}`);
    }
  }
  t.diagnostic(`${runs - failures.length}/${runs} runs match`);
  assert.deepEqual(failures, []);
});
