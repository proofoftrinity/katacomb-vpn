package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/ipc/namedpipe"
	"golang.org/x/sys/windows"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// Every op the Windows service lists dispatches to something, and the ones it
// does not list (OpenVPN's, the IPsec probe) are refused as unknown, which is
// what makes the app refuse those nodes before payment ([PH-2]).
func TestWindowsOpsDispatch(t *testing.T) {
	e := ops.NewEnv(t.TempDir())
	for _, op := range protocol.WindowsOps {
		res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: op}, e)
		if !res.OK && strings.HasPrefix(res.Error, "unknown op: ") {
			t.Errorf("%s is listed but not dispatched", op)
		}
	}
	for _, op := range []string{"openvpn_up", "openvpn_down", "xfrm_policies"} {
		res := Dispatch(context.Background(), protocol.Request{ID: 1, Op: op}, e)
		if res.OK || res.Error != "unknown op: "+op {
			t.Errorf("%s: got %+v, want the unknown-op refusal", op, res)
		}
	}
}

// [PH-10] The listener really applies the DACL, and a second listener on the
// same name fails instead of joining it.
func TestWindowsPipeListener(t *testing.T) {
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	path := `\\.\pipe\ProtectedPrefix\Administrators\Katacomb VPN\test-` + strings.ReplaceAll(t.Name(), "/", "-")
	ln, err := listen(path, tu.User.Sid)
	if err != nil {
		t.Skipf("cannot create a pipe under ProtectedPrefix (not elevated?): %v", err)
	}
	defer ln.Close()
	// The pipe takes a client only while an Accept is waiting.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if _, err := listen(path, tu.User.Sid); err == nil {
		t.Fatal("a second listener joined the pipe")
	}
	conn, err := namedpipe.DialTimeout(path, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	h := conn.(interface{ Handle() windows.Handle }).Handle()
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	got := sd.String()
	for _, want := range []string{"(A;;FA;;;SY)", "(A;;FA;;;BA)", ";;;" + tu.User.Sid.String() + ")"} {
		if !strings.Contains(got, want) {
			t.Errorf("DACL %s lacks %s", got, want)
		}
	}
	if n := strings.Count(got, "(A;"); n != 3 {
		t.Errorf("DACL %s has %d allow entries, want 3", got, n)
	}
}
