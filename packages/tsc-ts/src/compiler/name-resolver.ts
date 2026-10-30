// Name resolution: finds the symbol a name refers to by walking up the scopes from a location.
//
// The checker subclasses `NameResolver` to resolve aliases and merged symbols, report errors
// and record uses; the defaults here only read the binder's tables.
import {
  BindingElement,
  ConditionalTypeNode,
  ExportSpecifier,
  ExpressionWithTypeArguments,
  FunctionExpression,
  HeritageClause,
  InferTypeNode,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  NodeVisitor,
  ParameterDeclaration,
  type SourceFile,
  Tristate,
  getAsteriskToken,
  getBody,
  getLocalSymbol,
  getLocals,
  getModuleSpecifier,
  getName,
  getParameters,
  getSymbol,
  getText,
  getType,
} from './ast.js';
import { isFunctionLike, isFunctionLikeDeclarationKind, isInJSFile, isRequireCall } from './ast-utilities.js';
import {
  findConstructorDeclaration,
  getDeclarationOfKind,
  getImmediatelyInvokedFunctionExpression,
  getSourceFileOfNode,
  hasSyntacticModifier,
  hasStaticModifier,
  isClassElement,
  isClassLike,
  isConstAssertion,
  isExternalOrCommonJSModule,
  isGlobalSourceFile,
  isNullishCoalesce,
  isOptionalChain,
  isPartOfParameterDeclaration,
  isStatic,
  isTypeNodeKind,
} from './binder-utilities.js';
import { type DiagnosticMessage, Diagnostics } from './diagnostics.js';
import {
  type CompilerOptions,
  getEmitScriptTarget,
  getIsolatedModules,
  getUseDefineForClassFields,
} from './options.js';
import { SyntaxKind } from './syntax-kind.js';
import { ScriptTarget } from './types.js';
import { getDeclarations, InternalSymbolName, Symbol, SymbolFlags, type SymbolTable } from './symbol.js';

export class NameResolver {
  readonly compilerOptions: CompilerOptions;
  /** The global symbol table; empty unless the checker sets it. */
  globals: SymbolTable;
  argumentsSymbol: Symbol | undefined;
  requireSymbol: Symbol | undefined;

  constructor(compilerOptions: CompilerOptions) {
    this.compilerOptions = compilerOptions;
    this.globals = new Map<string, Symbol>();
    this.argumentsSymbol = undefined;
    this.requireSymbol = undefined;
  }

  // Hooks

  /** The symbol of `name` in `symbols` with a `meaning`. Ignores aliases and merging by default. */
  lookup(symbols: SymbolTable, name: string, meaning: SymbolFlags): Symbol | undefined {
    if (meaning === SymbolFlags.None) return undefined;
    const symbol = symbols.get(name);
    return symbol !== undefined && (symbol.flags & meaning) !== 0 ? symbol : undefined;
  }

  /** The (merged) symbol of a declaration. */
  getSymbolOfDeclaration(node: Node): Symbol | undefined {
    return symbolOfNode(node);
  }

  /** Reports an error; the default reports nothing. */
  error(_location: Node, _message: DiagnosticMessage, _args: readonly string[]): void {}

  symbolReferenced(_symbol: Symbol, _meaning: SymbolFlags): void {}

  /** Whether a function's parameters need their own scope, cached per function; Unknown if not cached. */
  getRequiresScopeChangeCache(_node: Node): Tristate {
    return Tristate.Unknown;
  }

  setRequiresScopeChangeCache(_node: Node, _value: Tristate): void {}

  /** Handles a reference from a property initializer to a constructor local; true to resolve to nothing. */
  onPropertyWithInvalidInitializer(
    _location: Node,
    _name: string,
    _declaration: Node,
    _result: Symbol | undefined,
  ): boolean {
    return false;
  }

  /** Reports a failed lookup; `location` is undefined for global lookups. */
  onFailedToResolveSymbol(
    _location: Node | undefined,
    _name: string,
    _meaning: SymbolFlags,
    _message: DiagnosticMessage,
  ): void {}

