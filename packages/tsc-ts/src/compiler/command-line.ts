/**
 * Parses `tsc` and `tsc --build` arguments into options, file names and diagnostics, as tsgo does.
 */
import { isUnicodeWhiteSpace, isWhiteSpaceLike } from './character-codes.js';
import { createCompilerDiagnostic, Diagnostics, type Diagnostic, type DiagnosticMessage } from './diagnostics.js';
import { isValidLocale } from './locale.js';
import {
  buildOption,
  buildOptionsByName,
  compilerOptionsByName,
  type OptionDeclaration,
  type OptionNameMap,
} from './option-declarations.js';
import {
  setBuildOption,
  setCompilerOption,
  type BuildOptions,
  type CompilerOptions,
  type OptionValue,
} from './options.js';
import { getNormalizedAbsolutePath, isNetworkPathValue } from './path.js';
import { getSpellingSuggestion } from './spelling.js';

/** Reads response files. */
export abstract class CommandLineHost {
  constructor(readonly currentDirectory: string) {}

  /** Returns `undefined` if the file can't be read. */
  abstract readFile(path: string): string | undefined;
}

export interface ParsedCommandLine {
  readonly options: CompilerOptions;
  readonly fileNames: readonly string[];
  readonly errors: readonly Diagnostic[];
  /** Options as written, keyed by declaration name in first-seen order. Paths are not made absolute. */
  readonly raw: ReadonlyMap<string, OptionValue>;
}

export interface ParsedBuildCommandLine {
  readonly buildOptions: BuildOptions;
  /** Only options shared with `tsc`, and `build`. */
  readonly compilerOptions: CompilerOptions;
  /** Project paths as given; `["."]` if none. */
  readonly projects: readonly string[];
  readonly errors: readonly Diagnostic[];
  readonly raw: ReadonlyMap<string, OptionValue>;
}

/** How a parser resolves and reports options. */
interface ParserMode {
  readonly options: OptionNameMap;
  readonly unknownOption: DiagnosticMessage;
  /** An unknown option with a spelling suggestion among `options`. */
  readonly unknownOptionDidYouMean: DiagnosticMessage;
  readonly missingArgument: DiagnosticMessage;
  /** Options of the other mode, reported with `wrongMode` instead of as unknown. */
  readonly otherModeOptions?: OptionNameMap;
  readonly wrongMode?: DiagnosticMessage;
}

const compilerMode: ParserMode = {
  options: compilerOptionsByName,
  unknownOption: Diagnostics.Unknown_compiler_option_0,
  unknownOptionDidYouMean: Diagnostics.Unknown_compiler_option_0_Did_you_mean_1,
  missingArgument: Diagnostics.Compiler_option_0_expects_an_argument,
  otherModeOptions: buildOptionsByName,
  wrongMode: Diagnostics.Compiler_option_0_may_only_be_used_with_build,
};

const buildMode: ParserMode = {
  options: buildOptionsByName,
  unknownOption: Diagnostics.Unknown_build_option_0,
  unknownOptionDidYouMean: Diagnostics.Unknown_build_option_0_Did_you_mean_1,
  missingArgument: Diagnostics.Build_option_0_requires_a_value_of_type_1,
  otherModeOptions: compilerOptionsByName,
  wrongMode: Diagnostics.Compiler_option_0_may_not_be_used_with_build,
};

export function parseCommandLine(args: readonly string[], host: CommandLineHost): ParsedCommandLine {
  const parser = new CommandLineParser(compilerMode, host);
  parser.parseArguments(args);
  const cwd = host.currentDirectory;
  const options: CompilerOptions = {};
  for (const [name, value] of parser.raw) {
    if (parser.droppedLists.has(name)) continue;
    setCompilerOption(options, name, toAbsolutePaths(name, value, cwd));
  }
  return { options, fileNames: parser.fileNames, errors: parser.errors, raw: parser.raw };
}

