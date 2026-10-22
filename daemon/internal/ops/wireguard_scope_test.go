//go:build linux

package ops

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// WireguardDown used to delete EVERY wireguard-type link, inherited from the bash
// helper. detectOtherVpn (vpn-manager.ts) is deliberately a warn-with-override
// rather than a gate, so the user can have Mullvad or IVPN up while connecting,
// and our disconnect then deleted their tunnel too — as root, with no warning.
// These pin the scoped behaviour; nothing else covers it, because every golden
// transcript was captured on a machine with only sntl0.

// [REL-10]
func TestWireguardDownLeavesForeignTunnelsAlone(t *testing.T) {
	f := newFake(t)
	f.addLink("sntl0")
	f.wgtype = true
	f.foreignWg = []string{"wg-mullvad", "wg0"}
	f.addLink("wg-mullvad")
	f.addLink("wg0")

	if err := WireguardDown(context.Background(), f.Env); err != nil {
		t.Fatal(err)
	}

	if f.hasLink("sntl0") {
		t.Error("sntl0 must be deleted")
	}
	for _, name := range []string{"wg-mullvad", "wg0"} {
		if !f.hasLink(name) {
			t.Errorf("%s belongs to another VPN and must survive our teardown", name)
		}
	}
	for _, cmd := range f.takeCmds() {
		for _, name := range []string{"wg-mullvad", "wg0"} {
			if strings.Contains(cmd, "delete "+name) || strings.HasSuffix(cmd, "down "+name) {
				t.Errorf("issued %q against another VPN's interface", cmd)
			}
		}
	}
}

// ...and with a foreign tunnel still up, the leaked-rule repair must decline:
// those rules may be that tunnel's, and wg-quick does not re-add them.
func TestWireguardDownSkipsRuleRepairWhileAnotherTunnelLives(t *testing.T) {
	f := newFake(t)
	f.addLink("sntl0")
	f.wgtype = true
	f.foreignWg = []string{"wg-mullvad"}
	f.addLink("wg-mullvad")
	f.leakRules()

	if err := WireguardDown(context.Background(), f.Env); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range f.takeCmds() {
		if strings.Contains(cmd, "rule del") {
			t.Errorf("deleted a policy rule while another wireguard tunnel was up: %q", cmd)
		}
	}
}

// The ordinary case is unchanged: ours alone, so the repair runs.
func TestWireguardDownRepairsRulesWhenOnlyOursExisted(t *testing.T) {
	f := newFake(t)
	f.addLink("sntl0")
	f.wgtype = true
	f.leakRules()

	if err := WireguardDown(context.Background(), f.Env); err != nil {
		t.Fatal(err)
	}
	var deleted int
	for _, cmd := range f.takeCmds() {
		if strings.Contains(cmd, "rule del") {
			deleted++
		}
	}
	if deleted == 0 {
		t.Error("with no other tunnel left, the leaked rule pair must be repaired")
	}
}

// --- wg-quick's firewall -------------------------------------------------------
//
// A full-tunnel `wg-quick up` also installs an anti-spoof firewall for sntl0: nft
// tables named `wg-quick-sntl0`, or, where nft is absent, iptables rules commented
// "wg-quick(8) rule for sntl0". Only `wg-quick down` removes it, which never runs for
// our tunnel ([REL-10]), so every disconnect, logout and quit left it behind until
// reboot, and every connect added another copy of its rules (seen in the VM,
// 2026-10-15). No golden transcript covers it: the capture's shims had no firewall.

// [REL-10]
func TestWireguardDownRemovesWgQuickNftTables(t *testing.T) {
	f := newFake(t)
	if err := WireguardUp(context.Background(), f.Env, cfgWG); err != nil {
		t.Fatal(err)
	}
	f.nftTables = map[string]bool{
		"ip wg-quick-sntl0": true, "ip6 wg-quick-sntl0": true,
		// Another tunnel's firewall and an unrelated table: never ours to delete.
		"ip wg-quick-wg0": true, "inet filter": true,
	}

	if err := WireguardDown(context.Background(), f.Env); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"ip wg-quick-sntl0", "ip6 wg-quick-sntl0"} {
		if f.nftTables[k] {
			t.Errorf("table %s survived the teardown", k)
		}
	}
	for _, k := range []string{"ip wg-quick-wg0", "inet filter"} {
		if !f.nftTables[k] {
			t.Errorf("table %s is not ours and must survive", k)
		}
	}
}

