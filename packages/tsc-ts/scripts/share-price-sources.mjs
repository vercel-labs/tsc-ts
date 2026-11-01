// The sources a `--with-share-price` build compiles: a copy of src/ with share-price-sources.patch applied. The
// patch adds the price log to the checkers, the records `TSC_TS_SHARE_PRICE` writes and the counters its summary
// adds, along with the workers that price their work. A build without the flag compiles src/ itself, which holds
// none of that, so the executable it writes is the one the same sources build without this script.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const patchPath = join(import.meta.dirname, 'share-price-sources.patch');

/** Writes the sources a price build compiles under `out`, and returns the entry file to build, relative to `root`. */
export function writeSharePriceSources(root, out) {
  const copy = join(out, 'src');
  rmSync(out, { recursive: true, force: true });
  cpSync(join(root, 'src'), copy, { recursive: true });
  applyUnifiedDiff(readFileSync(patchPath, 'utf8'), copy);
  return relative(root, join(copy, 'main.ts'));
}

/**
 * Applies the unified diff `patch` to the files under `dir`. Each hunk is checked against the file it edits, so a
 * patch that no longer applies to the sources fails the build instead of compiling something else. A hunk whose
 * line numbers drifted finds its lines by their content, the way `patch` does, and a hunk whose lines are gone
 * fails the build.
 */
export function applyUnifiedDiff(patch, dir) {
  for (const section of patch.split(/^(?=diff --git )/m)) {
    if (section === '') continue;
    const target = /^\+\+\+ b\/(.+)$/m.exec(section);
    if (target === null)
      throw new Error(`share-price-sources.patch: a section names no file: ${section.split('\n')[0]}`);
    const name = target[1];
    const file = join(dir, name);
    const lines = section.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const original = readFileSync(file, 'utf8').split('\n');
    const updated = [];
    let at = 0;
    let index = 0;
    while (index < lines.length && !lines[index].startsWith('@@ ')) index++;
    while (index < lines.length) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[index]);
      if (header === null) throw new Error(`${name}: expected a hunk at "${lines[index]}"`);
      const declared = Number(header[1]) - 1;
      const body = [];
      for (index++; index < lines.length && !lines[index].startsWith('@@ '); index++) {
        const line = lines[index];
        if (line.startsWith('\\')) continue;
        if (line.startsWith(' ') || line.startsWith('-'))
          body.push({ added: false, kept: line[0] === ' ', text: line.slice(1) });
        else if (line.startsWith('+')) body.push({ added: true, kept: false, text: line.slice(1) });
        else throw new Error(`${name}: cannot read the patch line "${line}"`);
      }
      // The hunk's own lines: the ones it keeps and the ones it removes, which must match the file where it goes.
      const expected = body.filter((line) => !line.added).map((line) => line.text);
      const found = locate(original, expected, declared, at);
      if (found < 0)
        throw new Error(
          `${name}: the hunk at "${header[0]}" does not apply: no ${expected.length} lines there read "${expected[0] ?? ''}"`,
        );
      while (at < found) updated.push(original[at++]);
      for (const line of body) {
        if (line.added) updated.push(line.text);
        else {
          if (original[at] !== line.text) throw new Error(`${name} line ${at + 1}: the patch expects "${line.text}"`);
          if (line.kept) updated.push(original[at]);
          at++;
        }
      }
    }
    while (at < original.length) updated.push(original[at++]);
    writeFileSync(file, updated.join('\n'));
  }
}

/**
 * Where the hunk's `expected` lines go in `lines`: its declared line `start` when they are there, otherwise the
 * one place they read the same, nearest to where the patch says they are. -1 when no place matches.
 */
function locate(lines, expected, start, after) {
  if (start >= after && matchesAt(lines, expected, start)) return start;
  let best = -1;
  for (let i = Math.max(0, after); i + expected.length <= lines.length; i++) {
    if (!matchesAt(lines, expected, i)) continue;
    if (best < 0 || Math.abs(i - start) < Math.abs(best - start)) best = i;
  }
  return best;
}

/** Whether `expected` reads the same as `lines` from `at`. */
function matchesAt(lines, expected, at) {
  if (at < 0 || at + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) if (lines[at + i] !== expected[i]) return false;
  return true;
}
