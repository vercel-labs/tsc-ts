// `tsc --api`: serves the API over stdin and stdout, on Windows over a named pipe it creates, or on Linux and macOS
// to one client at a time on a Unix socket it creates.
//
//   tsc --api [--cwd DIR] [--callbacks=readFile,fileExists,...] [--timing] [--pipe \\.\pipe\NAME]
//             [--listen SOCKET [--idle-exit SECONDS]]
import { existsSync } from 'node:fs';
import { Connection } from './connection.js';
import { ClientFileSystem, isCallback } from './fs.js';
import type { Callback } from './fs.js';
import { Session } from './session.js';

interface ServerOptions {
  cwd: string;
  callbacks: Set<Callback>;
  timing: boolean;
  pipe: string | undefined;
  listen: string | undefined;
  idleExit: number | undefined;
}

/** How long a `--listen` server waits for a client before it exits, by default. */
const defaultIdleExit = 60;

/** The default memory limit of a `--listen` server, as a multiple of its resident memory after its first client. */
const firstClientFactor = 2.5;

// The descriptor of a client connected to the named pipe `name`, which it creates, or -1 after an error message
// (native/pipe-win32.c, linked into the Windows build).
declare function tscTsOpenPipe(name: string): number;

// The Unix socket server (native/listen-posix.c, linked into the Linux and macOS builds): a socket listening at a path,
// which it binds with mode 0600, or -1 after an error message; the next client of this user, -2 when none connects
// within the timeout, or -1 after an error message; closing a descriptor; and removing the socket file.
declare function tscTsListen(path: string): number;
declare function tscTsAccept(listener: number, timeoutMs: number): number;
declare function tscTsClose(fd: number): void;
declare function tscTsUnlink(path: string): void;

// Runs the server until the client closes its end; returns the exit status.
export function runServer(args: string[], defaultLibraryPath: string): number {
  const options = parseArgs(args);
  if (options === undefined) return 2;
  let input = 0;
  let output = 1;
  if (options.pipe !== undefined && process.platform === 'win32') {
    const fd = tscTsOpenPipe(options.pipe);
    if (fd < 0) return 1;
    input = fd;
    output = fd;
  }
  const fs = new ClientFileSystem(options.callbacks);
  const session = new Session(
    {
      fs,
      currentDirectory: options.cwd,
      defaultLibraryPath,
      useCaseSensitiveFileNames: isFileSystemCaseSensitive(),
    },
    options.timing,
  );
  if (options.listen !== undefined)
    return serveClients(options.listen, options.idleExit ?? defaultIdleExit, fs, session);
  const connection = new Connection(input, output);
  fs.connect(connection);
  connection.run(session);
  return 0;
}

/**
 * `--listen`: serves one client at a time on the Unix socket `path`, each until it closes its end. Between clients the
 * session keeps only its parsed files, so a client gets the answers a new server would give (symbol ids, which number
 * the symbols of the whole process, continue from earlier clients) and reuses the parses of files whose text is
 * unchanged. Exits when no client connects for `idleExit` seconds, or after a client when the
 * resident memory is above the limit (TSC_TS_LISTEN_MEMORY megabytes, or 2.5 times the memory after the first
 * client), since syntax trees, symbols and types are never freed natively. To stop, it removes the socket file, so no
 * client can connect any more, serves the clients that connected before, and exits.
 */
function serveClients(path: string, idleExit: number, fs: ClientFileSystem, session: Session): number {
  const listener = tscTsListen(path);
  if (listener < 0) return 1;
  const megabytes = Number(process.env.TSC_TS_LISTEN_MEMORY ?? '');
  let limit = megabytes > 0 ? megabytes * 1048576 : 0;
  let status = 0;
  let stopping = false;
  for (;;) {
    const fd = tscTsAccept(listener, stopping ? 0 : idleExit * 1000);
    if (fd === -2) {
      if (stopping) break;
      tscTsUnlink(path);
      stopping = true;
      continue;
    }
    if (fd < 0) {
      status = 1;
      break;
    }
    const connection = new Connection(fd, fd);
    fs.connect(connection);
    try {
      connection.run(session);
    } catch {
      // The client closed its end during a request or a call to it.
    }
    tscTsClose(fd);
    session.reset();
    const memory = residentMemory();
    if (limit === 0) limit = memory * firstClientFactor;
    else if (memory > limit && !stopping) {
      tscTsUnlink(path);
      stopping = true;
    }
  }
  if (!stopping) tscTsUnlink(path);
  tscTsClose(listener);
  return status;
}

