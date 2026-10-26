/**
 * Declarations of every compiler, build, watch and type acquisition option, in tsgo's order.
 *
 * The order is significant: `--help` lists options in it and name lookups let later entries win.
 */
import {
  JsxEmit,
  ModuleDetectionKind,
  ModuleKind,
  ModuleResolutionKind,
  NewLineKind,
  PollingKind,
  ScriptTarget,
  WatchDirectoryKind,
  WatchFileKind,
} from './options.js';
import { Diagnostics, type DiagnosticMessage } from './diagnostics.js';

/** Accepted names (lowercase) of an enum option and their values. */
export type EnumValues = ReadonlyMap<string, number | string>;

/** Whether two enum values are equal; values of one option all have the same type. */
export function sameEnumValue(a: number | string, b: number | string): boolean {
  if (typeof a === 'number') return typeof b === 'number' && a === b;
  return typeof b === 'string' && a === b;
}

export type OptionKind = 'string' | 'number' | 'boolean' | 'object' | 'list' | 'listOrElement' | 'enum';

/** What a change to an option invalidates. */
export enum Affects {
  None = 0,
  DeclarationPath = 1 << 0,
  ProgramStructure = 1 << 1,
  SemanticDiagnostics = 1 << 2,
  BuildInfo = 1 << 3,
  BindDiagnostics = 1 << 4,
  SourceFile = 1 << 5,
  ModuleResolution = 1 << 6,
  Emit = 1 << 7,
}

export interface OptionDeclaration {
  readonly name: string;
  readonly shortName?: string;
  readonly kind: OptionKind;
  /** Values of `enum` options. */
  readonly values?: EnumValues;
  /** Names still accepted but no longer listed in help or errors. */
  readonly deprecatedValues?: ReadonlySet<string>;
  /** Element declaration of `list` options. */
  readonly element?: OptionDeclaration;
  readonly isFilePath?: boolean;
  readonly isTSConfigOnly?: boolean;
  readonly isCommandLineOnly?: boolean;
  readonly showInSimplifiedHelpView?: boolean;
  readonly category?: DiagnosticMessage;
  readonly description?: DiagnosticMessage;
  /** Shown as `default:` in help. `'undefined'` marks an unset tristate. */
  readonly defaultValueDescription?: boolean | number | string;
  /** Shown as `default:` in help instead of `defaultValueDescription`, in the output locale. */
  readonly defaultValueMessage?: DiagnosticMessage;
  readonly extraValidation?: 'spec' | 'locale';
  /** Smallest accepted value of `number` options. */
  readonly minValue?: number;
  readonly affects?: Affects;
  /** Defaults to on under `--strict`. */
  readonly strictFlag?: boolean;
  /** Compared through `getAllowJS` when options change. */
  readonly allowJsFlag?: boolean;
  /** Value forced when transpiling a single file. */
  readonly transpileOptionValue?: boolean;
  readonly listPreserveFalsyValues?: boolean;
  readonly allowConfigDirTemplateSubstitution?: boolean;
}

export const targetValues: EnumValues = new Map<string, number | string>([
  ['es5', ScriptTarget.ES5],
  ['es6', ScriptTarget.ES2015],
  ['es2015', ScriptTarget.ES2015],
  ['es2016', ScriptTarget.ES2016],
  ['es2017', ScriptTarget.ES2017],
  ['es2018', ScriptTarget.ES2018],
  ['es2019', ScriptTarget.ES2019],
  ['es2020', ScriptTarget.ES2020],
  ['es2021', ScriptTarget.ES2021],
  ['es2022', ScriptTarget.ES2022],
  ['es2023', ScriptTarget.ES2023],
  ['es2024', ScriptTarget.ES2024],
  ['es2025', ScriptTarget.ES2025],
  ['es2026', ScriptTarget.ES2026],
  ['esnext', ScriptTarget.ESNext],
]);

export const moduleValues: EnumValues = new Map<string, number | string>([
  ['commonjs', ModuleKind.CommonJS],
  ['amd', ModuleKind.AMD],
  ['system', ModuleKind.System],
  ['umd', ModuleKind.UMD],
  ['es6', ModuleKind.ES2015],
  ['es2015', ModuleKind.ES2015],
  ['es2020', ModuleKind.ES2020],
  ['es2022', ModuleKind.ES2022],
  ['esnext', ModuleKind.ESNext],
  ['node16', ModuleKind.Node16],
  ['node18', ModuleKind.Node18],
  ['node20', ModuleKind.Node20],
  ['nodenext', ModuleKind.NodeNext],
  ['preserve', ModuleKind.Preserve],
]);

