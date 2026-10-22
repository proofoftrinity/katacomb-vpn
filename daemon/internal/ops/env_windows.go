// Package ops on Windows: the same verbs, the same validation and the same
// trust boundary as on Linux, implemented in the service process instead of by
// exec'ing ip, iptables and wg-quick. Every tunnel part runs inside the service
// (the WireGuard/AmneziaWG device) or under it in a job object (the tun2socks
// engine), so a crashed or stopped service takes every tunnel with it. What
// outlives the process is kept in the state directory: the routes added on the
// real adapter, and the armed kill switch, whose filters outlive it on purpose.
package ops

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/amnezia-vpn/amneziawg-go/v3/device"
	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"

	"katacomb.vpn/daemon/internal/wfp"
)

const (
	routesStateName     = "routes.state"
	killswitchStateName = "killswitch.state"
	lockName            = ".lock"
)

// StateDir is %ProgramData%\Katacomb VPN.
func StateDir() string {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "Katacomb VPN")
}

// Env is the service's live state. Production builds one with NewEnv; the
// fields a test may replace are exported.
type Env struct {
	// Dir is the state directory (StateDir in production).
	Dir string
	// Executable is this helper's path; tun-up self-execs it as `_tun2socks`.
	Executable func() (string, error)
	// Warn reports a non-fatal condition (the service's log).
	Warn func(msg string)

	// opMu serialises the state-changing verbs inside this process; the lock
	// file in Dir serialises them with `service teardown`.
	opMu chan struct{}

	// mu guards the fields below, which the read-only ops read concurrently.
	mu       sync.Mutex
	dev      *device.Device
	tun      *tunProcess
	dns      *wfp.DNSGuard
	dnsOwner string // wgIface or tunIface: the tunnel whose teardown closes dns
	ks       *KillswitchParams
	job      windows.Handle
	owner    uint32 // the session of the client that brought the tunnel up
	hasOwner bool
}

// NewEnv returns the production Env for state directory dir.
func NewEnv(dir string) *Env {
	return &Env{
		Dir:        dir,
		Executable: os.Executable,
		Warn:       func(msg string) { fmt.Fprintf(os.Stderr, "Warning: %s\n", msg) },
		opMu:       make(chan struct{}, 1),
	}
}

func (e *Env) statePath(name string) string { return filepath.Join(e.Dir, name) }

// withLock is the Windows counterpart of the Linux flock: one state-changing
// verb at a time, in this process and against `service teardown` in another,
// bounded by ctx so a stuck holder surfaces as an error, not a hang.
func withLock(ctx context.Context, e *Env, fn func() error) error {
	select {
	case e.opMu <- struct{}{}:
	case <-ctx.Done():
		return errors.New("another privileged operation is still running")
	}
	defer func() { <-e.opMu }()

	p, err := windows.UTF16PtrFromString(e.statePath(lockName))
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return fmt.Errorf("lock: %w", err)
	}
	defer windows.CloseHandle(h)
	for {
		ol := new(windows.Overlapped)
		err := windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, ol)
		if err == nil {
			defer windows.UnlockFileEx(h, 0, 1, 0, ol)
			break
		}
		if !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return fmt.Errorf("lock: %w", err)
		}
		select {
		case <-ctx.Done():
			return errors.New("another privileged operation is still running")
		case <-time.After(50 * time.Millisecond):
		}
	}
	return fn()
}

// SetOwner records the session of the client that brought the tunnel up, so
// the service can tear it down when that user logs off.
func (e *Env) SetOwner(session uint32) {
	e.mu.Lock()
	e.owner, e.hasOwner = session, true
	e.mu.Unlock()
}

// Owner reports the session recorded by SetOwner.
func (e *Env) Owner() (uint32, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.owner, e.hasOwner
}

// --- the real adapter ------------------------------------------------------------

// uplink is the adapter and gateway the default route leaves by: where the VPN
// server's own /32 and the split-tunnel routes go.
type uplink struct {
	luid    winipcfg.LUID
	index   uint32
	gateway netip.Addr
	mtu     uint32
}

