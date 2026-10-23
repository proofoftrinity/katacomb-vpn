//go:build linux

package server

import (
	"context"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// dispatchPlatform serves the op only the Linux daemon has: the IPsec probe. ok
// is false for an op it does not know.
func dispatchPlatform(ctx context.Context, req protocol.Request, _ argMap, e *ops.Env) (protocol.Response, bool) {
	switch req.Op {
	case "xfrm_policies":
		// Read-only, like status: no lock, no state change. Lets the app warn about
		// an IPsec VPN it structurally cannot see for itself (no interface, and
		// reading policies needs CAP_NET_ADMIN).
		return protocol.Response{ID: req.ID, OK: true, Result: map[string]int{"count": ops.XfrmPolicyCount(ctx, e)}}, true
	}
	return protocol.Response{}, false
}
