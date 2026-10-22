package ops

import "testing"

func TestOtherVpnAdapters(t *testing.T) {
	for _, c := range []struct {
		ifType      uint32
		description string
		want        bool
	}{
		{53, "WireGuard Tunnel", true},
		{53, "Mullvad Tunnel", true},
		{6, "TAP-Windows Adapter V9", true},
		{6, "TAP-NordVPN Windows Adapter V9", true},
		{6, "OpenVPN Data Channel Offload", true},
		{6, "PANGP Virtual Ethernet Adapter Secure", true},
		{6, "Intel(R) Ethernet Connection I219-V", false},
		{71, "Intel(R) Wi-Fi 6 AX201 160MHz", false},
		{6, "Hyper-V Virtual Ethernet Adapter", false},
		{6, "VirtualBox Host-Only Ethernet Adapter", false},
		{24, "Software Loopback Interface 1", false},
		{131, "Teredo Tunneling Pseudo-Interface", false},
	} {
		if got := isOtherVpnAdapter(c.ifType, c.description); got != c.want {
			t.Errorf("%d %q: got %v, want %v", c.ifType, c.description, got, c.want)
		}
	}
}
