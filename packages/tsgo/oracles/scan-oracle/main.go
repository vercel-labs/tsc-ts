// Command scan-oracle prints TypeScript-Go's token stream for a file.
//
// Usage: scan-oracle FILE [--bench] [--full] [--trivia] [--jsx] [--target N] [--rescan] [--jsdoc]
//
// By default it prints "kind start end flags" per token. --full adds the full
// start and token value, scanner errors ("!" lines) and comment directives.
// --rescan also applies every applicable rescan at each token (restoring the
// state after each), and trivia utilities. --jsdoc scans each JSDoc comment
// with the JSDoc scanning functions.
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/core"
	"github.com/microsoft/TypeScript/tsc/internal/diagnostics"
	"github.com/microsoft/TypeScript/tsc/internal/scanner"
	"github.com/microsoft/TypeScript/tsc/internal/stringutil"
)

var w *bufio.Writer

// quote prints a JS string value as UTF-16 code units with \uXXXX escapes.
// Values over 64 units print as their length and FNV-1a hash.
func quote(s string) string {
	var units []rune
	for i := 0; i < len(s); {
		r, size := stringutil.DecodeJSStringRune(s[i:])
		if r == utf8.RuneError && size <= 1 {
			r = 0xfffd
			size = 1
		}
		if r >= 0x10000 {
			hi, lo := stringutil.CodePointToSurrogatePair(r)
			units = append(units, hi, lo)
		} else {
			units = append(units, r)
		}
		i += size
	}
	if len(units) > 64 {
		hash := uint32(2166136261)
		for _, u := range units {
			hash = (hash ^ uint32(u)) * 16777619
		}
		return fmt.Sprintf("#%d:%d", len(units), hash)
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, u := range units {
		if u >= 0x20 && u < 0x7f && u != '"' && u != '\\' {
			b.WriteByte(byte(u))
		} else {
			fmt.Fprintf(&b, "\\u%04x", u)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func onError(message *diagnostics.Message, start, length int, args ...any) {
	fmt.Fprintf(w, "! %d %d %d", message.Code(), start, length)
	for _, arg := range diagnostics.StringifyArgs(args) {
		fmt.Fprintf(w, " %s", quote(arg))
	}
	w.WriteByte('\n')
}

func token(prefix string, s *scanner.Scanner, k ast.Kind) {
	fmt.Fprintf(w, "%s%d %d %d %d %d %s\n", prefix, k, s.TokenFullStart(), s.TokenStart(), s.TokenEnd(), s.TokenFlags(), quote(s.TokenValue()))
}

func comments(prefix string, ranges func(yield func(ast.CommentRange) bool)) {
	w.WriteString(prefix)
	for c := range ranges {
		nl := 0
		if c.HasTrailingNewLine {
			nl = 1
		}
		fmt.Fprintf(w, " %d,%d,%d,%d", c.Pos(), c.End(), c.Kind, nl)
	}
	w.WriteByte('\n')
}

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	text := string(data)
	options := map[string]bool{}
	target := core.ScriptTargetLatest
	for i := 2; i < len(os.Args); i++ {
		if os.Args[i] == "--target" {
			n, _ := strconv.Atoi(os.Args[i+1])
			target = core.ScriptTarget(n)
			i++
		} else {
			options[os.Args[i]] = true
		}
	}
	if options["--bench"] {
		start := time.Now()
		count := 0
		for range 20 {
			s := scanner.NewScanner()
			s.SetText(text)
			s.SetScriptTarget(core.ScriptTargetLatest)
			for s.Scan() != 1 {
				count++
			}
		}
		fmt.Printf("tokens %d time %.2fms\n", count, float64(time.Since(start).Microseconds())/1000/20)
		return
	}
	w = bufio.NewWriter(os.Stdout)
	defer w.Flush()
	full := options["--full"] || options["--rescan"] || options["--jsdoc"]
	s := scanner.NewScanner()
	s.SetText(text)
	s.SetScriptTarget(target)
	if options["--jsx"] {
		s.SetLanguageVariant(core.LanguageVariantJSX)
	}
	if options["--trivia"] {
		s.SetSkipTrivia(false)
	}
	if !full {
		for {
			k := s.Scan()
			fmt.Fprintf(w, "%d %d %d %d\n", k, s.TokenStart(), s.TokenEnd(), s.TokenFlags())
			if k == 1 {
				break
			}
		}
		return
	}
	s.SetOnError(onError)
	if options["--rescan"] {
		w.WriteString("LS")
		for _, p := range core.ComputeECMALineStarts(text) {
			fmt.Fprintf(w, " %d", p)
		}
		w.WriteByte('\n')
	}
	for {
		k := s.Scan()
		token("", s, k)
		if options["--rescan"] {
			rescan(s, k, text)
		}
		if k == 1 {
			break
		}
	}
	for _, d := range s.CommentDirectives() {
		fmt.Fprintf(w, "D %d %d %d\n", d.Kind, d.Loc.Pos(), d.Loc.End())
	}
	if options["--jsdoc"] {
		jsdoc(text, target)
	}
}

func rescan(s *scanner.Scanner, k ast.Kind, text string) {
	try := func(prefix string, f func() ast.Kind) {
		state := s.Mark()
		token(prefix, s, f())
		s.Rewind(state)
	}
	switch k {
	case ast.KindSlashToken, ast.KindSlashEqualsToken:
		try("R/ ", func() ast.Kind { return s.ReScanSlashToken(true) })
	case ast.KindCloseBraceToken:
		try("Rt ", func() ast.Kind { return s.ReScanTemplateToken(false) })
		try("RT ", func() ast.Kind { return s.ReScanTemplateToken(true) })
	case ast.KindGreaterThanToken:
		try("R> ", s.ReScanGreaterThanToken)
	case ast.KindLessThanLessThanToken:
		try("R< ", s.ReScanLessThanToken)
	case ast.KindPrivateIdentifier:
		try("R# ", s.ReScanHashToken)
	case ast.KindQuestionQuestionToken:
		try("R? ", s.ReScanQuestionToken)
	case ast.KindAsteriskEqualsToken:
		try("R* ", s.ReScanAsteriskEqualsToken)
	case ast.KindEqualsToken:
		try("Ra ", s.ScanJsxAttributeValue)
		try("RA ", func() ast.Kind { s.ScanJsxAttributeValue(); return s.ReScanJsxAttributeValue() })
	}
	if k >= ast.KindIdentifier {
		try("Ri ", s.ScanJsxIdentifier)
	}
	if k == ast.KindGreaterThanToken || k == ast.KindCloseBraceToken {
		try("Rs ", s.ScanJsxToken)
	}
	try("Rj ", func() ast.Kind { return s.ReScanJsxToken(true) })
	try("RJ ", func() ast.Kind { return s.ReScanJsxToken(false) })
	full := s.TokenFullStart()
	fmt.Fprintf(w, "U %d %d %d %d\n",
		scanner.SkipTrivia(text, full),
		scanner.SkipTriviaEx(text, full, &scanner.SkipTriviaOptions{StopAfterLineBreak: true}),
		scanner.SkipTriviaEx(text, full, &scanner.SkipTriviaOptions{StopAtComments: true}),
		scanner.SkipTriviaEx(text, full, &scanner.SkipTriviaOptions{InJSDoc: true}))
	comments("L", scanner.GetLeadingCommentRanges(nil, text, full))
	comments("T", scanner.GetTrailingCommentRanges(nil, text, s.TokenEnd()))
}

func jsdoc(text string, target core.ScriptTarget) {
	trivia := scanner.NewScanner()
	trivia.SetText(text)
	trivia.SetSkipTrivia(false)
	var starts, ends []int
	for k := trivia.Scan(); k != ast.KindEndOfFile; k = trivia.Scan() {
		if k == ast.KindMultiLineCommentTrivia && strings.HasPrefix(trivia.TokenText(), "/**") && trivia.TokenEnd()-trivia.TokenStart() >= 5 {
			starts = append(starts, trivia.TokenStart())
			ends = append(ends, trivia.TokenEnd())
		}
	}
	s := scanner.NewScanner()
	s.SetText(text)
	s.SetScriptTarget(target)
	s.SetOnError(onError)
	for i, start := range starts {
		end := ends[i]
		fmt.Fprintf(w, "C %d %d\n", start, end)
		s.ResetTokenState(start + 3)
		for s.TokenEnd() < end {
			state := s.Mark()
			token("Jc ", s, s.ScanJSDocCommentTextToken(false))
			s.Rewind(state)
			token("JC ", s, s.ScanJSDocCommentTextToken(true))
			s.Rewind(state)
			at := 0
			if s.CanFollowJSDocAt() {
				at = 1
			}
			fmt.Fprintf(w, "J@ %d\n", at)
			k := s.ScanJSDocToken()
			token("J ", s, k)
			if k == ast.KindEndOfFile {
				break
			}
		}
		s.ResetTokenState(start + 3)
		s.SetSkipJSDocLeadingAsterisks(true)
		for {
			k := s.Scan()
			token("JS ", s, k)
			if k == ast.KindEndOfFile || s.TokenEnd() >= end {
				break
			}
		}
		s.SetSkipJSDocLeadingAsterisks(false)
	}
}
