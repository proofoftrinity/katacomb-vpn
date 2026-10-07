package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

// [PH-4] The socket is reachable by any member of the katacomb-vpn group, so the
// parser sees whatever they send. Whatever arrives, it never panics (one bad line
// must not take the root daemon down), and a line it accepts survives a re-encode
// with the same id and op, so the reply goes to the request that asked.
func FuzzParseRequest(f *testing.F) {
	raw, err := os.ReadFile("testdata/corpus/protocol.json")
	if err != nil {
		f.Fatal(err)
	}
	var corpus struct {
		Requests []struct {
			Line string `json:"line"`
		} `json:"requests"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		f.Fatal(err)
	}
	for _, c := range corpus.Requests {
		f.Add([]byte(c.Line))
	}
	for _, s := range []string{"null", "[]", `{"id":1e400,"op":"status"}`, `{"id":-1,"op":""}`, "{\"id\":1,\"op\":\"status\"}\n{", "\xff\xfe"} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, line []byte) {
		req, err := ParseRequest(line)
		if err != nil {
			return
		}
		b, err := json.Marshal(req)
		if err != nil {
			t.Fatalf("an accepted request does not re-encode: %v", err)
		}
		again, err := ParseRequest(b)
		if err != nil || again.ID != req.ID || again.Op != req.Op {
			t.Fatalf("accepted %q but its re-encoding %q parses as %+v (%v)", line, b, again, err)
		}
	})
}
