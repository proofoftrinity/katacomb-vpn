//go:build linux

package server

import (
	"context"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// dispatchPlatform serves the ops only the Linux daemon has: OpenVPN, and the
// IPsec probe. ok is false for an op it does not know.
func dispatchPlatform(ctx context.Context, req protocol.Request, args argMap, e *ops.Env) (protocol.Response, bool) {
	reply := func(result any) (protocol.Response, bool) {
		return protocol.Response{ID: req.ID, OK: true, Result: result}, true
	}
	fail := func(msg string) (protocol.Response, bool) {
		return protocol.Response{ID: req.ID, OK: false, Error: msg}, true
	}
	failErr := func(err error) (protocol.Response, bool) { return fail(err.Error()) }

	switch req.Op {
	case "xfrm_policies":
		// Read-only, like status: no lock, no state change. Lets the app warn about
		// an IPsec VPN it structurally cannot see for itself (no interface, and
		// reading policies needs CAP_NET_ADMIN).
		return reply(map[string]int{"count": ops.XfrmPolicyCount(ctx, e)})

	case "openvpn_up":
		cfg, ok := args.str("configString")
		if !ok {
			return fail("openvpn_up: configString required")
		}
		if err := ops.OpenVpnUp(ctx, e, []byte(cfg)); err != nil {
			return failErr(err)
		}
		return reply(nil)

	case "openvpn_down":
		if err := ops.OpenVpnDown(ctx, e); err != nil {
			return failErr(err)
		}
		return reply(nil)
	}
	return protocol.Response{}, false
}
