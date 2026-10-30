/**
 * Where emit writes the outputs of a source file.
 */
import type { CompilerOptions, JsxEmit } from './options.js';
import {
  changeExtension,
  combinePaths,
  comparePaths,
  ensureTrailingDirectorySeparator,
  fileExtensionIs,
  fileExtensionIsOneOf,
  getAnyExtensionFromPath,
  getBaseFileName,
  getCanonicalFileName,
  getDirectoryPath,
  getNormalizedAbsolutePath,
  getPathComponents,
  getPathComponentsRelativeTo,
  getPathFromPathComponents,
  reducePathComponents,
  removeFileExtension,
  resolvePath,
} from './path.js';

/** What output paths depend on besides options. */
export interface OutputPathsHost {
  /** With a trailing `/`, or `''`. */
  commonSourceDirectory(): string;
  readonly currentDirectory: string;
  readonly useCaseSensitiveFileNames: boolean;
}

/** The files emitted for one source file; `''` for those not emitted. */
export class OutputPaths {
  constructor(
    readonly jsFilePath: string,
    readonly sourceMapFilePath: string,
    readonly declarationFilePath: string,
    readonly declarationMapPath: string,
  ) {}
}

export function getOutputPathsFor(
  fileName: string,
  isJson: boolean,
  options: CompilerOptions,
  host: OutputPathsHost,
  forceDtsEmit: boolean,
): OutputPaths {
  const ownOutputFilePath = getOwnEmitOutputFilePath(
    fileName,
    options,
    host,
    getOutputExtension(fileName, options.jsx),
  );
  // A JSON file emitted onto itself is skipped.
  const isJsonEmittedToSameLocation =
    isJson && comparePaths(fileName, ownOutputFilePath, host.useCaseSensitiveFileNames, host.currentDirectory) === 0;
  let jsFilePath = '';
  let sourceMapFilePath = '';
  if (options.emitDeclarationOnly !== true && !isJsonEmittedToSameLocation) {
    jsFilePath = ownOutputFilePath;
    if (!isJson) sourceMapFilePath = getSourceMapFilePath(jsFilePath, options);
  }
  let declarationFilePath = '';
  let declarationMapPath = '';
  if (forceDtsEmit || (getEmitDeclarations(options) && !isJson)) {
    declarationFilePath = getDeclarationEmitOutputFilePath(fileName, options, host);
    if (options.declarationMap === true && getEmitDeclarations(options))
      declarationMapPath = declarationFilePath + '.map';
  }
  return new OutputPaths(jsFilePath, sourceMapFilePath, declarationFilePath, declarationMapPath);
}

function getEmitDeclarations(options: CompilerOptions): boolean {
  return options.declaration === true || options.composite === true;
}

export function getOutputExtension(fileName: string, jsx: JsxEmit | undefined): string {
  if (fileExtensionIs(fileName, '.json')) return '.json';
  if (jsx === 1 /* JsxEmit.Preserve */ && fileExtensionIsOneOf(fileName, ['.jsx', '.tsx'])) return '.jsx';
  if (fileExtensionIsOneOf(fileName, ['.mts', '.mjs'])) return '.mjs';
  if (fileExtensionIsOneOf(fileName, ['.cts', '.cjs'])) return '.cjs';
  return '.js';
}

/** The extension of declarations emitted for `path`. */
export function getDeclarationEmitExtensionForPath(path: string): string {
  if (fileExtensionIsOneOf(path, ['.mjs', '.mts'])) return '.d.mts';
  if (fileExtensionIsOneOf(path, ['.cjs', '.cts'])) return '.d.cts';
  if (fileExtensionIsOneOf(path, ['.ts', '.tsx', '.js', '.jsx'])) return '.d.ts';
  const extension = getAnyExtensionFromPath(path);
  return extension !== '' ? '.d' + extension + '.ts' : '.d.ts';
}