  /** Checks a successful lookup; `location` is undefined for global lookups. */
  onSuccessfullyResolvedSymbol(
    _location: Node | undefined,
    _result: Symbol,
    _meaning: SymbolFlags,
    _lastLocation: Node | undefined,
    _associatedDeclarationForContainingInitializerOrBindingName: Node | undefined,
    _withinDeferredContext: boolean,
  ): void {}

  /** The symbol for `arguments`; the default is a transient property symbol. */
  getArgumentsSymbol(): Symbol {
    let symbol = this.argumentsSymbol;
    if (symbol === undefined) {
      symbol = new Symbol(SymbolFlags.Property | SymbolFlags.Transient, 'arguments');
      this.argumentsSymbol = symbol;
    }
    return symbol;
  }

  /**
   * Resolves `name` with `meaning` from `location`. With a `nameNotFoundMessage`, reports
   * through the hooks; `isUse` counts it as a reference.
   */
  resolve(
    location: Node | undefined,
    name: string,
    meaning: SymbolFlags,
    nameNotFoundMessage: DiagnosticMessage | undefined,
    isUse: boolean,
    excludeGlobals: boolean,
  ): Symbol | undefined {
    let result: Symbol | undefined;
    let lastLocation: Node | undefined;
    let lastSelfReferenceLocation: Node | undefined;
    let propertyWithInvalidInitializer: Node | undefined;
    let associatedDeclarationForContainingInitializerOrBindingName: Node | undefined;
    let withinDeferredContext = false;
    // For did-you-mean suggestions, which start at the original location.
    const originalLocation = location;
    const nameIsConst = name === 'const';
    let current = location;
    loop: while (current !== undefined) {
      // `const` in `as const` is the expression's constant type, not a lookup.
      if (nameIsConst && isConstAssertion(current)) return undefined;
      // From the name of a namespace or enum, skip its own scope: its locals could conflict.
      if (
        (current.kind === SyntaxKind.ModuleDeclaration || current.kind === SyntaxKind.EnumDeclaration) &&
        lastLocation !== undefined &&
        getName(current) === lastLocation
      ) {
        lastLocation = current;
        current = current.parent;
        if (current === undefined) break;
      }
      // A module's import attributes type sees neither the module's locals nor its exports.
      const isModuleAttributes =
        current.kind === SyntaxKind.ModuleDeclaration &&
        (current as ModuleDeclaration).attributes !== undefined &&
        lastLocation === (current as ModuleDeclaration).attributes;
      const locals = getLocalsOf(current);
      // Locals of a global source file are merged into the globals.
      if (locals !== undefined && !isGlobalSourceFile(current)) {
        result = this.lookup(locals, name, meaning);
        if (result !== undefined) {
          let useResult = true;
          if (isModuleAttributes) {
            useResult = false;
          } else if (isFunctionLike(current) && lastLocation !== undefined && lastLocation !== getBody(current)) {
            // Type parameters are in scope in the whole signature, but local types only in the
            // body; parameters only in the body, parameter list and return type. JSDoc types
            // are parented above type parameters, so this doesn't apply to them.
            if ((meaning & result.flags & SymbolFlags.Type) !== 0 && lastLocation.kind !== SyntaxKind.JSDoc) {
              useResult =
                (result.flags & SymbolFlags.TypeParameter) !== 0 &&
                ((lastLocation.flags & NodeFlags.Synthesized) !== 0 ||
                  lastLocation === getType(current) ||
                  lastLocation.kind === SyntaxKind.Parameter ||
                  lastLocation.kind === SyntaxKind.JSDocParameterTag ||
                  lastLocation.kind === SyntaxKind.JSDocReturnTag ||
                  lastLocation.kind === SyntaxKind.TypeParameter);
            }
            if ((meaning & result.flags & SymbolFlags.Variable) !== 0) {
              if (this.useOuterVariableScopeInParameter(result, current, lastLocation)) useResult = false;
              else if ((result.flags & SymbolFlags.FunctionScopedVariable) !== 0) {
                // Initializers referencing later parameters are checked separately.
                useResult =
                  lastLocation.kind === SyntaxKind.Parameter ||
                  (lastLocation.flags & NodeFlags.Synthesized) !== 0 ||
                  (lastLocation === getType(current) && isInParameter(result.valueDeclaration));
              }
            }
          } else if (current instanceof ConditionalTypeNode) {
            // `infer T` is only in scope in the true branch.
            useResult = lastLocation === (current as ConditionalTypeNode).trueType;
          }
          if (useResult) break loop;
          result = undefined;
        }
      }
      withinDeferredContext = withinDeferredContext || isDeferredContext(current, lastLocation);
      switch (current.kind) {
        case SyntaxKind.SourceFile:
        case SyntaxKind.ModuleDeclaration: {
          if (current.kind === SyntaxKind.SourceFile && !isExternalOrCommonJSModule(current as SourceFile)) break;
          if (isModuleAttributes) break;
          const moduleSymbol = this.getSymbolOfDeclaration(current);
          if (moduleSymbol === undefined) break;
          const moduleExports = moduleSymbol.exports ?? emptyTable;
          if (
            current.kind === SyntaxKind.SourceFile ||
            ((current.flags & NodeFlags.Ambient) !== 0 && !isGlobalScopeAugmentationNode(current))
          ) {
            // An external module: the local name of its default export is in scope.
            result = moduleExports.get(InternalSymbolName.Default);
            if (result !== undefined) {
              const localSymbol = getLocalSymbolForExportDefault(result);
              if (localSymbol !== undefined && (result.flags & meaning) !== 0 && localSymbol.name === name) break loop;
              result = undefined;
            }
            // A name exported only by an export specifier isn't in scope. This checks the
            // flags without resolving the alias, which could be circular.
            const moduleExport = moduleExports.get(name);
            if (
              moduleExport !== undefined &&
              moduleExport.flags === SymbolFlags.Alias &&
              (getDeclarationOfKind(moduleExport, SyntaxKind.ExportSpecifier) !== undefined ||
                getDeclarationOfKind(moduleExport, SyntaxKind.NamespaceExport) !== undefined)
            )
              break;
          }
          if (name !== InternalSymbolName.Default) {
            result = this.lookup(moduleExports, name, meaning & SymbolFlags.ModuleMember);
            if (result !== undefined) {
              if (
                current.kind === SyntaxKind.SourceFile &&
                (current as SourceFile).commonJSModuleIndicator !== undefined &&
                (result.flags & SymbolFlags.Type) === 0
              )
                result = undefined;
              else break loop;
            }
          }
          break;
        }
        case SyntaxKind.EnumDeclaration: {
          const enumSymbol = this.getSymbolOfDeclaration(current);
          if (enumSymbol === undefined) break;
          result = this.lookup(enumSymbol.exports ?? emptyTable, name, meaning & SymbolFlags.EnumMember);
          if (result !== undefined) {
            if (
              nameNotFoundMessage !== undefined &&
              getIsolatedModules(this.compilerOptions) &&
              (current.flags & NodeFlags.Ambient) === 0 &&
              result.valueDeclaration !== undefined &&
              getSourceFileOfNode(current) !== getSourceFileOfNode(result.valueDeclaration)
            ) {
              const flagName =
                this.compilerOptions.verbatimModuleSyntax === true ? 'verbatimModuleSyntax' : 'isolatedModules';
              this.error(
                originalLocation!,
                Diagnostics.Cannot_access_0_from_another_file_without_qualification_when_1_is_enabled_Use_2_instead,
                [name, flagName, enumSymbol.name + '.' + name],
              );
            }
            break loop;
          }
          break;
        }
        case SyntaxKind.PropertyDeclaration:
          if (!isStatic(current)) {
            const ctor = findConstructorDeclaration(current.parent!);
            if (ctor !== undefined) {
              const ctorLocals = getLocalsOf(ctor);
              // Remembered to report later.
              if (ctorLocals !== undefined && this.lookup(ctorLocals, name, meaning & SymbolFlags.Value) !== undefined)
                propertyWithInvalidInitializer = current;
            }
          }
          break;
        case SyntaxKind.ClassDeclaration:
        case SyntaxKind.ClassExpression:
        case SyntaxKind.InterfaceDeclaration: {
          const classSymbol = this.getSymbolOfDeclaration(current);
          result =
            classSymbol === undefined
              ? undefined
              : this.lookup(classSymbol.members ?? emptyTable, name, meaning & SymbolFlags.Type);
          if (result !== undefined) {
            // Ignore type parameters declared elsewhere.
            if (!isTypeParameterSymbolDeclaredInContainer(result, current)) {
              result = undefined;
              break;
            }
            // Type parameters aren't in scope in static members.
            if (lastLocation !== undefined && isStatic(lastLocation)) {
              if (nameNotFoundMessage !== undefined)
                this.error(
                  originalLocation!,
                  Diagnostics.Static_members_cannot_reference_class_type_parameters,
                  noArgs,
                );
              return undefined;
            }
            break loop;
          }
          if (current.kind === SyntaxKind.ClassExpression && (meaning & SymbolFlags.Class) !== 0) {
            const className = getName(current);
            if (className !== undefined && name === getText(className)) {
              result = symbolOfNode(current);
              break loop;
            }
          }
          break;
        }
        case SyntaxKind.ExpressionWithTypeArguments: {
          const heritage = current.parent!;
          if (
            lastLocation === (current as ExpressionWithTypeArguments).expression &&
            heritage instanceof HeritageClause &&
            (heritage as HeritageClause).token === SyntaxKind.ExtendsKeyword
          ) {
            const container = (heritage as HeritageClause).parent!;
            if (isClassLike(container)) {
              const classSymbol = this.getSymbolOfDeclaration(container);
              result =
                classSymbol === undefined
                  ? undefined
                  : this.lookup(classSymbol.members ?? emptyTable, name, meaning & SymbolFlags.Type);
              if (result !== undefined) {
                if (nameNotFoundMessage !== undefined)
                  this.error(
                    originalLocation!,
                    Diagnostics.Base_class_expressions_cannot_reference_class_type_parameters,
                    noArgs,
                  );
                return undefined;
              }
            }
          }
          break;
        }
        case SyntaxKind.ComputedPropertyName: {
          // A class's computed property names can't reference its own type parameters.
          const grandparent = current.parent!.parent!;
          if (isClassLike(grandparent) || grandparent.kind === SyntaxKind.InterfaceDeclaration) {
            const containerSymbol = this.getSymbolOfDeclaration(grandparent);
            result =
              containerSymbol === undefined
                ? undefined
                : this.lookup(containerSymbol.members ?? emptyTable, name, meaning & SymbolFlags.Type);
            if (result !== undefined) {
              if (nameNotFoundMessage !== undefined)
                this.error(
                  originalLocation!,
                  Diagnostics.A_computed_property_name_cannot_reference_a_type_parameter_from_its_containing_type,
                  noArgs,
                );
              return undefined;
            }
          }
          break;
        }
        case SyntaxKind.MethodDeclaration:
        case SyntaxKind.Constructor:
        case SyntaxKind.GetAccessor:
        case SyntaxKind.SetAccessor:
        case SyntaxKind.FunctionDeclaration:
          if ((meaning & SymbolFlags.Variable) !== 0 && name === 'arguments') {
            result = this.getArgumentsSymbol();
            break loop;
          }
          break;
        case SyntaxKind.FunctionExpression: {
          if ((meaning & SymbolFlags.Variable) !== 0 && name === 'arguments') {
            result = this.getArgumentsSymbol();
            break loop;
          }
          const functionName = (current as FunctionExpression).name;
          if ((meaning & SymbolFlags.Function) !== 0 && functionName !== undefined && name === functionName.text) {
            result = symbolOfNode(current);
            break loop;
          }
          break;
        }
        case SyntaxKind.Decorator: {
          // Decorators resolve at the class: a parameter's at its class member, a member's at the class.
          let parent = current.parent;
          if (parent !== undefined && parent.kind === SyntaxKind.Parameter) {
            current = parent;
            parent = current.parent;
          }
          if (parent !== undefined && (isClassElement(parent) || parent.kind === SyntaxKind.ClassDeclaration))
            current = parent;
          break;
        }
        case SyntaxKind.Parameter: {
          const parameter = current as ParameterDeclaration;
          if (
            lastLocation !== undefined &&
            (lastLocation === parameter.initializer ||
              (lastLocation === parameter.name && isBindingPattern(lastLocation))) &&
            associatedDeclarationForContainingInitializerOrBindingName === undefined
          )
            associatedDeclarationForContainingInitializerOrBindingName = current;
          break;
        }
        case SyntaxKind.BindingElement: {
          const element = current as BindingElement;
          if (
            lastLocation !== undefined &&
            (lastLocation === element.initializer ||
              (lastLocation === element.name && isBindingPattern(lastLocation))) &&
            isPartOfParameterDeclaration(current) &&
            associatedDeclarationForContainingInitializerOrBindingName === undefined
          )
            associatedDeclarationForContainingInitializerOrBindingName = current;
          break;
        }
        case SyntaxKind.InferType:
          if ((meaning & SymbolFlags.TypeParameter) !== 0) {
            const typeParameter = (current as InferTypeNode).typeParameter;
            if (name === typeParameter.name.text) {
              result = symbolOfNode(typeParameter);
              break loop;
            }
          }
          break;
        case SyntaxKind.ExportSpecifier: {
          // `export { a as b } from "m"`: `a` resolves outside this module.
          const specifier = current as ExportSpecifier;
          const exportDeclaration = current.parent!.parent!;
          if (
            lastLocation !== undefined &&
            lastLocation === specifier.propertyName &&
            getModuleSpecifier(exportDeclaration) !== undefined
          )
            current = exportDeclaration.parent!;
          break;
        }
      }
      if (isSelfReferenceLocation(current, lastLocation)) lastSelfReferenceLocation = current;
      lastLocation = current;
      current = current.parent;
    }
    // A use from inside the declaration it resolves to is a self-reference, not a use.
    if (
      isUse &&
      result !== undefined &&
      (lastSelfReferenceLocation === undefined || result !== symbolOfNode(lastSelfReferenceLocation))
    )
      this.symbolReferenced(result, meaning);
    if (result === undefined && !excludeGlobals)
      result = this.lookup(this.globals, name, meaning | SymbolFlags.GlobalLookup);
    if (
      result === undefined &&
      originalLocation !== undefined &&
      isInJSFile(originalLocation) &&
      originalLocation.parent !== undefined &&
      isRequireCall(originalLocation.parent, false)
    )
      return this.requireSymbol;
    if (nameNotFoundMessage !== undefined) {
      if (
        propertyWithInvalidInitializer !== undefined &&
        this.onPropertyWithInvalidInitializer(originalLocation!, name, propertyWithInvalidInitializer, result)
      )
        return undefined;
      if (result === undefined) this.onFailedToResolveSymbol(originalLocation, name, meaning, nameNotFoundMessage);
      else
        this.onSuccessfullyResolvedSymbol(
          originalLocation,
          result,
          meaning,
          lastLocation,
          associatedDeclarationForContainingInitializerOrBindingName,
          withinDeferredContext,
        );
    }
    return result;
  }

