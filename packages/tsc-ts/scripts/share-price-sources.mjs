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
  applyPatch(readFileSync(patchPath, 'utf8'), copy);
  return relative(root, join(copy, 'main.ts'));
}

/**
 * Applies the unified diff `patch` to the files under `dir`. Each hunk is checked against the file it edits, so a
 * patch that no longer applies to the sources fails the build instead of compiling something else.
 */
function applyPatch(patch, dir) {
  for (const section of patch.split(/^(?=diff --git )/m)) {
    if (section === '') continue;
    const target = /^\+\+\+ b\/(.+)$/m.exec(section);
    if (target === null) throw new Error(`share-price-sources.patch: a section names no file: ${section.split('\n')[0]}`);
    const file = join(dir, target[1]);
    const lines = section.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const original = readFileSync(file, 'utf8').split('\n');
    const updated = [];
    let at = 0;
    let index = 0;
    while (index < lines.length && !lines[index].startsWith('@@ ')) index++;
    while (index < lines.length) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[index]);
      if (header === null) throw new Error(`${target[1]}: expected a hunk at "${lines[index]}"`);
      const start = Number(header[1]) - 1;
      if (start < at) throw new Error(`${target[1]}: the hunk at "${lines[index]}" comes before the one before it`);
      while (at < start) updated.push(original[at++]);
      for (index++; index < lines.length && !lines[index].startsWith('@@ '); index++) {
        const line = lines[index];
        if (line.startsWith('\\')) continue;
        const text = line.slice(1);
        if (line.startsWith(' ') || line.startsWith('-')) {
          if (original[at] !== text)
            throw new Error(`${target[1]} line ${at + 1}: the patch expects "${text}"`);
          if (line.startsWith(' ')) updated.push(original[at]);
          at++;
        } else if (line.startsWith('+')) updated.push(text);
        else throw new Error(`${target[1]}: cannot read the patch line "${line}"`);
      }
    }
    while (at < original.length) updated.push(original[at++]);
    writeFileSync(file, updated.join('\n'));
  }
}
