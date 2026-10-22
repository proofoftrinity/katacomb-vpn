package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// [PH-10] The Windows pipe admits SYSTEM, the Administrators and the user the
// service was installed for, and nobody else: a protected DACL of exactly those
// three allow entries, the user's without full control. Its name sits where only
// an administrator can create a pipe, and is the one the app dials (the corpus).
func TestWindowsPipeAdmitsOnlySystemAdminsAndTheUser(t *testing.T) {
	const user = "S-1-5-21-1-2-3-1001"
	sddl := fmt.Sprintf(pipeSDDL, user)
	if !strings.HasPrefix(sddl, "O:SYD:P(") || strings.Contains(sddl, "S:") {
		t.Fatalf("owner, protection or SACL changed: %s", sddl)
	}
	aces := regexp.MustCompile(`\(([^)]*)\)`).FindAllStringSubmatch(sddl, -1)
	want := map[string]string{"SY": "GA", "BA": "GA", user: "GRGW"}
	if len(aces) != len(want) {
		t.Fatalf("%d entries, want %d: %s", len(aces), len(want), sddl)
	}
	for _, a := range aces {
		f := strings.Split(a[1], ";")
		if len(f) != 6 || f[0] != "A" || f[1] != "" || want[f[5]] != f[2] {
			t.Errorf("unexpected entry (%s) in %s", a[1], sddl)
		}
	}
	if !strings.HasPrefix(PipePath, `\\.\pipe\ProtectedPrefix\Administrators\`) {
		t.Errorf("%s is outside ProtectedPrefix\\Administrators", PipePath)
	}
	body, err := os.ReadFile(filepath.Join("..", "protocol", "testdata", "corpus", "protocol.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		PipePath           string   `json:"pipePath"`
		WindowsOps         []string `json:"windowsOps"`
		WindowsLockFreeOps []string `json:"windowsLockFreeOps"`
	}
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatal(err)
	}
	if c.PipePath != PipePath {
		t.Errorf("PipePath %s, corpus says %s", PipePath, c.PipePath)
	}
}

// The Windows service's read-only ops run without the state mutex, and every
// other Windows op takes it, as the corpus tells the app.
func TestWindowsLockFreeOps(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "protocol", "testdata", "corpus", "protocol.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		WindowsOps         []string `json:"windowsOps"`
		WindowsLockFreeOps []string `json:"windowsLockFreeOps"`
	}
	if err := json.Unmarshal(body, &c); err != nil {
		t.Fatal(err)
	}
	free := map[string]bool{}
	for _, op := range c.WindowsLockFreeOps {
		free[op] = true
	}
	for _, op := range c.WindowsOps {
		if lockedOp(op) == free[op] {
			t.Errorf("%s: lockedOp=%v, corpus lock-free=%v", op, lockedOp(op), free[op])
		}
	}
}
