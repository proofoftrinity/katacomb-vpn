package ops

import (
	"net/netip"

	"katacomb.vpn/daemon/internal/wfp"
)

// The Windows kill switch and DNS protection, as data. Planned here, on every
// platform, so the rules are pinned by tests that run on Linux too; the
// filters are installed by internal/wfp on Windows only.

// Destinations that stay reachable while the kill switch is armed, so the user
// can still reach their own LAN. Hardcoded HERE on purpose: the app sends one
// boolean and never a range, so nothing a compromised renderer or the
// unauthenticated socket can say turns this into a hole to a public address. An
// ACCEPT in OUTPUT only permits; it does not route, so these cannot pull tunnel
// traffic out of the tunnel. 100.64.0.0/10 (CGNAT, Tailscale) is deliberately
// absent. Shared by the iptables chain (killswitch.go) and the WFP filters.
var (
	lanRangesV4 = []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "224.0.0.0/4", "255.255.255.255/32"}
	// fe80::/10 also unbreaks neighbour discovery, which the v6 chain drops otherwise.
	lanRangesV6 = []string{"fe80::/10", "fc00::/7", "ff00::/8"}
)

// WFP weights inside one sublayer: the highest-weight matching filter decides,
// and permits must outrank the block that catches everything else.
const (
	weightBlockAll  = 0
	weightPermit    = 12
	weightLoopback  = 13
	weightDNSBlock  = 14
	weightDNSPermit = 15
)

var allLayers = []wfp.Layer{wfp.ConnectV4, wfp.AcceptV4, wfp.ConnectV6, wfp.AcceptV6}

// killswitchFilters is KillswitchOn's iptables chain in WFP's terms, exception
// for exception: loopback, the tunnel interface, the VPN server, DHCP, the LAN
// ranges when asked, then block everything else. Its DNS and ESTABLISHED rules
// are both scoped to the tunnel interface, which the interface permit already
// covers, so they have no filter of their own. IPv6 gets the same chain minus
// the server and DHCP, as the ip6tables chain does.
//
// tunnel is the tunnel adapter's LUID, 0 while it does not exist: iptables names
// an interface, so `-o sntl0` matches a tunnel created after the chain; WFP
// matches a LUID, so ops re-plans when the tunnel appears.
func killswitchFilters(tunnel uint64, endpoint netip.Addr, lan bool) []wfp.Filter {
	var fs []wfp.Filter
	for _, l := range allLayers {
		fs = append(fs, wfp.Filter{Name: "Permit loopback", Layer: l, Action: wfp.Permit, Weight: weightLoopback, Loopback: true})
	}
	if tunnel != 0 {
		for _, l := range allLayers {
			fs = append(fs, wfp.Filter{Name: "Permit the tunnel", Layer: l, Action: wfp.Permit, Weight: weightPermit, Interface: tunnel})
		}
	}
	server := netip.PrefixFrom(endpoint, 32)
	fs = append(fs,
		wfp.Filter{Name: "Permit the VPN server", Layer: wfp.ConnectV4, Action: wfp.Permit, Weight: weightPermit, Remote: server},
		wfp.Filter{Name: "Permit the VPN server", Layer: wfp.AcceptV4, Action: wfp.Permit, Weight: weightPermit, Remote: server},
		wfp.Filter{Name: "Permit DHCP", Layer: wfp.ConnectV4, Action: wfp.Permit, Weight: weightPermit, Protocols: []uint8{wfp.UDP}, RemotePort: 67},
		wfp.Filter{Name: "Permit DHCP", Layer: wfp.AcceptV4, Action: wfp.Permit, Weight: weightPermit, Protocols: []uint8{wfp.UDP}, LocalPort: 68, RemotePort: 67},
	)
	if lan {
		for _, r := range lanRangesV4 {
			p := netip.MustParsePrefix(r)
			fs = append(fs,
				wfp.Filter{Name: "Permit the LAN", Layer: wfp.ConnectV4, Action: wfp.Permit, Weight: weightPermit, Remote: p},
				wfp.Filter{Name: "Permit the LAN", Layer: wfp.AcceptV4, Action: wfp.Permit, Weight: weightPermit, Remote: p})
		}
		for _, r := range lanRangesV6 {
			p := netip.MustParsePrefix(r)
			fs = append(fs,
				wfp.Filter{Name: "Permit the LAN", Layer: wfp.ConnectV6, Action: wfp.Permit, Weight: weightPermit, Remote: p},
				wfp.Filter{Name: "Permit the LAN", Layer: wfp.AcceptV6, Action: wfp.Permit, Weight: weightPermit, Remote: p})
		}
	}
	for _, l := range allLayers {
		fs = append(fs, wfp.Filter{Name: "Block everything else", Layer: l, Action: wfp.Block, Weight: weightBlockAll})
	}
	return fs
}

// dnsGuardFilters keeps every DNS query inside the tunnel, kill switch or not.
// On Linux the resolver is one file, and pointing it at the tunnel's resolver is
// the whole job. Windows asks every adapter's resolvers, the LAN's included, and
// a LAN resolver is on-link, so the tunnel's /1 routes never catch it: the query
// leaves in the clear. So port 53 is blocked everywhere except through the tunnel
// and on loopback. The VPN server is exempt too, or a node serving on port 53
// would be cut off from its own client.
func dnsGuardFilters(tunnel uint64, endpoint netip.Addr) []wfp.Filter {
	dns := []uint8{wfp.UDP, wfp.TCP}
	server := netip.PrefixFrom(endpoint, 32)
	var fs []wfp.Filter
	for _, l := range allLayers {
		fs = append(fs,
			wfp.Filter{Name: "Permit DNS through the tunnel", Layer: l, Action: wfp.Permit, Weight: weightDNSPermit, Interface: tunnel, Protocols: dns, RemotePort: 53},
			wfp.Filter{Name: "Permit DNS on loopback", Layer: l, Action: wfp.Permit, Weight: weightDNSPermit, Loopback: true, Protocols: dns, RemotePort: 53})
	}
	fs = append(fs,
		wfp.Filter{Name: "Permit the VPN server", Layer: wfp.ConnectV4, Action: wfp.Permit, Weight: weightDNSPermit, Remote: server},
		wfp.Filter{Name: "Permit the VPN server", Layer: wfp.AcceptV4, Action: wfp.Permit, Weight: weightDNSPermit, Remote: server})
	for _, l := range allLayers {
		fs = append(fs, wfp.Filter{Name: "Block DNS outside the tunnel", Layer: l, Action: wfp.Block, Weight: weightDNSBlock, Protocols: dns, RemotePort: 53})
	}
	return fs
}

// tunnelRoutes is a full tunnel as routes on the tunnel adapter: each default
// route becomes its two halves, more specific than the real default route, which
// stays in place to carry the VPN server's own /32. tun-up does the same on Linux.
func tunnelRoutes(v4, v6 bool) []netip.Prefix {
	var rs []netip.Prefix
	if v4 {
		rs = append(rs, netip.MustParsePrefix("0.0.0.0/1"), netip.MustParsePrefix("128.0.0.0/1"))
	}
	if v6 {
		rs = append(rs, netip.MustParsePrefix("::/1"), netip.MustParsePrefix("8000::/1"))
	}
	return rs
}