export function parseBuildCommandLine(args: readonly string[], host: CommandLineHost): ParsedBuildCommandLine {
  const parser = new CommandLineParser(buildMode, host);
  parser.parseArguments(args);
  const buildOptions: BuildOptions = {};
  const compilerOptions: CompilerOptions = {};
  for (const [name, value] of parser.raw) {
    if (parser.droppedLists.has(name)) continue;
    const declaration = buildOptionsByName.get(name);
    if (declaration === buildOption || (declaration !== undefined && declaration === compilerOptionsByName.get(name))) {
      setCompilerOption(compilerOptions, name, value);
    }
    setBuildOption(buildOptions, name, value);
  }
  const errors = parser.errors;
  const { clean, force, verbose, dry } = buildOptions;
  const watch = compilerOptions.watch;
  if (clean === true && force === true)
    errors.push(createCompilerDiagnostic(Diagnostics.Options_0_and_1_cannot_be_combined, 'clean', 'force'));
  if (clean === true && verbose === true)
    errors.push(createCompilerDiagnostic(Diagnostics.Options_0_and_1_cannot_be_combined, 'clean', 'verbose'));
  if (clean === true && watch === true)
    errors.push(createCompilerDiagnostic(Diagnostics.Options_0_and_1_cannot_be_combined, 'clean', 'watch'));
  if (watch === true && dry === true)
    errors.push(createCompilerDiagnostic(Diagnostics.Options_0_and_1_cannot_be_combined, 'watch', 'dry'));
  return {
    buildOptions,
    compilerOptions,
    projects: parser.fileNames.length > 0 ? parser.fileNames : ['.'],
    errors,
    raw: parser.raw,
  };
}

/** Resolves file path values of compiler options against `cwd`. */
function toAbsolutePaths(name: string, value: OptionValue, cwd: string): OptionValue {
  const declaration = compilerOptionsByName.get(name);
  if (declaration === undefined) return value;
  if (declaration.kind === 'list') {
    if (declaration.element?.isFilePath === true && Array.isArray(value)) {
      return value.map((path) => getNormalizedAbsolutePath(path, cwd));
    }
  } else if (declaration.isFilePath === true && typeof value === 'string') {
    return getNormalizedAbsolutePath(value, cwd);
  }
  return value;
}

class CommandLineParser {
  readonly raw = new Map<string, OptionValue>();
  readonly fileNames: string[] = [];
  readonly errors: Diagnostic[] = [];
  /**
   * List options whose items were all dropped (`--types ,`). tsgo leaves them unset,
   * though `raw` (and so `--init`) has `[]`.
   */
  readonly droppedLists = new Set<string>();
  /** Response files being read, so one that includes itself is skipped. */
  private readonly responseFiles = new Set<string>();

  constructor(
    private readonly mode: ParserMode,
    private readonly host: CommandLineHost,
  ) {}