// [REL-10]
func TestWireguardDownRemovesWgQuickIptablesRules(t *testing.T) {
	f := newFake(t)
	f.LookPath = func(name string) (string, error) {
		if name == "nft" {
			return "", errors.New("not found")
		}
		return name, nil
	}
	f.addLink("sntl0")
	f.wgtype = true
	ours := `-m comment --comment "wg-quick(8) rule for sntl0"`
	f.iptSave["iptables-save"] = "*raw\n:PREROUTING ACCEPT [0:0]\n" +
		"-A PREROUTING -d 10.8.0.3/32 ! -i sntl0 -m addrtype ! --src-type LOCAL " + ours + " -j DROP\n" +
		`-A PREROUTING -d 10.9.0.2/32 ! -i wg0 -m addrtype ! --src-type LOCAL -m comment --comment "wg-quick(8) rule for wg0" -j DROP` + "\n" +
		"COMMIT\n*mangle\n:PREROUTING ACCEPT [0:0]\n:POSTROUTING ACCEPT [0:0]\n" +
		"-A PREROUTING -p udp " + ours + " -j CONNMARK --restore-mark --nfmask 0xffffffff --ctmask 0xffffffff\n" +
		"-A POSTROUTING -p udp -m mark --mark 0xca6c " + ours + " -j CONNMARK --save-mark --nfmask 0xffffffff --ctmask 0xffffffff\n" +
		"COMMIT\n*filter\n:OUTPUT ACCEPT [0:0]\n-A OUTPUT -j KATACOMB_KS\nCOMMIT\n"

	if err := WireguardDown(context.Background(), f.Env); err != nil {
		t.Fatal(err)
	}
	want := "*raw\n" +
		"-D PREROUTING -d 10.8.0.3/32 ! -i sntl0 -m addrtype ! --src-type LOCAL " + ours + " -j DROP\n" +
		"COMMIT\n*mangle\n" +
		"-D PREROUTING -p udp " + ours + " -j CONNMARK --restore-mark --nfmask 0xffffffff --ctmask 0xffffffff\n" +
		"-D POSTROUTING -p udp -m mark --mark 0xca6c " + ours + " -j CONNMARK --save-mark --nfmask 0xffffffff --ctmask 0xffffffff\n" +
		"COMMIT\n*filter\nCOMMIT\n"
	if got := f.restoreStdin["iptables-restore"]; got != want {
		t.Errorf("iptables-restore batch:\n got: %q\nwant: %q", got, want)
	}
	// Without -n, iptables-restore flushes every table it names: the kill switch with them.
	if cmds := strings.Join(f.takeCmds(), "\n"); !strings.Contains(cmds, "iptables-restore -n") {
		t.Errorf("the batch must be applied with -n (no flush), got:\n%s", cmds)
	}
	if _, ran := f.restoreStdin["ip6tables-restore"]; ran {
		t.Error("ip6tables held nothing of ours: no restore may run")
	}
}

// The firewall is a live sntl0's anti-spoof protection: it stays while any sntl0
// does (here one `down` does not delete, as a userspace AmneziaWG link is not
// wireguard-type).
// [REL-10]
func TestWireguardDownKeepsTheFirewallWhileSntl0Lives(t *testing.T) {
	f := newFake(t)
	f.addLink("sntl0")
	f.nftTables = map[string]bool{"ip wg-quick-sntl0": true}

	if err := WireguardDown(context.Background(), f.Env); err != nil {
		t.Fatal(err)
	}
	if !f.nftTables["ip wg-quick-sntl0"] {
		t.Error("deleted the firewall of an sntl0 that is still up")
	}
}

// --- bypass route bounds -------------------------------------------------------
//
// Each entry becomes an `ip route add` as root. The list used to be unbounded and
// invalid entries were dropped without a word, so a split tunnel that was only
// half applied looked exactly like one that worked.

func TestTunUpRefusesTooManyBypassRoutes(t *testing.T) {
	f := newFake(t)
	routes := make([]string, MaxBypassRoutes+1)
	for i := range routes {
		routes[i] = "10.0.0.0/24"
	}
	_, err := TunUp(context.Background(), f.Env, TunUpParams{
		SocksAddr: "127.0.0.1:1080", RemoteHost: "203.0.113.10",
		Gateway: "192.168.1.1", Iface: "eth0", BypassRoutes: routes,
	})
	if err == nil || !strings.Contains(err.Error(), "too many bypass routes") {
		t.Fatalf("want a refusal naming the cap, got %v", err)
	}
	// It must refuse BEFORE touching anything.
	if len(f.takeCmds()) != 0 {
		t.Error("refusal must happen before any command runs")
	}
}

func TestTunUpReportsDroppedBypassRoutes(t *testing.T) {
	f := newFake(t)
	if _, err := TunUp(context.Background(), f.Env, TunUpParams{
		SocksAddr: "127.0.0.1:1080", RemoteHost: "203.0.113.10",
		Gateway: "192.168.1.1", Iface: "eth0",
		// One good, two the guard rejects: a default route (the split-tunnel
		// escape the guard exists to stop) and a malformed entry.
		BypassRoutes: []string{"10.0.0.0/24", "0.0.0.0/0", "not-a-cidr"},
	}); err != nil {
		t.Fatal(err)
	}
	var warned string
	for _, w := range f.warns {
		if strings.Contains(w, "bypass route") {
			warned = w
		}
	}
	if warned == "" {
		t.Fatal("dropping bypass routes must be reported, not silent")
	}
	if !strings.Contains(warned, "2") {
		t.Errorf("warning should count the dropped entries, got %q", warned)
	}
	// The content of a rejected entry must never be echoed back.
	for _, bad := range []string{"0.0.0.0/0", "not-a-cidr"} {
		if strings.Contains(warned, bad) {
			t.Errorf("warning echoes caller-supplied content %q", bad)
		}
	}
	// ...and the valid one still gets its route.
	var added bool
	for _, cmd := range f.takeCmds() {
		if strings.Contains(cmd, "route add 10.0.0.0/24") {
			added = true
		}
	}
	if !added {
		t.Error("the valid bypass route must still be applied")
	}
}
