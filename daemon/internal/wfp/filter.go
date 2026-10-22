// Package wfp is the Windows half of the kill switch and of DNS protection:
// filters in the Windows Filtering Platform, under Katacomb VPN's own provider
// and sublayers, so they can be found and removed without touching anyone else's.
//
// This file is the pure half: the description of one filter, which internal/ops
// plans and tests on every platform. The *_windows.go files install descriptions
// into the base filtering engine; their syscall layer is adapted from
// wireguard-windows' tunnel/firewall (MIT, Copyright (C) 2019-2021 WireGuard LLC).
package wfp

import "net/netip"

// Action is what a matching filter decides.
type Action uint8

const (
	Permit Action = iota + 1
	Block
)

// Layer is where a filter is evaluated: the ALE layers that authorise a new
// flow, once per connection (TCP) or per socket and remote (UDP). Connect is the
// outbound side (iptables' OUTPUT), Accept the inbound side.
type Layer uint8

const (
	ConnectV4 Layer = iota + 1
	AcceptV4
	ConnectV6
	AcceptV6
)

// IsV6 reports whether the layer sees IPv6 traffic.
func (l Layer) IsV6() bool { return l == ConnectV6 || l == AcceptV6 }

// IP protocol numbers a filter can match.
const (
	TCP uint8 = 6
	UDP uint8 = 17
)

// Filter is one filter. Every condition that is set must match; a zero value
// means "any". Protocols is the one list: any of its entries matches.
type Filter struct {
	Name   string
	Layer  Layer
	Action Action
	// Weight orders filters inside one sublayer: the highest-weight match decides.
	Weight uint8
	// Loopback matches traffic that never leaves the machine.
	Loopback bool
	// Interface is the local interface's LUID.
	Interface uint64
	// Remote is the remote address range; its family must match the layer's.
	Remote     netip.Prefix
	Protocols  []uint8
	LocalPort  uint16
	RemotePort uint16
}
