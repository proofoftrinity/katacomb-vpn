package wfp

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The kill switch's objects outlive the process that adds them (its session is
// not dynamic), so a restarted service, the uninstaller and `service teardown`
// find them by these fixed keys. Data1 and Data4 spell "Katk" and "katacomb".
var (
	providerKey        = windows.GUID{Data1: 0x4b61746b, Data2: 0x6b73, Data3: 0x0001, Data4: [8]byte{0x6b, 0x61, 0x74, 0x61, 0x63, 0x6f, 0x6d, 0x62}}
	killSwitchSublayer = windows.GUID{Data1: 0x4b61746b, Data2: 0x6b73, Data3: 0x0002, Data4: [8]byte{0x6b, 0x61, 0x74, 0x61, 0x63, 0x6f, 0x6d, 0x62}}
	dnsGuardSublayer   = windows.GUID{Data1: 0x4b61746b, Data2: 0x6b73, Data3: 0x0003, Data4: [8]byte{0x6b, 0x61, 0x74, 0x61, 0x63, 0x6f, 0x6d, 0x62}}
)

// The "not found" answers a removal treats as already done.
const (
	errFilterNotFound   = syscall.Errno(0x80320003) // FWP_E_FILTER_NOT_FOUND
	errProviderNotFound = syscall.Errno(0x80320005) // FWP_E_PROVIDER_NOT_FOUND
	errSublayerNotFound = syscall.Errno(0x80320007) // FWP_E_SUBLAYER_NOT_FOUND
)

func openEngine(dynamic bool) (uintptr, error) {
	name, err := windows.UTF16PtrFromString("Katacomb VPN")
	if err != nil {
		return 0, err
	}
	session := wtFwpmSession0{
		displayData:          wtFwpmDisplayData0{name: name},
		txnWaitTimeoutInMSec: windows.INFINITE,
	}
	if dynamic {
		session.flags = cFWPM_SESSION_FLAG_DYNAMIC
	}
	var engine uintptr
	if err := fwpmEngineOpen0(&session, &engine); err != nil {
		return 0, fmt.Errorf("open the filtering engine: %w", err)
	}
	return engine, nil
}

