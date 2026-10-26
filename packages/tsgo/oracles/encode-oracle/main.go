// Command encode-oracle parses a file the way the compiler host and the API do and
// writes tsgo's binary AST encoding of it, a tree dump in encoder order (--tree), or
// timings (--bench, --bench-encode).
//
// Usage: encode-oracle FILE [--tree|--bench|--bench-encode] [--jsx] [--force]
//
// The file is parsed as "/" + its base name, so output doesn't depend on its location.
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/api/encoder"
	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
	"github.com/zeebo/xxh3"
)

func parse(fileName string, text string, jsx bool, force bool) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: tspath.RootedFilePath(fileName), PathKey: tspath.PathKey(fileName)}
	if !tspath.IsDeclarationFileName(fileName) {
		// As GetExternalModuleIndicatorOptions with default compiler options.
		opts.ExternalModuleIndicatorOptions.Force = tspath.FileExtensionIsOneOf(fileName, []string{tspath.ExtensionCjs, tspath.ExtensionCts, tspath.ExtensionMjs, tspath.ExtensionMts})
	}
	if jsx {
		opts.ExternalModuleIndicatorOptions.JSX = true
	}
	if force {
		opts.ExternalModuleIndicatorOptions.Force = true
	}
	file := parser.ParseSourceFile(opts, text, core.GetScriptKindFromFileName(tspath.RootedFilePath(fileName)))
	file.Hash = xxh3.HashString128(text)
	return file
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	text := string(data)
	fileName := "/" + filepath.Base(os.Args[1])
	mode := ""
	jsx, force := false, false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--jsx":
			jsx = true
		case "--force":
			force = true
		default:
			mode = arg
		}
	}
	switch mode {
	case "--bench":
		start := time.Now()
		nodes := 0
		for range 20 {
			nodes += parse(fileName, text, jsx, force).NodeCount
		}
		fmt.Printf("nodes %d time %.2fms\n", nodes/20, float64(time.Since(start).Microseconds())/1000/20)
	case "--bench-encode":
		file := parse(fileName, text, jsx, force)
		size := 0
		start := time.Now()
		for range 20 {
			bytes, _, err := encoder.EncodeSourceFile(file)
			if err != nil {
				panic(err)
			}
			size = len(bytes)
		}
		fmt.Printf("bytes %d time %.2fms\n", size, float64(time.Since(start).Microseconds())/1000/20)
	case "--tree":
		w := bufio.NewWriter(os.Stdout)
		defer w.Flush()
		tree(w, parse(fileName, text, jsx, force))
	case "":
		bytes, _, err := encoder.EncodeSourceFile(parse(fileName, text, jsx, force))
		if err != nil {
			panic(err)
		}
		os.Stdout.Write(bytes)
	default:
		panic("unknown option " + mode)
	}
}

// tree prints every node and node list in the encoder's order (JSDoc after each node's
// children), then diagnostics and file metadata. Positions are UTF-8 offsets.
func tree(w *bufio.Writer, file *ast.SourceFile) {
	depth := 0
	visitor := ast.NewNodeVisitor(nil, nil, ast.NodeVisitorHooks{
		VisitNodes: func(list *ast.NodeList, v *ast.NodeVisitor) *ast.NodeList {
			if list == nil {
				return nil
			}
			fmt.Fprintf(w, "%d L %d %d %d\n", depth, list.Pos(), list.End(), len(list.Nodes))
			depth++
			v.VisitSlice(list.Nodes)
			depth--
			return list
		},
		VisitModifiers: func(modifiers *ast.ModifierList, v *ast.NodeVisitor) *ast.ModifierList {
			if modifiers != nil && len(modifiers.Nodes) > 0 {
				v.Hooks.VisitNodes(&modifiers.NodeList, v)
			}
			return modifiers
		},
	})
	// The node whose children are being visited; a node with another parent is marked.
	var container *ast.Node
	var visit func(n *ast.Node) *ast.Node
	visit = func(n *ast.Node) *ast.Node {
		fmt.Fprintf(w, "%d %d %d %d %d", depth, n.Kind, n.Pos(), n.End(), n.Flags)
		if n.Parent != container {
			if n.Parent == nil {
				fmt.Fprint(w, " ^nil")
			} else {
				fmt.Fprintf(w, " ^%d@%d", n.Parent.Kind, n.Parent.Pos())
			}
		}
		fmt.Fprintln(w)
		saveContainer := container
		container = n
		depth++
		visitor.VisitEachChild(n)
		for _, jsdoc := range n.JSDoc(file) {
			visit(jsdoc)
		}
		depth--
		container = saveContainer
		return n
	}
	visitor.Visit = visit
	visit(file.AsNode())
	for _, d := range file.Diagnostics() {
		fmt.Fprintf(w, "diag %d %d %d %s\n", d.Code(), d.Pos(), d.Len(), d.String())
	}
	for _, d := range file.JSDiagnostics() {
		fmt.Fprintf(w, "jsdiag %d %d %d %s\n", d.Code(), d.Pos(), d.Len(), d.String())
	}
	for _, d := range file.JSDocDiagnostics() {
		fmt.Fprintf(w, "jsdocdiag %d %d %d %s\n", d.Code(), d.Pos(), d.Len(), d.String())
	}
	for _, n := range file.Imports() {
		fmt.Fprintf(w, "import %d %d %d\n", n.Kind, n.Pos(), n.End())
	}
	for _, n := range file.ModuleAugmentations {
		fmt.Fprintf(w, "augmentation %d %d %d\n", n.Kind, n.Pos(), n.End())
	}
	for _, name := range file.AmbientModuleNames {
		fmt.Fprintf(w, "ambient %q\n", name)
	}
	if n := file.ExternalModuleIndicator; n != nil {
		fmt.Fprintf(w, "module %d %d %d\n", n.Kind, n.Pos(), n.End())
	}
	references := func(label string, refs []*ast.FileReference) {
		for _, ref := range refs {
			fmt.Fprintf(w, "%s %d %d %q %d %t\n", label, ref.Pos(), ref.End(), ref.FileName, ref.ResolutionMode, ref.Preserve)
		}
	}
	references("reference", file.ReferencedFiles)
	references("types", file.TypeReferenceDirectives)
	references("lib", file.LibReferenceDirectives)
	for _, pragma := range file.Pragmas {
		fmt.Fprintf(w, "pragma %s\n", pragma.Name)
	}
	if d := file.CheckJsDirective; d != nil {
		fmt.Fprintf(w, "checkjs %t %d %d\n", d.Enabled, d.Range.Pos(), d.Range.End())
	}
	for _, d := range file.CommentDirectives {
		fmt.Fprintf(w, "directive %d %d %d\n", d.Kind, d.Loc.Pos(), d.Loc.End())
	}
	fmt.Fprintf(w, "file %d %d %t\n", file.LanguageVariant, file.ScriptKind, file.IsDeclarationFile)
}