/** `--lib` names and the bundled files they select. */
export const libMap: EnumValues = new Map<string, number | string>([
  ['es5', 'lib.es5.d.ts'],
  ['es6', 'lib.es2015.d.ts'],
  ['es2015', 'lib.es2015.d.ts'],
  ['es7', 'lib.es2016.d.ts'],
  ['es2016', 'lib.es2016.d.ts'],
  ['es2017', 'lib.es2017.d.ts'],
  ['es2018', 'lib.es2018.d.ts'],
  ['es2019', 'lib.es2019.d.ts'],
  ['es2020', 'lib.es2020.d.ts'],
  ['es2021', 'lib.es2021.d.ts'],
  ['es2022', 'lib.es2022.d.ts'],
  ['es2023', 'lib.es2023.d.ts'],
  ['es2024', 'lib.es2024.d.ts'],
  ['es2025', 'lib.es2025.d.ts'],
  ['es2026', 'lib.es2026.d.ts'],
  ['esnext', 'lib.esnext.d.ts'],
  ['dom', 'lib.dom.d.ts'],
  ['dom.iterable', 'lib.dom.iterable.d.ts'],
  ['dom.asynciterable', 'lib.dom.asynciterable.d.ts'],
  ['webworker', 'lib.webworker.d.ts'],
  ['webworker.importscripts', 'lib.webworker.importscripts.d.ts'],
  ['webworker.iterable', 'lib.webworker.iterable.d.ts'],
  ['webworker.asynciterable', 'lib.webworker.asynciterable.d.ts'],
  ['scripthost', 'lib.scripthost.d.ts'],
  ['es2015.core', 'lib.es2015.core.d.ts'],
  ['es2015.collection', 'lib.es2015.collection.d.ts'],
  ['es2015.generator', 'lib.es2015.generator.d.ts'],
  ['es2015.iterable', 'lib.es2015.iterable.d.ts'],
  ['es2015.promise', 'lib.es2015.promise.d.ts'],
  ['es2015.proxy', 'lib.es2015.proxy.d.ts'],
  ['es2015.reflect', 'lib.es2015.reflect.d.ts'],
  ['es2015.symbol', 'lib.es2015.symbol.d.ts'],
  ['es2015.symbol.wellknown', 'lib.es2015.symbol.wellknown.d.ts'],
  ['es2016.array.include', 'lib.es2016.array.include.d.ts'],
  ['es2016.intl', 'lib.es2016.intl.d.ts'],
  ['es2017.arraybuffer', 'lib.es2017.arraybuffer.d.ts'],
  ['es2017.date', 'lib.es2017.date.d.ts'],
  ['es2017.object', 'lib.es2017.object.d.ts'],
  ['es2017.sharedmemory', 'lib.es2017.sharedmemory.d.ts'],
  ['es2017.string', 'lib.es2017.string.d.ts'],
  ['es2017.intl', 'lib.es2017.intl.d.ts'],
  ['es2017.typedarrays', 'lib.es2017.typedarrays.d.ts'],
  ['es2018.asyncgenerator', 'lib.es2018.asyncgenerator.d.ts'],
  ['es2018.asynciterable', 'lib.es2018.asynciterable.d.ts'],
  ['es2018.intl', 'lib.es2018.intl.d.ts'],
  ['es2018.promise', 'lib.es2018.promise.d.ts'],
  ['es2018.regexp', 'lib.es2018.regexp.d.ts'],
  ['es2019.array', 'lib.es2019.array.d.ts'],
  ['es2019.object', 'lib.es2019.object.d.ts'],
  ['es2019.string', 'lib.es2019.string.d.ts'],
  ['es2019.symbol', 'lib.es2019.symbol.d.ts'],
  ['es2019.intl', 'lib.es2019.intl.d.ts'],
  ['es2020.bigint', 'lib.es2020.bigint.d.ts'],
  ['es2020.date', 'lib.es2020.date.d.ts'],
  ['es2020.promise', 'lib.es2020.promise.d.ts'],
  ['es2020.sharedmemory', 'lib.es2020.sharedmemory.d.ts'],
  ['es2020.string', 'lib.es2020.string.d.ts'],
  ['es2020.symbol.wellknown', 'lib.es2020.symbol.wellknown.d.ts'],
  ['es2020.intl', 'lib.es2020.intl.d.ts'],
  ['es2020.number', 'lib.es2020.number.d.ts'],
  ['es2021.promise', 'lib.es2021.promise.d.ts'],
  ['es2021.string', 'lib.es2021.string.d.ts'],
  ['es2021.weakref', 'lib.es2021.weakref.d.ts'],
  ['es2021.intl', 'lib.es2021.intl.d.ts'],
  ['es2022.array', 'lib.es2022.array.d.ts'],
  ['es2022.error', 'lib.es2022.error.d.ts'],
  ['es2022.intl', 'lib.es2022.intl.d.ts'],
  ['es2022.object', 'lib.es2022.object.d.ts'],
  ['es2022.string', 'lib.es2022.string.d.ts'],
  ['es2022.regexp', 'lib.es2022.regexp.d.ts'],
  ['es2023.array', 'lib.es2023.array.d.ts'],
  ['es2023.collection', 'lib.es2023.collection.d.ts'],
  ['es2023.intl', 'lib.es2023.intl.d.ts'],
  ['es2024.arraybuffer', 'lib.es2024.arraybuffer.d.ts'],
  ['es2024.collection', 'lib.es2024.collection.d.ts'],
  ['es2024.object', 'lib.es2024.object.d.ts'],
  ['es2024.promise', 'lib.es2024.promise.d.ts'],
  ['es2024.regexp', 'lib.es2024.regexp.d.ts'],
  ['es2024.sharedmemory', 'lib.es2024.sharedmemory.d.ts'],
  ['es2024.string', 'lib.es2024.string.d.ts'],
  ['es2025.collection', 'lib.es2025.collection.d.ts'],
  ['es2025.float16', 'lib.es2025.float16.d.ts'],
  ['es2025.intl', 'lib.es2025.intl.d.ts'],
  ['es2025.iterator', 'lib.es2025.iterator.d.ts'],
  ['es2025.promise', 'lib.es2025.promise.d.ts'],
  ['es2025.regexp', 'lib.es2025.regexp.d.ts'],
  ['es2026.array', 'lib.es2026.array.d.ts'],
  ['es2026.collection', 'lib.es2026.collection.d.ts'],
  ['es2026.error', 'lib.es2026.error.d.ts'],
  ['es2026.iterator', 'lib.es2026.iterator.d.ts'],
  ['es2026.json', 'lib.es2026.json.d.ts'],
  ['es2026.math', 'lib.es2026.math.d.ts'],
  ['es2026.typedarrays', 'lib.es2026.typedarrays.d.ts'],
  ['esnext.asynciterable', 'lib.es2018.asynciterable.d.ts'],
  ['esnext.symbol', 'lib.es2019.symbol.d.ts'],
  ['esnext.bigint', 'lib.es2020.bigint.d.ts'],
  ['esnext.weakref', 'lib.es2021.weakref.d.ts'],
  ['esnext.object', 'lib.es2024.object.d.ts'],
  ['esnext.regexp', 'lib.es2024.regexp.d.ts'],
  ['esnext.string', 'lib.es2024.string.d.ts'],
  ['esnext.float16', 'lib.es2025.float16.d.ts'],
  ['esnext.array', 'lib.es2026.array.d.ts'],
  ['esnext.collection', 'lib.es2026.collection.d.ts'],
  ['esnext.error', 'lib.es2026.error.d.ts'],
  ['esnext.typedarrays', 'lib.es2026.typedarrays.d.ts'],
  ['esnext.iterator', 'lib.esnext.iterator.d.ts'],
  ['esnext.promise', 'lib.esnext.promise.d.ts'],
  ['esnext.date', 'lib.esnext.date.d.ts'],
  ['esnext.decorators', 'lib.esnext.decorators.d.ts'],
  ['esnext.disposable', 'lib.esnext.disposable.d.ts'],
  ['esnext.intl', 'lib.esnext.intl.d.ts'],
  ['esnext.modulesource', 'lib.esnext.modulesource.d.ts'],
  ['esnext.sharedmemory', 'lib.esnext.sharedmemory.d.ts'],
  ['esnext.temporal', 'lib.esnext.temporal.d.ts'],
  ['decorators', 'lib.decorators.d.ts'],
  ['decorators.legacy', 'lib.decorators.legacy.d.ts'],
]);

