// Command bind-oracle prints TypeScript-Go's symbols and bind diagnostics
// for a file, or times parsing and binding with --bench.
//
// Usage: bind-oracle FILE [--bench|--bench-bind] [--named] [--tree] [--flow] [--tables] [--resolve]
//
// --named parses the file as "/" + its base name, with the script kind of its
// extension, instead of as /input.ts. --tree prints the parse tree only.
// --flow and --tables append the flow graph and symbol tables. --bench-bind
// times binding alone. --resolve resolves every identifier as a value, a type and a
// namespace with the binder's default name resolver.
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/binder"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

func parse(text string) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: "/input.ts", PathKey: tspath.PathKey("/input.ts")}
	return parser.ParseSourceFile(opts, text, core.ScriptKindTS)
}

// As the encode oracle: the base name, its script kind, and default module detection.
func parseNamed(name string, text string) *ast.SourceFile {
	fileName := "/" + filepath.Base(name)
	opts := ast.SourceFileParseOptions{FileName: tspath.RootedFilePath(fileName), PathKey: tspath.PathKey(fileName)}
	if !tspath.IsDeclarationFileName(fileName) {
		opts.ExternalModuleIndicatorOptions.Force = tspath.FileExtensionIsOneOf(fileName, []string{tspath.ExtensionCjs, tspath.ExtensionCts, tspath.ExtensionMjs, tspath.ExtensionMts})
	}
	return parser.ParseSourceFile(opts, text, core.GetScriptKindFromFileName(tspath.RootedFilePath(fileName)))
}

func symbol(s *ast.Symbol) string {
	if s == nil {
		return "-"
	}
	return fmt.Sprintf("%q:%d:%d", s.Name(), s.Flags(), len(s.Declarations()))
}

