// Shared by the binder test and scripts/bind-corpus.mjs: building the bind driver and
// comparing it with the bind oracle.
import { join, resolve } from 'node:path';
import { repo, run } from './parser-cases.mjs';
import { compileSources } from './temp.mjs';

export const bindOracle = resolve(repo, 'packages/tsgo/dist/bind-oracle');

/** Compiles the bind driver with tsc and returns the command that runs it under Node. */
export function buildBindDriver() {
  const out = compileSources('tsc-ts-bind-', ['drivers/bind.ts']);
  return [process.execPath, '--stack-size=16000', join(out, 'drivers/bind.js')];
}

/** The first differing line of two outputs, or undefined if they're equal. */
export function firstDifference(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) return { line: i, expected: a[i], actual: b[i] };
  return undefined;
}

/**
 * tsgo's output without the flow nodes of the identifiers the driver lists on a `plain-identifiers`
 * line: tsc-ts keeps a flow node only on identifiers that can be read as references. The flow
 * nodes left are renumbered in the order the output first references them, as both drivers
 * number them, and the ones only those identifiers referenced are dropped.
 */
/**
 * The symbol name of a pattern ambient module with import attributes ends in a node id that keeps it unique
 * (`"*.ext"pattern@<id>`): tsgo numbers nodes on first use, tsc-ts when it creates them, so the ids differ. The
 * names are internal; compare them without the id.
 */
export function withoutPatternModuleIds(text) {
  return text.replace(/"pattern@\d+/g, '"pattern@');
}

export function withoutPlainIdentifierFlows(expected, actual) {
  const actualLines = actual.split('\n');
  const at = actualLines.findIndex((line) => line.startsWith('plain-identifiers '));
  if (at < 0) return { expected, actual };
  const plain = new Set(actualLines[at].split(' ').slice(1));
  actualLines.splice(at, 1);
  const lines = expected.split('\n').filter((line) => !(line.startsWith('flowof ') && plain.has(line.split(' ')[1])));
  const flowLines = new Map();
  for (const line of lines) {
    const match = /^flow @(\d+) (.*)$/.exec(line);
    if (match) flowLines.set(match[1], match[2]);
  }
  const ids = new Map();
  const order = [];
  const renumber = (text) =>
    text.replace(/@(\d+)/g, (_, id) => {
      if (!ids.has(id)) {
        ids.set(id, ids.size);
        order.push(id);
      }
      return '@' + ids.get(id);
    });
  const result = [];
  let flowsAt = -1;
  for (const line of lines) {
    if (line.startsWith('flowof ')) result.push(renumber(line));
    else if (line.startsWith('flow @')) {
      if (flowsAt < 0) flowsAt = result.length;
    } else result.push(line);
  }
  const flows = [];
  for (let i = 0; i < order.length; i++) flows.push(`flow @${i} ${renumber(flowLines.get(order[i]))}`);
  if (flowsAt >= 0) result.splice(flowsAt, 0, ...flows);
  return { expected: result.join('\n'), actual: actualLines.join('\n') };
}

/**
 * Compares binding of one file with `flags`. When the outputs differ, also compares the
 * parse trees, so binder differences can be told from parser ones.
 */
export async function compareBinding(command, path, flags) {
  const [expected, actual] = await Promise.all([run([bindOracle, path, ...flags]), run([...command, path, ...flags])]);
  const ok = expected.code === 0 && actual.code === 0;
  const outputs = withoutPlainIdentifierFlows(
    withoutPatternModuleIds(expected.stdout.toString()),
    withoutPatternModuleIds(actual.stdout.toString()),
  );
  const difference = ok ? firstDifference(outputs.expected, outputs.actual) : undefined;
  if (ok && difference === undefined) return { match: true };
  const named = flags.includes('--named') ? ['--named'] : [];
  const [expectedTree, actualTree] = await Promise.all([
    run([bindOracle, path, '--tree', ...named]),
    run([...command, path, '--tree', ...named]),
  ]);
  const parserDiffers =
    expectedTree.code !== 0 ||
    actualTree.code !== 0 ||
    firstDifference(expectedTree.stdout.toString(), actualTree.stdout.toString()) !== undefined;
  return { match: false, parserDiffers, difference, error: actual.stderr.slice(0, 2000) };
}