export const jsxValues: EnumValues = new Map<string, number | string>([
  ['preserve', JsxEmit.Preserve],
  ['react-native', JsxEmit.ReactNative],
  ['react-jsx', JsxEmit.ReactJSX],
  ['react-jsxdev', JsxEmit.ReactJSXDev],
  ['react', JsxEmit.React],
]);

export const moduleResolutionValues: EnumValues = new Map<string, number | string>([
  ['node16', ModuleResolutionKind.Node16],
  ['nodenext', ModuleResolutionKind.NodeNext],
  ['bundler', ModuleResolutionKind.Bundler],
  ['classic', ModuleResolutionKind.Classic],
  ['node', ModuleResolutionKind.Node10],
  ['node10', ModuleResolutionKind.Node10],
]);

export const newLineValues: EnumValues = new Map<string, number | string>([
  ['crlf', NewLineKind.CRLF],
  ['lf', NewLineKind.LF],
]);

export const moduleDetectionValues: EnumValues = new Map<string, number | string>([
  ['auto', ModuleDetectionKind.Auto],
  ['legacy', ModuleDetectionKind.Legacy],
  ['force', ModuleDetectionKind.Force],
]);

export const watchFileValues: EnumValues = new Map<string, number | string>([
  ['fixedpollinginterval', WatchFileKind.FixedPollingInterval],
  ['prioritypollinginterval', WatchFileKind.PriorityPollingInterval],
  ['dynamicprioritypolling', WatchFileKind.DynamicPriorityPolling],
  ['fixedchunksizepolling', WatchFileKind.FixedChunkSizePolling],
  ['usefsevents', WatchFileKind.UseFsEvents],
  ['usefseventsonparentdirectory', WatchFileKind.UseFsEventsOnParentDirectory],
]);

export const watchDirectoryValues: EnumValues = new Map<string, number | string>([
  ['usefsevents', WatchDirectoryKind.UseFsEvents],
  ['fixedpollinginterval', WatchDirectoryKind.FixedPollingInterval],
  ['dynamicprioritypolling', WatchDirectoryKind.DynamicPriorityPolling],
  ['fixedchunksizepolling', WatchDirectoryKind.FixedChunkSizePolling],
]);

export const fallbackPollingValues: EnumValues = new Map<string, number | string>([
  ['fixedinterval', PollingKind.FixedInterval],
  ['priorityinterval', PollingKind.PriorityInterval],
  ['dynamicpriority', PollingKind.DynamicPriority],
  ['fixedchunksize', PollingKind.FixedChunkSize],
]);

/** `--build`, `-b`. Only valid as the first argument. */
export const buildOption: OptionDeclaration = {
  name: 'build',
  shortName: 'b',
  kind: 'boolean',
  showInSimplifiedHelpView: true,
  category: Diagnostics.Command_line_Options,
  description: Diagnostics.Build_one_or_more_projects_and_their_dependencies_if_out_of_date,
  defaultValueDescription: false,
};

