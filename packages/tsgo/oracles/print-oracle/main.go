// Command print-oracle parses files like encode-oracle and prints them back with
// TypeScript-Go's printer, without transforms.
//
// Usage:
//
//	print-oracle FILE [--remove-comments] [--crlf] [--target es2020] [--sourcemap] [--bench]
//	print-oracle --batch LIST OUTDIR [--remove-comments] [--crlf]
//
// In batch mode LIST holds one path per line; the output for the i-th path is written
// to OUTDIR/i.out, or OUTDIR/i.err if the printer panics. With --sourcemap, the output is
// followed by a line with the source map of printing to out.js.
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/parser"
	"github.com/microsoft/TypeScript/tsc/internal/printer"
	"github.com/microsoft/TypeScript/tsc/internal/sourcemap"
	"github.com/microsoft/TypeScript/tsc/internal/tspath"
)

func parse(fileName string, text string) *ast.SourceFile {
	opts := ast.SourceFileParseOptions{FileName: tspath.RootedFilePath(fileName), PathKey: tspath.PathKey(fileName)}
	if !tspath.IsDeclarationFileName(fileName) {
		opts.ExternalModuleIndicatorOptions.Force = tspath.FileExtensionIsOneOf(fileName, []string{tspath.ExtensionCjs, tspath.ExtensionCts, tspath.ExtensionMjs, tspath.ExtensionMts})
	}
	return parser.ParseSourceFile(opts, text, core.GetScriptKindFromFileName(tspath.RootedFilePath(fileName)))
}

func print(path string, options printer.PrinterOptions, sourceMap bool) (out string, err error) {
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		return "", readErr
	}
	file := parse("/"+filepath.Base(path), string(data))
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	p := printer.NewPrinter(options, printer.PrintHandlers{}, nil)
	if !sourceMap {
		return p.EmitSourceFile(file), nil
	}
	generator := sourcemap.NewGenerator("out.js", "", "/", tspath.CaseSensitive)
	writer := printer.NewTextWriter(options.NewLine.GetNewLineCharacter(), 0)
	p.Write(file.AsNode(), file, writer, generator)
	return writer.String() + "\n" + generator.String(), nil
}

var targets = map[string]core.ScriptTarget{
	"es2015": core.ScriptTargetES2015,
	"es2020": core.ScriptTargetES2020,
	"es2021": core.ScriptTargetES2021,
	"esnext": core.ScriptTargetESNext,
}

func main() {
	options := printer.PrinterOptions{NewLine: core.NewLineKindLF}
	var positional []string
	bench := false
	batch := false
	sourceMap := false
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--remove-comments":
			options.RemoveComments = true
		case "--crlf":
			options.NewLine = core.NewLineKindCRLF
		case "--bench":
			bench = true
		case "--sourcemap":
			sourceMap = true
		case "--batch":
			batch = true
		case "--target":
			i++
			options.Target = targets[args[i]]
		default:
			positional = append(positional, args[i])
		}
	}
	if batch {
		list, err := os.ReadFile(positional[0])
		if err != nil {
			panic(err)
		}
		outDir := positional[1]
		for i, path := range strings.Split(strings.TrimRight(string(list), "\n"), "\n") {
			out, err := print(path, options, sourceMap)
			if err != nil {
				os.WriteFile(filepath.Join(outDir, fmt.Sprintf("%d.err", i)), []byte(err.Error()), 0o644)
			} else {
				os.WriteFile(filepath.Join(outDir, fmt.Sprintf("%d.out", i)), []byte(out), 0o644)
			}
		}
		return
	}
	if bench {
		data, err := os.ReadFile(positional[0])
		if err != nil {
			panic(err)
		}
		file := parse("/"+filepath.Base(positional[0]), string(data))
		size := 0
		start := time.Now()
		for range 20 {
			size = len(printer.NewPrinter(options, printer.PrintHandlers{}, nil).EmitSourceFile(file))
		}
		fmt.Printf("chars %d time %.2fms\n", size, float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	out, err := print(positional[0], options, sourceMap)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	w.WriteString(out)
}
