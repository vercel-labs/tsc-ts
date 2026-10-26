/**
 * `tsc --version`, `--help`, `--help --all` and `tsc --build --help` output.
 */
import { charSize, codePointAt, utf8Length } from './character-codes.js';
import { Diagnostics, localizeMessage, type DiagnosticMessage, type Locale } from './diagnostics.js';
import {
  buildOption,
  buildOptionDeclarations,
  optionDeclarations,
  optionsForBuild,
  optionsForWatch,
  sameEnumValue,
  type OptionDeclaration,
} from './option-declarations.js';
import type { System } from './tsc-cli.js';

export const version = '7.1.0-beta';

/** Whether output gets colors: `NO_COLOR` and `FORCE_COLOR` override the TTY check. */
export function defaultIsPretty(sys: System): boolean {
  if (sys.getEnvironmentVariable('NO_COLOR') !== '') return false;
  if (sys.getEnvironmentVariable('FORCE_COLOR') !== '') return true;
  return sys.writeOutputIsTTY;
}

/** ANSI styles, or plain text when colors are off. */
export class Colors {
  private readonly enabled: boolean;
  /** Console hosts where blue lacks contrast. */
  private readonly avoidBlue: boolean;
  private readonly richColors: boolean;

  constructor(sys: System) {
    this.enabled = defaultIsPretty(sys);
    const isWindows = sys.getEnvironmentVariable('OS').toLowerCase().includes('windows');
    const isWindowsTerminal = sys.getEnvironmentVariable('WT_SESSION') !== '';
    const isVSCode = sys.getEnvironmentVariable('TERM_PROGRAM') === 'vscode';
    this.avoidBlue = isWindows && !isWindowsTerminal && !isVSCode;
    this.richColors =
      sys.getEnvironmentVariable('COLORTERM') === 'truecolor' ||
      sys.getEnvironmentVariable('TERM') === 'xterm-256color';
  }

  bold(text: string): string {
    return this.enabled ? '\x1b[1m' + text + '\x1b[22m' : text;
  }

  blue(text: string): string {
    if (!this.enabled) return text;
    return this.avoidBlue ? this.brightWhite(text) : '\x1b[94m' + text + '\x1b[39m';
  }

  blueBackground(text: string): string {
    if (!this.enabled) return text;
    return (this.richColors ? '\x1b[48;5;68m' : '\x1b[44m') + text + '\x1b[39;49m';
  }

  brightWhite(text: string): string {
    return this.enabled ? '\x1b[97m' + text + '\x1b[39m' : text;
  }
}

/** Number of code points, which Go's `%*s` pads to. */
function codePointLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i += charSize(codePointAt(text, i, text.length))) length++;
  return length;
}

function padEnd(text: string, width: number): string {
  const length = codePointLength(text);
  return length >= width ? text : text + ' '.repeat(width - length);
}

function padStart(text: string, width: number): string {
  const length = codePointLength(text);
  return length >= width ? text : ' '.repeat(width - length) + text;
}

/**
 * The end of the longest piece of `text` from `start` that fits in `bytes` UTF-8 bytes, and at least
 * one character. tsgo slices at the byte, which can split a character; here it moves to the next piece.
 */
function utf8PieceEnd(text: string, start: number, bytes: number): number {
  let end = start;
  let used = 0;
  while (end < text.length) {
    const codePoint = codePointAt(text, end, text.length);
    used += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (used > bytes && end > start) break;
    end += charSize(codePoint);
  }
  return end;
}

/** `message`, with the TypeScript logo right-aligned when the terminal is wide enough. */
export function header(sys: System, colors: Colors, message: string): string {
  const width = sys.terminalWidth;
  const icon = '     ';
  if (width < utf8Length(message) + icon.length) return message + '\n\n';
  const leftAlign = Math.min(width, 120) - icon.length;
  return (
    padEnd(message, leftAlign) +
    colors.blueBackground(icon) +
    '\n' +
    ' '.repeat(leftAlign) +
    colors.blueBackground(colors.brightWhite('  TS ')) +
    '\n'
  );
}