/** Options shared by `tsc` and `tsc --build`. */
export const commonOptionsWithBuild: readonly OptionDeclaration[] = [
  {
    name: 'help',
    shortName: 'h',
    kind: 'boolean',
    isCommandLineOnly: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Print_this_message,
    defaultValueDescription: false,
  },
  {
    name: 'help',
    shortName: '?',
    kind: 'boolean',
    isCommandLineOnly: true,
    category: Diagnostics.Command_line_Options,
    defaultValueDescription: false,
  },
  {
    name: 'watch',
    shortName: 'w',
    kind: 'boolean',
    isCommandLineOnly: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Watch_input_files,
    defaultValueDescription: false,
  },
  {
    name: 'preserveWatchOutput',
    kind: 'boolean',
    category: Diagnostics.Output_Formatting,
    description: Diagnostics.Disable_wiping_the_console_in_watch_mode,
    defaultValueDescription: false,
  },
  {
    name: 'listFiles',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Print_all_of_the_files_read_during_the_compilation,
    defaultValueDescription: false,
  },
  {
    name: 'explainFiles',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Print_files_read_during_the_compilation_including_why_it_was_included,
    defaultValueDescription: false,
  },
  {
    name: 'listEmittedFiles',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Print_the_names_of_emitted_files_after_a_compilation,
    defaultValueDescription: false,
  },
  {
    name: 'pretty',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Output_Formatting,
    description: Diagnostics.Enable_color_and_formatting_in_TypeScript_s_output_to_make_compiler_errors_easier_to_read,
    defaultValueDescription: true,
  },
  {
    name: 'traceResolution',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Log_paths_used_during_the_moduleResolution_process,
    defaultValueDescription: false,
  },
  {
    name: 'diagnostics',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Output_compiler_performance_information_after_building,
    defaultValueDescription: false,
  },
  {
    name: 'extendedDiagnostics',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Output_more_detailed_compiler_performance_information_after_building,
    defaultValueDescription: false,
  },
  {
    name: 'generateCpuProfile',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Emit_a_v8_CPU_profile_of_the_compiler_run_for_debugging,
    defaultValueDescription: 'profile.cpuprofile',
  },
  {
    name: 'generateTrace',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Generates_an_event_trace_and_a_list_of_types,
  },
  {
    name: 'incremental',
    shortName: 'i',
    kind: 'boolean',
    category: Diagnostics.Projects,
    description: Diagnostics.Save_tsbuildinfo_files_to_allow_for_incremental_compilation_of_projects,
    defaultValueMessage: Diagnostics.X_false_unless_composite_is_set,
  },
  {
    name: 'declaration',
    shortName: 'd',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Generate_d_ts_files_from_TypeScript_and_JavaScript_files_in_your_project,
    defaultValueMessage: Diagnostics.X_false_unless_composite_is_set,
    affects: Affects.BuildInfo,
  },
  {
    name: 'declarationMap',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Create_sourcemaps_for_d_ts_files,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'emitDeclarationOnly',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Only_output_d_ts_files_and_not_JavaScript_files,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'sourceMap',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Create_source_map_files_for_emitted_JavaScript_files,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'inlineSourceMap',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Include_sourcemap_files_inside_the_emitted_JavaScript,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'noCheck',
    kind: 'boolean',
    category: Diagnostics.Compiler_Diagnostics,
    description: Diagnostics.Disable_full_type_checking_only_critical_parse_and_emit_errors_will_be_reported,
    defaultValueDescription: false,
    transpileOptionValue: true,
  },
  {
    name: 'deduplicatePackages',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Deduplicate_packages_with_the_same_name_and_version,
    defaultValueDescription: true,
    affects: Affects.ProgramStructure,
  },
  {
    name: 'noEmit',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Disable_emitting_files_from_a_compilation,
    defaultValueDescription: false,
  },
  {
    name: 'assumeChangesOnlyAffectDirectDependencies',
    kind: 'boolean',
    category: Diagnostics.Watch_and_Build_Modes,
    description:
      Diagnostics.Have_recompiles_in_projects_that_use_incremental_and_watch_mode_assume_that_changes_within_a_file_will_only_affect_files_directly_depending_on_it,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'locale',
    kind: 'string',
    isCommandLineOnly: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Set_the_language_of_the_messaging_from_TypeScript_This_does_not_affect_emit,
    defaultValueMessage: Diagnostics.Platform_specific,
    extraValidation: 'locale',
  },
  {
    name: 'quiet',
    shortName: 'q',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Do_not_print_diagnostics,
  },
  {
    name: 'singleThreaded',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Run_in_single_threaded_mode,
  },
  {
    name: 'pprofDir',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Generate_pprof_CPU_Slashmemory_profiles_to_the_given_directory,
  },
  {
    name: 'checkers',
    kind: 'number',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Set_the_number_of_checkers_per_project,
    defaultValueMessage: Diagnostics.X_4_unless_singleThreaded_is_passed,
    minValue: 1,
  },
];

