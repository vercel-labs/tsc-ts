# tsc-ts

The TypeScript 7.0.2 compiler (tsgo), ported to TypeScript and compiled to a native executable with [scriptc](https://scriptc.dev). Experimental.

## Installation

```sh
npm install -D tsc-ts
```

npm installs the executable for your platform from an optional dependency:

| Platform                         | Package                    |
| -------------------------------- | -------------------------- |
| macOS, Apple silicon             | `@tsc-ts/darwin-arm64`     |
| macOS, Intel                     | `@tsc-ts/darwin-x64`       |
| Linux arm64, glibc 2.34 or later | `@tsc-ts/linux-arm64-gnu`  |
| Linux arm64, musl                | `@tsc-ts/linux-arm64-musl` |
| Linux x64, glibc 2.34 or later   | `@tsc-ts/linux-x64-gnu`    |
| Linux x64, musl                  | `@tsc-ts/linux-x64-musl`   |
| Windows x64                      | `@tsc-ts/win32-x64-msvc`   |

Don't install with `--omit=optional` or `--no-optional`.

## Usage

`tsc-ts` takes the same arguments as `tsc`:

```sh
npx tsc-ts -p tsconfig.json
npx tsc-ts --noEmit src/index.ts
```

`tsc-ts --api` serves the TypeScript API over stdin and stdout, like `tsc --api`. On Windows, `--api --pipe \\.\pipe\<name>` serves it over a named pipe it creates, as `tsc --api --pipe` does, for clients that connect to the pipe (such as scriptc under Node.js); only the native executable supports `--pipe`. On macOS and Linux, `--api --listen <path>` serves it on a Unix socket it creates, with mode 0600, to one client of the same user at a time, each until the client closes its end. Each client gets the answers a new `tsc-ts --api` process would give, except that symbol ids continue from earlier clients, and the server reads every file through the client again, but it keeps parsed files between clients and reuses those whose text is unchanged, along with the encoding `getSourceFile` sends for each, so a client that opens the same project again loads it faster. The server exits when no client connects for 60 seconds (`--idle-exit <seconds>` sets the time), or after a client when its resident memory is above 2.5 times what it held after its first client (`TSC_TS_LISTEN_MEMORY` sets the limit in megabytes). To stop, it removes the socket file, serves the clients that had connected, and exits. It replaces a socket file that no server answers on, such as one left by a server that was killed. Only the native executable supports `--listen`. With `--default-libraries-from-disk`, the server reads the files in its default library directory (`TSC_TS_LIB_DIR`, or the executable's directory) from the disk itself, even when the client handles file system calls (`--callbacks`), which saves a round trip to the client for each library file.

`--checkers N` checks the program on N threads. Unless `--checkers` or `--singleThreaded` is given, the native executable uses one checker per CPU it may run on (up to 16), and at least tsgo's four; it uses fewer than the CPUs, but never fewer than four, when the estimated peak memory of more checkers would not fit 85% of the machine's memory (`TSC_TS_CHECKERS=fixed` keeps tsgo's four), and checkers beyond the fourth stop taking files, one at a time, when the process's memory reaches that share; it shares one program between its threads and also parses and binds the program's files on them. Unless `--singleThreaded` is given, the program's files are parsed and bound on threads also with `--checkers 1` and in the first build of `--watch`, with or without build info, as tsgo does. Files that share costly declarations, such as a large generated schema and the few files importing it, are checked together on one checker. Under Node.js, where every thread builds its own copy of the program, tsc-ts checks on one thread unless `--checkers` is given. `--incremental`, `--watch` and `--build` always check on one thread. The diagnostics are the same as with one checker.

The native executable never frees syntax trees, types, signatures or symbols: it keeps them until it exits, which saves the cost of tracking them during a build. A one-shot build is unaffected, but a long-running process grows with each rebuild or project update. Native `--watch` (also with `--build`) runs in a child process, and when a change arrives while that process holds more than 2.5 times the memory it held after its first build, a new process replaces it and builds the change, reporting what the old process would have. `TSC_TS_WATCH_MEMORY` sets that limit in megabytes, and `TSC_TS_WATCH_MEMORY=0` turns the replacement off. A `--api` process grows with each project update; restart it to reclaim the memory.

The default lib files (`lib.*.d.ts`) ship next to the executable. Set `TSC_TS_LIB_DIR` to use another directory.

## Programmatic API

`tsc-ts/api` describes tsc-ts's programs, checkers, nodes, symbols, types and signatures in TypeScript, with the names and numbering of TypeScript 7's API (`typescript/unstable/sync`): the node interfaces, `Symbol`, `Type` and its kinds, `Signature`, `IndexInfo`, `TypePredicate`, `Diagnostic`, `Program`, `TypeChecker`, `CompilerOptions`, and the enums `SyntaxKind`, `NodeFlags`, `ModifierFlags`, `TokenFlags`, `SymbolFlags`, `TypeFlags`, `ObjectFlags`, `ElementFlags`, `SignatureFlags`, `SignatureKind`, `IndexKind`, `TypePredicateKind`, `TypeFormatFlags`, `NodeBuilderFlags`, `ScriptTarget`, `ModuleKind`, `ModuleResolutionKind`, `ModuleDetectionKind`, `ScriptKind`, `LanguageVariant`, `JsxEmit`, `NewLineKind`, `DiagnosticCategory` and `InternalSymbolName`.

```ts
import { SyntaxKind, type Node } from 'tsc-ts/api';

const isIdentifier = (node: Node): boolean => node.kind === SyntaxKind.Identifier;
```

Lists of child nodes are `NodeList` objects: `node.arguments.nodes` holds the nodes, and `pos` and `end` the list's range. `symbolName(symbol)` gives a symbol's name as TypeScript 7's API does (`__call`, `export=`).

### Programs and checkers

`createProgram({ rootNames, options, host })` creates a program of root files with compiler options, and `createProgramFromConfigFile(configFileName, host)` the program of a `tsconfig.json`. `parseConfigFile(configFileName, host)` returns a config file's options, root files and diagnostics. A program loads its files as `tsc-ts` loads a project's, on the calling thread.

```ts
import { createProgramFromConfigFile, SyntaxKind, walkPreorder } from 'tsc-ts/api';

const program = createProgramFromConfigFile('tsconfig.json', {
  getCurrentDirectory: () => process.cwd(),
  useCaseSensitiveFileNames: () => process.platform === 'linux',
  getDefaultLibraryDirectory: () => '/path/to/lib',
});
const checker = program.getTypeChecker();
for (const file of program.getSourceFiles()) {
  if (program.isSourceFileDefaultLibrary(file)) continue;
  walkPreorder(file, (node) => {
    if (node.kind === SyntaxKind.Identifier) console.log(checker.typeToString(checker.getTypeAtLocation(node)!));
  });
}
program.dispose();
```

The host's `getDefaultLibraryDirectory()` names the directory with TypeScript 7's `lib.*.d.ts` files; the platform packages carry them in their `lib` directory. The host's `readFile`, `fileExists`, `directoryExists`, `realpath` and `getAccessibleEntries` are optional: where one is missing or answers undefined, the program reads the disk.

The program's diagnostics, with their text and positions, are those `tsc --api` returns for the same project. `getTypeChecker()` returns a checker for queries, separate from the checker that reports the program's diagnostics, so queries don't change them. Its methods answer as the `tsc --api` requests of the same names. Nodes, symbols, types and signatures are tsc-ts's own objects, one per node, symbol, type and signature in a program, so they can be compared with `===` and used as Map keys.

`parseSourceFile(fileName, text, options)` parses one file without a program, as a program with `options.compilerOptions` parses it. The node functions `forEachChild`, `walkPreorder`, `tokenStartOfNode`, `getJSDoc`, `getModifiers`, `canHaveModifiers`, `getCombinedModifierFlags`, `getCombinedNodeFlags`, `getLineStarts`, `getLineAndCharacterOfPosition`, `getPositionOfLineAndCharacter` and `tokenToString`, and `flattenDiagnosticMessageText`, behave as TypeScript 7's. `getSourceFileOfNode(node)` returns the source file a node is in, and `getTextOfNode(node)` its text from the start of its first token, as TypeScript's `node.getSourceFile()` and `node.getText()` do.

`getPreEmitDiagnostics(program, sourceFile?)` returns a program's config file parsing, program, syntactic, global and semantic diagnostics, sorted and without duplicates, as TypeScript's function of that name does.

An exception the compiler throws while answering a call reaches the caller as an `InternalCompilerError`, with the exception as its `cause`; the program's checker may be inconsistent after one, so dispose of the program. `program.dispose()` frees the program's checkers; calls on the program or its checker after it throw a `DisposedProgramError`.

The package has a JavaScript build with declaration files for Node.js, and the TypeScript sources of the API and the compiler (the `source` export condition) for compilers that build it from source. The sources compile with scriptc: a test builds a program on `tsc-ts/api` natively and checks that it answers as the Node build.
