package main

import (
	"bytes"
	"go/format"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every Go file in the module is gofmt-clean. The privileged helper is reviewed
// line by line, and a hand-aligned struct that drifts out of gofmt's layout turns
// the next unrelated edit into a whitespace diff that hides the real change.
func TestEveryFileIsGofmtClean(t *testing.T) {
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && path != "." && (d.Name() == "testdata" || strings.HasPrefix(d.Name(), ".")) {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out, err := format.Source(src)
		if err != nil {
			t.Errorf("%s: %v", path, err)
		} else if !bytes.Equal(src, out) {
			t.Errorf("%s is not gofmt-clean: run `gofmt -w %s`", path, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
