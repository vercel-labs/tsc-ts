// Package checkhost is a minimal checker.Program for checking one file
// against the bundled lib files, for the check oracle.
package checkhost

import (
	"context"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/binder"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/module"
	"github.com/microsoft/TypeScript/tsc/internal/packagejson"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/symlinks"
	"github.com/microsoft/TypeScript/tsc/internal/tsoptions"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

// LibDir is the virtual directory of the bundled lib files.
const LibDir = "/libs/"

// libCache keeps parsed lib files across programs; binding is per file, and
// checkers keep their own state, so programs can share them.
var libCache = map[string]*ast.SourceFile{}

type Program struct {
	options *core.CompilerOptions
	files   []*ast.SourceFile
	byPath  map[tspath.PathKey]*ast.SourceFile
	libs    map[tspath.PathKey]bool
}

func parseFile(fileName string, text string) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: tspath.RootedFilePath(fileName), PathKey: tspath.PathKey(fileName)}
	return parser.ParseSourceFile(opts, text, core.GetScriptKindFromFileName(tspath.RootedFilePath(fileName)))
}

// NewProgram parses fileName and the lib files it needs. readLib returns the
// text of a bundled lib file by name.
func NewProgram(fileName string, text string, readLib func(name string) (string, bool)) *Program {
	return NewProgramWithOptions(fileName, text, DefaultOptions(), readLib)
}

// DefaultOptions returns the options of a checked file: strict, ESNext, no emit.
func DefaultOptions() *core.CompilerOptions {
	return &core.CompilerOptions{Strict: core.TSTrue, Target: core.ScriptTargetESNext, NoEmit: core.TSTrue}
}

// NewProgramWithOptions is NewProgram with the given compiler options.
func NewProgramWithOptions(fileName string, text string, options *core.CompilerOptions, readLib func(name string) (string, bool)) *Program {
	p := &Program{
		options: options,
		byPath:  map[tspath.PathKey]*ast.SourceFile{},
		libs:    map[tspath.PathKey]bool{},
	}
	var addLib func(name string)
	addLib = func(name string) {
		path := tspath.PathKey(LibDir + name)
		if p.byPath[path] != nil {
			return
		}
		file := libCache[name]
		if file == nil {
			libText, ok := readLib(name)
			if !ok {
				return
			}
			file = parseFile(LibDir+name, libText)
			libCache[name] = file
		}
		p.byPath[path] = file
		p.libs[path] = true
		for _, ref := range file.LibReferenceDirectives {
			if libName, ok := tsoptions.GetLibFileName(ref.FileName); ok {
				addLib(libName)
			}
		}
		p.files = append(p.files, file)
	}
	addLib(tsoptions.GetDefaultLibFileName(p.options))
	main := parseFile(fileName, text)
	p.byPath[main.PathKey()] = main
	p.files = append(p.files, main)
	return p
}

// Check returns the diagnostics of fileName: syntactic, bind, semantic, and
// global diagnostics, in that order. JS files add their JS-only syntactic and
// JSDoc diagnostics as a program does for a checked JS file.
func Check(fileName string, text string, readLib func(name string) (string, bool)) []*ast.Diagnostic {
	return CheckWithOptions(fileName, text, DefaultOptions(), readLib)
}

// CheckWithOptions is Check with the given compiler options.
func CheckWithOptions(fileName string, text string, options *core.CompilerOptions, readLib func(name string) (string, bool)) []*ast.Diagnostic {
	p := NewProgramWithOptions(fileName, text, options, readLib)
	p.BindSourceFiles()
	c, _ := checker.NewChecker(p, nil)
	file := p.byPath[tspath.PathKey(fileName)]
	var diags []*ast.Diagnostic
	diags = append(diags, file.Diagnostics()...)
	diags = append(diags, file.JSDiagnostics()...)
	diags = append(diags, file.BindDiagnostics()...)
	diags = append(diags, c.GetDiagnostics(context.Background(), file)...)
	diags = append(diags, file.JSDocDiagnostics()...)
	diags = append(diags, c.GetGlobalDiagnostics()...)
	return diags
}

func (p *Program) Options() *core.CompilerOptions  { return p.options }
func (p *Program) SourceFiles() []*ast.SourceFile  { return p.files }
func (p *Program) FileExists(fileName tspath.RootedFilePath) bool {
	return p.byPath[tspath.PathKey(fileName)] != nil
}
func (p *Program) GetSourceFile(fileName string) *ast.SourceFile {
	return p.byPath[tspath.PathKey(fileName)]
}

