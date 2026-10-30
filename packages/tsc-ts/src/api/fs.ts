// The server's file system: the disk, with operations the client asked to
// handle (`--callbacks`) forwarded to it, except for paths in the default
// library directory with `--default-libraries-from-disk`.
import {
  type DirectoryEntries,
  diskEntries,
  diskReadFile,
  diskRealpath,
  diskStat,
  type FileStat,
} from '../library/disk.js';
import type { Connection } from './connection.js';

export type Callback = 'readFile' | 'fileExists' | 'directoryExists' | 'getAccessibleEntries' | 'realpath';

export function isCallback(name: string): name is Callback {
  return (
    name === 'readFile' ||
    name === 'fileExists' ||
    name === 'directoryExists' ||
    name === 'getAccessibleEntries' ||
    name === 'realpath'
  );
}

interface EntriesValue {
  files: string[] | null;
  directories: string[] | null;
}

/**
 * A client's callback reply, as TypeScript 7.1 has it: `{kind, value}`. `value` carries the answer, `useOS` asks
 * the server to use its own file system, `missing` (readFile) hides the file, and `identity` (realpath) keeps the
 * path. `error` and a reply without a kind fail the request, as tsc's panics do.
 */
interface CallbackReply {
  kind?: string;
  value?: unknown;
}

function decodeReply(name: Callback, reply: string): CallbackReply {
  const decoded = JSON.parse(reply) as CallbackReply | null;
  const kind = decoded?.kind ?? '';
  if (kind === '') throw new Error('filesystem callback response is missing a kind');
  if (kind === 'error') throw new Error('filesystem callback returned serverFS.error: ' + name);
  return decoded!;
}

function invalidReply(name: Callback, reply: CallbackReply): never {
  throw new Error(`invalid ${name} callback response kind: ${reply.kind ?? ''}`);
}

export class ClientFileSystem {
  private connection: Connection | undefined;
  // The directory whose paths are always read from the disk, with a trailing slash.
  private readonly diskDirectory: string | undefined;

  constructor(
    private readonly callbacks: Set<Callback>,
    diskDirectory?: string,
  ) {
    if (diskDirectory !== undefined) {
      const directory = diskDirectory.replace(/\\/g, '/');
      this.diskDirectory = directory.endsWith('/') ? directory : directory + '/';
    }
  }

  connect(connection: Connection): void {
    this.connection = connection;
  }

  readFile(path: string): string | undefined {
    const reply = this.call('readFile', path);
    if (reply === undefined) return diskReadFile(path);
    if (reply.kind === 'value') return reply.value as string;
    if (reply.kind === 'missing') return undefined;
    if (reply.kind === 'useOS') return diskReadFile(path);
    return invalidReply('readFile', reply);
  }

  fileExists(path: string): boolean {
    const reply = this.call('fileExists', path);
    if (reply === undefined || reply.kind === 'useOS') return diskStat(path)?.isDirectory === false;
    if (reply.kind === 'value') return reply.value === true;
    return invalidReply('fileExists', reply);
  }

  directoryExists(path: string): boolean {
    const reply = this.call('directoryExists', path);
    if (reply === undefined || reply.kind === 'useOS') return diskStat(path)?.isDirectory === true;
    if (reply.kind === 'value') return reply.value === true;
    return invalidReply('directoryExists', reply);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const reply = this.call('getAccessibleEntries', path);
    if (reply === undefined || reply.kind === 'useOS') return diskEntries(path);
    if (reply.kind === 'value') {
      const entries = reply.value as EntriesValue | null;
      return { files: entries?.files ?? [], directories: entries?.directories ?? [] };
    }
    return invalidReply('getAccessibleEntries', reply);
  }

  realpath(path: string): string {
    const reply = this.call('realpath', path);
    if (reply === undefined || reply.kind === 'useOS') return diskRealpath(path);
    if (reply.kind === 'value') return reply.value as string;
    if (reply.kind === 'identity') return path;
    return invalidReply('realpath', reply);
  }

  stat(path: string): FileStat | undefined {
    return diskStat(path);
  }

  // The client's reply, or undefined to use the disk.
  private call(name: Callback, path: string): CallbackReply | undefined {
    if (!this.callbacks.has(name)) return undefined;
    const disk = this.diskDirectory;
    if (disk !== undefined && (path.startsWith(disk) || path + '/' === disk)) return undefined;
    if (this.connection === undefined) throw new Error(`${name} called before the connection was set`);
    return decodeReply(name, this.connection.call(name, JSON.stringify(path)));
  }
}