  /**
   * Whether a parameter default refers outside the function: names declared in the body
   * aren't in scope there unless emit moves the parameter into the body.
   */
  useOuterVariableScopeInParameter(result: Symbol, location: Node, lastLocation: Node): boolean {
    if (lastLocation.kind !== SyntaxKind.Parameter) return false;
    const body = getBody(location);
    const declaration = result.valueDeclaration;
    if (body === undefined || declaration === undefined || declaration.pos < body.pos || declaration.end > body.end)
      return false;
    // Static fields in class expressions, optional chains and `??` before ES2020, and object
    // rest in binding patterns before ES2017 move parameters into the body.
    let requiresScopeChange = this.getRequiresScopeChangeCache(location);
    if (requiresScopeChange === Tristate.Unknown) {
      requiresScopeChange = Tristate.False;
      for (const parameter of getParameters(location)!.nodes)
        if (this.requiresScopeChange(parameter as ParameterDeclaration)) requiresScopeChange = Tristate.True;
      this.setRequiresScopeChangeCache(location, requiresScopeChange);
    }
    return requiresScopeChange !== Tristate.True;
  }

  requiresScopeChange(node: ParameterDeclaration): boolean {
    const visitor = new ScopeChangeFinder(this.compilerOptions);
    return (
      visitor.requiresScopeChange(node.name) ||
      (node.initializer !== undefined && visitor.requiresScopeChange(node.initializer))
    );
  }
}