/** Help output for one terminal, in one language. */
class HelpWriter {
  readonly colors: Colors;
  readonly width: number;

  constructor(
    readonly sys: System,
    readonly locale: Locale,
  ) {
    this.colors = new Colors(sys);
    this.width = sys.terminalWidth;
  }

  text(message: DiagnosticMessage, ...args: string[]): string {
    return localizeMessage(this.locale, message, args);
  }

  header(): string {
    return header(
      this.sys,
      this.colors,
      this.text(Diagnostics.X_tsc_Colon_The_TypeScript_Compiler) + ' - ' + versionText(this.locale),
    );
  }
}

function versionText(locale: Locale): string {
  return localizeMessage(locale, Diagnostics.Version_0, [version]);
}

export function printVersion(sys: System, locale: Locale): void {
  sys.write(versionText(locale) + '\n');
}

/** `tsc --help`, or with `all`, `tsc --help --all`. */
export function printHelp(sys: System, locale: Locale, all: boolean): void {
  const writer = new HelpWriter(sys, locale);
  const options = [...optionDeclarations, buildOption];
  if (all) {
    options.sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    printAllHelp(writer, options);
  } else {
    printEasyHelp(
      writer,
      options.filter((option) => option.showInSimplifiedHelpView === true),
    );
  }
}

export function printBuildHelp(sys: System, locale: Locale): void {
  const writer = new HelpWriter(sys, locale);
  const options = buildOptionDeclarations.filter((option) => option !== buildOption);
  sys.write(
    writer.header() +
      sectionOutput(
        writer,
        writer.text(Diagnostics.BUILD_OPTIONS),
        options,
        false,
        buildModeIntroduction(writer),
        undefined,
      ),
  );
}

function buildModeIntroduction(writer: HelpWriter): string {
  return writer.text(
    Diagnostics.Using_build_b_will_make_tsc_behave_more_like_a_build_orchestrator_than_a_compiler_This_is_used_to_trigger_building_composite_projects_which_you_can_learn_more_about_at_0,
    'https://aka.ms/tsc-composite-builds',
  );
}

function learnMore(writer: HelpWriter): string {
  return writer.text(Diagnostics.You_can_learn_about_all_of_the_compiler_options_at_0, 'https://aka.ms/tsc');
}

function printEasyHelp(writer: HelpWriter, options: readonly OptionDeclaration[]): void {
  let out = writer.header();
  out += writer.colors.bold(writer.text(Diagnostics.COMMON_COMMANDS)) + '\n\n';
  out += example(writer, ['tsc'], Diagnostics.Compiles_the_current_project_tsconfig_json_in_the_working_directory);
  out += example(
    writer,
    ['tsc app.ts util.ts'],
    Diagnostics.Ignoring_tsconfig_json_compiles_the_specified_files_with_default_compiler_options,
  );
  out += example(writer, ['tsc -b'], Diagnostics.Build_a_composite_project_in_the_working_directory);
  out += example(
    writer,
    ['tsc --init'],
    Diagnostics.Creates_a_tsconfig_json_with_the_recommended_settings_in_the_working_directory,
  );
  out += example(
    writer,
    ['tsc -p ./path/to/tsconfig.json'],
    Diagnostics.Compiles_the_TypeScript_project_located_at_the_specified_path,
  );
  out += example(
    writer,
    ['tsc --help --all'],
    Diagnostics.An_expanded_version_of_this_information_showing_all_possible_compiler_options,
  );
  out += example(
    writer,
    ['tsc --noEmit', 'tsc --target esnext'],
    Diagnostics.Compiles_the_current_project_with_additional_settings,
  );

  const commandLineOptions: OptionDeclaration[] = [];
  const configOptions: OptionDeclaration[] = [];
  for (const option of options) {
    if (option.isCommandLineOnly === true || option.category === Diagnostics.Command_line_Options)
      commandLineOptions.push(option);
    else configOptions.push(option);
  }
  out += sectionOutput(
    writer,
    writer.text(Diagnostics.COMMAND_LINE_FLAGS),
    commandLineOptions,
    false,
    undefined,
    undefined,
  );
  out += sectionOutput(
    writer,
    writer.text(Diagnostics.COMMON_COMPILER_OPTIONS),
    configOptions,
    false,
    undefined,
    learnMore(writer),
  );
  writer.sys.write(out);
}

