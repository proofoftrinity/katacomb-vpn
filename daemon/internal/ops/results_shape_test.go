package ops

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// [PH-2] The Windows-only read-only ops answer with exactly the keys and JSON
// types the corpus gives the app's readers. Those readers fail open on anything
// else, so a renamed field would silently switch off the traffic meter, the
// network-change check and the other-VPN warning on Windows. The ops themselves
// only run on Windows; their reply types are checked here, on every platform.
func TestWindowsResultShapesMatchTheCorpus(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "protocol", "testdata", "corpus", "protocol.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Results map[string]map[string]any `json:"results"`
	}
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatal(err)
	}
	kinds := func(v any) map[string]string {
		b, _ := json.Marshal(v)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		out := map[string]string{}
		for k, x := range m {
			switch x.(type) {
			case bool:
				out[k] = "bool"
			case float64:
				out[k] = "number"
			case string:
				out[k] = "string"
			case []any:
				out[k] = "array"
			default:
				out[k] = "other"
			}
		}
		return out
	}
	for op, v := range map[string]any{
		"traffic_counters": TrafficResult{Present: true},
		"default_route":    DefaultRouteResult{},
		"other_vpns":       OtherVpnsResult{Names: []string{}},
	} {
		want, ok := c.Results[op]
		if !ok {
			t.Fatalf("corpus has no result shape for %s", op)
		}
		got, exp := kinds(v), kinds(want)
		if len(got) != len(exp) {
			t.Fatalf("%s replies %v, corpus says %v", op, got, exp)
		}
		for k, kind := range exp {
			if got[k] != kind {
				t.Fatalf("%s replies %v, corpus says %v", op, got, exp)
			}
		}
	}
}