/** The declaration output of `inputFileName`, as a referenced project lays it out. */
export function getOutputDeclarationFileName(
  inputFileName: string,
  options: CompilerOptions,
  host: OutputPathsHost,
): string {
  const directory = options.declarationDir ?? options.outDir ?? '';
  return changeExtension(
    getOutputPathWithoutChangingExtension(inputFileName, directory, host),
    getDeclarationEmitExtensionForPath(inputFileName),
  );
}

export function getOutputJSFileName(inputFileName: string, options: CompilerOptions, host: OutputPathsHost): string {
  if (options.emitDeclarationOnly === true) return '';
  const outputFileName = changeExtension(
    getOutputPathWithoutChangingExtension(inputFileName, options.outDir ?? '', host),
    getOutputExtension(inputFileName, options.jsx),
  );
  if (
    !fileExtensionIs(outputFileName, '.json') ||
    comparePaths(inputFileName, outputFileName, host.useCaseSensitiveFileNames, host.currentDirectory) !== 0
  ) {
    return outputFileName;
  }
  return '';
}

/** The JavaScript output of `inputFileName`, whatever the file kind and emit options. */
export function getOutputJSFileNameWorker(
  inputFileName: string,
  options: CompilerOptions,
  host: OutputPathsHost,
): string {
  return changeExtension(
    getOutputPathWithoutChangingExtension(inputFileName, options.outDir ?? '', host),
    getOutputExtension(inputFileName, options.jsx),
  );
}

/** The declaration output of `inputFileName`. */
export function getOutputDeclarationFileNameWorker(
  inputFileName: string,
  options: CompilerOptions,
  host: OutputPathsHost,
): string {
  const directory =
    options.declarationDir !== undefined && options.declarationDir !== ''
      ? options.declarationDir
      : (options.outDir ?? '');
  return changeExtension(
    getOutputPathWithoutChangingExtension(inputFileName, directory, host),
    getDeclarationEmitExtensionForPath(inputFileName),
  );
}

function getOutputPathWithoutChangingExtension(
  inputFileName: string,
  outputDirectory: string,
  host: OutputPathsHost,
): string {
  if (outputDirectory === '') return inputFileName;
  const relative = getPathFromPathComponents(
    getPathComponentsRelativeTo(
      host.commonSourceDirectory(),
      inputFileName,
      host.useCaseSensitiveFileNames,
      host.currentDirectory,
    ),
  );
  return resolvePath(outputDirectory, relative);
}

function getDeclarationEmitOutputFilePath(file: string, options: CompilerOptions, host: OutputPathsHost): string {
  const outputDirectory = options.declarationDir ?? options.outDir;
  const path =
    outputDirectory === undefined
      ? file
      : getSourceFilePathInNewDirWorker(
          file,
          outputDirectory,
          host.currentDirectory,
          host.commonSourceDirectory(),
          host.useCaseSensitiveFileNames,
        );
  return removeFileExtension(path) + getDeclarationEmitExtensionForPath(path);
}

/**
 * `fileName` moved from `commonSourceDirectory` to `newDirectory`. The prefix check is case-folded when file names
 * are case-insensitive; case folding keeps each code point's length, so the prefix is removed by its own length.
 */
export function getSourceFilePathInNewDirWorker(
  fileName: string,
  newDirectory: string,
  currentDirectory: string,
  commonSourceDirectory: string,
  useCaseSensitiveFileNames: boolean,
): string {
  let sourceFilePath = getNormalizedAbsolutePath(fileName, currentDirectory);
  const common = getCanonicalFileName(commonSourceDirectory, useCaseSensitiveFileNames);
  if (getCanonicalFileName(sourceFilePath, useCaseSensitiveFileNames).startsWith(common)) {
    sourceFilePath = sourceFilePath.slice(commonSourceDirectory.length);
  }
  return combinePaths(newDirectory, sourceFilePath);
}

function getOwnEmitOutputFilePath(
  fileName: string,
  options: CompilerOptions,
  host: OutputPathsHost,
  extension: string,
): string {
  const withoutExtension =
    options.outDir === undefined
      ? removeFileExtension(fileName)
      : removeFileExtension(
          getSourceFilePathInNewDirWorker(
            fileName,
            options.outDir,
            host.currentDirectory,
            host.commonSourceDirectory(),
            host.useCaseSensitiveFileNames,
          ),
        );
  return withoutExtension + extension;
}

