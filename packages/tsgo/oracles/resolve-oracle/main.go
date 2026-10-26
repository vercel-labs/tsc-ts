// Command resolve-oracle prints TypeScript-Go's module and type reference
// resolutions for JSON cases (an array, read from the file named by the first
// argument) as a JSON array on stdout.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/microsoft/TypeScript/tsc/internal/collections"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/diagnostics"
	"github.com/microsoft/TypeScript/tsc/internal/module"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/microsoft/TypeScript/tsc/internal/vfs"
	"github.com/microsoft/TypeScript/tsc/internal/vfs/vfstest"
)

type pathMapping struct {
	Key    string   `json:"key"`
	Values []string `json:"values"`
}

type options struct {
	ModuleResolution          int           `json:"moduleResolution"`
	Module                    int           `json:"module"`
	Target                    int           `json:"target"`
	AllowJs                   *bool         `json:"allowJs"`
	CheckJs                   *bool         `json:"checkJs"`
	ResolveJsonModule         *bool         `json:"resolveJsonModule"`
	ResolvePackageJsonExports *bool         `json:"resolvePackageJsonExports"`
	ResolvePackageJsonImports *bool         `json:"resolvePackageJsonImports"`
	NoDtsResolution           *bool         `json:"noDtsResolution"`
	PreserveSymlinks          *bool         `json:"preserveSymlinks"`
	TraceResolution           *bool         `json:"traceResolution"`
	CustomConditions          []string      `json:"customConditions"`
	ModuleSuffixes            []string      `json:"moduleSuffixes"`
	RootDirs                  []string      `json:"rootDirs"`
	TypeRoots                 []string      `json:"typeRoots"`
	Types                     []string      `json:"types"`
	Paths                     []pathMapping `json:"paths"`
	PathsBasePath             string        `json:"pathsBasePath"`
	ConfigFilePath            string        `json:"configFilePath"`
	OutDir                    string        `json:"outDir"`
	DeclarationDir            string        `json:"declarationDir"`
	RootDir                   string        `json:"rootDir"`
}

func tristate(b *bool) core.Tristate {
	if b == nil {
		return core.TSUnknown
	}
	if *b {
		return core.TSTrue
	}
	return core.TSFalse
}

func (o *options) toCompilerOptions() *core.CompilerOptions {
	result := &core.CompilerOptions{
		ModuleResolution:          core.ModuleResolutionKind(o.ModuleResolution),
		Module:                    core.ModuleKind(o.Module),
		Target:                    core.ScriptTarget(o.Target),
		AllowJs:                   tristate(o.AllowJs),
		CheckJs:                   tristate(o.CheckJs),
		ResolveJsonModule:         tristate(o.ResolveJsonModule),
		ResolvePackageJsonExports: tristate(o.ResolvePackageJsonExports),
		ResolvePackageJsonImports: tristate(o.ResolvePackageJsonImports),
		NoDtsResolution:           tristate(o.NoDtsResolution),
		PreserveSymlinks:          tristate(o.PreserveSymlinks),
		TraceResolution:           tristate(o.TraceResolution),
		CustomConditions:          o.CustomConditions,
		ModuleSuffixes:            o.ModuleSuffixes,
		RootDirs:                  directories(o.RootDirs),
		TypeRoots:                 directories(o.TypeRoots),
		Types:                     o.Types,
		PathsBasePath:             tspath.RootedDirectoryPath(o.PathsBasePath),
		ConfigFilePath:            tspath.RootedFilePath(o.ConfigFilePath),
		OutDir:                    tspath.RootedDirectoryPath(o.OutDir),
		DeclarationDir:            tspath.RootedDirectoryPath(o.DeclarationDir),
		RootDir:                   tspath.RootedDirectoryPath(o.RootDir),
	}
	if o.Paths != nil {
		paths := collections.NewOrderedMapWithSizeHint[string, []string](len(o.Paths))
		for _, p := range o.Paths {
			paths.Set(p.Key, p.Values)
		}
		result.Paths = paths
	}
	return result
}

type request struct {
	Kind           string `json:"kind"` // "module", "type" or "automaticTypes"
	Name           string `json:"name"`
	ContainingFile string `json:"containingFile"`
	Mode           int    `json:"mode"`
	Redirect       bool   `json:"redirect"`
}

type redirect struct {
	ConfigName string   `json:"configName"`
	Options    *options `json:"options"`
}

