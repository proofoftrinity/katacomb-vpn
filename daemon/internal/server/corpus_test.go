package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"katacomb.vpn/daemon/internal/guard"
	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// Shared with src/main/helper/daemon-protocol-corpus.test.ts via
// internal/protocol/testdata/corpus/protocol.json. internal/protocol's own
// corpus_test.go pins the framing and encoding; this pins the OP LIST, which is
// the half that actually drifts — an op added to the TypeScript union with no
// dispatch case here (or the reverse) is otherwise only discovered at runtime,
// as an `unknown op` the app reports as a stale daemon.

type opsCorpus struct {
	Ops             []string `json:"ops"`
	LockFreeOps     []string `json:"lockFreeOps"`
	UnknownOpPrefix string   `json:"unknownOpPrefix"`
}

func loadOpsCorpus(t *testing.T) opsCorpus {
	t.Helper()
	path := filepath.Join("..", "protocol", "testdata", "corpus", "protocol.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var c opsCorpus
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	return c
}

// Every op the corpus lists must dispatch to something. We assert only that the
// reply is not the unknown-op refusal: an op can legitimately fail here (missing
// args), it just must not be unrecognised.
func TestCorpusOpsAllDispatch(t *testing.T) {
	c := loadOpsCorpus(t)
	r := newRec(t)
	for _, op := range c.Ops {
		t.Run(op, func(t *testing.T) {
			res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: op}, r.Env)
			if !res.OK && strings.HasPrefix(res.Error, c.UnknownOpPrefix) {
				t.Fatalf("op %q is in the corpus but this daemon does not implement it (%q)", op, res.Error)
			}
		})
	}
}

// The capability probe must actually carry the op list, or the client silently
// falls back to post-hoc `unknown op` detection and the pre-purchase check that
// this exists for never fires.
// [PH-2]
func TestProtocolVersionReportsOps(t *testing.T) {
	c := loadOpsCorpus(t)
	r := newRec(t)
	res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: "protocol_version"}, r.Env)
	if !res.OK {
		t.Fatalf("protocol_version failed: %q", res.Error)
	}
	m, ok := res.Result.(map[string]any)
	if !ok {
		t.Fatalf("result is %T, want a map", res.Result)
	}
	got, ok := m["ops"].([]string)
	if !ok {
		t.Fatalf("result has no ops list (%T)", m["ops"])
	}
	if len(got) != len(c.Ops) {
		t.Fatalf("reported %d ops, corpus has %d", len(got), len(c.Ops))
	}
	for i := range got {
		if got[i] != c.Ops[i] {
			t.Errorf("reported ops[%d] = %q, corpus says %q", i, got[i], c.Ops[i])
		}
	}
}

func TestCorpusUnknownOpStillRefused(t *testing.T) {
	c := loadOpsCorpus(t)
	r := newRec(t)
	res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: "definitely_not_an_op"}, r.Env)
	if res.OK || res.Error != c.UnknownOpPrefix+"definitely_not_an_op" {
		t.Fatalf("got ok=%v error=%q, want the corpus unknown-op refusal", res.OK, res.Error)
	}
}

func TestCorpusLockFreeOps(t *testing.T) {
	c := loadOpsCorpus(t)
	for _, op := range c.LockFreeOps {
		if lockedOp(op) {
			t.Errorf("corpus says %q runs lock-free but the server takes the mutex for it", op)
		}
	}
	for _, op := range c.Ops {
		lockFree := false
		for _, f := range c.LockFreeOps {
			if f == op {
				lockFree = true
			}
		}
		if !lockFree && !lockedOp(op) {
			t.Errorf("op %q takes no lock but the corpus does not list it as lock-free", op)
		}
	}
}

type limitsAndResults struct {
	Limits struct {
		MaxBypassRoutes int    `json:"maxBypassRoutes"`
		LanSharingArg   string `json:"lanSharingArg"`
	} `json:"limits"`
	Results map[string]map[string]any `json:"results"`
}

func loadLimitsAndResults(t *testing.T) limitsAndResults {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("..", "protocol", "testdata", "corpus", "protocol.json"))
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var c limitsAndResults
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	return c
}

// [PH-4] The split-tunnel cap and the LAN-sharing argv word are enforced on both
// sides of the socket. They were two hand-kept literals each; the corpus is now the
// one value both read, so changing one side alone fails a suite.
func TestCorpusLimits(t *testing.T) {
	c := loadLimitsAndResults(t)
	if ops.MaxBypassRoutes != c.Limits.MaxBypassRoutes {
		t.Fatalf("ops.MaxBypassRoutes = %d, corpus says %d", ops.MaxBypassRoutes, c.Limits.MaxBypassRoutes)
	}
	if guard.LanSharingArg != c.Limits.LanSharingArg {
		t.Fatalf("guard.LanSharingArg = %q, corpus says %q", guard.LanSharingArg, c.Limits.LanSharingArg)
	}
}

// jsonShape is a value's JSON kind, so two payloads can be compared key for key
// without comparing the values themselves.
func jsonShape(v any) map[string]string {
	out := map[string]string{}
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
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

// [PH-2] The read-only ops answer with exactly the keys and types the app's readers
// look for. Those readers fail OPEN on anything else ("cannot know"), so a renamed
// field here would silently switch off the stale-daemon refusal before payment, the
// IPsec warning and the dead-peer detector, with every test still green.
func TestCorpusResultShapes(t *testing.T) {
	c := loadLimitsAndResults(t)
	r := newRec(t)
	for _, op := range []string{"protocol_version", "xfrm_policies", "wireguard_handshake"} {
		t.Run(op, func(t *testing.T) {
			want, ok := c.Results[op]
			if !ok {
				t.Fatalf("corpus has no result shape for %s", op)
			}
			res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: op}, r.Env)
			if !res.OK {
				t.Fatalf("%s failed: %s", op, res.Error)
			}
			got, exp := jsonShape(res.Result), jsonShape(want)
			if len(got) != len(exp) {
				t.Fatalf("%s replies %v, corpus says %v", op, got, exp)
			}
			for k, kind := range exp {
				if got[k] != kind {
					t.Fatalf("%s replies %v, corpus says %v", op, got, exp)
				}
			}
		})
	}
}
