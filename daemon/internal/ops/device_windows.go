package ops

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/conn"
	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"github.com/amnezia-vpn/amneziawg-go/v3/tun"
	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"

	"katacomb.vpn/daemon/internal/amneziawg"
	"katacomb.vpn/daemon/internal/guard"
	"katacomb.vpn/daemon/internal/wfp"
)

func init() {
	tun.WintunTunnelType = "Katacomb VPN"
}

// WireguardUp brings up WireGuard on the embedded AmneziaWG device: with no
// obfuscation keys in the config, it speaks plain WireGuard on the wire. The
// config is validated by the WireGuard guard, as on Linux.
func WireguardUp(ctx context.Context, e *Env, config []byte) error {
	if err := guard.AssertWireguardConfig(config); err != nil {
		return err
	}
	return withLock(ctx, e, func() error { return e.deviceUp(config) })
}

// AmneziaWgUp brings up AmneziaWG on the same device. binDir is accepted and
// ignored, as on Linux.
func AmneziaWgUp(ctx context.Context, e *Env, config []byte, binDir string) error {
	if err := guard.AssertAmneziaWgConfig(config); err != nil {
		return err
	}
	_ = binDir
	return withLock(ctx, e, func() error { return e.deviceUp(config) })
}

// WireguardDown and AmneziaWgDown are the same teardown: one device serves both.
func WireguardDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error { e.deviceDown(); return nil })
}

func AmneziaWgDown(ctx context.Context, e *Env) error {
	return WireguardDown(ctx, e)
}

