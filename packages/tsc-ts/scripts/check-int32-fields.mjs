// Checks the LLVM IR of a native build (dist/main.ll, which scriptc keeps beside the executable) for the class layouts
// the checker's speed depends on: scriptc stores the number fields of Node, Type and Symbol (kinds, flags, positions,
// ids) as 32-bit integers when it proves every write an int32. A field falls back to a double when one write isn't
// provably an int32 (`a + b.length` without `| 0`), and every number field of every class that reaches dynamic code
// does when the program makes a dynamic store that could name any property (a computed-key store into an untyped
// object, a DataView over a buffer of a union type). The same layouts keep the fields the public API's node types
// declare as fields of their own: a native build copies the stored fields of a node into a record when API code
// narrows one (`node as StringLiteralLike`), so a field behind an accessor is missing there.
// Usage: node scripts/check-int32-fields.mjs [dist/main.ll]
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** The classes whose number fields must be i32. */
export const int32Classes = ['Node', 'Type', 'Symbol'];

/** The fields of a class that the public API's types declare, which a conversion of a node to those types reads. */
export const storedFields = new Map([['Node', ['kind', 'flags', 'pos', 'end', 'parent']]]);

/** The fields the struct type of `line` stores, from the class comment scriptc writes after it. */
function fieldsOf(line) {
  const comment = /}\s*;\s*class\s+%\S+\s*(?:\([^)]*\)\s*)?\{([^}]*)\}/.exec(line);
  return comment === null
    ? []
    : comment[1]
        .split(';')
        .map((field) => field.trim())
        .filter((field) => field !== '');
}

/**
 * The problems with the struct types of `classes` in IR text read line by line: a class with a double field, a class
 * that keeps a stored field behind an accessor, or a class not found.
 */
export async function checkInt32Fields(lines, classes = int32Classes) {
  const found = new Map();
  const pattern = /^%\S+ = type \{([^}]*)\} ; class %m\d+\.(\w+) /;
  for await (const line of lines) {
    if (!line.startsWith('%')) continue;
    const match = pattern.exec(line);
    if (match === null || !classes.includes(match[2]) || found.has(match[2])) continue;
    found.set(match[2], line);
  }
  const problems = [];
  for (const name of classes) {
    const line = found.get(name);
    if (line === undefined) {
      problems.push(`no struct type for class ${name}`);
      continue;
    }
    if (/\bdouble\b/.test(pattern.exec(line)[1]))
      problems.push(`class ${name} stores number fields as doubles: ${line}`);
    const fields = fieldsOf(line);
    const missing = (storedFields.get(name) ?? []).filter((field) => !fields.includes(field));
    if (missing.length > 0) problems.push(`class ${name} does not store ${missing.join(', ')}: ${line}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2] ?? 'dist/main.ll';
  const problems = await checkInt32Fields(createInterface({ input: createReadStream(path), crlfDelay: Infinity }));
  if (problems.length > 0) {
    console.error(`${path}:\n  ${problems.join('\n  ')}`);
    console.error(
      'A write scriptc cannot prove is an int32, or a dynamic store, keeps these fields from being 32-bit integers; a field kept behind an accessor is not stored. See scripts/check-int32-fields.mjs.',
    );
    process.exit(1);
  }
}
