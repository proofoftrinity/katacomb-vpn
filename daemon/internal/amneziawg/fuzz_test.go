package amneziawg

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var uapiLine = regexp.MustCompile(`^[a-z_0-9]+=[^\n]*$`)

// The device's configuration channel is line-based `key=value`, so one smuggled
// newline would be a second command. Whatever INI it is handed, ToUAPI never panics,
// and what it emits is only well-formed key=value lines.
func FuzzToUAPI(f *testing.F) {
	files, _ := filepath.Glob(filepath.Join("..", "guard", "testdata", "corpus", "amneziawg", "*.conf"))
	if len(files) == 0 {
		f.Fatal("no amneziawg corpus seeds")
	}
	for _, file := range files {
		b, err := os.ReadFile(file)
		if err != nil {
			f.Fatal(err)
		}
		f.Add(b)
	}
	f.Fuzz(func(t *testing.T, ini []byte) {
		out, err := ToUAPI(ini)
		if err != nil {
			return
		}
		for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
			if line != "" && !uapiLine.MatchString(line) {
				t.Fatalf("emitted %q from %q", line, ini)
			}
		}
	})
}