// inTransaction runs fn atomically: either everything it added is in force, or
// nothing it did is.
func inTransaction(engine uintptr, fn func() error) error {
	if err := fwpmTransactionBegin0(engine); err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	if err := fn(); err != nil {
		_ = fwpmTransactionAbort0(engine)
		return err
	}
	if err := fwpmTransactionCommit0(engine); err != nil {
		_ = fwpmTransactionAbort0(engine)
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// InstallKillSwitch puts filters in force as the kill switch, replacing the set
// already installed, in one transaction. The session is NOT dynamic: the filters
// outlive this process, so a crashed service fails closed, and they live in the
// base filtering engine's memory only, so a reboot clears them, as it clears
// iptables.
func InstallKillSwitch(filters []Filter) error {
	engine, err := openEngine(false)
	if err != nil {
		return err
	}
	defer fwpmEngineClose0(engine)
	return inTransaction(engine, func() error {
		if err := removeKillSwitch(engine); err != nil {
			return err
		}
		name, err := windows.UTF16PtrFromString("Katacomb VPN")
		if err != nil {
			return err
		}
		provider := wtFwpmProvider0{providerKey: providerKey, displayData: wtFwpmDisplayData0{name: name}}
		if err := fwpmProviderAdd0(engine, &provider); err != nil {
			return fmt.Errorf("add provider: %w", err)
		}
		if err := addSublayer(engine, killSwitchSublayer, &providerKey, "Katacomb VPN kill switch", ^uint16(0)); err != nil {
			return err
		}
		return addFilters(engine, killSwitchSublayer, &providerKey, filters)
	})
}

// RemoveKillSwitch deletes every filter in the kill switch's sublayer, then the
// sublayer and the provider. Idempotent: nothing installed is not an error.
func RemoveKillSwitch() error {
	engine, err := openEngine(false)
	if err != nil {
		return err
	}
	defer fwpmEngineClose0(engine)
	return inTransaction(engine, func() error { return removeKillSwitch(engine) })
}

// CountKillSwitch reports how many kill switch filters are in force.
func CountKillSwitch() (int, error) {
	engine, err := openEngine(false)
	if err != nil {
		return 0, err
	}
	defer fwpmEngineClose0(engine)
	ids, err := filterIDs(engine, killSwitchSublayer)
	return len(ids), err
}

func removeKillSwitch(engine uintptr) error {
	if err := removeFilters(engine, killSwitchSublayer); err != nil {
		return err
	}
	if err := fwpmSubLayerDeleteByKey0(engine, &killSwitchSublayer); err != nil && !errors.Is(err, errSublayerNotFound) {
		return fmt.Errorf("delete sublayer: %w", err)
	}
	if err := fwpmProviderDeleteByKey0(engine, &providerKey); err != nil && !errors.Is(err, errProviderNotFound) {
		return fmt.Errorf("delete provider: %w", err)
	}
	return nil
}

// DNSGuard holds DNS protection's filters in a DYNAMIC session: Close, or this
// process dying, removes them. DNS protection belongs to a tunnel, and every
// tunnel dies with the service, so its filters must die with it too; the kill
// switch is what stays behind when the user asked for that.
type DNSGuard struct {
	engine uintptr
}

// OpenDNSGuard puts filters in force in a sublayer of their own.
func OpenDNSGuard(filters []Filter) (*DNSGuard, error) {
	engine, err := openEngine(true)
	if err != nil {
		return nil, err
	}
	err = inTransaction(engine, func() error {
		if err := addSublayer(engine, dnsGuardSublayer, nil, "Katacomb VPN DNS protection", ^uint16(0)-1); err != nil {
			return err
		}
		return addFilters(engine, dnsGuardSublayer, nil, filters)
	})
	if err != nil {
		_ = fwpmEngineClose0(engine)
		return nil, err
	}
	return &DNSGuard{engine: engine}, nil
}

// Close removes the guard's filters by closing its session.
func (g *DNSGuard) Close() error {
	if g == nil || g.engine == 0 {
		return nil
	}
	err := fwpmEngineClose0(g.engine)
	g.engine = 0
	return err
}

// CountDNSGuard reports how many DNS protection filters are in force, whoever owns them.
func CountDNSGuard() (int, error) {
	engine, err := openEngine(false)
	if err != nil {
		return 0, err
	}
	defer fwpmEngineClose0(engine)
	ids, err := filterIDs(engine, dnsGuardSublayer)
	return len(ids), err
}

func addSublayer(engine uintptr, key windows.GUID, provider *windows.GUID, name string, weight uint16) error {
	n, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	sl := wtFwpmSublayer0{subLayerKey: key, displayData: wtFwpmDisplayData0{name: n}, providerKey: provider, weight: weight}
	if err := fwpmSubLayerAdd0(engine, &sl); err != nil {
		return fmt.Errorf("add sublayer: %w", err)
	}
	return nil
}

func removeFilters(engine uintptr, sublayer windows.GUID) error {
	ids, err := filterIDs(engine, sublayer)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := fwpmFilterDeleteById0(engine, id); err != nil && !errors.Is(err, errFilterNotFound) {
			return fmt.Errorf("delete filter %d: %w", id, err)
		}
	}
	return nil
}

// filterIDs enumerates every filter in the engine and keeps the ones in sublayer.
func filterIDs(engine uintptr, sublayer windows.GUID) ([]uint64, error) {
	var enum uintptr
	if err := fwpmFilterCreateEnumHandle0(engine, &enum); err != nil {
		return nil, fmt.Errorf("enumerate filters: %w", err)
	}
	defer fwpmFilterDestroyEnumHandle0(engine, enum)
	var ids []uint64
	for {
		var entries unsafe.Pointer
		var n uint32
		if err := fwpmFilterEnum0(engine, enum, 256, &entries, &n); err != nil {
			return nil, fmt.Errorf("enumerate filters: %w", err)
		}
		if n == 0 {
			if entries != nil {
				fwpmFreeMemory0(&entries)
			}
			return ids, nil
		}
		for _, f := range unsafe.Slice((**wtFwpmFilter0)(entries), n) {
			if f.subLayerKey == sublayer {
				ids = append(ids, f.filterID)
			}
		}
		fwpmFreeMemory0(&entries)
	}
}

func addFilters(engine uintptr, sublayer windows.GUID, provider *windows.GUID, filters []Filter) error {
	for _, f := range filters {
		if err := addFilter(engine, sublayer, provider, f); err != nil {
			return fmt.Errorf("add filter %q: %w", f.Name, err)
		}
	}
	return nil
}

var layerKeys = map[Layer]windows.GUID{
	ConnectV4: cFWPM_LAYER_ALE_AUTH_CONNECT_V4,
	AcceptV4:  cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
	ConnectV6: cFWPM_LAYER_ALE_AUTH_CONNECT_V6,
	AcceptV6:  cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
}

// addFilter turns one description into an FWPM_FILTER0. Values wider than a
// pointer travel by pointer to Go memory, kept alive until the call returns.
func addFilter(engine uintptr, sublayer windows.GUID, provider *windows.GUID, f Filter) error {
	layer, ok := layerKeys[f.Layer]
	if !ok {
		return errors.New("unknown layer")
	}
	var action wtFwpActionType
	switch f.Action {
	case Permit:
		action = cFWP_ACTION_PERMIT
	case Block:
		action = cFWP_ACTION_BLOCK
	default:
		return errors.New("unknown action")
	}
	cond := func(field windows.GUID, match wtFwpMatchType, typ wtFwpDataType, value uintptr) wtFwpmFilterCondition0 {
		return wtFwpmFilterCondition0{fieldKey: field, matchType: match, conditionValue: wtFwpValue0{_type: typ, value: value}}
	}
	var (
		conds []wtFwpmFilterCondition0
		luid  = new(uint64)
		v4    = new(wtFwpV4AddrAndMask)
		v6    = new(wtFwpV6AddrAndMask)
	)
	if f.Loopback {
		conds = append(conds, cond(cFWPM_CONDITION_FLAGS, cFWP_MATCH_FLAGS_ALL_SET, cFWP_UINT32, cFWP_CONDITION_FLAG_IS_LOOPBACK))
	}
	if f.Interface != 0 {
		*luid = f.Interface
		conds = append(conds, cond(cFWPM_CONDITION_IP_LOCAL_INTERFACE, cFWP_MATCH_EQUAL, cFWP_UINT64, uintptr(unsafe.Pointer(luid))))
	}
	if f.Remote.IsValid() {
		addr := f.Remote.Addr()
		if addr.Is4() == f.Layer.IsV6() {
			return errors.New("remote address family does not match the layer")
		}
		if addr.Is4() {
			a := addr.As4()
			host := uint32(a[0])<<24 | uint32(a[1])<<16 | uint32(a[2])<<8 | uint32(a[3])
			if f.Remote.Bits() == 32 {
				conds = append(conds, cond(cFWPM_CONDITION_IP_REMOTE_ADDRESS, cFWP_MATCH_EQUAL, cFWP_UINT32, uintptr(host)))
			} else {
				v4.addr, v4.mask = host, ^uint32(0)<<(32-f.Remote.Bits())
				conds = append(conds, cond(cFWPM_CONDITION_IP_REMOTE_ADDRESS, cFWP_MATCH_EQUAL, cFWP_V4_ADDR_MASK, uintptr(unsafe.Pointer(v4))))
			}
		} else {
			v6.addr, v6.prefixLength = addr.As16(), uint8(f.Remote.Bits())
			conds = append(conds, cond(cFWPM_CONDITION_IP_REMOTE_ADDRESS, cFWP_MATCH_EQUAL, cFWP_V6_ADDR_MASK, uintptr(unsafe.Pointer(v6))))
		}
	}
	// One condition per protocol, same field: WFP ORs conditions on one field.
	for _, p := range f.Protocols {
		conds = append(conds, cond(cFWPM_CONDITION_IP_PROTOCOL, cFWP_MATCH_EQUAL, cFWP_UINT8, uintptr(p)))
	}
	if f.LocalPort != 0 {
		conds = append(conds, cond(cFWPM_CONDITION_IP_LOCAL_PORT, cFWP_MATCH_EQUAL, cFWP_UINT16, uintptr(f.LocalPort)))
	}
	if f.RemotePort != 0 {
		conds = append(conds, cond(cFWPM_CONDITION_IP_REMOTE_PORT, cFWP_MATCH_EQUAL, cFWP_UINT16, uintptr(f.RemotePort)))
	}

	name, err := windows.UTF16PtrFromString(f.Name)
	if err != nil {
		return err
	}
	filter := wtFwpmFilter0{
		displayData: wtFwpmDisplayData0{name: name},
		providerKey: provider,
		layerKey:    layer,
		subLayerKey: sublayer,
		weight:      wtFwpValue0{_type: cFWP_UINT8, value: uintptr(f.Weight)},
		action:      wtFwpmAction0{_type: action},
	}
	if len(conds) > 0 {
		filter.numFilterConditions = uint32(len(conds))
		filter.filterCondition = &conds[0]
	}
	var id uint64
	err = fwpmFilterAdd0(engine, &filter, &id)
	runtime.KeepAlive(conds)
	runtime.KeepAlive(luid)
	runtime.KeepAlive(v4)
	runtime.KeepAlive(v6)
	return err
}