/** Finds syntax that makes emit move a parameter into the function body. */
class ScopeChangeFinder extends NodeVisitor {
  readonly options: CompilerOptions;

  constructor(options: CompilerOptions) {
    super();
    this.options = options;
  }

  visitNode(node: Node): boolean {
    return this.requiresScopeChange(node);
  }

  requiresScopeChange(node: Node): boolean {
    switch (node.kind) {
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.Constructor:
        return false;
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.PropertyAssignment:
        return this.requiresScopeChange(getName(node)!);
      case SyntaxKind.PropertyDeclaration:
        if (hasStaticModifier(node)) return !getEmitStandardClassFields(this.options);
        return this.requiresScopeChange(getName(node)!);
    }
    if (isNullishCoalesce(node) || isOptionalChain(node))
      return getEmitScriptTarget(this.options) < ScriptTarget.ES2020;
    if (
      node instanceof BindingElement &&
      (node as BindingElement).dotDotDotToken !== undefined &&
      (node as BindingElement).parent!.kind === SyntaxKind.ObjectBindingPattern
    )
      return getEmitScriptTarget(this.options) < ScriptTarget.ES2017;
    if (isTypeNodeKind(node.kind)) return false;
    return node.forEachChild(this);
  }
}

const noArgs: readonly string[] = [];
const emptyTable: SymbolTable = new Map<string, Symbol>();

