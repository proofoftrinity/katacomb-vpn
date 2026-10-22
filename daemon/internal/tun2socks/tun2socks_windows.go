package tun2socks

import (
	"io"
	"os"

	wgtun "golang.zx2c4.com/wireguard/tun"
)

// On Windows the engine's TUN is a Wintun adapter; name its kind ours.
func init() {
	wgtun.WintunTunnelType = "Katacomb VPN"
}

// stopRequested fires when the service closes the engine's stdin. Windows has no
// SIGTERM to send a child, and a killed engine never closes its Wintun adapter,
// which then lingers, down, until the next adapter is created.
func stopRequested() <-chan struct{} {
	ch := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		close(ch)
	}()
	return ch
}
