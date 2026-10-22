package server

import (
	"context"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// dispatchPlatform serves the ops only the Windows service has: the read-only
// facts the app reads for itself on Linux. ok is false for an op it does not
// know, OpenVPN's and the IPsec probe's included, so the app refuses those
// before payment.
func dispatchPlatform(ctx context.Context, req protocol.Request, args argMap, e *ops.Env) (protocol.Response, bool) {
	reply := func(result any) (protocol.Response, bool) {
		return protocol.Response{ID: req.ID, OK: true, Result: result}, true
	}
	fail := func(msg string) (protocol.Response, bool) {
		return protocol.Response{ID: req.ID, OK: false, Error: msg}, true
	}

	switch req.Op {
	case "traffic_counters":
		// Read-only: our tunnel adapter's byte counters (/proc/net/dev on Linux).
		iface, ok := args.str("iface")
		if !ok {
			return fail("traffic_counters: iface required")
		}
		res, err := ops.TrafficCounters(e, iface)
		if err != nil {
			return fail("traffic_counters: " + err.Error())
		}
		return reply(res)

	case "default_route":
		// Read-only: the route the tunnels leave by (`ip route show default`).
		return reply(ops.DefaultRoute(e))

	case "other_vpns":
		// Read-only: other VPNs' adapters, for the warn-with-override.
		return reply(ops.OtherVpns(e))
	}
	return protocol.Response{}, false
}
