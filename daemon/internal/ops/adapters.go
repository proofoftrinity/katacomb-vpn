package ops

import "strings"

// isOtherVpnAdapter is the Windows counterpart of detectOtherVpn's `ip link`
// types: an adapter is another VPN's when it is a virtual tunnel adapter (Wintun
// and WireGuard's own driver report IF_TYPE_PROP_VIRTUAL) or a known VPN driver
// by its description (TAP adapters report plain Ethernet). It only ever feeds a
// warning the user can override, never a refusal.
func isOtherVpnAdapter(ifType uint32, description string) bool {
	const ifTypePropVirtual = 53
	if ifType == ifTypePropVirtual {
		return true
	}
	d := strings.ToLower(description)
	for _, k := range []string{"tap-", "openvpn", "wireguard", "wintun", "anyconnect", "pangp", "fortinet", "zerotier", "tailscale"} {
		if strings.Contains(d, k) {
			return true
		}
	}
	return false
}
