//go:build linux

package ops

// Status reads the kernel's interface table (world-readable; no lock, no spawn).
func Status(e *Env) StatusResult {
	return StatusResult{
		WgUp:   linkExists(e, wgIface),
		TunUp:  linkExists(e, tunIface),
		OvpnUp: linkExists(e, ovpnIface),
	}
}