function example(writer: HelpWriter, commands: readonly string[], description: DiagnosticMessage): string {
  let text = '';
  for (const command of commands) text += '  ' + writer.colors.blue(command) + '\n';
  return text + '  ' + writer.text(description) + '\n\n';
}

function printAllHelp(writer: HelpWriter, options: readonly OptionDeclaration[]): void {
  let out = writer.header();
  out += sectionOutput(
    writer,
    writer.text(Diagnostics.ALL_COMPILER_OPTIONS),
    options,
    true,
    undefined,
    learnMore(writer),
  );
  out += sectionOutput(
    writer,
    writer.text(Diagnostics.WATCH_OPTIONS),
    optionsForWatch,
    false,
    writer.text(
      Diagnostics.Including_watch_w_will_start_watching_the_current_project_for_the_file_changes_Once_set_you_can_config_watch_mode_with_Colon,
    ),
    undefined,
  );
  out += sectionOutput(
    writer,
    writer.text(Diagnostics.BUILD_OPTIONS),
    optionsForBuild.filter((option) => option !== buildOption),
    false,
    buildModeIntroduction(writer),
    undefined,
  );
  writer.sys.write(out);
}

/** A section heading and its options, grouped by category when `byCategory` is set. */
function sectionOutput(
  writer: HelpWriter,
  name: string,
  options: readonly OptionDeclaration[],
  byCategory: boolean,
  before: string | undefined,
  after: string | undefined,
): string {
  let out = writer.colors.bold(name) + '\n\n';
  if (before !== undefined) out += before + '\n\n';
  if (!byCategory) {
    out += groupOutput(writer, options);
  } else {
    const categories = new Map<string, OptionDeclaration[]>();
    for (const option of options) {
      if (option.category === undefined) continue;
      const category = writer.text(option.category);
      const group = categories.get(category);
      if (group === undefined) categories.set(category, [option]);
      else group.push(option);
    }
    for (const [category, group] of categories) out += '### ' + category + '\n\n' + groupOutput(writer, group);
  }
  if (after !== undefined) out += after + '\n\n';
  return out;
}

function displayName(option: OptionDeclaration): string {
  return '--' + option.name + (option.shortName !== undefined ? ', -' + option.shortName : '');
}

function groupOutput(writer: HelpWriter, options: readonly OptionDeclaration[]): string {
  let maxLength = 0;
  for (const option of options) maxLength = Math.max(maxLength, displayName(option).length);
  // Names are right-aligned two spaces from the margin; descriptions start two spaces after them.
  const nameEnd = maxLength + 2;
  const descriptionStart = nameEnd + 2;
  let out = '';
  for (const option of options) out += optionOutput(writer, option, nameEnd, descriptionStart);
  // Always end with a blank line.
  return out.endsWith('\n\n') ? out : out + '\n';
}

interface ValueCandidates {
  /** `type:`, `one of:` or `one or more:`. */
  readonly label: string;
  readonly values: string;
}