func (p *Program) GetSourceFileForResolvedModule(resolved *module.ResolvedModule) *ast.SourceFile {
	return p.byPath[tspath.PathKey(resolved.ResolvedFileName)]
}

func (p *Program) BindSourceFiles() {
	for _, file := range p.files {
		if !file.IsBound() {
			binder.BindSourceFile(file)
		}
	}
}

// GetSourceFileMetaData returns what a program finds for a file without a package.json: lib
// files are CommonJS scripts, and the input's format follows from its extension.
func (p *Program) GetSourceFileMetaData(path tspath.PathKey) ast.SourceFileMetaData {
	if p.libs[path] {
		return ast.SourceFileMetaData{ImpliedNodeFormat: core.ResolutionModeCommonJS}
	}
	return ast.SourceFileMetaData{ImpliedNodeFormat: ast.GetImpliedNodeFormatForFile(tspath.RootedFilePath(path), "")}
}

func (p *Program) GetEmitModuleFormatOfFile(sourceFile ast.HasFileName) core.ModuleKind {
	return ast.GetEmitModuleFormatOfFileWorker(sourceFile.FileName(), p.options, p.GetSourceFileMetaData(sourceFile.PathKey()))
}

func (p *Program) GetEmitSyntaxForUsageLocation(sourceFile ast.HasFileName, location *ast.StringLiteralLike) core.ResolutionMode {
	return emitSyntaxForUsageLocation(sourceFile.FileName(), p.GetSourceFileMetaData(sourceFile.PathKey()), location, p.options)
}

func (p *Program) GetImpliedNodeFormatForEmit(sourceFile ast.HasFileName) core.ModuleKind {
	return ast.GetImpliedNodeFormatForEmitWorker(sourceFile.FileName(), p.options.GetEmitModuleKind(), p.GetSourceFileMetaData(sourceFile.PathKey()))
}

func (p *Program) GetResolvedModule(currentSourceFile ast.HasFileName, moduleReference string, mode core.ResolutionMode) *module.ResolvedModule {
	return nil
}

func (p *Program) GetResolvedModules() map[tspath.PathKey]module.ModeAwareCache[*module.ResolvedModule] {
	return nil
}

func (p *Program) GetPackagesMap() map[string]bool { return nil }

func (p *Program) GetJSXRuntimeImportSpecifier(path tspath.PathKey) (moduleReference string, specifier *ast.Node) {
	return "", nil
}

func (p *Program) GetImportHelpersImportSpecifier(path tspath.PathKey) *ast.Node { return nil }

func (p *Program) SourceFileMayBeEmitted(sourceFile *ast.SourceFile, forceDtsEmit bool) bool {
	return !p.libs[sourceFile.PathKey()]
}

func (p *Program) IsSourceFileDefaultLibrary(path tspath.PathKey) bool { return p.libs[path] }

func (p *Program) GetProjectReferenceFromOutputDts(path tspath.PathKey) *tsoptions.SourceOutputAndProjectReference {
	return nil
}

func (p *Program) GetRedirectForResolution(file ast.HasFileName) *tsoptions.ParsedCommandLine {
	return nil
}

func (p *Program) CommonSourceDirectory() tspath.RootedDirectoryPath { return "/" }

// Host methods.

func (p *Program) GetSymlinkCache() *symlinks.KnownSymlinks { return nil }
func (p *Program) ContentMapperExtensions() []string        { return nil }
func (p *Program) ContentMapperExtensionRewrites() []tspath.ExtensionRewrite {
	return nil
}
func (p *Program) GetGlobalTypingsCacheLocation() tspath.RootedDirectoryPath { return "" }
func (p *Program) CaseSensitivity() tspath.CaseSensitivity                  { return tspath.CaseSensitive }
func (p *Program) BaseDirectory() tspath.RootedDirectoryPath                { return "/" }

func (p *Program) GetProjectReferenceFromSource(path tspath.PathKey) *tsoptions.SourceOutputAndProjectReference {
	return nil
}

func (p *Program) GetRedirectTargets(path tspath.PathKey) []tspath.RootedFilePath { return nil }

func (p *Program) GetSourceOfProjectReferenceIfOutputIncluded(file ast.HasFileName) tspath.RootedFilePath {
	return ""
}

