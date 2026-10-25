/**
 * A parse thread of parallel-parse.ts: loads the chunks of files the main thread sends with a
 * FileLoader of its own, which parses, binds and resolves them as the program's FileLoader will, and
 * returns their bound source files, published, with the files they add.
 */
import { publish } from '@scriptc/threads';
import { type ExternalModuleIndicatorOptions, ParseOptions, ScriptKind, type SourceFile } from './ast.js';
import { bindSourceFile } from './binder.js';
import { useThreadTextCaches } from './diagnostics.js';
import { CompilerHost, FileLoader } from './file-loader.js';
import { computeHash } from './incremental.js';
import { isIncremental } from './options.js';
import type { FileSystem } from './file-system.js';
import {
  fileSize,
  LoadJobs,
  LoadKind,
  type LoadMessage,
  PackageJsonLookups,
  PreparedBatch,
  PreparedFile,
} from './parallel-parse.js';
import { parseSourceFile } from './parser.js';
import { mark, markAt, timeline } from './timeline.js';
import type { ParsedCommandLine } from './tsconfig.js';

/** Parses and binds the files the loader asks for, and keeps them with their parse inputs. */
class PreparingHost extends CompilerHost {
  prepared: PreparedFile[] = [];
  /** Whether the files' build info versions are computed (an incremental program). */
  computesVersions = false;
  readMs = 0;
  parseMs = 0;
  bindMs = 0;

  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    const t0 = timeline ? performance.now() : 0;
    const text = this.fs.readFile(fileName);
    if (text === undefined) return undefined;
    const t1 = timeline ? performance.now() : 0;
    const file = parseSourceFile(
      fileName,
      text,
      new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions),
    );
    const t2 = timeline ? performance.now() : 0;
    bindSourceFile(file);
    // Published now, while its nodes are in cache: the chunk's publish (`ParseThread.load`) then skips
    // them, where walking the whole chunk's files at once reads each node from memory again.
    publish(file);
    if (timeline) {
      const t3 = performance.now();
      this.readMs += t1 - t0;
      this.parseMs += t2 - t1;
      this.bindMs += t3 - t2;
      if (t3 - t0 >= 10)
        markAt(
          t0,
          `file read ${(t1 - t0).toFixed(1)} parse ${(t2 - t1).toFixed(1)} bind ${(t3 - t2).toFixed(1)} ${text.length} ${fileName}`,
        );
    }
    const version = this.computesVersions ? computeHash(file.text) : '';
    this.prepared.push(
      new PreparedFile(
        fileName,
        path,
        externalModuleIndicatorOptions.jsx,
        externalModuleIndicatorOptions.force,
        file,
        version,
      ),
    );
    return file;
  }
}

export class ParseThread {
  private readonly host: PreparingHost;
  private readonly loader: FileLoader;
  // The `package.json` lookups of earlier chunks, sent with them.
  private sentPackageJsons = 0;

  constructor(config: ParsedCommandLine, fs: FileSystem, currentDirectory: string, defaultLibraryPath: string) {
    this.host = new PreparingHost(fs, currentDirectory, defaultLibraryPath);
    // The versions of an incremental program's files are computed here rather than one after another
    // on the main thread (programToSnapshot, incremental.ts).
    this.host.computesVersions = isIncremental(config.options);
    this.loader = new FileLoader(this.host, config);
    // The files this thread loads are published with their chunk: text caches it computes later (of
    // declaration files, which the parser leaves out) go to copies.
    useThreadTextCaches();
  }

  /** Loads `chunk`: its bound files, published, and the files they add. */
  load(chunk: LoadMessage): PreparedBatch {
    const start = performance.now();
    const added = new LoadJobs();
    const files = this.host.prepared;
    for (let i = 0; i < chunk.names.length; i++) {
      const before = files.length;
      const loaded = this.loader.loadAhead(chunk.kinds[i]!, chunk.names[i]!, chunk.depths[i]!, added);
      // What the loader found loading the file it just prepared.
      if (loaded !== undefined && files.length === before + 1 && files[before]!.file === loaded.file)
        files[before]!.loaded = loaded;
    }
    this.host.prepared = [];
    // The sizes of the files to load next, so the main thread hands out large ones first.
    for (let k = 0; k < added.names.length; k++)
      if (added.kinds[k] === LoadKind.File) added.sizes[k] = fileSize(added.names[k]!);
    const end = performance.now();
    if (timeline) {
      const h = this.host;
      markAt(
        start,
        `chunk ${chunk.names.length} jobs ${files.length} files ${(end - start).toFixed(1)}ms: read ${h.readMs.toFixed(1)} parse ${h.parseMs.toFixed(1)} bind ${h.bindMs.toFixed(1)} other ${(end - start - h.readMs - h.parseMs - h.bindMs).toFixed(1)}`,
      );
      h.readMs = 0;
      h.parseMs = 0;
      h.bindMs = 0;
    }
    // The lookups this chunk added to the module resolution's cache (which keeps insertion order).
    const packageJsons = new PackageJsonLookups();
    const infos = this.loader.resolver.packageJsonInfoCache.infos();
    for (let k = this.sentPackageJsons; k < infos.length; k++) {
      const info = infos[k]!;
      packageJsons.directories.push(info.packageDirectory);
      packageJsons.exists.push(info.contents !== undefined);
      packageJsons.directoryExists.push(info.directoryExists);
    }
    this.sentPackageJsons = infos.length;
    const batch = publish(new PreparedBatch(files, added, end - start, packageJsons));
    if (timeline) mark(`published ${(performance.now() - end).toFixed(1)}ms`);
    return batch;
  }
}