/** Whether class fields are emitted as standard `[[Define]]` fields. */
function getEmitStandardClassFields(options: CompilerOptions): boolean {
  return getUseDefineForClassFields(options) && getEmitScriptTarget(options) >= ScriptTarget.ES2022;
}

function symbolOfNode(node: Node): Symbol | undefined {
  return getSymbol(node);
}

function getLocalsOf(node: Node): SymbolTable | undefined {
  return getLocals(node);
}

function isBindingPattern(node: Node): boolean {
  return node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern;
}

function isGlobalScopeAugmentationNode(node: Node): boolean {
  return node instanceof ModuleDeclaration && (node as ModuleDeclaration).keyword === SyntaxKind.GlobalKeyword;
}

function isInParameter(declaration: Node | undefined): boolean {
  for (let current = declaration; current !== undefined; current = current.parent)
    if (current.kind === SyntaxKind.Parameter) return true;
  return false;
}

/** The local symbol of an `export default` declaration. */
export function getLocalSymbolForExportDefault(symbol: Symbol): Symbol | undefined {
  const declarations = getDeclarations(symbol);
  if (declarations.length === 0 || !hasSyntacticModifier(declarations[0]!, ModifierFlags.Default)) return undefined;
  for (const declaration of declarations) {
    const localSymbol = getLocalSymbol(declaration);
    if (localSymbol !== undefined) return localSymbol;
  }
  return undefined;
}

