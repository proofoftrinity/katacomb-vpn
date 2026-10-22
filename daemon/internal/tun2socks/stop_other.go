//go:build !windows

package tun2socks

// stopRequested never fires off Windows: tun-down sends SIGTERM.
func stopRequested() <-chan struct{} { return nil }