  parseArguments(args: readonly string[]): void {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      i++;
      if (arg === '') continue;
      if (arg.startsWith('@')) {
        this.parseResponseFile(arg.slice(1));
      } else if (arg.startsWith('-')) {
        const name = arg.startsWith('--') ? arg.slice(2) : arg.slice(1);
        const option = this.mode.options.find(name, true);
        if (option !== undefined) i = this.parseOptionValue(args, i, option, this.mode);
        else this.errors.push(this.unknownOptionError(name, arg));
      } else {
        this.fileNames.push(arg);
      }
    }
  }

  private unknownOptionError(name: string, arg: string): Diagnostic {
    const other = this.mode.otherModeOptions?.get(name);
    if (other !== undefined && this.mode.wrongMode !== undefined) {
      const message =
        other.name === 'build' ? Diagnostics.Option_build_must_be_the_first_command_line_argument : this.mode.wrongMode;
      return createCompilerDiagnostic(message, name);
    }
    const suggestion = getSpellingSuggestion(name, this.mode.options.names());
    if (suggestion !== '') return createCompilerDiagnostic(this.mode.unknownOptionDidYouMean, arg, suggestion);
    return createCompilerDiagnostic(this.mode.unknownOption, arg);
  }

  /** Splits a response file into arguments at whitespace; `"` quotes an argument. */
  private parseResponseFile(fileName: string): void {
    const path = getNormalizedAbsolutePath(fileName, this.host.currentDirectory);
    if (this.responseFiles.has(path)) return;
    this.responseFiles.add(path);
    this.readResponseFile(fileName, path);
    this.responseFiles.delete(path);
  }

  private readResponseFile(fileName: string, path: string): void {
    const text = this.host.readFile(path);
    if (text === undefined) {
      this.errors.push(createCompilerDiagnostic(Diagnostics.Cannot_read_file_0, path));
      return;
    }
    const args: string[] = [];
    let pos = 0;
    while (pos < text.length) {
      while (pos < text.length && text.charCodeAt(pos) <= 32) pos++;
      if (pos >= text.length) break;
      const start = pos;
      if (text.charCodeAt(pos) === 34 /* " */) {
        pos++;
        while (pos < text.length && text.charCodeAt(pos) !== 34) pos++;
        if (pos < text.length) {
          args.push(text.slice(start + 1, pos));
          pos++;
        } else {
          // The file name as written.
          this.errors.push(
            createCompilerDiagnostic(Diagnostics.Unterminated_quoted_string_in_response_file_0, fileName),
          );
        }
      } else {
        while (pos < text.length && text.charCodeAt(pos) > 32) pos++;
        args.push(text.slice(start, pos));
      }
    }
    this.parseArguments(args);
  }

  /** Reads the value of `option` starting at `args[i]`; returns the index of the next argument. */
  private parseOptionValue(args: readonly string[], i: number, option: OptionDeclaration, mode: ParserMode): number {
    const name = option.name;
    const next = i < args.length ? args[i] : undefined;

    if (option.isTSConfigOnly === true) {
      const value = next ?? '';
      if (value === 'null') {
        this.raw.set(name, null);
        return i + 1;
      }
      if (option.kind === 'boolean') {
        if (value === 'false') {
          this.raw.set(name, false);
          return i + 1;
        }
        this.errors.push(
          createCompilerDiagnostic(
            Diagnostics.Option_0_can_only_be_specified_in_tsconfig_json_file_or_set_to_false_or_null_on_command_line,
            name,
          ),
        );
        return value === 'true' ? i + 1 : i;
      }
      this.errors.push(
        createCompilerDiagnostic(
          Diagnostics.Option_0_can_only_be_specified_in_tsconfig_json_file_or_set_to_null_on_command_line,
          name,
        ),
      );
      return value !== '' && !value.startsWith('-') ? i + 1 : i;
    }

    if (next === undefined) {
      if (option.kind === 'boolean') {
        this.raw.set(name, true);
        return i;
      }
      this.errors.push(createCompilerDiagnostic(mode.missingArgument, name, valueTypeName(option)));
      if (option.kind === 'list') this.raw.set(name, []);
      else if (option.kind === 'enum') this.errors.push(invalidEnumValueError(option));
      return i;
    }

    if (next === 'null') {
      this.raw.set(name, null);
      return i + 1;
    }

    switch (option.kind) {
      case 'number': {
        const value = parseInteger(next);
        if (value === undefined) {
          this.errors.push(createCompilerDiagnostic(mode.missingArgument, name, 'number'));
        } else if (value >= (option.minValue ?? 0)) {
          this.raw.set(name, value);
        } else {
          this.errors.push(
            createCompilerDiagnostic(
              Diagnostics.Option_0_requires_value_to_be_greater_than_1,
              name,
              String(option.minValue ?? 0),
            ),
          );
        }
        return i + 1;
      }
      case 'boolean':
        // The value is optional: only a literal `true` or `false` is consumed.
        this.raw.set(name, next !== 'false');
        return next === 'true' || next === 'false' ? i + 1 : i;
      case 'string':
        if (!this.validateString(option, next)) return i + 1;
        if (option.isFilePath === true && isNetworkPathValue(next!, this.host.currentDirectory))
          this.errors.push(createCompilerDiagnostic(Diagnostics.Network_path_0_is_not_supported, next!));
        else this.raw.set(name, next);
        return i + 1;
      case 'list': {
        const errorCount = this.errors.length;
        const values = this.parseList(option, next);
        this.raw.set(name, values ?? []);
        if (values === undefined) this.droppedLists.add(name);
        else this.droppedLists.delete(name);
        return (values !== undefined && values.length > 0) || this.errors.length > errorCount ? i + 1 : i;
      }
      case 'enum':
        this.raw.set(name, this.parseEnumValue(option, trimWhiteSpaceLike(next)));
        return i + 1;
      default:
        throw new Error(`Option '${name}' of kind '${option.kind}' can't be given on the command line.`);
    }
  }

  /** Parses comma-separated items; `undefined` if there were items but none was kept. */
  private parseList(option: OptionDeclaration, text: string): string[] | undefined {
    const element = option.element;
    const value = trimSpace(text);
    if (element === undefined || value === '' || value.startsWith('-')) return [];
    const result: string[] = [];
    for (const item of value.split(',')) {
      if (element.kind === 'string') {
        if (this.validateString(element, item) && item !== '') result.push(item);
      } else if (element.kind === 'enum') {
        const converted = this.parseEnumValue(element, trimWhiteSpaceLike(item));
        if (typeof converted === 'string' && converted !== '') result.push(converted);
      } else {
        throw new Error(`Lists of ${element.kind} are not supported.`);
      }
    }
    return result.length > 0 ? result : undefined;
  }

  /** Maps an enum name to its value; reports unknown names. An empty name is `null`. */
  private parseEnumValue(option: OptionDeclaration, text: string): number | string | null {
    if (text === '') return null;
    const value = option.values?.get(text.toLowerCase());
    if (value !== undefined) return value;
    this.errors.push(invalidEnumValueError(option));
    return null;
  }

  /** Runs an option's extra validation; returns whether the value is valid. */
  private validateString(option: OptionDeclaration, value: string): boolean {
    if (option.extraValidation === 'spec') {
      const message = specError(value);
      if (message !== undefined) {
        this.errors.push(createCompilerDiagnostic(message));
        return false;
      }
    } else if (option.extraValidation === 'locale' && !isValidLocale(value)) {
      this.errors.push(
        createCompilerDiagnostic(
          Diagnostics.Locale_must_be_an_IETF_BCP_47_language_tag_Examples_Colon_0_1,
          'en',
          'ja-jp',
        ),
      );
      return false;
    }
    return true;
  }
}

