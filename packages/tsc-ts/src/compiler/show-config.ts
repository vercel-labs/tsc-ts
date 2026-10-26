/**
 * `tsc --showConfig`: the effective configuration as tsconfig.json text.
 */
import { Diagnostics } from './diagnostics.js';
import { compilerOptionsByName, sameEnumValue, type OptionDeclaration } from './option-declarations.js';
import {
  compilerOptionNames,
  getAllowImportingTsExtensions,
  getAllowJS,
  getAreDeclarationMapsEnabled,
  getCompilerOption,
  getEmitDeclarations,
  getEmitModuleDetectionKind,
  getEmitModuleKind,
  getIsolatedModules,
  getModuleResolutionKind,
  getResolveJsonModule,
  getResolvePackageJsonExports,
  getResolvePackageJsonImports,
  getUseDefineForClassFields,
  isIncremental,
  shouldPreserveConstEnums,
  type CompilerOptions,
  type PluginImport,
} from './options.js';
import { getDirectoryPath, getNormalizedAbsolutePath, getRelativePathFromFile } from './path.js';

/** What `--showConfig` prints besides compiler options. Config file contents are filled in by tsconfig parsing. */
export interface ShowConfigInput {
  readonly options: CompilerOptions;
  readonly fileNames: readonly string[];
  readonly currentDirectory: string;
  readonly useCaseSensitiveFileNames: boolean;
  readonly references?: readonly { readonly originalPath: string; readonly circular: boolean }[];
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly compileOnSave?: boolean;
}

/** Compiler-side bookkeeping options never shown. */
const hiddenOptions = new Set([
  'showConfig',
  'configFile',
  'configFilePath',
  'help',
  'init',
  'listFilesOnly',
  'listEmittedFiles',
  // TypeScript 7.1's generated serializer has no `listFiles`.
  'listFiles',
  'project',
  'build',
  'version',
]);

/** Options worth showing when one of their dependencies is set, mirroring TypeScript's computed options. */
const impliedOptions: readonly { readonly name: string; readonly dependencies: readonly string[] }[] = [
  { name: 'module', dependencies: ['target'] },
  { name: 'moduleResolution', dependencies: ['module', 'target'] },
  { name: 'moduleDetection', dependencies: ['module', 'target'] },
  { name: 'isolatedModules', dependencies: ['verbatimModuleSyntax'] },
  { name: 'preserveConstEnums', dependencies: ['isolatedModules', 'verbatimModuleSyntax'] },
  { name: 'declaration', dependencies: ['composite'] },
  { name: 'declarationMap', dependencies: ['declaration', 'composite'] },
  { name: 'incremental', dependencies: ['composite'] },
  { name: 'useDefineForClassFields', dependencies: ['target', 'module'] },
  { name: 'resolvePackageJsonExports', dependencies: ['moduleResolution', 'module', 'target'] },
  {
    name: 'resolvePackageJsonImports',
    dependencies: ['moduleResolution', 'resolvePackageJsonExports', 'module', 'target'],
  },
  { name: 'resolveJsonModule', dependencies: ['moduleResolution', 'module', 'target'] },
  { name: 'allowJs', dependencies: ['checkJs'] },
  { name: 'allowImportingTsExtensions', dependencies: ['rewriteRelativeImportExtensions'] },
];

/** Formats `--showConfig` output for `configFileName` (`tsconfig.json` in the current directory if empty). */
export function showConfig(input: ShowConfigInput, configFileName: string): string {
  const configPath = getNormalizedAbsolutePath(
    configFileName === '' ? 'tsconfig.json' : configFileName,
    input.currentDirectory,
  );
  const paths = new RelativePaths(configPath, input.useCaseSensitiveFileNames);
  // Option name -> value as JSON at the options' indentation.
  const shown = new Map<string, string>();
  for (const name of compilerOptionNames) {
    const option = compilerOptionsByName.get(name);
    if (option === undefined || hiddenOptions.has(option.name)) continue;
    if (option.category === Diagnostics.Command_line_Options || option.category === Diagnostics.Output_Formatting)
      continue;
    const json =
      name === 'paths'
        ? pathsJson(input.options.paths)
        : name === 'plugins'
          ? pluginsJson(input.options.plugins)
          : optionJson(option, input.options, paths);
    if (json !== undefined) shown.set(option.name, json);
  }

  const empty: CompilerOptions = {};
  const given = new Set(shown.keys());
  for (const implied of impliedOptions) {
    if (given.has(implied.name) || !implied.dependencies.some((name) => given.has(name))) continue;
    const option = compilerOptionsByName.get(implied.name);
    if (option === undefined) continue;
    const json = impliedJson(option, input.options);
    if (json !== undefined && json !== impliedJson(option, empty)) shown.set(option.name, json);
  }

  let out = '{\n    "compilerOptions": ';
  if (shown.size === 0) {
    out += '{}';
  } else {
    const entries: string[] = [];
    for (const [name, json] of shown) entries.push('        ' + JSON.stringify(name) + ': ' + json);
    out += '{\n' + entries.join(',\n') + '\n    }';
  }
  const references = input.references ?? [];
  if (references.length > 0) {
    const items: string[] = [];
    for (const reference of references) {
      let item = '{\n            "path": ' + JSON.stringify(reference.originalPath);
      if (reference.circular) item += ',\n            "circular": true';
      items.push(item + '\n        }');
    }
    out += ',\n    "references": [\n        ' + items.join(',\n        ') + '\n    ]';
  }
  const files: string[] = [];
  for (const fileName of input.fileNames) files.push(paths.relative(fileName, input.currentDirectory));
  if (files.length > 0) out += ',\n    "files": ' + jsonArray(files, 1);
  if (input.include !== undefined && input.include.length > 0)
    out += ',\n    "include": ' + jsonArray(input.include, 1);
  if (input.exclude !== undefined && input.exclude.length > 0)
    out += ',\n    "exclude": ' + jsonArray(input.exclude, 1);
  if (input.compileOnSave === true) out += ',\n    "compileOnSave": true';
  return out + '\n}';
}

