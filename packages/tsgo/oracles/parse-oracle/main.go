// Command parse-oracle prints TypeScript-Go's syntax tree and parse
// diagnostics for a file, or times parsing with --bench.
package main

import (
	"bufio"
	"fmt"
	"os"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

func parse(name, text string) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: tspath.RootedFilePath("/" + name), PathKey: tspath.PathKey("/" + name)}
	return parser.ParseSourceFile(opts, text, core.ScriptKindTS)
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	text := string(data)
	if len(os.Args) > 2 && os.Args[2] == "--bench" {
		start := time.Now()
		nodes := 0
		for range 20 {
			f := parse("input.ts", text)
			nodes += f.NodeCount
		}
		fmt.Printf("nodes %d time %.2fms\n", nodes/20, float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	f := parse("input.ts", text)
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	var visit func(n *ast.Node, depth int) bool
	visit = func(n *ast.Node, depth int) bool {
		fmt.Fprintf(w, "%d %d %d %d %d\n", depth, n.Kind, n.Pos(), n.End(), n.Flags)
		n.ForEachChild(func(c *ast.Node) bool { return visit(c, depth+1) })
		return false
	}
	visit(f.AsNode(), 0)
	for _, d := range f.Diagnostics() {
		fmt.Fprintf(w, "diag %d %d %d %s\n", d.Code(), d.Pos(), d.Len(), d.String())
	}
}