/** Options of `tsc` that `tsc --build` rejects. */
export const optionsForCompiler: readonly OptionDeclaration[] = [
  {
    name: 'all',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Show_all_compiler_options,
    defaultValueDescription: false,
  },
  {
    name: 'version',
    shortName: 'v',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Print_the_compiler_s_version,
    defaultValueDescription: false,
  },
  {
    name: 'init',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Initializes_a_TypeScript_project_and_creates_a_tsconfig_json_file,
    defaultValueDescription: false,
  },
  {
    name: 'project',
    shortName: 'p',
    kind: 'string',
    isFilePath: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description:
      Diagnostics.Compile_the_project_given_the_path_to_its_configuration_file_or_to_a_folder_with_a_tsconfig_json,
  },
  {
    name: 'showConfig',
    kind: 'boolean',
    isCommandLineOnly: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Print_the_final_configuration_instead_of_building,
    defaultValueDescription: false,
  },
  {
    name: 'listFilesOnly',
    kind: 'boolean',
    isCommandLineOnly: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Print_names_of_files_that_are_part_of_the_compilation_and_then_stop_processing,
    defaultValueDescription: false,
  },
  {
    name: 'ignoreConfig',
    kind: 'boolean',
    isCommandLineOnly: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Ignore_the_tsconfig_found_and_build_with_commandline_options_and_files,
    defaultValueDescription: false,
  },
  {
    name: 'target',
    shortName: 't',
    kind: 'enum',
    values: targetValues,
    deprecatedValues: new Set(['es5']),
    showInSimplifiedHelpView: true,
    category: Diagnostics.Language_and_Environment,
    description:
      Diagnostics.Set_the_JavaScript_language_version_for_emitted_JavaScript_and_include_compatible_library_declarations,
    defaultValueDescription: ScriptTarget.ES2026,
    affects: Affects.BuildInfo | Affects.SourceFile | Affects.ModuleResolution | Affects.Emit,
  },
  {
    name: 'module',
    shortName: 'm',
    kind: 'enum',
    values: moduleValues,
    deprecatedValues: new Set(['amd', 'system', 'umd', 'none']),
    showInSimplifiedHelpView: true,
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_what_module_code_is_generated,
    defaultValueDescription: 'undefined',
    affects: Affects.BuildInfo | Affects.ModuleResolution | Affects.Emit,
  },
  {
    name: 'lib',
    kind: 'list',
    element: {
      name: 'lib',
      kind: 'enum',
      values: libMap,
    },
    showInSimplifiedHelpView: true,
    category: Diagnostics.Language_and_Environment,
    description:
      Diagnostics.Specify_a_set_of_bundled_library_declaration_files_that_describe_the_target_runtime_environment,
    affects: Affects.ProgramStructure,
  },
  {
    name: 'allowJs',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.JavaScript_Support,
    description:
      Diagnostics.Allow_JavaScript_files_to_be_a_part_of_your_program_Use_the_checkJs_option_to_get_errors_from_these_files,
    defaultValueMessage: Diagnostics.X_false_unless_checkJs_is_set,
    affects: Affects.BuildInfo,
    allowJsFlag: true,
  },
  {
    name: 'checkJs',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.JavaScript_Support,
    description: Diagnostics.Enable_error_reporting_in_type_checked_JavaScript_files,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.ModuleResolution,
  },
  {
    name: 'jsx',
    kind: 'enum',
    values: jsxValues,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Specify_what_JSX_code_is_generated,
    defaultValueDescription: 'undefined',
    affects:
      Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.SourceFile | Affects.ModuleResolution | Affects.Emit,
  },
  {
    name: 'outFile',
    kind: 'string',
    isFilePath: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description:
      Diagnostics.Specify_a_file_that_bundles_all_outputs_into_one_JavaScript_file_If_declaration_is_true_also_designates_a_file_that_bundles_all_d_ts_output,
    affects: Affects.DeclarationPath | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'outDir',
    kind: 'string',
    isFilePath: true,
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Specify_an_output_folder_for_all_emitted_files,
    affects: Affects.DeclarationPath | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'rootDir',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_the_root_folder_within_your_source_files,
    defaultValueMessage: Diagnostics.Computed_from_the_list_of_input_files,
    affects: Affects.DeclarationPath | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'composite',
    kind: 'boolean',
    isTSConfigOnly: true,
    category: Diagnostics.Projects,
    description: Diagnostics.Enable_constraints_that_allow_a_TypeScript_project_to_be_used_with_project_references,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'tsBuildInfoFile',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Projects,
    description: Diagnostics.Specify_the_path_to_tsbuildinfo_incremental_compilation_file,
    defaultValueDescription: '.tsbuildinfo',
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'removeComments',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Disable_emitting_comments,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'importHelpers',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description:
      Diagnostics.Allow_importing_helper_functions_from_tslib_once_per_project_instead_of_including_them_per_file,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.SourceFile | Affects.Emit,
  },
  {
    name: 'downlevelIteration',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Emit_more_compliant_but_verbose_and_less_performant_JavaScript_for_iteration,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'isolatedModules',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description: Diagnostics.Ensure_that_each_file_can_be_safely_transpiled_without_relying_on_other_imports,
    defaultValueDescription: false,
    transpileOptionValue: true,
  },
  {
    name: 'verbatimModuleSyntax',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description:
      Diagnostics.Do_not_transform_or_elide_any_imports_or_exports_not_marked_as_type_only_ensuring_they_are_written_in_the_output_file_s_format_based_on_the_module_setting,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'isolatedDeclarations',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description:
      Diagnostics.Require_sufficient_annotation_on_exports_so_other_tools_can_trivially_generate_declaration_files,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'erasableSyntaxOnly',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description: Diagnostics.Do_not_allow_runtime_constructs_that_are_not_part_of_ECMAScript,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'libReplacement',
    kind: 'boolean',
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Enable_lib_replacement,
    defaultValueDescription: false,
    affects: Affects.ProgramStructure,
  },
  {
    name: 'strict',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enable_all_strict_type_checking_options,
    defaultValueDescription: true,
    affects: Affects.BuildInfo,
  },
  {
    name: 'noImplicitAny',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enable_error_reporting_for_expressions_and_declarations_with_an_implied_any_type,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'strictNullChecks',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.When_type_checking_take_into_account_null_and_undefined,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'strictFunctionTypes',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description:
      Diagnostics.When_assigning_functions_check_to_ensure_parameters_and_the_return_values_are_subtype_compatible,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'strictBindCallApply',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Check_that_the_arguments_for_bind_call_and_apply_methods_match_the_original_function,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'strictPropertyInitialization',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Check_for_class_properties_that_are_declared_but_not_set_in_the_constructor,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'strictBuiltinIteratorReturn',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Built_in_iterators_are_instantiated_with_a_TReturn_type_of_undefined_instead_of_any,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'noImplicitThis',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enable_error_reporting_when_this_is_given_the_type_any,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'useUnknownInCatchVariables',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Default_catch_clause_variables_as_unknown_instead_of_any,
    defaultValueMessage: Diagnostics.X_true_unless_strict_is_false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
    strictFlag: true,
  },
  {
    name: 'alwaysStrict',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Ensure_use_strict_is_always_emitted,
    defaultValueDescription: true,
    affects: Affects.BuildInfo | Affects.SourceFile | Affects.Emit,
  },
  {
    name: 'stableTypeOrdering',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Ensure_types_are_ordered_stably_and_deterministically_across_compilations,
    defaultValueDescription: true,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noUnusedLocals',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enable_error_reporting_when_local_variables_aren_t_read,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noUnusedParameters',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Raise_an_error_when_a_function_parameter_isn_t_read,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'exactOptionalPropertyTypes',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Interpret_optional_property_types_as_written_rather_than_adding_undefined,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noImplicitReturns',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enable_error_reporting_for_codepaths_that_do_not_explicitly_return_in_a_function,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noFallthroughCasesInSwitch',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enable_error_reporting_for_fallthrough_cases_in_switch_statements,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.BindDiagnostics,
  },
  {
    name: 'noUncheckedIndexedAccess',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Add_undefined_to_a_type_when_accessed_using_an_index,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noImplicitOverride',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Ensure_overriding_members_in_derived_classes_are_marked_with_an_override_modifier,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noPropertyAccessFromIndexSignature',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Enforces_using_indexed_accessors_for_keys_declared_using_an_indexed_type,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'moduleResolution',
    kind: 'enum',
    values: moduleResolutionValues,
    deprecatedValues: new Set(['node', 'classic', 'node10']),
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_how_TypeScript_looks_up_a_file_from_a_given_module_specifier,
    defaultValueMessage:
      Diagnostics.X_nodenext_if_module_is_nodenext_node16_if_module_is_node16_or_node18_otherwise_bundler,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'baseUrl',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_the_base_directory_to_resolve_non_relative_module_names,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'paths',
    kind: 'object',
    isTSConfigOnly: true,
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_a_set_of_entries_that_re_map_imports_to_additional_lookup_locations,
    affects: Affects.ModuleResolution,
    allowConfigDirTemplateSubstitution: true,
  },
  {
    name: 'rootDirs',
    kind: 'list',
    element: {
      name: 'rootDirs',
      kind: 'string',
      isFilePath: true,
    },
    isTSConfigOnly: true,
    category: Diagnostics.Modules,
    description: Diagnostics.Allow_multiple_folders_to_be_treated_as_one_when_resolving_modules,
    defaultValueMessage: Diagnostics.Computed_from_the_list_of_input_files,
    affects: Affects.ModuleResolution,
    allowConfigDirTemplateSubstitution: true,
  },
  {
    name: 'typeRoots',
    kind: 'list',
    element: {
      name: 'typeRoots',
      kind: 'string',
      isFilePath: true,
    },
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_multiple_folders_that_act_like_Slashnode_modules_Slash_types,
    affects: Affects.ModuleResolution,
    allowConfigDirTemplateSubstitution: true,
  },
  {
    name: 'types',
    kind: 'list',
    element: {
      name: 'types',
      kind: 'string',
    },
    showInSimplifiedHelpView: true,
    category: Diagnostics.Modules,
    description: Diagnostics.Specify_type_package_names_to_be_included_without_being_referenced_in_a_source_file,
    affects: Affects.ProgramStructure,
  },
  {
    name: 'allowSyntheticDefaultImports',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description: Diagnostics.Allow_import_x_from_y_when_a_module_doesn_t_have_a_default_export,
    defaultValueDescription: true,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'esModuleInterop',
    kind: 'boolean',
    showInSimplifiedHelpView: true,
    category: Diagnostics.Interop_Constraints,
    description:
      Diagnostics.Emit_additional_JavaScript_to_ease_support_for_importing_CommonJS_modules_This_enables_allowSyntheticDefaultImports_for_type_compatibility,
    defaultValueDescription: true,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'preserveSymlinks',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description: Diagnostics.Disable_resolving_symlinks_to_their_realpath_This_correlates_to_the_same_flag_in_node,
    defaultValueDescription: false,
  },
  {
    name: 'allowUmdGlobalAccess',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description: Diagnostics.Allow_accessing_UMD_globals_from_modules,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'moduleSuffixes',
    kind: 'list',
    element: {
      name: 'moduleSuffixes',
      kind: 'string',
    },
    category: Diagnostics.Modules,
    description: Diagnostics.List_of_file_name_suffixes_to_search_when_resolving_a_module,
    affects: Affects.ModuleResolution,
    listPreserveFalsyValues: true,
  },
  {
    name: 'allowImportingTsExtensions',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description:
      Diagnostics.Allow_imports_to_include_TypeScript_file_extensions_Requires_moduleResolution_bundler_and_either_noEmit_or_emitDeclarationOnly_to_be_set,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'rewriteRelativeImportExtensions',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description:
      Diagnostics.Rewrite_ts_tsx_mts_and_cts_file_extensions_in_relative_import_paths_to_their_JavaScript_equivalent_in_output_files,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'resolvePackageJsonExports',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description: Diagnostics.Use_the_package_json_exports_field_when_resolving_package_imports,
    defaultValueMessage: Diagnostics.X_true_when_moduleResolution_is_node16_nodenext_or_bundler_otherwise_false,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'resolvePackageJsonImports',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description: Diagnostics.Use_the_package_json_imports_field_when_resolving_imports,
    defaultValueMessage: Diagnostics.X_true_when_moduleResolution_is_node16_nodenext_or_bundler_otherwise_false,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'customConditions',
    kind: 'list',
    element: {
      name: 'condition',
      kind: 'string',
    },
    category: Diagnostics.Modules,
    description: Diagnostics.Conditions_to_set_in_addition_to_the_resolver_specific_defaults_when_resolving_imports,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'noUncheckedSideEffectImports',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description: Diagnostics.Check_side_effect_imports,
    defaultValueDescription: true,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'sourceRoot',
    kind: 'string',
    category: Diagnostics.Emit,
    description: Diagnostics.Specify_the_root_path_for_debuggers_to_find_the_reference_source_code,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'mapRoot',
    kind: 'string',
    category: Diagnostics.Emit,
    description: Diagnostics.Specify_the_location_where_debugger_should_locate_map_files_instead_of_generated_locations,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'inlineSources',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Include_source_code_in_the_sourcemaps_inside_the_emitted_JavaScript,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'experimentalDecorators',
    kind: 'boolean',
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Enable_experimental_support_for_legacy_experimental_decorators,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'emitDecoratorMetadata',
    kind: 'boolean',
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Emit_design_type_metadata_for_decorated_declarations_in_source_files,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'jsxFactory',
    kind: 'string',
    category: Diagnostics.Language_and_Environment,
    description:
      Diagnostics.Specify_the_JSX_factory_function_used_when_targeting_React_JSX_emit_e_g_React_createElement_or_h,
    defaultValueDescription: '`React.createElement`',
  },
  {
    name: 'jsxFragmentFactory',
    kind: 'string',
    category: Diagnostics.Language_and_Environment,
    description:
      Diagnostics.Specify_the_JSX_Fragment_reference_used_for_fragments_when_targeting_React_JSX_emit_e_g_React_Fragment_or_Fragment,
    defaultValueDescription: 'React.Fragment',
  },
  {
    name: 'jsxImportSource',
    kind: 'string',
    category: Diagnostics.Language_and_Environment,
    description:
      Diagnostics.Specify_module_specifier_used_to_import_the_JSX_factory_functions_when_using_jsx_Colon_react_jsx_Asterisk,
    defaultValueDescription: 'react',
    affects:
      Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.SourceFile | Affects.ModuleResolution | Affects.Emit,
  },
  {
    name: 'resolveJsonModule',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description: Diagnostics.Enable_importing_json_files,
    defaultValueDescription: false,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'allowArbitraryExtensions',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description: Diagnostics.Enable_importing_files_with_any_extension_provided_a_declaration_file_is_present,
    defaultValueDescription: false,
    affects: Affects.ProgramStructure,
  },
  {
    name: 'reactNamespace',
    kind: 'string',
    category: Diagnostics.Language_and_Environment,
    description:
      Diagnostics.Specify_the_object_invoked_for_createElement_This_only_applies_when_targeting_react_JSX_emit,
    defaultValueDescription: '`React`',
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'skipDefaultLibCheck',
    kind: 'boolean',
    category: Diagnostics.Completeness,
    description: Diagnostics.Skip_type_checking_d_ts_files_that_are_included_with_TypeScript,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'emitBOM',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Emit_a_UTF_8_Byte_Order_Mark_BOM_in_the_beginning_of_output_files,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'newLine',
    kind: 'enum',
    values: newLineValues,
    category: Diagnostics.Emit,
    description: Diagnostics.Set_the_newline_character_for_emitting_files,
    defaultValueDescription: '',
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'noErrorTruncation',
    kind: 'boolean',
    category: Diagnostics.Output_Formatting,
    description: Diagnostics.Disable_truncating_types_in_error_messages,
    defaultValueDescription: false,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo,
  },
  {
    name: 'noLib',
    kind: 'boolean',
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Disable_including_any_library_files_including_the_default_lib_d_ts,
    defaultValueDescription: false,
    affects: Affects.ProgramStructure,
    transpileOptionValue: true,
  },
  {
    name: 'noResolve',
    kind: 'boolean',
    category: Diagnostics.Modules,
    description:
      Diagnostics.Disallow_import_s_require_s_or_reference_s_from_expanding_the_number_of_files_TypeScript_should_add_to_a_project,
    defaultValueDescription: false,
    affects: Affects.ModuleResolution,
    transpileOptionValue: true,
  },
  {
    name: 'stripInternal',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Disable_emitting_declarations_that_have_internal_in_their_JSDoc_comments,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'disableSizeLimit',
    kind: 'boolean',
    category: Diagnostics.Editor_Support,
    description:
      Diagnostics.Remove_the_20mb_cap_on_total_source_code_size_for_JavaScript_files_in_the_TypeScript_language_server,
    defaultValueDescription: false,
    affects: Affects.ProgramStructure,
  },
  {
    name: 'disableSourceOfProjectReferenceRedirect',
    kind: 'boolean',
    isTSConfigOnly: true,
    category: Diagnostics.Projects,
    description:
      Diagnostics.Disable_preferring_source_files_instead_of_declaration_files_when_referencing_composite_projects,
    defaultValueDescription: false,
  },
  {
    name: 'disableSolutionSearching',
    kind: 'boolean',
    isTSConfigOnly: true,
    category: Diagnostics.Projects,
    description: Diagnostics.Opt_a_project_out_of_multi_project_reference_checking_when_editing,
    defaultValueDescription: false,
  },
  {
    name: 'disableReferencedProjectLoad',
    kind: 'boolean',
    isTSConfigOnly: true,
    category: Diagnostics.Projects,
    description: Diagnostics.Reduce_the_number_of_projects_loaded_automatically_by_TypeScript,
    defaultValueDescription: false,
  },
  {
    name: 'noEmitHelpers',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Disable_generating_custom_helper_functions_like_extends_in_compiled_output,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'noEmitOnError',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Disable_emitting_files_if_any_type_checking_errors_are_reported,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'preserveConstEnums',
    kind: 'boolean',
    category: Diagnostics.Emit,
    description: Diagnostics.Disable_erasing_const_enum_declarations_in_generated_code,
    defaultValueDescription: false,
    affects: Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'declarationDir',
    kind: 'string',
    isFilePath: true,
    category: Diagnostics.Emit,
    description: Diagnostics.Specify_the_output_directory_for_generated_declaration_files,
    affects: Affects.DeclarationPath | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'skipLibCheck',
    kind: 'boolean',
    category: Diagnostics.Completeness,
    description: Diagnostics.Skip_type_checking_all_d_ts_files,
    defaultValueDescription: false,
    affects: Affects.BuildInfo,
  },
  {
    name: 'allowUnusedLabels',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Disable_error_reporting_for_unused_labels,
    defaultValueDescription: 'undefined',
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.BindDiagnostics,
  },
  {
    name: 'allowUnreachableCode',
    kind: 'boolean',
    category: Diagnostics.Type_Checking,
    description: Diagnostics.Disable_error_reporting_for_unreachable_code,
    defaultValueDescription: 'undefined',
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.BindDiagnostics,
  },
  {
    name: 'forceConsistentCasingInFileNames',
    kind: 'boolean',
    category: Diagnostics.Interop_Constraints,
    description: Diagnostics.Ensure_that_casing_is_correct_in_imports,
    defaultValueDescription: true,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'maxNodeModuleJsDepth',
    kind: 'number',
    category: Diagnostics.JavaScript_Support,
    description:
      Diagnostics.Specify_the_maximum_folder_depth_used_for_checking_JavaScript_files_from_node_modules_Only_applicable_with_allowJs,
    defaultValueDescription: 0,
    affects: Affects.ModuleResolution,
  },
  {
    name: 'useDefineForClassFields',
    kind: 'boolean',
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Emit_ECMAScript_standard_compliant_class_fields,
    defaultValueMessage: Diagnostics.X_true_for_ES2022_and_above_including_ESNext,
    affects: Affects.SemanticDiagnostics | Affects.BuildInfo | Affects.Emit,
  },
  {
    name: 'plugins',
    kind: 'list',
    element: {
      name: 'plugin',
      kind: 'object',
    },
    isTSConfigOnly: true,
    category: Diagnostics.Editor_Support,
    description: Diagnostics.Specify_a_list_of_language_service_plugins_to_include,
  },
  {
    name: 'moduleDetection',
    kind: 'enum',
    values: moduleDetectionValues,
    category: Diagnostics.Language_and_Environment,
    description: Diagnostics.Control_what_method_is_used_to_detect_module_format_JS_files,
    defaultValueMessage:
      Diagnostics.X_auto_Colon_Treat_files_with_imports_exports_import_meta_jsx_with_jsx_Colon_react_jsx_or_esm_format_with_module_Colon_node16_as_modules,
    affects: Affects.SourceFile | Affects.ModuleResolution,
  },
  {
    name: 'ignoreDeprecations',
    kind: 'string',
    defaultValueDescription: 'undefined',
  },
];