type testCase struct {
	Files                     map[string]string `json:"files"`
	Symlinks                  map[string]string `json:"symlinks"`
	UseCaseSensitiveFileNames bool              `json:"useCaseSensitiveFileNames"`
	CurrentDirectory          string            `json:"currentDirectory"`
	Options                   options           `json:"options"`
	TypingsLocation           string            `json:"typingsLocation"`
	ProjectName               string            `json:"projectName"`
	Redirect                  *redirect         `json:"redirect"`
	Requests                  []request         `json:"requests"`
}

type packageID struct {
	Name             string `json:"name"`
	SubModuleName    string `json:"subModuleName"`
	Version          string `json:"version"`
	PeerDependencies string `json:"peerDependencies"`
}

type result struct {
	ResolvedFileName         string     `json:"resolvedFileName"`
	OriginalPath             string     `json:"originalPath"`
	Extension                string     `json:"extension"`
	ResolvedUsingTsExtension bool       `json:"resolvedUsingTsExtension"`
	IsExternalLibraryImport  bool       `json:"isExternalLibraryImport"`
	PackageID                *packageID `json:"packageId"`
	AlternateResult          string     `json:"alternateResult"`
	Primary                  bool       `json:"primary"`
	Diagnostics              []string   `json:"diagnostics"`
	Traces                   []string   `json:"traces"`
	Names                    []string   `json:"names,omitempty"`
	Error                    string     `json:"error,omitempty"`
}

type host struct {
	fs  vfs.FS
	cwd string
}

func (h *host) FS() vfs.FS { return h.fs }
func (h *host) GetCurrentDirectory() tspath.RootedDirectoryPath {
	return tspath.RootedDirectoryPath(h.cwd)
}

type projectReference struct {
	name    string
	options *core.CompilerOptions
}

func (p *projectReference) ConfigName() tspath.RootedFilePath      { return tspath.RootedFilePath(p.name) }
func (p *projectReference) CompilerOptions() *core.CompilerOptions { return p.options }

func format(m *diagnostics.Message, args []any) string {
	return diagnostics.Format(m.String(), diagnostics.StringifyArgs(args))
}

func formatTraces(traces []module.DiagAndArgs) []string {
	lines := make([]string, 0, len(traces))
	for _, t := range traces {
		lines = append(lines, format(t.Message, t.Args))
	}
	return lines
}

func toPackageID(id module.PackageId) *packageID {
	if id.Name == "" {
		return nil
	}
	return &packageID{id.Name, id.SubModuleName, id.Version, id.PeerDependencies}
}

func run(c *testCase) []*result {
	files := make(map[string]any, len(c.Files)+len(c.Symlinks))
	for name, text := range c.Files {
		files[name] = text
	}
	for link, target := range c.Symlinks {
		files[link] = vfstest.Symlink(target)
	}
	h := &host{fs: vfstest.FromMap(files, caseSensitivity(c.UseCaseSensitiveFileNames)), cwd: c.CurrentDirectory}
	compilerOptions := c.Options.toCompilerOptions()
	resolver := module.NewResolver(module.ResolverOptions{
		Host:            h,
		CompilerOptions: compilerOptions,
		TypingsLocation: tspath.RootedDirectoryPath(c.TypingsLocation),
		ProjectName:     c.ProjectName,
	})
	var ref module.ResolvedProjectReference
	if c.Redirect != nil {
		var redirectOptions *core.CompilerOptions
		if c.Redirect.Options != nil {
			redirectOptions = c.Redirect.Options.toCompilerOptions()
		}
		ref = &projectReference{c.Redirect.ConfigName, redirectOptions}
	}
	results := make([]*result, 0, len(c.Requests))
	for _, req := range c.Requests {
		results = append(results, resolve(resolver, h, compilerOptions, ref, req))
	}
	return results
}

