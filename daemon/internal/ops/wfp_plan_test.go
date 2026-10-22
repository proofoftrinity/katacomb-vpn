package ops

import (
	"fmt"
	"net/netip"
	"slices"
	"testing"

	"katacomb.vpn/daemon/internal/wfp"
)

// These plans are what internal/wfp installs on Windows. They are pure, so they
// are pinned here, on every platform; the Windows integration tests check that
// the installed filters do what the plans say.

var testEndpoint = netip.MustParseAddr("203.0.113.7")

const testTunnel = uint64(0x1234)

func describe(f wfp.Filter) string { return fmt.Sprintf("%+v", f) }

// [REL-43] The Windows kill switch lets out exactly what the iptables chain lets
// out: loopback, the tunnel, the VPN server's /32, DHCP, and the LAN ranges only
// when LAN sharing is on. Every layer ends in a block that every permit outranks.
func TestWindowsKillswitchPermitsOnlyTheChainsExceptions(t *testing.T) {
	server := netip.PrefixFrom(testEndpoint, 32)
	for _, c := range []struct {
		tunnel uint64
		lan    bool
	}{{testTunnel, false}, {testTunnel, true}, {0, false}, {0, true}} {
		t.Run(fmt.Sprintf("tunnel=%d,lan=%v", c.tunnel, c.lan), func(t *testing.T) {
			lan := c.lan
			fs := killswitchFilters(c.tunnel, testEndpoint, lan)
			var lanSeen []string
			blocks := map[wfp.Layer]int{}
			lowestPermit := uint8(255)
			for _, f := range fs {
				if f.Action == wfp.Block {
					if f.Loopback || f.Interface != 0 || f.Remote.IsValid() || len(f.Protocols) > 0 || f.LocalPort != 0 || f.RemotePort != 0 {
						t.Errorf("a block with conditions leaves a gap: %s", describe(f))
					}
					blocks[f.Layer]++
					continue
				}
				lowestPermit = min(lowestPermit, f.Weight)
				switch {
				case f.Loopback && f.Interface == 0 && !f.Remote.IsValid() && f.RemotePort == 0:
				case f.Interface != 0 && f.Interface == c.tunnel && !f.Remote.IsValid() && f.RemotePort == 0:
				case f.Remote == server && !f.Layer.IsV6() && f.RemotePort == 0:
				case slices.Equal(f.Protocols, []uint8{wfp.UDP}) && f.RemotePort == 67 && !f.Layer.IsV6() && !f.Remote.IsValid():
				case f.Remote.IsValid() && f.Interface == 0 && f.RemotePort == 0:
					lanSeen = append(lanSeen, f.Remote.String())
				default:
					t.Errorf("permit outside the chain's exceptions: %s", describe(f))
				}
			}
			for _, l := range allLayers {
				if blocks[l] != 1 {
					t.Errorf("layer %d has %d block-all filters, want 1", l, blocks[l])
				}
			}
			for _, f := range fs {
				if f.Action == wfp.Block && f.Weight >= lowestPermit {
					t.Errorf("block weight %d does not lose to permit weight %d", f.Weight, lowestPermit)
				}
			}
			var want []string
			if lan {
				// Both directions of every range, from the list the iptables chain uses.
				for _, r := range append(slices.Clone(lanRangesV4), lanRangesV6...) {
					want = append(want, r, r)
				}
			}
			slices.Sort(lanSeen)
			slices.Sort(want)
			if !slices.Equal(lanSeen, want) {
				t.Errorf("LAN permits %v, want %v", lanSeen, want)
			}
			for _, r := range lanSeen {
				if netip.MustParsePrefix(r).Overlaps(netip.MustParsePrefix("100.64.0.0/10")) {
					t.Errorf("CGNAT range permitted: %s", r)
				}
			}
		})
	}
}

// [REL-43] Before the tunnel exists there is nothing to permit by interface; the
// tunnel's permit arrives with its LUID, on every layer.
func TestWindowsKillswitchPermitsTheTunnelOnlyOnceItExists(t *testing.T) {
	count := func(fs []wfp.Filter) int {
		n := 0
		for _, f := range fs {
			if f.Interface != 0 {
				n++
			}
		}
		return n
	}
	if n := count(killswitchFilters(0, testEndpoint, false)); n != 0 {
		t.Fatalf("%d interface permits with no tunnel", n)
	}
	if n := count(killswitchFilters(testTunnel, testEndpoint, false)); n != len(allLayers) {
		t.Fatalf("%d interface permits, want one per layer (%d)", n, len(allLayers))
	}
}

// [REL-44] While a Windows tunnel is up, port 53 is blocked on every layer except
// through the tunnel and on loopback, and the VPN server stays reachable whatever
// port it serves on.
func TestWindowsDnsGuardKeepsDnsInTheTunnel(t *testing.T) {
	server := netip.PrefixFrom(testEndpoint, 32)
	dns := []uint8{wfp.UDP, wfp.TCP}
	fs := dnsGuardFilters(testTunnel, testEndpoint)
	blocked := map[wfp.Layer]bool{}
	var blockWeight uint8
	for _, f := range fs {
		if f.Action == wfp.Block {
			if f.RemotePort != 53 || !slices.Equal(f.Protocols, dns) || f.Interface != 0 || f.Remote.IsValid() || f.Loopback {
				t.Errorf("the DNS block is not all of port 53: %s", describe(f))
			}
			blocked[f.Layer] = true
			blockWeight = f.Weight
		}
	}
	for _, l := range allLayers {
		if !blocked[l] {
			t.Errorf("layer %d does not block DNS", l)
		}
	}
	for _, f := range fs {
		if f.Action != wfp.Permit {
			continue
		}
		if f.Weight <= blockWeight {
			t.Errorf("permit does not outrank the DNS block: %s", describe(f))
		}
		switch {
		case f.RemotePort == 53 && f.Interface == testTunnel && !f.Loopback && !f.Remote.IsValid():
		case f.RemotePort == 53 && f.Loopback && f.Interface == 0 && !f.Remote.IsValid():
		case f.Remote == server && f.RemotePort == 0 && f.Interface == 0:
		default:
			t.Errorf("DNS can leave outside the tunnel: %s", describe(f))
		}
	}
}

func TestTunnelRoutesSplitEachDefaultInHalves(t *testing.T) {
	got := tunnelRoutes(true, true)
	want := []netip.Prefix{
		netip.MustParsePrefix("0.0.0.0/1"), netip.MustParsePrefix("128.0.0.0/1"),
		netip.MustParsePrefix("::/1"), netip.MustParsePrefix("8000::/1"),
	}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := tunnelRoutes(true, false); len(got) != 2 || got[0].Addr().Is6() {
		t.Fatalf("v4 only: %v", got)
	}
	if got := tunnelRoutes(false, false); len(got) != 0 {
		t.Fatalf("no defaults: %v", got)
	}
}