function optionOutput(
  writer: HelpWriter,
  option: OptionDeclaration,
  nameEnd: number,
  descriptionStart: number,
): string {
  const colors = writer.colors;
  const name = displayName(option);
  const candidates = valueCandidates(writer, option);
  const defaultValue = defaultValueText(writer, option);
  const showDetails = showAdditionalInfo(option, candidates);
  const width = writer.width;
  const description = option.description !== undefined ? writer.text(option.description) : '';
  const defaultLabel = writer.text(Diagnostics.X_default_Colon);
  let out = '';

  if (width >= 80) {
    out += prettyLines(colors, name, description, nameEnd, descriptionStart, width, true) + '\n';
    if (showDetails) {
      if (candidates !== undefined) {
        out += prettyLines(colors, candidates.label, candidates.values, nameEnd, descriptionStart, width, false) + '\n';
      }
      if (defaultValue !== '') {
        out += prettyLines(colors, defaultLabel, defaultValue, nameEnd, descriptionStart, width, false) + '\n';
      }
    }
    return out + '\n';
  }

  out += colors.blue(name) + '\n' + description + '\n';
  if (showDetails) {
    if (candidates !== undefined) out += candidates.label + ' ' + candidates.values;
    if (defaultValue !== '') {
      if (candidates !== undefined) out += '\n';
      out += defaultLabel + ' ' + defaultValue;
    }
    out += '\n';
  }
  return out + '\n';
}

/** `left` right-aligned in a column, then `right` wrapped at the terminal width, measured in UTF-8 bytes. */
function prettyLines(
  colors: Colors,
  left: string,
  right: string,
  nameEnd: number,
  descriptionStart: number,
  width: number,
  colorLeft: boolean,
): string {
  const lineLength = width - descriptionStart;
  let out = '';
  let start = 0;
  while (start < right.length) {
    let lineStart: string;
    if (start === 0) {
      lineStart = padEnd(padStart(left, nameEnd), descriptionStart);
      if (colorLeft) lineStart = colors.blue(lineStart);
    } else {
      lineStart = ' '.repeat(descriptionStart);
    }
    const end = utf8PieceEnd(right, start, lineLength);
    out += lineStart + right.slice(start, end) + '\n';
    start = end;
  }
  return out;
}

function showAdditionalInfo(option: OptionDeclaration, candidates: ValueCandidates | undefined): boolean {
  if (option.category === Diagnostics.Command_line_Options) return false;
  return !(
    candidates !== undefined &&
    candidates.values === 'string' &&
    option.defaultValueDescription === undefined &&
    option.defaultValueMessage === undefined
  );
}

function valueCandidates(writer: HelpWriter, option: OptionDeclaration): ValueCandidates | undefined {
  switch (option.kind) {
    case 'object':
      return undefined;
    case 'listOrElement':
      throw new Error('listOrElement options have no value candidates.');
    case 'string':
    case 'number':
    case 'boolean':
      return { label: writer.text(Diagnostics.X_type_Colon), values: possibleValues(option) };
    case 'list':
      return { label: writer.text(Diagnostics.X_one_or_more_Colon), values: possibleValues(option) };
    case 'enum':
      return { label: writer.text(Diagnostics.X_one_of_Colon), values: possibleValues(option) };
  }
}

function possibleValues(option: OptionDeclaration): string {
  switch (option.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return option.kind;
    case 'list':
    case 'listOrElement':
      return option.element !== undefined ? possibleValues(option.element) : '';
    case 'object':
      return '';
    case 'enum': {
      // Synonyms share a value: `es6/es2015`.
      const synonyms = new Map<string, string[]>();
      if (option.values !== undefined) {
        for (const [name, value] of option.values) {
          if (option.deprecatedValues?.has(name) === true) continue;
          const key = typeof value === 'number' ? String(value) : value;
          const names = synonyms.get(key);
          if (names === undefined) synonyms.set(key, [name]);
          else names.push(name);
        }
      }
      const groups: string[] = [];
      for (const names of synonyms.values()) groups.push(names.join('/'));
      return groups.join(', ');
    }
  }
}

function defaultValueText(writer: HelpWriter, option: OptionDeclaration): string {
  if (option.defaultValueMessage !== undefined) return writer.text(option.defaultValueMessage);
  const value = option.defaultValueDescription;
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  const enumOption = option.kind === 'list' ? option.element : option;
  if (enumOption?.kind !== 'enum' || enumOption.values === undefined) return String(value);
  const names: string[] = [];
  for (const [name, enumValue] of enumOption.values) if (sameEnumValue(enumValue, value)) names.push(name);
  return names.join('/');
}