export function getSourceMapFilePath(jsFilePath: string, options: CompilerOptions): string {
  return options.sourceMap === true && options.inlineSourceMap !== true ? jsFilePath + '.map' : '';
}

/** The `.tsbuildinfo` file of an incremental build, or `''`. */
export function getBuildInfoFileName(
  options: CompilerOptions,
  currentDirectory: string,
  useCaseSensitiveFileNames: boolean,
): string {
  if (options.incremental !== true && options.composite !== true && options.build !== true) return '';
  if (options.tsBuildInfoFile !== undefined) return options.tsBuildInfoFile;
  if (options.configFilePath === undefined) return '';
  const configWithoutExtension = removeFileExtension(options.configFilePath);
  let buildInfoWithoutExtension = configWithoutExtension;
  if (options.outDir !== undefined) {
    buildInfoWithoutExtension =
      options.rootDir !== undefined
        ? resolvePath(
            options.outDir,
            getPathFromPathComponents(
              getPathComponentsRelativeTo(
                options.rootDir,
                configWithoutExtension,
                useCaseSensitiveFileNames,
                currentDirectory,
              ),
            ),
          )
        : combinePaths(options.outDir, getBaseFileName(configWithoutExtension));
  }
  return buildInfoWithoutExtension + '.tsbuildinfo';
}

/**
 * The common source directory with a trailing `/`: `rootDir`, else the config file's directory, else the deepest
 * directory containing `files()`. `checkRoot` reports files outside an explicit or config root.
 */
export function getCommonSourceDirectory(
  options: CompilerOptions,
  files: () => readonly string[],
  currentDirectory: string,
  useCaseSensitiveFileNames: boolean,
  checkRoot: ((files: readonly string[], root: string) => void) | undefined,
): string {
  let directory: string;
  if (options.rootDir !== undefined) {
    directory = options.rootDir;
    if (checkRoot !== undefined) checkRoot(files(), directory);
  } else if (options.configFilePath !== undefined) {
    directory = getDirectoryPath(options.configFilePath);
    if (checkRoot !== undefined) checkRoot(files(), directory);
  } else {
    directory = computeCommonSourceDirectoryOfFilenames(files(), currentDirectory, useCaseSensitiveFileNames);
  }
  return directory === '' ? '' : ensureTrailingDirectorySeparator(directory);
}

/** Like `getCommonSourceDirectory` for emitted files only, ignoring `rootDir` and the config file. */
export function getComputedCommonSourceDirectory(
  emittedFiles: readonly string[],
  currentDirectory: string,
  useCaseSensitiveFileNames: boolean,
): string {
  const directory = computeCommonSourceDirectoryOfFilenames(emittedFiles, currentDirectory, useCaseSensitiveFileNames);
  return directory === '' ? '' : ensureTrailingDirectorySeparator(directory);
}

/** The deepest directory containing every file; `''` if they share no root, `currentDirectory` if there are none. */
function computeCommonSourceDirectoryOfFilenames(
  fileNames: readonly string[],
  currentDirectory: string,
  useCaseSensitiveFileNames: boolean,
): string {
  let common: string[] | undefined;
  for (const fileName of fileNames) {
    const components = reducePathComponents(getPathComponents(fileName, currentDirectory));
    components.pop();
    if (common === undefined) {
      common = components;
      continue;
    }
    const shared = Math.min(common.length, components.length);
    for (let i = 0; i < shared; i++) {
      if (
        getCanonicalFileName(common[i], useCaseSensitiveFileNames) !==
        getCanonicalFileName(components[i], useCaseSensitiveFileNames)
      ) {
        if (i === 0) return '';
        common.length = i;
        break;
      }
    }
    if (components.length < common.length) common.length = components.length;
  }
  if (common === undefined || common.length === 0) return currentDirectory;
  return getPathFromPathComponents(common);
}