// defaultUplink picks the IPv4 default route with the lowest route plus
// interface metric, as Windows itself does. Our tunnels never hold a default
// route (they take the two /1 halves), so they are never picked.
func defaultUplink() (uplink, error) {
	rows, err := winipcfg.GetIPForwardTable2(windows.AF_INET)
	if err != nil {
		return uplink{}, fmt.Errorf("reading the routing table: %w", err)
	}
	best := ^uint32(0)
	var u uplink
	for _, r := range rows {
		if r.DestinationPrefix.PrefixLength != 0 {
			continue
		}
		gw := r.NextHop.Addr()
		if !gw.Is4() || gw.IsUnspecified() {
			continue
		}
		ifc, err := r.InterfaceLUID.IPInterface(windows.AF_INET)
		if err != nil || !ifc.Connected {
			continue
		}
		if m := r.Metric + ifc.Metric; m < best {
			best = m
			u = uplink{luid: r.InterfaceLUID, index: r.InterfaceIndex, gateway: gw, mtu: ifc.NLMTU}
		}
	}
	if !u.gateway.IsValid() {
		return uplink{}, errors.New("no default route: is the network connected?")
	}
	return u, nil
}

// adapter finds a live adapter by its alias (sntl0, sntl-tun). Live means up: a
// tunnel whose process died leaves its Wintun adapter behind, down, until the
// next adapter is created, and that is no tunnel.
func adapter(alias string) (*winipcfg.MibIfRow2, bool) {
	rows, err := winipcfg.GetIfTable2Ex(winipcfg.MibIfEntryNormal)
	if err != nil {
		return nil, false
	}
	for i := range rows {
		if rows[i].Alias() == alias && rows[i].OperStatus == winipcfg.IfOperStatusUp {
			return &rows[i], true
		}
	}
	return nil, false
}

