// Command check-oracle prints TypeScript-Go's diagnostics for a file checked
// against the bundled libs, or times checking with --bench. A .tsx file is
// checked as /input.tsx with the JSX options of its @jsx, @jsxFactory,
// @jsxFragmentFactory and @jsxImportSource directives. A test case whose files
// are all JavaScript and that sets @checkJs is checked as /input.js with
// allowJs and checkJs. TSC_TS_CHECK_OPTIONS lists options for every input,
// separated by commas: names of boolean options to turn on, module,
// moduleResolution and target as name=value, and the strict family,
// allowUnreachableCode and allowUnusedLabels as name=true or name=false. With
// TSC_TS_CHECK_DECLARATION=1, a .ts test case is checked as the declaration file
// /input.d.ts.
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checkhost"
	"github.com/microsoft/TypeScript/tsc/internal/core"
)

var moduleKinds = map[string]core.ModuleKind{
	"commonjs": core.ModuleKindCommonJS,
	"es2015":   core.ModuleKindES2015,
	"es2020":   core.ModuleKindES2020,
	"es2022":   core.ModuleKindES2022,
	"esnext":   core.ModuleKindESNext,
	"node16":   core.ModuleKindNode16,
	"node18":   core.ModuleKindNode18,
	"node20":   core.ModuleKindNode20,
	"nodenext": core.ModuleKindNodeNext,
	"preserve": core.ModuleKindPreserve,
}

var moduleResolutionKinds = map[string]core.ModuleResolutionKind{
	"node10":   core.ModuleResolutionKindNode10,
	"node16":   core.ModuleResolutionKindNode16,
	"nodenext": core.ModuleResolutionKindNodeNext,
	"bundler":  core.ModuleResolutionKindBundler,
}

var scriptTargets = map[string]core.ScriptTarget{
	"es5":    core.ScriptTargetES5,
	"es2015": core.ScriptTargetES2015,
	"es2016": core.ScriptTargetES2016,
	"es2017": core.ScriptTargetES2017,
	"es2018": core.ScriptTargetES2018,
	"es2019": core.ScriptTargetES2019,
	"es2020": core.ScriptTargetES2020,
	"es2021": core.ScriptTargetES2021,
	"es2022": core.ScriptTargetES2022,
	"es2023": core.ScriptTargetES2023,
	"es2024": core.ScriptTargetES2024,
	"esnext": core.ScriptTargetESNext,
}

// setOption sets an entry of TSC_TS_CHECK_OPTIONS (a boolean option's name, or name=value), and
// reports whether it is one TSC_TS_CHECK_OPTIONS takes.
func setOption(options *core.CompilerOptions, entry string) bool {
	if name, value, ok := strings.Cut(entry, "="); ok {
		switch name {
		case "module":
			kind, ok := moduleKinds[value]
			options.Module = kind
			return ok
		case "moduleResolution":
			kind, ok := moduleResolutionKinds[value]
			options.ModuleResolution = kind
			return ok
		case "target":
			target, ok := scriptTargets[value]
			options.Target = target
			return ok
		}
		if value != "true" && value != "false" {
			return false
		}
		flag := core.TSFalse
		if value == "true" {
			flag = core.TSTrue
		}
		switch name {
		case "strict":
			options.Strict = flag
			return true
		case "strictNullChecks":
			options.StrictNullChecks = flag
			return true
		case "noImplicitAny":
			options.NoImplicitAny = flag
			return true
		case "strictFunctionTypes":
			options.StrictFunctionTypes = flag
			return true
		case "strictBindCallApply":
			options.StrictBindCallApply = flag
			return true
		case "strictPropertyInitialization":
			options.StrictPropertyInitialization = flag
			return true
		case "noImplicitThis":
			options.NoImplicitThis = flag
			return true
		case "useUnknownInCatchVariables":
			options.UseUnknownInCatchVariables = flag
			return true
		case "alwaysStrict":
			options.AlwaysStrict = flag
			return true
		case "strictBuiltinIteratorReturn":
			options.StrictBuiltinIteratorReturn = flag
			return true
		case "allowUnreachableCode":
			options.AllowUnreachableCode = flag
			return true
		case "allowUnusedLabels":
			options.AllowUnusedLabels = flag
			return true
		}
		return false
	}
	switch entry {
	case "exactOptionalPropertyTypes":
		options.ExactOptionalPropertyTypes = core.TSTrue
	case "noUncheckedIndexedAccess":
		options.NoUncheckedIndexedAccess = core.TSTrue
	case "isolatedModules":
		options.IsolatedModules = core.TSTrue
	case "verbatimModuleSyntax":
		options.VerbatimModuleSyntax = core.TSTrue
	case "erasableSyntaxOnly":
		options.ErasableSyntaxOnly = core.TSTrue
	case "noImplicitOverride":
		options.NoImplicitOverride = core.TSTrue
	case "noPropertyAccessFromIndexSignature":
		options.NoPropertyAccessFromIndexSignature = core.TSTrue
	case "noImplicitReturns":
		options.NoImplicitReturns = core.TSTrue
	case "noFallthroughCasesInSwitch":
		options.NoFallthroughCasesInSwitch = core.TSTrue
	case "noUnusedLocals":
		options.NoUnusedLocals = core.TSTrue
	case "noUnusedParameters":
		options.NoUnusedParameters = core.TSTrue
	default:
		return false
	}
	return true
}

