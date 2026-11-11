import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript-5.9';

const root = path.resolve(import.meta.dirname, '../content/docs');
const defaults = {
  strict: true,
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ['ES2022', 'DOM', 'DOM.Iterable'],
};

async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(filename);
    else if (filename.endsWith('.mdx')) yield filename;
  }
}

let checked = 0;
let failures = 0;
for await (const filename of files(root)) {
  const text = await readFile(filename, 'utf8');
  for (const match of text.matchAll(/^```(ts|tsx)\b[^\n]*\n([\s\S]*?)^```/gm)) {
    const line = text.slice(0, match.index).split('\n').length;
    const location = `${path.relative(root, filename)}:${line}`;
    const rawOptions = { ...defaults, ...(match[1] === 'tsx' ? { jsx: 'preserve' } : {}) };
    for (const directive of match[2].matchAll(/^\/\/ @option: (\w+)=(.+)$/gm)) {
      const [, key, value] = directive;
      try {
        rawOptions[key] = JSON.parse(value);
      } catch {
        rawOptions[key] = value;
      }
    }
    const converted = ts.convertCompilerOptionsFromJson(rawOptions, process.cwd());
    const virtualRoot = path.resolve('.example-check', String(checked));
    const virtualFiles = new Map();
    const parts = match[2].split(/^\/\/ @filename: (.+)\r?\n/gm);
    const add = (name, source) => {
      if (path.isAbsolute(name) || name.split(/[\\/]/).includes('..'))
        throw new Error(`Invalid example filename: ${name}`);
      const filePath = path.join(virtualRoot, name);
      // A single example is isolated from globals in other blocks. Explicit
      // multi-file examples retain their script/module distinction.
      virtualFiles.set(filePath, parts.length === 1 ? `${source}\nexport {};\n` : source);
    };
    if (parts.length === 1) add(`example.${match[1] === 'tsx' ? 'tsx' : 'ts'}`, parts[0]);
    else {
      if (parts[0].replace(/^\/\/ @option:.*$/gm, '').trim())
        throw new Error(`Source before first filename in ${location}`);
      for (let i = 1; i < parts.length; i += 2) add(parts[i], parts[i + 1]);
    }
    const host = ts.createCompilerHost(converted.options);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    host.readFile = (file) => virtualFiles.get(path.resolve(file)) ?? read(file);
    host.fileExists = (file) => virtualFiles.has(path.resolve(file)) || exists(file);
    host.directoryExists = (directory) => directory.startsWith(virtualRoot) || ts.sys.directoryExists(directory);
    host.realpath = (file) => file;
    const program = ts.createProgram([...virtualFiles.keys()], converted.options, host);
    const diagnostics = [...converted.errors, ...ts.getPreEmitDiagnostics(program)];
    if (diagnostics.length) {
      failures += 1;
      console.error(`\n${location}`);
      console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCurrentDirectory: () => process.cwd(),
          getCanonicalFileName: (file) => file,
          getNewLine: () => '\n',
        }),
      );
    }
    checked += 1;
  }
}

if (checked) console.log(`Checked ${checked} examples with TypeScript ${ts.version}; ${failures} failed.`);
else console.log('No TypeScript examples found; nothing to check.');
if (failures) process.exitCode = 1;