func resolve(resolver *module.DefaultResolver, h *host, compilerOptions *core.CompilerOptions, ref module.ResolvedProjectReference, req request) (res *result) {
	res = &result{}
	defer func() {
		if r := recover(); r != nil {
			res = &result{Error: "panic"}
		}
	}()
	var redirect module.ResolvedProjectReference
	if req.Redirect {
		redirect = ref
	}
	mode := core.ResolutionMode(req.Mode)
	switch req.Kind {
	case "module":
		r, traces, _ := resolver.ResolveModuleName(req.Name, tspath.RootedFilePath(req.ContainingFile), mode, redirect)
		res.ResolvedFileName = string(r.ResolvedFileName)
		res.OriginalPath = string(r.OriginalPath)
		res.Extension = r.Extension
		res.ResolvedUsingTsExtension = r.ResolvedUsingTsExtension
		res.IsExternalLibraryImport = r.IsExternalLibraryImport
		res.PackageID = toPackageID(r.PackageId)
		res.AlternateResult = string(r.AlternateResult)
		for _, d := range r.ResolutionDiagnostics {
			res.Diagnostics = append(res.Diagnostics, fmt.Sprintf("%d %s", d.Code(), d.String()))
		}
		res.Traces = formatTraces(traces)
	case "type":
		r, traces := resolver.ResolveTypeReferenceDirective(req.Name, tspath.RootedFilePath(req.ContainingFile), mode, redirect)
		res.ResolvedFileName = string(r.ResolvedFileName)
		res.OriginalPath = string(r.OriginalPath)
		res.Primary = r.Primary
		res.IsExternalLibraryImport = r.IsExternalLibraryImport
		res.PackageID = toPackageID(r.PackageId)
		for _, d := range r.ResolutionDiagnostics {
			res.Diagnostics = append(res.Diagnostics, fmt.Sprintf("%d %s", d.Code(), d.String()))
		}
		res.Traces = formatTraces(traces)
	case "automaticTypes":
		res.Names = module.GetAutomaticTypeDirectiveNames(compilerOptions, h.GetCurrentDirectory(), h.fs)
		if res.Names == nil {
			res.Names = []string{}
		}
	case "path":
		// Path utilities applied to Name (a) and ContainingFile (b).
		a, b := req.Name, req.ContainingFile
		res.Names = []string{
			tspath.NormalizePath(a),
			tspath.GetNormalizedAbsolutePath(a, tspath.RootedDirectoryPath(b)),
			tspath.CombinePaths(b, a),
			tspath.GetDirectoryPath(a),
			tspath.GetBaseFileName(a),
			strings.Join(tspath.GetPathComponents(tspath.CombinePaths(b, a)), "|"),
			toPath(a, b),
			strconv.Itoa(tspath.ComparePaths(a, b, tspath.CaseInsensitive)),
			strconv.FormatBool(tspath.ContainsPath(b, a, tspath.CaseSensitive)),
			tspath.RemoveFileExtension(a),
			tspath.TryGetExtensionFromPath(a),
			tspath.GetDeclarationFileExtension(a),
			tspath.ChangeExtension(a, ".js"),
			strconv.FormatBool(tspath.IsExternalModuleNameRelative(a)),
			strconv.Itoa(tspath.GetEncodedRootLength(a)),
			tspath.ResolvePath(b, a),
		}
	case "config":
		r := module.ResolveConfig(req.Name, tspath.RootedFilePath(req.ContainingFile), h.fs)
		res.ResolvedFileName = string(r.ResolvedFileName)
		res.Extension = r.Extension
		res.IsExternalLibraryImport = r.IsExternalLibraryImport
		res.PackageID = toPackageID(r.PackageId)
	}
	return res
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var cases []testCase
	if err := json.Unmarshal(data, &cases); err != nil {
		panic(err)
	}
	all := make([][]*result, 0, len(cases))
	for i := range cases {
		all = append(all, runSafely(&cases[i]))
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(all); err != nil {
		panic(err)
	}
}

func runSafely(c *testCase) (results []*result) {
	defer func() {
		if r := recover(); r != nil {
			results = []*result{{Error: "panic"}}
		}
	}()
	return run(c)
}

func directories(paths []string) []tspath.RootedDirectoryPath {
	if paths == nil {
		return nil
	}
	result := make([]tspath.RootedDirectoryPath, len(paths))
	for i, p := range paths {
		result[i] = tspath.RootedDirectoryPath(p)
	}
	return result
}

func caseSensitivity(sensitive bool) tspath.CaseSensitivity {
	if sensitive {
		return tspath.CaseSensitive
	}
	return tspath.CaseInsensitive
}

// toPath is a case-insensitive path key of fileName relative to basePath, as the "path" requests
// compare it.
func toPath(fileName string, basePath string) string {
	if tspath.IsRootedDiskPath(fileName) {
		return tspath.ToFileNameLowerCase(tspath.NormalizePath(fileName))
	}
	return tspath.ToFileNameLowerCase(tspath.GetNormalizedAbsolutePath(fileName, tspath.RootedDirectoryPath(basePath)))
}