/** Whether a reference at `location` runs later than its scope's own code, like in a function body. */
function isDeferredContext(location: Node, lastLocation: Node | undefined): boolean {
  if (location.kind !== SyntaxKind.ArrowFunction && location.kind !== SyntaxKind.FunctionExpression) {
    // Instance property initializers run in the constructor; a declaration's name runs in its scope.
    return (
      location.kind === SyntaxKind.TypeQuery ||
      ((isFunctionLikeDeclarationKind(location.kind) ||
        (location.kind === SyntaxKind.PropertyDeclaration && !isStatic(location))) &&
        (lastLocation === undefined || lastLocation !== getName(location)))
    );
  }
  if (lastLocation !== undefined && lastLocation === getName(location)) return false;
  // Immediately invoked generators and async functions aren't part of the containing flow.
  if (getAsteriskToken(location) !== undefined || hasSyntacticModifier(location, ModifierFlags.Async)) return true;
  return getImmediatelyInvokedFunctionExpression(location) === undefined;
}

function isTypeParameterSymbolDeclaredInContainer(symbol: Symbol, container: Node): boolean {
  for (const declaration of getDeclarations(symbol))
    if (declaration.kind === SyntaxKind.TypeParameter && declaration.parent === container) return true;
  return false;
}

function isSelfReferenceLocation(node: Node, lastLocation: Node | undefined): boolean {
  switch (node.kind) {
    case SyntaxKind.Parameter:
      return lastLocation !== undefined && lastLocation === getName(node);
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.ModuleDeclaration:
      // `namespace N { N; }`
      return true;
  }
  return false;
}