/** The process's resident memory in bytes; 0 if it can't be read. */
function residentMemory(): number {
  try {
    return process.memoryUsage.rss();
  } catch {
    return 0;
  }
}

// Parses Go-style flags: -name, --name, -name=value or -name value.
function parseArgs(args: string[]): ServerOptions | undefined {
  const options: ServerOptions = {
    cwd: process.cwd(),
    callbacks: new Set(),
    timing: false,
    pipe: undefined,
    listen: undefined,
    idleExit: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) break;
    const name = arg.replace(/^--?/, '').split('=')[0];
    const eq = arg.indexOf('=');
    const value = (): string | undefined => (eq >= 0 ? arg.slice(eq + 1) : args[++i]);
    switch (name) {
      case 'cwd': {
        const cwd = value();
        if (cwd === undefined) return usage('flag needs an argument: -cwd');
        options.cwd = cwd;
        break;
      }
      case 'callbacks': {
        const list = value();
        if (list === undefined) return usage('flag needs an argument: -callbacks');
        for (const callback of list === '' ? [] : list.split(',')) {
          if (!isCallback(callback)) throw new Error(`unknown callback name: ${callback}`);
          options.callbacks.add(callback);
        }
        break;
      }
      case 'timing':
        options.timing = eq < 0 || arg.slice(eq + 1) === 'true';
        break;
      case 'pipe': {
        // Only the native Windows build links the pipe server.
        if (process.platform !== 'win32' || isNode()) return usage('-pipe is supported only by tsc-ts on Windows');
        const pipe = value();
        if (pipe === undefined || pipe === '') return usage('flag needs an argument: -pipe');
        options.pipe = pipe;
        break;
      }
      case 'listen': {
        // Only the native Linux and macOS builds link the socket server.
        if ((process.platform !== 'linux' && process.platform !== 'darwin') || isNode()) {
          return usage('-listen is supported only by tsc-ts on Linux and macOS');
        }
        const listen = value();
        if (listen === undefined || listen === '') return usage('flag needs an argument: -listen');
        options.listen = listen;
        break;
      }
      case 'idle-exit': {
        const text = value();
        if (text === undefined) return usage('flag needs an argument: -idle-exit');
        const seconds = Number(text);
        if (text === '' || !Number.isInteger(seconds) || seconds < 0 || seconds > 2147483) {
          return usage(`invalid value "${text}" for flag -idle-exit`);
        }
        options.idleExit = seconds;
        break;
      }
      case 'async':
        return usage(`-${name} is not supported`);
      default:
        return usage(`flag provided but not defined: -${name}`);
    }
  }
  if (options.listen !== undefined && options.pipe !== undefined) return usage('-listen and -pipe cannot be combined');
  if (options.idleExit !== undefined && options.listen === undefined) return usage('-idle-exit needs -listen');
  return options;
}

function usage(message: string): undefined {
  process.stderr.write(
    `${message}\nUsage of api:\n  -callbacks string\n  -cwd string\n  -idle-exit int\n  -listen string\n  -pipe string\n  -timing\n`,
  );
  return undefined;
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}

// The file system is case-insensitive if the executable exists under a
// different case, as in TypeScript-Go.
function isFileSystemCaseSensitive(): boolean {
  if (process.platform === 'win32') return false;
  const path = process.execPath;
  let swapped = '';
  for (const c of path) {
    const upper = c.toUpperCase();
    swapped += upper === c ? c.toLowerCase() : upper;
  }
  return swapped === path || !existsSync(swapped);
}