function valueTypeName(option: OptionDeclaration): string {
  if (option.kind === 'list') return 'Array';
  if (option.kind === 'listOrElement') return (option.element?.kind ?? 'string') + ' or Array';
  return option.kind;
}

function invalidEnumValueError(option: OptionDeclaration): Diagnostic {
  return createCompilerDiagnostic(
    Diagnostics.Argument_for_0_option_must_be_Colon_1,
    '--' + option.name,
    enumNamesList(option),
  );
}

/** `'a', 'b', 'c'`: the option's value names without deprecated ones. */
export function enumNamesList(option: OptionDeclaration): string {
  const names: string[] = [];
  if (option.values !== undefined) {
    for (const name of option.values.keys()) {
      if (option.deprecatedValues?.has(name) !== true) names.push(name);
    }
  }
  return "'" + names.join("', '") + "'";
}

/** Rejects `..` after a `**` wildcard in exclude specs. */
function specError(spec: string): DiagnosticMessage | undefined {
  const wildcard = spec.startsWith('**/') ? 0 : spec.indexOf('/**/');
  if (wildcard === -1) return undefined;
  const lastDotDot = spec.endsWith('/..') ? spec.length : spec.lastIndexOf('/../');
  return lastDotDot > wildcard
    ? Diagnostics.File_specification_cannot_contain_a_parent_directory_that_appears_after_a_recursive_directory_wildcard_Asterisk_Asterisk_Colon_0
    : undefined;
}

/** Parses a decimal 64-bit integer with an optional sign, like Go's `strconv.Atoi`. */
function parseInteger(text: string): number | undefined {
  let start = 0;
  if (text.startsWith('+') || text.startsWith('-')) start = 1;
  if (start === text.length) return undefined;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch < 48 || ch > 57) return undefined;
  }
  let digits = text.slice(start);
  while (digits.length > 1 && digits.startsWith('0')) digits = digits.slice(1);
  const limit = text.startsWith('-') ? '9223372036854775808' : '9223372036854775807';
  if (digits.length > limit.length || (digits.length === limit.length && digits > limit)) return undefined;
  return Number(text);
}

function trimSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isUnicodeWhiteSpace(text.charCodeAt(start))) start++;
  while (end > start && isUnicodeWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

function trimWhiteSpaceLike(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhiteSpaceLike(text.charCodeAt(start))) start++;
  while (end > start && isWhiteSpaceLike(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
