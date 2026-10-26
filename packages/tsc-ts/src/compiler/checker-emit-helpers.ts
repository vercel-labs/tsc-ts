// Emit helpers imported from tslib under --importHelpers: checks that the helpers a file's emit needs exist.
import type { Node, SourceFile } from './ast.js';
import { getSourceFileOfNode, isExternalModule } from './binder-utilities.js';
import type { Checker } from './checker.js';
import { resolveExternalModule } from './checker-modules.js';
import { getParameterCount, getSignaturesOfSymbol } from './checker-signatures.js';
import { getExportsOfModule, getSymbolOfMeaning, resolveSymbol } from './checker-symbols.js';
import { Diagnostics } from './diagnostics.js';
import { NodeFlags } from './ast.js';
import { ModuleKind, getEmitModuleKind } from './options.js';
import { type Symbol, SymbolFlags } from './symbol.js';

/** The emit helpers tslib provides, in tsgo's order (which orders the errors one check reports). */
export const enum ExternalEmitHelpers {
  None = 0,
  Rest = 1 << 0,
  Decorate = 1 << 1,
  Metadata = 1 << 2,
  Param = 1 << 3,
  Awaiter = 1 << 4,
  Await = 1 << 5,
  AsyncGenerator = 1 << 6,
  AsyncDelegator = 1 << 7,
  AsyncValues = 1 << 8,
  ExportStar = 1 << 9,
  ImportStar = 1 << 10,
  ImportDefault = 1 << 11,
  MakeTemplateObject = 1 << 12,
  ClassPrivateFieldGet = 1 << 13,
  ClassPrivateFieldSet = 1 << 14,
  ClassPrivateFieldIn = 1 << 15,
  SetFunctionName = 1 << 16,
  PropKey = 1 << 17,
  AddDisposableResourceAndDisposeResources = 1 << 18,
  RewriteRelativeImportExtension = 1 << 19,
  /** __esDecorate and __runInitializers, for ECMAScript decorators. */
  ESDecorateAndRunInitializers = Decorate,
  FirstEmitHelper = Rest,
  LastEmitHelper = RewriteRelativeImportExtension,
  /** for await..of before ES2018. */
  ForAwaitOfIncludes = AsyncValues,
  /** Async generators before ES2018. */
  AsyncGeneratorIncludes = Await | AsyncGenerator,
  /** `yield*` in async generators before ES2018. */
  AsyncDelegatorIncludes = Await | AsyncDelegator | AsyncValues,
}

/** A helper check for a node of a file that the checker checks later (checkExternalEmitHelpers). */
class PendingHelperCheck {
  constructor(
    readonly location: Node,
    readonly helpers: ExternalEmitHelpers,
  ) {}
}

/** A file's tslib module, the helpers checked against it so far, and checks waiting for the file's own check. */
export class EmitHelperFileLinks {
  helpersModule: Symbol | undefined = undefined;
  requestedHelpers: number = ExternalEmitHelpers.None;
  /** Created on the first check; most files have none. */
  pending: PendingHelperCheck[] | undefined = undefined;
}

function fileLinks(c: Checker, file: SourceFile): EmitHelperFileLinks {
  let links = c.emitHelperFileLinks.get(file);
  if (links === undefined) {
    links = new EmitHelperFileLinks();
    c.emitHelperFileLinks.set(file, links);
  }
  return links;
}

/**
 * Under --importHelpers, the emit of the syntax at `location` calls `helpers` from tslib. Reports TS2354 when
 * tslib can't be resolved (once per file), and TS2343 or TS2807 for a helper tslib lacks or has with too few
 * parameters.
 */
export function checkExternalEmitHelpers(c: Checker, location: Node, helpers: ExternalEmitHelpers): void {
  if (c.compilerOptions.importHelpers !== true) return;
  const file = getSourceFileOfNode(location);
  if (!isEffectiveExternalModule(c, file) || (location.flags & NodeFlags.Ambient) !== 0) return;
  // TS2354 and each TS2343 are reported once per file, at the first syntax checked that needs the helper. A
  // checker checks files out of program order, so a check for an earlier file, reached from a later one,
  // waits for the earlier file's own check, as when files are checked in program order.
  const checking = c.fileBeingChecked;
  if (checking !== undefined && checking !== file && !c.nodeLinks(file).typeChecked) {
    const fileIndex = c.fileIndex.get(file);
    const checkingIndex = c.fileIndex.get(checking);
    if (fileIndex !== undefined && checkingIndex !== undefined && fileIndex < checkingIndex) {
      (fileLinks(c, file).pending ??= []).push(new PendingHelperCheck(location, helpers));
      return;
    }
  }
  const helpersModule = resolveHelpersModule(c, file, location);
  if (helpersModule === c.unknownSymbol) return;
  const links = fileLinks(c, file);
  const unchecked = helpers & ~links.requestedHelpers;
  if (unchecked !== 0) {
    for (
      let helper = ExternalEmitHelpers.FirstEmitHelper as number;
      helper <= ExternalEmitHelpers.LastEmitHelper;
      helper <<= 1
    ) {
      if ((unchecked & helper) === 0) continue;
      for (const name of getHelperNames(c, helper)) {
        const symbol = resolveSymbol(
          c,
          getSymbolOfMeaning(c, getExportsOfModule(c, helpersModule), name, SymbolFlags.Value),
        );
        if (symbol === undefined)
          c.error(
            location,
            Diagnostics.This_syntax_requires_an_imported_helper_named_1_which_does_not_exist_in_0_Consider_upgrading_your_version_of_0,
            'tslib',
            name,
          );
        else if ((helper & ExternalEmitHelpers.ClassPrivateFieldGet) !== 0) {
          if (!hasSignatureWithArityGreaterThan(c, symbol, 3))
            c.error(
              location,
              Diagnostics.This_syntax_requires_an_imported_helper_named_1_with_2_parameters_which_is_not_compatible_with_the_one_in_0_Consider_upgrading_your_version_of_0,
              'tslib',
              name,
              '4',
            );
        } else if ((helper & ExternalEmitHelpers.ClassPrivateFieldSet) !== 0) {
          if (!hasSignatureWithArityGreaterThan(c, symbol, 4))
            c.error(
              location,
              Diagnostics.This_syntax_requires_an_imported_helper_named_1_with_2_parameters_which_is_not_compatible_with_the_one_in_0_Consider_upgrading_your_version_of_0,
              'tslib',
              name,
              '5',
            );
        }
      }
    }
  }
  links.requestedHelpers |= helpers;
}