// waitAdapterGone returns once no adapter, live or not, holds alias, or after 5 s.
// Windows removes a closed Wintun adapter after the close returns, and a new
// adapter created meanwhile cannot take the name.
func waitAdapterGone(alias string) {
	for i := 0; i < 50; i++ {
		rows, err := winipcfg.GetIfTable2Ex(winipcfg.MibIfEntryNormal)
		if err != nil {
			return
		}
		held := false
		for j := range rows {
			held = held || rows[j].Alias() == alias
		}
		if !held {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func adapterLUID(alias string) winipcfg.LUID {
	if row, ok := adapter(alias); ok {
		return row.InterfaceLUID
	}
	return 0
}

// --- routes on the real adapter --------------------------------------------------

// uplinkRoute is one route added on the real adapter, recorded in routes.state
// because it outlives the process: a crashed service leaves its tunnel's routes
// on the adapter, where Heal finds and removes them.
type uplinkRoute struct {
	owner   string // the tunnel it belongs to: wgIface or tunIface
	luid    winipcfg.LUID
	prefix  netip.Prefix
	nextHop netip.Addr
}

func (r uplinkRoute) String() string {
	return fmt.Sprintf("%s %d %s %s", r.owner, uint64(r.luid), r.prefix, r.nextHop)
}

func (e *Env) readRoutes() []uplinkRoute {
	f, err := os.Open(e.statePath(routesStateName))
	if err != nil {
		return nil
	}
	defer f.Close()
	var rs []uplinkRoute
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fl := strings.Fields(sc.Text())
		if len(fl) != 4 {
			continue
		}
		luid, err1 := strconv.ParseUint(fl[1], 10, 64)
		prefix, err2 := netip.ParsePrefix(fl[2])
		hop, err3 := netip.ParseAddr(fl[3])
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		rs = append(rs, uplinkRoute{owner: fl[0], luid: winipcfg.LUID(luid), prefix: prefix, nextHop: hop})
	}
	return rs
}

func (e *Env) writeRoutes(rs []uplinkRoute) error {
	if len(rs) == 0 {
		err := os.Remove(e.statePath(routesStateName))
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var b strings.Builder
	for _, r := range rs {
		b.WriteString(r.String() + "\n")
	}
	return os.WriteFile(e.statePath(routesStateName), []byte(b.String()), 0o600)
}

// addUplinkRoute adds prefix via the uplink's gateway, recording it FIRST, so a
// crash between the two never leaves a route nothing knows about.
func (e *Env) addUplinkRoute(owner string, u uplink, prefix netip.Prefix) error {
	r := uplinkRoute{owner: owner, luid: u.luid, prefix: prefix, nextHop: u.gateway}
	if err := e.writeRoutes(append(e.readRoutes(), r)); err != nil {
		return fmt.Errorf("recording a route: %w", err)
	}
	err := u.luid.AddRoute(prefix, u.gateway, 0)
	if err != nil && !errors.Is(err, windows.ERROR_OBJECT_ALREADY_EXISTS) {
		return fmt.Errorf("route %s via %s: %w", prefix, u.gateway, err)
	}
	return nil
}

// removeUplinkRoutes deletes the recorded routes of one tunnel ("" = every
// tunnel's) and forgets them. A route already gone is not an error.
func (e *Env) removeUplinkRoutes(owner string) {
	var keep []uplinkRoute
	for _, r := range e.readRoutes() {
		if owner != "" && r.owner != owner {
			keep = append(keep, r)
			continue
		}
		if err := r.luid.DeleteRoute(r.prefix, r.nextHop); err != nil && !errors.Is(err, windows.ERROR_NOT_FOUND) {
			e.Warn(fmt.Sprintf("could not remove route %s: %v", r.prefix, err))
		}
	}
	if err := e.writeRoutes(keep); err != nil {
		e.Warn(fmt.Sprintf("could not update %s: %v", routesStateName, err))
	}
}

// configureTunnel gives a tunnel adapter its addresses, the full-tunnel routes,
// metric 0 (so its routes and its resolvers win over the real adapter's) and MTU.
func configureTunnel(luid winipcfg.LUID, addrs []netip.Prefix, routes []netip.Prefix, mtu uint32) error {
	if err := luid.SetIPAddresses(addrs); err != nil {
		return fmt.Errorf("tunnel address: %w", err)
	}
	families := []winipcfg.AddressFamily{windows.AF_INET}
	for _, a := range addrs {
		if a.Addr().Is6() {
			families = append(families, windows.AF_INET6)
			break
		}
	}
	for _, fam := range families {
		ifc, err := luid.IPInterface(fam)
		if err != nil {
			return fmt.Errorf("tunnel interface: %w", err)
		}
		ifc.UseAutomaticMetric = false
		ifc.Metric = 0
		ifc.NLMTU = mtu
		if err := ifc.Set(); err != nil {
			return fmt.Errorf("tunnel interface: %w", err)
		}
	}
	for _, r := range routes {
		if r.Addr().Is6() && len(families) == 1 {
			continue // no IPv6 address: the halves would only blackhole
		}
		hop := netip.IPv4Unspecified()
		if r.Addr().Is6() {
			hop = netip.IPv6Unspecified()
		}
		if err := luid.AddRoute(r, hop, 0); err != nil && !errors.Is(err, windows.ERROR_OBJECT_ALREADY_EXISTS) {
			return fmt.Errorf("tunnel route %s: %w", r, err)
		}
	}
	return nil
}

// --- the kill switch's state -----------------------------------------------------

func (e *Env) loadKillswitch() {
	b, err := os.ReadFile(e.statePath(killswitchStateName))
	if err != nil {
		return
	}
	f := strings.Fields(string(b))
	if len(f) != 4 {
		return
	}
	p := KillswitchParams{Iface: f[0], RemoteHost: f[1], LanSharing: f[3] == "lan"}
	if f[2] != "-" {
		p.DnsIp = f[2]
	}
	if p.check() == nil {
		e.ks = &p
	}
}

func (e *Env) saveKillswitch(p KillswitchParams) error {
	dns, lan := p.DnsIp, "-"
	if dns == "" {
		dns = "-"
	}
	if p.LanSharing {
		lan = "lan"
	}
	return os.WriteFile(e.statePath(killswitchStateName), fmt.Appendf(nil, "%s %s %s %s\n", p.Iface, p.RemoteHost, dns, lan), 0o600)
}