// deviceUp does what wg-quick does around the device, in wg-quick's order:
// addresses, MTU, routes, DNS. The VPN server's /32 goes via the real gateway
// before the tunnel takes the default route's halves, so the device's own UDP
// never loops into the tunnel. Any failure tears the half-built tunnel down.
func (e *Env) deviceUp(config []byte) (err error) {
	d, err := parseAwgDirectives(config)
	if err != nil {
		return err
	}
	endpoint, perr := netip.ParseAddr(d.endpointIP)
	if perr != nil || !endpoint.Is4() {
		return errors.New("the Endpoint must be an IPv4 address")
	}
	var addrs []netip.Prefix
	for _, a := range d.addresses {
		p, err := parseInterfaceAddress(a)
		if err != nil {
			return err
		}
		addrs = append(addrs, p)
	}
	uapi, err := amneziawg.ToUAPI(config)
	if err != nil {
		return err
	}

	// A stale device (a crash of the app, a reconnect with no down) never
	// survives a bring-up, as `ip link delete sntl0` makes sure on Linux.
	e.deviceDown()

	up, err := defaultUplink()
	if err != nil {
		return err
	}
	mtu := uint32(d.mtu)
	if mtu == 0 {
		// wg-quick's rule: the uplink's MTU minus WireGuard's 80-byte overhead.
		mtu = 1420
		if up.mtu > 80 {
			mtu = up.mtu - 80
		}
	}

	tdev, err := tun.CreateTUN(wgIface, int(mtu))
	if err != nil {
		return fmt.Errorf("creating %s: %w", wgIface, err)
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	defer func() {
		if err != nil {
			dev.Close()
			e.closeDNSGuard(wgIface)
			e.removeUplinkRoutes(wgIface)
		}
	}()
	if err := dev.IpcSet(uapi); err != nil {
		return fmt.Errorf("configuring the device: %w", err)
	}
	luid := winipcfg.LUID(tdev.(*tun.NativeTun).LUID())

	if err := e.replanKillswitch(wgIface, luid); err != nil {
		return err
	}
	if err := e.addUplinkRoute(wgIface, up, netip.PrefixFrom(endpoint, 32)); err != nil {
		return err
	}
	if err := configureTunnel(luid, addrs, tunnelRoutes(d.hasV4Default, d.hasV6Default), mtu); err != nil {
		return err
	}
	if len(d.nameservers) > 0 {
		var servers []netip.Addr
		v6 := false
		for _, ns := range d.nameservers {
			a, err := netip.ParseAddr(ns)
			if err != nil {
				return fmt.Errorf("DNS: %w", err)
			}
			servers = append(servers, a)
			v6 = v6 || a.Is6()
		}
		// SetDNS keeps the servers of the family it is given.
		if err := luid.SetDNS(windows.AF_INET, servers, d.searches); err != nil {
			return fmt.Errorf("DNS: %w", err)
		}
		if v6 {
			if err := luid.SetDNS(windows.AF_INET6, servers, d.searches); err != nil {
				return fmt.Errorf("DNS: %w", err)
			}
		}
		if err := e.openDNSGuard(wgIface, luid, endpoint); err != nil {
			return err
		}
	}
	if err := dev.Up(); err != nil {
		return fmt.Errorf("starting the device: %w", err)
	}
	e.mu.Lock()
	e.dev = dev
	e.mu.Unlock()
	return nil
}

// deviceDown closes the device, which removes its adapter and the routes and
// DNS on it, then the DNS guard and the VPN server's route on the real adapter.
// With no device in this process it still removes the routes a crashed one left.
func (e *Env) deviceDown() {
	e.mu.Lock()
	dev := e.dev
	e.dev = nil
	e.mu.Unlock()
	if dev != nil {
		dev.Close()
		waitAdapterGone(wgIface)
	}
	e.closeDNSGuard(wgIface)
	e.removeUplinkRoutes(wgIface)
}

// parseInterfaceAddress reads an Address entry; a bare address is a host route.
func parseInterfaceAddress(s string) (netip.Prefix, error) {
	if p, err := netip.ParsePrefix(s); err == nil {
		return p, nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, errors.New("invalid Address")
	}
	return netip.PrefixFrom(a, a.BitLen()), nil
}

// WgHandshake reads the device's own peer state. Unlike Linux, where only a
// kernel sntl0 can be asked, the Windows device is in this process for both
// WireGuard and AmneziaWG, so Kernel ("there is something to read") is true
// whenever a device is up.
func WgHandshake(ctx context.Context, e *Env) WgHandshakeResult {
	e.mu.Lock()
	dev := e.dev
	e.mu.Unlock()
	if dev == nil {
		return WgHandshakeResult{}
	}
	uapi, err := dev.IpcGet()
	if err != nil {
		return WgHandshakeResult{}
	}
	return WgHandshakeResult{Kernel: true, AgeSeconds: handshakeAge(uapi, time.Now())}
}

// handshakeAge reads the newest last_handshake_time_sec in a UAPI dump: -1 when
// no peer ever completed one, never negative after a clock step.
func handshakeAge(uapi string, now time.Time) int {
	var latest int64
	for _, line := range strings.Split(uapi, "\n") {
		v, ok := strings.CutPrefix(line, "last_handshake_time_sec=")
		if !ok {
			continue
		}
		if ts, err := strconv.ParseInt(v, 10, 64); err == nil && ts > latest {
			latest = ts
		}
	}
	if latest == 0 {
		return -1
	}
	return int(max(now.Unix()-latest, 0))
}

// --- DNS protection --------------------------------------------------------------

// openDNSGuard puts dnsGuardFilters in force for the tunnel named owner,
// replacing any guard already open.
func (e *Env) openDNSGuard(owner string, luid winipcfg.LUID, endpoint netip.Addr) error {
	g, err := wfp.OpenDNSGuard(dnsGuardFilters(uint64(luid), endpoint))
	if err != nil {
		return fmt.Errorf("DNS protection: %w", err)
	}
	e.mu.Lock()
	old := e.dns
	e.dns, e.dnsOwner = g, owner
	e.mu.Unlock()
	_ = old.Close()
	return nil
}

// closeDNSGuard closes the guard if the tunnel named owner holds it.
func (e *Env) closeDNSGuard(owner string) {
	e.mu.Lock()
	g := e.dns
	if e.dnsOwner != owner {
		g = nil
	} else {
		e.dns, e.dnsOwner = nil, ""
	}
	e.mu.Unlock()
	_ = g.Close()
}