var extraOptions = strings.FieldsFunc(os.Getenv("TSC_TS_CHECK_OPTIONS"), func(r rune) bool { return r == ',' })

// newOptions returns the default options with those of TSC_TS_CHECK_OPTIONS turned on.
func newOptions() *core.CompilerOptions {
	options := checkhost.DefaultOptions()
	for _, name := range extraOptions {
		setOption(options, name)
	}
	return options
}

var directive = regexp.MustCompile(`(?im)^[ \t]*//[ \t]*@(\w+)[ \t]*:([^\r\n]*)`)

var jsxEmits = map[string]core.JsxEmit{
	"preserve":     core.JsxEmitPreserve,
	"react-native": core.JsxEmitReactNative,
	"react":        core.JsxEmitReact,
	"react-jsx":    core.JsxEmitReactJSX,
	"react-jsxdev": core.JsxEmitReactJSXDev,
}

var jsExtension = regexp.MustCompile(`(?i)\.(js|jsx|cjs|mjs)$`)

// isCheckedJS reports whether a test case sets @checkJs and all its @filename units are JavaScript.
func isCheckedJS(text string) bool {
	units := 0
	checkJs := false
	for _, m := range directive.FindAllStringSubmatch(text, -1) {
		value := strings.TrimSpace(m[2])
		switch strings.ToLower(m[1]) {
		case "filename":
			if !jsExtension.MatchString(value) {
				return false
			}
			units++
		case "checkjs":
			checkJs = strings.ToLower(strings.TrimSpace(strings.Split(value, ",")[0])) == "true"
		}
	}
	return units > 0 && checkJs
}

func check(path string, text string, readLib func(name string) (string, bool)) []*ast.Diagnostic {
	if !strings.HasSuffix(path, ".tsx") {
		if isCheckedJS(text) {
			options := newOptions()
			options.AllowJs = core.TSTrue
			options.CheckJs = core.TSTrue
			return checkhost.CheckWithOptions("/input.js", text, options, readLib)
		}
		if os.Getenv("TSC_TS_CHECK_DECLARATION") == "1" {
			return checkhost.CheckWithOptions("/input.d.ts", text, newOptions(), readLib)
		}
		return checkhost.CheckWithOptions("/input.ts", text, newOptions(), readLib)
	}
	options := newOptions()
	for _, m := range directive.FindAllStringSubmatch(text, -1) {
		value := strings.TrimSpace(strings.Split(m[2], ",")[0])
		switch strings.ToLower(m[1]) {
		case "jsx":
			options.Jsx = jsxEmits[strings.ToLower(value)]
		case "jsxfactory":
			options.JsxFactory = value
		case "jsxfragmentfactory":
			options.JsxFragmentFactory = value
		case "jsximportsource":
			options.JsxImportSource = value
		}
	}
	return checkhost.CheckWithOptions("/input.tsx", text, options, readLib)
}

func main() {
	for _, name := range extraOptions {
		if !setOption(checkhost.DefaultOptions(), name) {
			fmt.Fprintf(os.Stderr, "unknown option in TSC_TS_CHECK_OPTIONS: %s\n", name)
			os.Exit(2)
		}
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	libDir := os.Args[2]
	readLib := func(name string) (string, bool) {
		b, err := os.ReadFile(filepath.Join(libDir, name))
		return string(b), err == nil
	}
	text := string(data)
	if len(os.Args) > 3 && os.Args[3] == "--batch" {
		// The first argument lists input files, one per line.
		w := bufio.NewWriter(os.Stdout)
		defer w.Flush()
		for _, line := range strings.Split(text, "\n") {
			if line == "" {
				continue
			}
			input, err := os.ReadFile(line)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "== %s\n", line)
			func() {
				defer func() {
					if r := recover(); r != nil {
						fmt.Fprintf(w, "!! panic\n")
					}
				}()
				print(w, check(line, string(input), readLib))
			}()
		}
		return
	}
	if len(os.Args) > 3 && os.Args[3] == "--bench" {
		start := time.Now()
		var diags []*ast.Diagnostic
		for range 5 {
			diags = check(os.Args[1], text, readLib)
		}
		fmt.Printf("diagnostics %d time %.2fms\n", len(diags), float64(time.Since(start).Microseconds())/1000/5)
		return
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	print(w, check(os.Args[1], text, readLib))
}

func print(w *bufio.Writer, diags []*ast.Diagnostic) {
	for _, d := range diags {
		name := ""
		if d.File() != nil {
			name = string(d.File().FileName())
		}
		fmt.Fprintf(w, "%s %d %d %d %s\n", name, d.Code(), d.Pos(), d.Len(), d.String())
	}
}
