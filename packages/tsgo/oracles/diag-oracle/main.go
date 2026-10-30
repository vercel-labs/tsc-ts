// Command diag-oracle prints TypeScript-Go's diagnostic messages, their
// translations, locale matching, message formatting and diagnostic output
// for the JSON request in the file named by the first argument, as JSON on
// stdout.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf16"
	_ "unsafe"

	tsast "github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/diagnostics"
	"github.com/microsoft/TypeScript/tsc/internal/diagnosticwriter"
	"github.com/microsoft/TypeScript/tsc/internal/locale"
	tsparser "github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

//go:linkname keyToMessage github.com/microsoft/TypeScript/tsc/internal/diagnostics.keyToMessage
func keyToMessage(key diagnostics.Key) *diagnostics.Message

type file struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

type diagnostic struct {
	File    int          `json:"file"`
	Pos     int          `json:"pos"`
	End     int          `json:"end"`
	Key     string       `json:"key"`
	Args    []string     `json:"args"`
	Chain   []diagnostic `json:"chain"`
	Related []diagnostic `json:"related"`
}

type render struct {
	Locale                    string       `json:"locale"`
	CurrentDirectory          string       `json:"currentDirectory"`
	UseCaseSensitiveFileNames bool         `json:"useCaseSensitiveFileNames"`
	NewLine                   string       `json:"newLine"`
	Files                     []file       `json:"files"`
	Diagnostics               []diagnostic `json:"diagnostics"`
}

type format struct {
	Locale string   `json:"locale"`
	Key    string   `json:"key"`
	Args   []string `json:"args"`
}

type request struct {
	Locales []string `json:"locales"`
	Matches []string `json:"matches"`
	Formats []format `json:"formats"`
	Renders []render `json:"renders"`
}

type message struct {
	Name     string `json:"name"`
	Code     int32  `json:"code"`
	Category string `json:"category"`
	Key      string `json:"key"`
	Text     string `json:"text"`
	Flags    int    `json:"flags"`
}

type rendered struct {
	Plain     string   `json:"plain"`
	Pretty    string   `json:"pretty"`
	Summary   string   `json:"summary"`
	Flattened []string `json:"flattened"`
	Status    []string `json:"status"`
}

type response struct {
	Messages  []message           `json:"messages"`
	Localized map[string][]string `json:"localized"`
	Matches   []string            `json:"matches"`
	Formats   []string            `json:"formats"`
	Renders   []rendered          `json:"renders"`
}

type declared struct {
	name    string
	message *diagnostics.Message
}

// The messages in declaration order, read from the generated Go source and
// resolved to the compiled message values.
func readMessages() []declared {
	_, self, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(self), "../../internal/diagnostics/diagnostics_generated.go")
	parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		panic(err)
	}
	var result []declared
	for _, decl := range parsed.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.VAR {
			continue
		}
		for _, spec := range gen.Specs {
			name := spec.(*ast.ValueSpec).Names[0].Name
			// Messages are `&Message{...}`; other variables, such as the list of all messages, are skipped.
			unary, ok := spec.(*ast.ValueSpec).Values[0].(*ast.UnaryExpr)
			if !ok {
				continue
			}
			value := unary.X.(*ast.CompositeLit)
			for _, element := range value.Elts {
				field := element.(*ast.KeyValueExpr)
				if field.Key.(*ast.Ident).Name != "key" {
					continue
				}
				key, _ := strconv.Unquote(field.Value.(*ast.BasicLit).Value)
				m := keyToMessage(diagnostics.Key(key))
				if m == nil {
					panic("unknown key " + key)
				}
				result = append(result, declared{name, m})
			}
		}
	}
	return result
}

func parseLocale(tag string) locale.Locale {
	l, _ := locale.Parse(tag)
	return l
}

// Converts a UTF-16 offset in text to a UTF-8 byte offset.
func byteOffset(text string, pos int) int {
	if pos < 0 {
		return pos
	}
	units := 0
	for i, r := range text {
		if units >= pos {
			return i
		}
		units += len(utf16.Encode([]rune{r}))
	}
	return len(text)
}

