package guard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The keys wg-quick itself acts on rather than passing to `wg setconf`: the four that
// run shell as root, and the two the guard refuses because they reroute or persist.
var wgQuickDirectives = map[string]bool{"preup": true, "postup": true, "predown": true, "postdown": true, "saveconfig": true, "table": true}

// The key wg-quick(8) reads off a line: bash's `read -r` drops NUL bytes, the line is
// cut at the first '#', and the key is everything before the first '=' with the
// surrounding whitespace trimmed. Using its parser as the oracle means a config the
// guard accepts but wg-quick would execute is caught as the bypass it would be.
func wgQuickKey(raw string) (string, bool) {
	line := strings.ReplaceAll(raw, "\x00", "")
	if i := strings.IndexByte(line, '#'); i >= 0 {
		line = line[:i]
	}
	key, _, ok := strings.Cut(line, "=")
	return strings.TrimSpace(key), ok
}

func seedFrom(f *testing.F, dirs ...string) {
	for _, dir := range dirs {
		files, err := filepath.Glob(filepath.Join("testdata", "corpus", dir, "*.conf"))
		if err != nil || len(files) == 0 {
			f.Fatalf("no corpus seeds in %s", dir)
		}
		for _, file := range files {
			b, err := os.ReadFile(file)
			if err != nil {
				f.Fatal(err)
			}
			f.Add(b)
		}
	}
}

// [NT-1] Whatever a node sends, the root-side guard never panics, never admits a line
// wg-quick would act on as a directive (PostUp and friends run shell as root), and
// admits nothing as WireGuard that it would refuse as AmneziaWG (awg-quick runs the
// same hooks).
func FuzzAssertWireguardConfig(f *testing.F) {
	seedFrom(f, "wireguard", "amneziawg")
	f.Fuzz(func(t *testing.T, cfg []byte) {
		if AssertWireguardConfig(cfg) != nil {
			return
		}
		for _, raw := range strings.Split(string(cfg), "\n") {
			if key, ok := wgQuickKey(raw); ok && wgQuickDirectives[strings.ToLower(key)] {
				t.Fatalf("accepted a config wg-quick would run as %q: %q", key, cfg)
			}
		}
		if err := AssertAmneziaWgConfig(cfg); err != nil {
			t.Fatalf("accepted as WireGuard but refused as AmneziaWG (%v): %q", err, cfg)
		}
	})
}
