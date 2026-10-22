package ops

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"

	"katacomb.vpn/daemon/internal/guard"
	"katacomb.vpn/daemon/internal/wfp"
)

// KillswitchOn installs killswitchFilters ([REL-43]) for the tunnel adapter
// named p.Iface, in one transaction that replaces any kill switch in force. The
// DNS resolver needs no filter of its own: the iptables chain's DNS rules are
// scoped to the tunnel, which the tunnel's permit already covers.
func KillswitchOn(ctx context.Context, e *Env, p KillswitchParams) error {
	if err := p.check(); err != nil {
		return err
	}
	return withLock(ctx, e, func() error {
		if err := e.installKillswitch(p, adapterLUID(p.Iface)); err != nil {
			return err
		}
		if err := e.saveKillswitch(p); err != nil {
			return fmt.Errorf("recording the kill switch: %w", err)
		}
		e.mu.Lock()
		e.ks = &p
		e.mu.Unlock()
		return nil
	})
}

// KillswitchOff removes the filters, whoever installed them: the fixed keys
// find a crashed service's too.
func KillswitchOff(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error { return e.killswitchOff() })
}

func (e *Env) killswitchOff() error {
	if err := wfp.RemoveKillSwitch(); err != nil {
		return err
	}
	if err := os.Remove(e.statePath(killswitchStateName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	e.mu.Lock()
	e.ks = nil
	e.mu.Unlock()
	return nil
}

func (e *Env) installKillswitch(p KillswitchParams, luid winipcfg.LUID) error {
	if err := wfp.InstallKillSwitch(killswitchFilters(uint64(luid), netip.MustParseAddr(p.RemoteHost), p.LanSharing)); err != nil {
		return fmt.Errorf("kill switch: %w", err)
	}
	return nil
}

// replanKillswitch points an armed kill switch at a tunnel adapter that was just
// created: WFP permits a LUID, not a name, and a new adapter may get a new one.
// A no-op when the kill switch is off or armed for the other tunnel.
func (e *Env) replanKillswitch(iface string, luid winipcfg.LUID) error {
	e.mu.Lock()
	ks := e.ks
	e.mu.Unlock()
	if ks == nil || ks.Iface != iface {
		return nil
	}
	return e.installKillswitch(*ks, luid)
}

// DnsSet points the tun2socks tunnel's adapter at ip and keeps every DNS query
// inside the tunnel ([REL-44]). Windows has no resolv.conf to swap: the
// resolver lives on the adapter, and the tunnel adapter's metric 0 makes it the
// one Windows asks first.
func DnsSet(ctx context.Context, e *Env, ip string) error {
	if !guard.IsAllowedDnsResolver(ip) {
		return errors.New("DNS resolver not allowed")
	}
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return errors.New("DNS resolver not allowed")
	}
	return withLock(ctx, e, func() error {
		e.mu.Lock()
		tp := e.tun
		e.mu.Unlock()
		if tp == nil {
			return errors.New("no tunnel to point DNS at")
		}
		fam := winipcfg.AddressFamily(windows.AF_INET)
		if addr.Is6() {
			fam = windows.AF_INET6
		}
		if err := tp.luid.SetDNS(fam, []netip.Addr{addr}, nil); err != nil {
			return fmt.Errorf("DNS: %w", err)
		}
		return e.openDNSGuard(tunIface, tp.luid, tp.remote)
	})
}

// DnsRestore closes the tun2socks tunnel's DNS guard. The resolver itself
// needs no restoring: it lives on the tunnel adapter, which goes with the
// tunnel. Idempotent.
func DnsRestore(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error {
		e.closeDNSGuard(tunIface)
		return nil
	})
}