/** Makes paths relative to the config file. */
class RelativePaths {
  private readonly directory: string;

  constructor(
    private readonly configPath: string,
    private readonly caseSensitive: boolean,
  ) {
    this.directory = getDirectoryPath(configPath);
  }

  relative(path: string, base: string): string {
    return getRelativePathFromFile(this.configPath, getNormalizedAbsolutePath(path, base), this.caseSensitive);
  }

  relativeToConfig(path: string): string {
    return this.relative(path, this.directory);
  }
}

/** JSON for a set option: enums by name, file paths relative to the config file. */
function optionJson(option: OptionDeclaration, options: CompilerOptions, paths: RelativePaths): string | undefined {
  const value = getCompilerOption(options, option.name);
  if (value === undefined) return undefined;
  if (typeof value === 'number') return option.kind === 'enum' ? enumJson(option, value) : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    return JSON.stringify(option.isFilePath === true ? paths.relativeToConfig(value) : value);
  }
  const element = option.element;
  if (element?.isFilePath === true)
    return jsonArray(
      value.map((path) => paths.relativeToConfig(path)),
      2,
    );
  // `lib` holds file names; show the first name selecting each.
  if (element?.values !== undefined)
    return jsonArray(
      value.map((item) => enumNameOf(element, item) ?? item),
      2,
    );
  return jsonArray(value, 2);
}

function impliedJson(option: OptionDeclaration, options: CompilerOptions): string | undefined {
  switch (option.name) {
    case 'module':
      return enumJson(option, getEmitModuleKind(options));
    case 'moduleResolution':
      return enumJson(option, getModuleResolutionKind(options));
    case 'moduleDetection':
      return enumJson(option, getEmitModuleDetectionKind(options));
    case 'isolatedModules':
      return String(getIsolatedModules(options));
    case 'preserveConstEnums':
      return String(shouldPreserveConstEnums(options));
    case 'declaration':
      return String(getEmitDeclarations(options));
    case 'declarationMap':
      return String(getAreDeclarationMapsEnabled(options));
    case 'incremental':
      return String(isIncremental(options));
    case 'useDefineForClassFields':
      return String(getUseDefineForClassFields(options));
    case 'resolvePackageJsonExports':
      return String(getResolvePackageJsonExports(options));
    case 'resolvePackageJsonImports':
      return String(getResolvePackageJsonImports(options));
    case 'resolveJsonModule':
      return String(getResolveJsonModule(options));
    case 'allowJs':
      return String(getAllowJS(options));
    case 'allowImportingTsExtensions':
      return String(getAllowImportingTsExtensions(options));
    default:
      return undefined;
  }
}

function enumJson(option: OptionDeclaration, value: number): string | undefined {
  const name = enumNameOf(option, value);
  return name === undefined ? undefined : JSON.stringify(name);
}

function enumNameOf(option: OptionDeclaration, value: number | string): string | undefined {
  if (option.values === undefined) return undefined;
  for (const [name, enumValue] of option.values) if (sameEnumValue(enumValue, value)) return name;
  return undefined;
}

function indent(level: number): string {
  return '    '.repeat(level);
}

function jsonArray(items: readonly string[], level: number): string {
  if (items.length === 0) return '[]';
  const inner = indent(level + 1);
  return '[\n' + inner + items.map((item) => JSON.stringify(item)).join(',\n' + inner) + '\n' + indent(level) + ']';
}

function pluginsJson(plugins: readonly PluginImport[] | undefined): string | undefined {
  if (plugins === undefined) return undefined;
  if (plugins.length === 0) return '[]';
  const items = plugins.map(
    (plugin) => indent(3) + '{\n' + indent(4) + '"name": ' + JSON.stringify(plugin.name) + '\n' + indent(3) + '}',
  );
  return '[\n' + items.join(',\n') + '\n' + indent(2) + ']';
}

function pathsJson(paths: ReadonlyMap<string, readonly string[] | undefined> | undefined): string | undefined {
  if (paths === undefined) return undefined;
  if (paths.size === 0) return '{}';
  const entries: string[] = [];
  for (const [key, value] of paths) {
    entries.push(indent(3) + JSON.stringify(key) + ': ' + jsonArray(value ?? [], 3));
  }
  return '{\n' + entries.join(',\n') + '\n' + indent(2) + '}';
}