func sortedNames(table ast.SymbolTable) []string {
	names := make([]string, 0, len(table))
	for name := range table {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// Numbers nodes in visit order and symbols and flow nodes in order of first reference.
type ids struct {
	nodes    map[*ast.Node]int
	symbols  map[*ast.Symbol]int
	symList  []*ast.Symbol
	flows    map[*ast.FlowNode]int
	flowList []*ast.FlowNode
}

func (x *ids) node(n *ast.Node) string {
	if n == nil {
		return "-"
	}
	if i, ok := x.nodes[n]; ok {
		return fmt.Sprint(i)
	}
	return fmt.Sprintf("?%d", n.Kind)
}

func (x *ids) sym(s *ast.Symbol) string {
	if s == nil {
		return "-"
	}
	i, ok := x.symbols[s]
	if !ok {
		i = len(x.symList)
		x.symbols[s] = i
		x.symList = append(x.symList, s)
	}
	return fmt.Sprintf("#%d", i)
}

func (x *ids) flow(f *ast.FlowNode) string {
	if f == nil {
		return "-"
	}
	i, ok := x.flows[f]
	if !ok {
		i = len(x.flowList)
		x.flows[f] = i
		x.flowList = append(x.flowList, f)
	}
	return fmt.Sprintf("@%d", i)
}

func (x *ids) table(table ast.SymbolTable) string {
	parts := []string{}
	for _, name := range sortedNames(table) {
		parts = append(parts, fmt.Sprintf("%q=%s", name, x.sym(table[name])))
	}
	return "{" + strings.Join(parts, " ") + "}"
}

func flowNodeOf(n *ast.Node) *ast.FlowNode {
	if data := n.FlowNodeData(); data != nil {
		return data.FlowNode
	}
	return nil
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	text := string(data)
	named, tree, flows, tables, bench, benchBind, resolve := false, false, false, false, false, false, false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--named":
			named = true
		case "--tree":
			tree = true
		case "--flow":
			flows = true
		case "--tables":
			tables = true
		case "--bench":
			bench = true
		case "--bench-bind":
			benchBind = true
		case "--resolve":
			resolve = true
		}
	}
	doParse := func() *ast.SourceFile {
		if named {
			return parseNamed(os.Args[1], text)
		}
		return parse(text)
	}
	if bench {
		start := time.Now()
		for range 20 {
			binder.BindSourceFile(doParse())
		}
		fmt.Printf("time %.2fms\n", float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	if benchBind {
		// Parse first so only binding is timed.
		files := make([]*ast.SourceFile, 20)
		for i := range files {
			files[i] = doParse()
		}
		start := time.Now()
		for _, f := range files {
			binder.BindSourceFile(f)
		}
		fmt.Printf("time %.2fms\n", float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	f := doParse()
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	if tree {
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
		return
	}
	binder.BindSourceFile(f)
	x := &ids{nodes: map[*ast.Node]int{}, symbols: map[*ast.Symbol]int{}, flows: map[*ast.FlowNode]int{}}
	var order []*ast.Node
	var visit func(n *ast.Node, depth int) bool
	visit = func(n *ast.Node, depth int) bool {
		x.nodes[n] = len(order)
		order = append(order, n)
		fmt.Fprintf(w, "%d %d %d %d %d %s %s", depth, n.Kind, n.Pos(), n.End(), n.Flags, symbol(n.Symbol()), symbol(n.LocalSymbol()))
		if locals := n.Locals(); len(locals) > 0 {
			for _, name := range sortedNames(locals) {
				fmt.Fprintf(w, " %s", symbol(locals[name]))
			}
		}
		fmt.Fprintln(w)
		n.ForEachChild(func(c *ast.Node) bool { return visit(c, depth+1) })
		return false
	}
	visit(f.AsNode(), 0)
	for _, d := range f.BindDiagnostics() {
		fmt.Fprintf(w, "diag %d %d %d %s\n", d.Code(), d.Pos(), d.Len(), d.String())
		if tables {
			for _, r := range d.RelatedInformation() {
				fmt.Fprintf(w, "related %d %d %d %s\n", r.Code(), r.Pos(), r.Len(), r.String())
			}
		}
	}
	if resolve {
		resolver := &binder.NameResolver{CompilerOptions: &core.CompilerOptions{}}
		meanings := []ast.SymbolFlags{ast.SymbolFlagsValue, ast.SymbolFlagsType, ast.SymbolFlagsNamespace}
		for i, n := range order {
			if n.Kind != ast.KindIdentifier {
				continue
			}
			parts := []string{}
			for _, meaning := range meanings {
				parts = append(parts, x.sym(resolver.Resolve(n, n.Text(), meaning, nil, false, false)))
			}
			fmt.Fprintf(w, "resolve %d %s\n", i, strings.Join(parts, " "))
		}
	}
	if tables {
		fmt.Fprintf(w, "file symbols=%d cjs=%s module=%s\n", f.SymbolCount, x.node(f.CommonJSModuleIndicator), x.node(f.ExternalModuleIndicator))
		for i, n := range order {
			parts := []string{}
			if s := n.Symbol(); s != nil {
				parts = append(parts, "sym="+x.sym(s))
			}
			if s := n.LocalSymbol(); s != nil {
				parts = append(parts, "local="+x.sym(s))
			}
			if locals := n.Locals(); len(locals) > 0 {
				parts = append(parts, "locals="+x.table(locals))
			}
			if data := n.LocalsContainerData(); data != nil && data.NextContainer != nil {
				parts = append(parts, "next="+x.node(data.NextContainer))
			}
			if len(parts) > 0 {
				fmt.Fprintf(w, "node %d %s\n", i, strings.Join(parts, " "))
			}
		}
		if len(f.GlobalExports) > 0 {
			fmt.Fprintf(w, "global %s\n", x.table(f.GlobalExports))
		}
		for _, p := range f.PatternAmbientModules {
			fmt.Fprintf(w, "pattern %q %d %s\n", p.Pattern.Text, p.Pattern.StarIndex, x.sym(p.Symbol))
		}
		for i := 0; i < len(x.symList); i++ {
			s := x.symList[i]
			decls := []string{}
			for _, d := range s.Declarations() {
				decls = append(decls, x.node(d))
			}
			fmt.Fprintf(w, "symbol #%d %q %d decls=[%s] value=%s parent=%s export=%s", i, s.Name(), s.Flags(), strings.Join(decls, " "), x.node(s.ValueDeclaration()), x.sym(s.Parent()), x.sym(s.ExportSymbol()))
			if len(s.Members()) > 0 {
				fmt.Fprintf(w, " members=%s", x.table(s.Members()))
			}
			if len(s.Exports()) > 0 {
				fmt.Fprintf(w, " exports=%s", x.table(s.Exports()))
			}
			fmt.Fprintln(w)
		}
	}
	if flows {
		for i, n := range order {
			parts := []string{}
			if fl := flowNodeOf(n); fl != nil {
				parts = append(parts, "flow="+x.flow(fl))
			}
			if data := n.BodyData(); data != nil && data.EndFlowNode != nil {
				parts = append(parts, "end="+x.flow(data.EndFlowNode))
			}
			var ret *ast.FlowNode
			switch n.Kind {
			case ast.KindConstructor:
				ret = n.AsConstructorDeclaration().ReturnFlowNode
			case ast.KindClassStaticBlockDeclaration:
				ret = n.AsClassStaticBlockDeclaration().ReturnFlowNode
			case ast.KindCaseClause, ast.KindDefaultClause:
				if ft := n.AsCaseOrDefaultClause().FallthroughFlowNode; ft != nil {
					parts = append(parts, "fallthrough="+x.flow(ft))
				}
			}
			if ret != nil {
				parts = append(parts, "return="+x.flow(ret))
			}
			if len(parts) > 0 {
				fmt.Fprintf(w, "flowof %d %s\n", i, strings.Join(parts, " "))
			}
		}
		for i := 0; i < len(x.flowList); i++ {
			fl := x.flowList[i]
			fmt.Fprintf(w, "flow @%d %d", i, fl.Flags)
			switch {
			case fl.Flags&ast.FlowFlagsSwitchClause != 0:
				data := fl.Node.AsFlowSwitchClauseData()
				fmt.Fprintf(w, " switch=%s %d %d", x.node(data.SwitchStatement), data.ClauseStart, data.ClauseEnd)
			case fl.Flags&ast.FlowFlagsReduceLabel != 0:
				data := fl.Node.AsFlowReduceLabelData()
				fmt.Fprintf(w, " target=%s reduced=[", x.flow(data.Target))
				for l := data.Antecedents; l != nil; l = l.Next {
					fmt.Fprintf(w, " %s", x.flow(l.Flow))
				}
				fmt.Fprint(w, " ]")
			default:
				fmt.Fprintf(w, " node=%s", x.node(fl.Node))
			}
			fmt.Fprintf(w, " ante=%s", x.flow(fl.Antecedent))
			if fl.Antecedents != nil {
				fmt.Fprint(w, " antes=[")
				for l := fl.Antecedents; l != nil; l = l.Next {
					fmt.Fprintf(w, " %s", x.flow(l.Flow))
				}
				fmt.Fprint(w, " ]")
			}
			fmt.Fprintln(w)
		}
	}
}