func (p *Program) GetNearestAncestorDirectoryWithPackageJson(dirname tspath.RootedDirectoryPath) tspath.RootedDirectoryPath {
	return ""
}

func (p *Program) GetPackageJsonInfo(pkgJsonPath tspath.RootedFilePath) *packagejson.InfoCacheEntry {
	return nil
}

func (p *Program) GetDefaultResolutionModeForFile(file ast.HasFileName) core.ResolutionMode {
	if importSyntaxAffectsModuleResolution(p.options) {
		return ast.GetImpliedNodeFormatForEmitWorker(file.FileName(), p.options.GetEmitModuleKind(), p.GetSourceFileMetaData(file.PathKey()))
	}
	return core.ResolutionModeNone
}

func (p *Program) GetResolvedModuleFromModuleSpecifier(file ast.HasFileName, moduleSpecifier *ast.StringLiteralLike) *module.ResolvedModule {
	return nil
}

// GetModeForUsageLocation, importSyntaxAffectsModuleResolution and emitSyntaxForUsageLocation are
// those of the compiler package (fileloader.go).
func (p *Program) GetModeForUsageLocation(file ast.HasFileName, usage *ast.StringLiteralLike) core.ResolutionMode {
	if ast.IsImportDeclaration(usage.Parent) || usage.Parent.Kind == ast.KindJSImportDeclaration || ast.IsExportDeclaration(usage.Parent) || ast.IsJSDocImportTag(usage.Parent) {
		if ast.IsExclusivelyTypeOnlyImportOrExport(usage.Parent) {
			var override core.ResolutionMode
			var ok bool
			switch usage.Parent.Kind {
			case ast.KindImportDeclaration, ast.KindJSImportDeclaration:
				override, ok = usage.Parent.AsImportDeclaration().Attributes.GetResolutionModeOverride(nil)
			case ast.KindExportDeclaration:
				override, ok = usage.Parent.AsExportDeclaration().Attributes.GetResolutionModeOverride(nil)
			case ast.KindJSDocImportTag:
				override, ok = usage.Parent.AsJSDocImportTag().Attributes.GetResolutionModeOverride(nil)
			}
			if ok {
				return override
			}
		}
	}
	if ast.IsLiteralTypeNode(usage.Parent) && ast.IsImportTypeNode(usage.Parent.Parent) {
		if override, ok := usage.Parent.Parent.AsImportTypeNode().Attributes.GetResolutionModeOverride(nil); ok {
			return override
		}
	}
	if importSyntaxAffectsModuleResolution(p.options) {
		return emitSyntaxForUsageLocation(file.FileName(), p.GetSourceFileMetaData(file.PathKey()), usage, p.options)
	}
	return core.ResolutionModeNone
}

func importSyntaxAffectsModuleResolution(options *core.CompilerOptions) bool {
	moduleResolution := options.GetModuleResolutionKind()
	return core.ModuleResolutionKindNode16 <= moduleResolution && moduleResolution <= core.ModuleResolutionKindNodeNext ||
		options.GetResolvePackageJsonExports() || options.GetResolvePackageJsonImports()
}

func emitSyntaxForUsageLocation(fileName tspath.RootedFilePath, meta ast.SourceFileMetaData, usage *ast.Node, options *core.CompilerOptions) core.ResolutionMode {
	if ast.IsRequireCall(usage.Parent, false) || ast.IsExternalModuleReference(usage.Parent) && ast.IsImportEqualsDeclaration(usage.Parent.Parent) {
		return core.ModuleKindCommonJS
	}
	fileEmitMode := ast.GetEmitModuleFormatOfFileWorker(fileName, options, meta)
	if call := ast.WalkUpParenthesizedExpressions(usage.Parent); ast.IsImportCall(call) {
		if ast.IsSourcePhaseImportCall(call) {
			return core.ModuleKindESNext
		}
		if ast.ShouldTransformImportCall(fileName, options, fileEmitMode) {
			return core.ModuleKindCommonJS
		}
		return core.ModuleKindESNext
	}
	if fileEmitMode == core.ModuleKindCommonJS {
		return core.ModuleKindCommonJS
	}
	if fileEmitMode.IsNonNodeESM() || fileEmitMode == core.ModuleKindPreserve {
		return core.ModuleKindESNext
	}
	return core.ModuleKindNone
}

var _ checker.Program = (*Program)(nil)
