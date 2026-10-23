package ops

import (
	"fmt"
	"strings"
	"time"

	"katacomb.vpn/daemon/internal/guard"
)

// What both platforms' verbs share: the op budget, our interface names, the
// parameter and reply shapes the app sends and reads, and the checks those
// parameters get at the trust boundary, so the two platforms cannot drift apart.

const (
	// OpTimeout bounds one verb: the budget the client's request timer and the old
	// daemon's execFileSync both used.
	OpTimeout = 60 * time.Second

	wgIface  = "sntl0"
	tunIface = "sntl-tun"

	// tun2socks terminates TCP in a userspace netstack and advertises MSS = MTU-40;
	// 1400 keeps large TLS ClientHellos inside the proxy-wrapped path. Set at
	// startup because the netstack caches it at creation.
	tunMTU  = "1400"
	tunAddr = "198.18.0.1/15"
)

// KillswitchParams is `killswitch-on <iface> <host> [dns] [lan-sharing]`.
type KillswitchParams struct {
	Iface      string
	RemoteHost string
	DnsIp      string // "" = none
	LanSharing bool
}

// TunUpParams is `tun-up <bin> <socks> <remote> <gw> <if> [bypass…]`. The
// `<bin>` slot is accepted and IGNORED: the tun2socks engine is compiled into
// this helper (internal/tun2socks) and tun-up self-execs it, so root never runs
// a binary it was handed. The slot stays so old and new apps share one argv
// contract (the new app passes `-`).
type TunUpParams struct {
	SocksAddr  string
	RemoteHost string
	Gateway    string
	Iface      string
	// BypassRoutes are split-tunnel CIDRs, passed through RAW. Filtering happens
	// in TunUp, which is the trust boundary: both doors reach it, and a caller's
	// own filtering is never the one that counts.
	BypassRoutes []string
}

// MaxBypassRoutes bounds the split-tunnel list. Each entry becomes an `ip route
// add` as root, and the list was previously unbounded — a caller could make the
// helper issue arbitrarily many. The app's own UI cannot produce anything near
// this many, so exceeding it means a bug or a hostile caller, and refusing says
// so rather than working slowly and silently.
const MaxBypassRoutes = 64

const (
	tunPollTries    = 50
	tunPollInterval = 100 * time.Millisecond
)

// StatusResult is the `status` op's reply, key for key what the app reads.
type StatusResult struct {
	WgUp  bool `json:"wgUp"`
	TunUp bool `json:"tunUp"`
}

// WgHandshakeResult is the `wireguard_handshake` op's reply, key for key what the
// app reads.
type WgHandshakeResult struct {
	// Kernel is false when there is nothing to read: no sntl0, or an sntl0 that is
	// the userspace AmneziaWG device (a `type tun` link, and internal/amneziawg
	// deliberately never opens a UAPI socket, so wg(8) cannot reach it either), or
	// wg not installed. The app reads false as "cannot know", never as "dead".
	Kernel bool `json:"kernel"`
	// AgeSeconds is how long ago the most recent peer handshake completed. -1 when
	// the device exists but no peer has ever completed one — wg reports that as a
	// timestamp of 0, which must not be read as "1970, so decades stale".
	AgeSeconds int `json:"ageSeconds"`
}

// check is the kill switch's argument validation, whichever door it came through.
func (p KillswitchParams) check() error {
	if !guard.IsValidInterfaceName(p.Iface) {
		return fmt.Errorf("invalid interface name: %s", p.Iface)
	}
	if !guard.IsIPv4(p.RemoteHost) {
		return fmt.Errorf("invalid IPv4 address: %s", p.RemoteHost)
	}
	// A 0.0.0.0/32 whitelist matches no packet, so the DROP-all rule would swallow
	// the tunnel's own outer traffic: interface up, "connected", nothing gets
	// through. Refuse instead of installing a self-defeating chain.
	if p.RemoteHost == "0.0.0.0" {
		return fmt.Errorf("killswitch remote host 0.0.0.0 whitelists nothing")
	}
	if p.DnsIp != "" && !guard.IsIPv4(p.DnsIp) {
		return fmt.Errorf("invalid IPv4 address: %s", p.DnsIp)
	}
	return nil
}

// check is tun-up's scalar validation; the bypass routes have their own.
func (p TunUpParams) check() error {
	if !guard.IsValidSocksAddr(p.SocksAddr) {
		return fmt.Errorf("invalid SOCKS address: %s", p.SocksAddr)
	}
	if !guard.IsIPv4(p.RemoteHost) {
		return fmt.Errorf("invalid IPv4 address: %s", p.RemoteHost)
	}
	if !guard.IsIPv4(p.Gateway) {
		return fmt.Errorf("invalid IPv4 address: %s", p.Gateway)
	}
	if !guard.IsValidInterfaceName(p.Iface) {
		return fmt.Errorf("invalid interface name: %s", p.Iface)
	}
	return nil
}

// acceptedBypassRoutes refuses a list over MaxBypassRoutes and drops every entry
// the guard does not allow, warning with the count.
func acceptedBypassRoutes(routes []string, warn func(string)) ([]string, error) {
	if len(routes) > MaxBypassRoutes {
		return nil, fmt.Errorf("too many bypass routes: %d, max %d", len(routes), MaxBypassRoutes)
	}
	var bypass []string
	var dropped int
	for _, r := range routes {
		if guard.IsAllowedBypassCidr(r) {
			bypass = append(bypass, strings.TrimSpace(r))
		} else {
			dropped++
		}
	}
	// Report the COUNT, never the entries: these are caller-supplied strings and
	// the guard's own rule is that a refusal names a reason, not content. Silently
	// dropping them was the old behaviour and it made a half-applied split tunnel
	// indistinguishable from a working one.
	if dropped > 0 {
		warn(fmt.Sprintf("tun-up: ignored %d invalid bypass route(s) of %d", dropped, len(routes)))
	}
	return bypass, nil
}

// The Windows-only read-only ops. On Linux the app reads these itself (ip,
// /proc/net/dev); on Windows the same facts need the IP Helper API, so the
// service answers them. Shared so the Linux tests pin their shapes too.

// TrafficResult is the `traffic_counters` op's reply: a tunnel adapter's byte
// counters. Present is false when the adapter does not exist.
type TrafficResult struct {
	Present bool   `json:"present"`
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

// DefaultRouteResult is the `default_route` op's reply: the gateway and the
// interface index the IPv4 default route leaves by, both "" when there is none.
type DefaultRouteResult struct {
	Gateway string `json:"gateway"`
	Iface   string `json:"iface"`
}

// OtherVpnsResult is the `other_vpns` op's reply: the names of other VPN
// adapters that are up.
type OtherVpnsResult struct {
	Names []string `json:"names"`
}
