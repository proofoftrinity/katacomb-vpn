package ops

import (
	"errors"
	"strconv"

	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

// Status reports which of our adapters exist, as the Linux one reads
// /sys/class/net. There is no OpenVPN on Windows.
func Status(e *Env) StatusResult {
	_, wg := adapter(wgIface)
	_, tun := adapter(tunIface)
	return StatusResult{WgUp: wg, TunUp: tun}
}

// TrafficCounters reads one of our tunnel adapters' byte counters: what the app
// reads from /proc/net/dev on Linux.
func TrafficCounters(e *Env, iface string) (TrafficResult, error) {
	if iface != wgIface && iface != tunIface {
		return TrafficResult{}, errors.New("not a tunnel interface")
	}
	row, ok := adapter(iface)
	if !ok {
		return TrafficResult{}, nil
	}
	return TrafficResult{Present: true, RxBytes: row.InOctets, TxBytes: row.OutOctets}, nil
}

// DefaultRoute reports the IPv4 default route the tunnels leave by: what the
// app reads from `ip route show default` on Linux, to notice the network change
// under a tunnel.
func DefaultRoute(e *Env) DefaultRouteResult {
	u, err := defaultUplink()
	if err != nil {
		return DefaultRouteResult{}
	}
	return DefaultRouteResult{Gateway: u.gateway.String(), Iface: strconv.FormatUint(uint64(u.index), 10)}
}

// OtherVpns names the other VPNs' adapters that are up ([isOtherVpnAdapter]).
func OtherVpns(e *Env) OtherVpnsResult {
	res := OtherVpnsResult{Names: []string{}}
	rows, err := winipcfg.GetIfTable2Ex(winipcfg.MibIfEntryNormal)
	if err != nil {
		return res
	}
	for i := range rows {
		r := &rows[i]
		alias := r.Alias()
		// Filter interfaces are a real adapter's shadows in the table, not adapters.
		if alias == wgIface || alias == tunIface || r.OperStatus != winipcfg.IfOperStatusUp || r.InterfaceAndOperStatusFlags&winipcfg.IAOSFFilterInterface != 0 {
			continue
		}
		if isOtherVpnAdapter(uint32(r.Type), r.Description()) {
			res.Names = append(res.Names, alias)
		}
	}
	return res
}
