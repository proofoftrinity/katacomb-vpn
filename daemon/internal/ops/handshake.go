//go:build linux

package ops

import (
	"context"
	"strconv"
	"strings"
	"time"
)

// WgHandshake reports the age of the last completed handshake on sntl0 when it is
// a kernel WireGuard device. It exists because nothing else can tell an idle tunnel
// from a dead one: the interface-presence monitor sees sntl0 either way, and the
// one-way check in the app needs traffic LEAVING to have any evidence, which an
// idle user never produces. The configs we emit carry PersistentKeepalive = 15, so
// a live peer re-handshakes on its own (RekeyAfterTime is 120s on send, and the
// keepalive guarantees a send) and the age saws between 0 and ~140s forever; a
// dead peer's age just grows. Reading it needs CAP_NET_ADMIN, which is the whole
// reason this lives here rather than in the app — the helper is already root.
//
// One exec per quota tick (15s) while a WireGuard session is up. That is deliberate
// and cheap; do not fold it into Status, whose contract is "no spawn".
//
// Read-only, so it takes no lock — and it must not: the app polls this on a timer,
// and a lock here would sit behind an in-flight wireguard_up for up to OpTimeout.
// It informs, never gates. A wrong answer costs at worst one wrongly-ended session
// that the user reconnects from the Sessions tab, never a refused connect.
func WgHandshake(ctx context.Context, e *Env) WgHandshakeResult {
	wg, err := tool(e, "wg")
	if err != nil {
		return WgHandshakeResult{}
	}
	// e.Run rather than output(): output() folds a failure into "", and here the
	// failure IS the answer — "not a WireGuard device" must stay distinct from "a
	// device with no peers", which is what an empty stdout means.
	out, _, err := e.Run(ctx, []string{wg, "show", wgIface, "latest-handshakes"}, RunOpt{})
	if err != nil {
		return WgHandshakeResult{}
	}
	// One `<pubkey>\t<unix seconds>` line per peer. Our configs have one peer; the
	// max is one line and stays right for any config.
	var latest int64
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		ts, err := strconv.ParseInt(fields[len(fields)-1], 10, 64)
		if err != nil {
			continue
		}
		if ts > latest {
			latest = ts
		}
	}
	if latest == 0 {
		return WgHandshakeResult{Kernel: true, AgeSeconds: -1}
	}
	age := time.Now().Unix() - latest
	if age < 0 {
		// A backwards clock step must not read as a handshake from the future.
		age = 0
	}
	return WgHandshakeResult{Kernel: true, AgeSeconds: int(age)}
}