func build(d diagnostic, files []*tsast.SourceFile) *tsast.Diagnostic {
	m := keyToMessage(diagnostics.Key(d.Key))
	if m == nil {
		panic("unknown key " + d.Key)
	}
	var f *tsast.SourceFile
	pos, end := d.Pos, d.End
	if d.File >= 0 {
		f = files[d.File]
		pos, end = byteOffset(f.Text(), pos), byteOffset(f.Text(), end)
	}
	var chain, related []*tsast.Diagnostic
	for _, c := range d.Chain {
		chain = append(chain, build(c, files))
	}
	for _, r := range d.Related {
		related = append(related, build(r, files))
	}
	args := d.Args
	if args == nil {
		args = []string{}
	}
	return tsast.NewDiagnosticFromSerialized(f, core.NewTextRange(pos, end), m.Code(), m.Category(), m.Key(), args, chain, related, m.ReportsUnnecessary(), m.ReportsDeprecated(), false)
}

func safely(f func() string) (result string) {
	defer func() {
		if r := recover(); r != nil {
			result = fmt.Sprint("panic: ", r)
		}
	}()
	return f()
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var req request
	if err := json.Unmarshal(data, &req); err != nil {
		panic(err)
	}
	messages := readMessages()
	res := response{Localized: map[string][]string{}, Matches: []string{}, Formats: []string{}, Renders: []rendered{}}
	for _, d := range messages {
		m := d.message
		flags := int(m.Category())
		if m.ReportsUnnecessary() {
			flags |= 4
		}
		if m.ElidedInCompatibilityPyramid() {
			flags |= 8
		}
		if m.ReportsDeprecated() {
			flags |= 16
		}
		res.Messages = append(res.Messages, message{Name: d.name, Code: m.Code(), Category: m.Category().Name(), Key: string(m.Key()), Text: m.String(), Flags: flags})
	}
	for _, tag := range req.Locales {
		l := parseLocale(tag)
		texts := make([]string, len(messages))
		for i, d := range messages {
			texts[i] = diagnostics.Localize(l, d.message, "")
		}
		res.Localized[tag] = texts
	}
	for _, tag := range req.Matches {
		res.Matches = append(res.Matches, diagnostics.Identifier_expected.Localize(parseLocale(tag)))
	}
	for _, f := range req.Formats {
		res.Formats = append(res.Formats, safely(func() string {
			return diagnostics.Localize(parseLocale(f.Locale), nil, diagnostics.Key(f.Key), f.Args...)
		}))
	}
	for _, r := range req.Renders {
		var files []*tsast.SourceFile
		for _, f := range r.Files {
			files = append(files, tsparser.ParseSourceFile(tsast.SourceFileParseOptions{FileName: tspath.RootedFilePath(f.Name), PathKey: tspath.PathKey(f.Name)}, f.Text, core.ScriptKindTS))
		}
		var diags []*tsast.Diagnostic
		for _, d := range r.Diagnostics {
			diags = append(diags, build(d, files))
		}
		opts := &diagnosticwriter.FormattingOptions{
			Locale:              parseLocale(r.Locale),
			CaseSensitivity:     caseSensitivity(r.UseCaseSensitiveFileNames),
			CurrentDirectory:    tspath.RootedDirectoryPath(r.CurrentDirectory),
			NewLine:             r.NewLine,
		}
		wrapped := diagnosticwriter.FromASTDiagnostics(diags)
		var out rendered
		out.Plain = safely(func() string {
			var b strings.Builder
			diagnosticwriter.WriteFormatDiagnostics(&b, wrapped, opts)
			return b.String()
		})
		out.Pretty = safely(func() string {
			var b strings.Builder
			diagnosticwriter.FormatDiagnosticsWithColorAndContext(&b, wrapped, opts)
			return b.String()
		})
		out.Summary = safely(func() string {
			var b strings.Builder
			diagnosticwriter.WriteErrorSummaryText(&b, wrapped, opts)
			return b.String()
		})
		for _, d := range wrapped {
			out.Flattened = append(out.Flattened, diagnosticwriter.FlattenDiagnosticMessage(d, r.NewLine, opts.Locale))
			var plain, color strings.Builder
			diagnosticwriter.FormatDiagnosticsStatusAndTime(&plain, "12:34:56 PM", d, opts)
			diagnosticwriter.FormatDiagnosticsStatusWithColorAndTime(&color, "12:34:56 PM", d, opts)
			out.Status = append(out.Status, plain.String(), color.String())
		}
		res.Renders = append(res.Renders, out)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(res); err != nil {
		panic(err)
	}
}

func caseSensitivity(sensitive bool) tspath.CaseSensitivity {
	if sensitive {
		return tspath.CaseSensitive
	}
	return tspath.CaseInsensitive
}