/** Options only valid with `tsc --build`. */
export const optionsForBuild: readonly OptionDeclaration[] = [
  buildOption,
  {
    name: 'verbose',
    shortName: 'v',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Enable_verbose_logging,
    defaultValueDescription: false,
  },
  {
    name: 'dry',
    shortName: 'd',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Show_what_would_be_built_or_deleted_if_specified_with_clean,
    defaultValueDescription: false,
  },
  {
    name: 'force',
    shortName: 'f',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Build_all_projects_including_those_that_appear_to_be_up_to_date,
    defaultValueDescription: false,
  },
  {
    name: 'clean',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Delete_the_outputs_of_all_projects,
    defaultValueDescription: false,
  },
  {
    name: 'builders',
    kind: 'number',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Set_the_number_of_projects_to_build_concurrently,
    defaultValueMessage: Diagnostics.X_4_unless_singleThreaded_is_passed,
    minValue: 1,
  },
  {
    name: 'stopBuildOnErrors',
    kind: 'boolean',
    category: Diagnostics.Command_line_Options,
    description: Diagnostics.Skip_building_downstream_projects_on_error_in_upstream_project,
    defaultValueDescription: false,
  },
];

/** Watch options, accepted on the command line and in `watchOptions`. */
export const optionsForWatch: readonly OptionDeclaration[] = [
  {
    name: 'watchInterval',
    kind: 'number',
    category: Diagnostics.Watch_and_Build_Modes,
  },
  {
    name: 'watchFile',
    kind: 'enum',
    values: watchFileValues,
    category: Diagnostics.Watch_and_Build_Modes,
    description: Diagnostics.Specify_how_the_TypeScript_watch_mode_works,
    defaultValueDescription: WatchFileKind.UseFsEvents,
  },
  {
    name: 'watchDirectory',
    kind: 'enum',
    values: watchDirectoryValues,
    category: Diagnostics.Watch_and_Build_Modes,
    description:
      Diagnostics.Specify_how_directories_are_watched_on_systems_that_lack_recursive_file_watching_functionality,
    defaultValueDescription: WatchDirectoryKind.UseFsEvents,
  },
  {
    name: 'fallbackPolling',
    kind: 'enum',
    values: fallbackPollingValues,
    category: Diagnostics.Watch_and_Build_Modes,
    description:
      Diagnostics.Specify_what_approach_the_watcher_should_use_if_the_system_runs_out_of_native_file_watchers,
    defaultValueDescription: PollingKind.PriorityInterval,
  },
  {
    name: 'synchronousWatchDirectory',
    kind: 'boolean',
    category: Diagnostics.Watch_and_Build_Modes,
    description:
      Diagnostics.Synchronously_call_callbacks_and_update_the_state_of_directory_watchers_on_platforms_that_don_t_support_recursive_watching_natively,
    defaultValueDescription: false,
  },
  {
    name: 'excludeDirectories',
    kind: 'list',
    element: {
      name: 'excludeDirectory',
      kind: 'string',
      isFilePath: true,
      extraValidation: 'spec',
    },
    category: Diagnostics.Watch_and_Build_Modes,
    description: Diagnostics.Remove_a_list_of_directories_from_the_watch_process,
    allowConfigDirTemplateSubstitution: true,
  },
  {
    name: 'excludeFiles',
    kind: 'list',
    element: {
      name: 'excludeFile',
      kind: 'string',
      isFilePath: true,
      extraValidation: 'spec',
    },
    category: Diagnostics.Watch_and_Build_Modes,
    description: Diagnostics.Remove_a_list_of_files_from_the_watch_mode_s_processing,
    allowConfigDirTemplateSubstitution: true,
  },
];