/** Runs the helper checks for nodes of `file` that were reached while checking later files. */
export function checkPendingExternalEmitHelpers(c: Checker, file: SourceFile): void {
  const links = c.emitHelperFileLinks.get(file);
  if (links?.pending === undefined) return;
  const pending = links.pending;
  links.pending = undefined;
  for (const check of pending) checkExternalEmitHelpers(c, check.location, check.helpers);
}

/** A module file, or a file the module kind treats as CommonJS when it uses `require` or `exports`. */
function isEffectiveExternalModule(c: Checker, file: SourceFile): boolean {
  if (isExternalModule(file)) return true;
  const moduleKind = getEmitModuleKind(c.compilerOptions);
  const commonJSContaining =
    moduleKind === ModuleKind.CommonJS || (moduleKind >= ModuleKind.Node16 && moduleKind <= ModuleKind.NodeNext);
  return commonJSContaining && file.commonJSModuleIndicator !== undefined;
}

function hasSignatureWithArityGreaterThan(c: Checker, symbol: Symbol, arity: number): boolean {
  for (const signature of getSignaturesOfSymbol(c, symbol)) if (getParameterCount(c, signature) > arity) return true;
  return false;
}

/** The tslib module for `file`, or the unknown symbol; resolved once per file, reporting TS2354 at `errorNode`. */
function resolveHelpersModule(c: Checker, file: SourceFile, errorNode: Node): Symbol {
  const links = fileLinks(c, file);
  if (links.helpersModule === undefined)
    links.helpersModule =
      resolveExternalModule(
        c,
        c.host.getImportHelpersImportSpecifier(file) ?? errorNode,
        'tslib',
        Diagnostics.This_syntax_requires_an_imported_helper_but_module_0_cannot_be_found,
        errorNode,
        false,
        undefined,
      ) ?? c.unknownSymbol;
  return links.helpersModule;
}

function getHelperNames(c: Checker, helper: number): string[] {
  switch (helper) {
    case ExternalEmitHelpers.Rest:
      return ['__rest'];
    case ExternalEmitHelpers.Decorate:
      return c.legacyDecorators ? ['__decorate'] : ['__esDecorate', '__runInitializers'];
    case ExternalEmitHelpers.Metadata:
      return ['__metadata'];
    case ExternalEmitHelpers.Param:
      return ['__param'];
    case ExternalEmitHelpers.Awaiter:
      return ['__awaiter'];
    case ExternalEmitHelpers.Await:
      return ['__await'];
    case ExternalEmitHelpers.AsyncGenerator:
      return ['__asyncGenerator'];
    case ExternalEmitHelpers.AsyncDelegator:
      return ['__asyncDelegator'];
    case ExternalEmitHelpers.AsyncValues:
      return ['__asyncValues'];
    case ExternalEmitHelpers.ExportStar:
      return ['__exportStar'];
    case ExternalEmitHelpers.ImportStar:
      return ['__importStar'];
    case ExternalEmitHelpers.ImportDefault:
      return ['__importDefault'];
    case ExternalEmitHelpers.MakeTemplateObject:
      return ['__makeTemplateObject'];
    case ExternalEmitHelpers.ClassPrivateFieldGet:
      return ['__classPrivateFieldGet'];
    case ExternalEmitHelpers.ClassPrivateFieldSet:
      return ['__classPrivateFieldSet'];
    case ExternalEmitHelpers.ClassPrivateFieldIn:
      return ['__classPrivateFieldIn'];
    case ExternalEmitHelpers.SetFunctionName:
      return ['__setFunctionName'];
    case ExternalEmitHelpers.PropKey:
      return ['__propKey'];
    case ExternalEmitHelpers.AddDisposableResourceAndDisposeResources:
      return ['__addDisposableResource', '__disposeResources'];
    case ExternalEmitHelpers.RewriteRelativeImportExtension:
      return ['__rewriteRelativeImportExtension'];
  }
  return [];
}