/** Keys of `typeAcquisition` in tsconfig.json. */
export const typeAcquisitionDeclarations: readonly OptionDeclaration[] = [
  {
    name: 'enable',
    kind: 'boolean',
    defaultValueDescription: false,
  },
  {
    name: 'include',
    kind: 'list',
    element: {
      name: 'include',
      kind: 'string',
    },
  },
  {
    name: 'exclude',
    kind: 'list',
    element: {
      name: 'exclude',
      kind: 'string',
    },
  },
  {
    name: 'disableFilenameBasedTypeAcquisition',
    kind: 'boolean',
    defaultValueDescription: false,
  },
];

/** Every compiler option: what `tsc` accepts. */
export const optionDeclarations: readonly OptionDeclaration[] = [...commonOptionsWithBuild, ...optionsForCompiler];

/** What `tsc --build` accepts. */
export const buildOptionDeclarations: readonly OptionDeclaration[] = [...commonOptionsWithBuild, ...optionsForBuild];

/** Case-insensitive lookup of declarations by name or short name. Later declarations win. */
export class OptionNameMap {
  private readonly byName = new Map<string, OptionDeclaration>();
  private readonly shortNames = new Map<string, string>();

  constructor(declarations: readonly OptionDeclaration[]) {
    for (const declaration of declarations) {
      this.byName.set(declaration.name.toLowerCase(), declaration);
      if (declaration.shortName !== undefined) this.shortNames.set(declaration.shortName, declaration.name);
    }
  }

  get(name: string): OptionDeclaration | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** Looks up `name`, or with `allowShort` the option it abbreviates. */
  find(name: string, allowShort: boolean): OptionDeclaration | undefined {
    const lower = name.toLowerCase();
    const long = allowShort ? this.shortNames.get(lower) : undefined;
    return this.get(long ?? lower);
  }
}

export const compilerOptionsByName = new OptionNameMap(optionDeclarations);
export const buildOptionsByName = new OptionNameMap(buildOptionDeclarations);
export const watchOptionsByName = new OptionNameMap(optionsForWatch);
