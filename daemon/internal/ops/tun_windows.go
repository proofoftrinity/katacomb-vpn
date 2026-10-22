package ops

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os/exec"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

// tunProcess is the running tun2socks engine: `<self> _tun2socks …`, in the
// service's job object, so it dies with the service like systemd kills a
// stopped Linux daemon's children. It runs apart from the service because the
// engine exits the process on any start failure.
type tunProcess struct {
	cmd    *exec.Cmd
	stdin  io.Closer // closing it is the engine's stop signal
	done   chan struct{}
	luid   winipcfg.LUID
	remote netip.Addr
}

// TunUp starts the tun2socks engine on a Wintun adapter `sntl-tun` and routes
// everything into it, with the VPN server's /32 and the split-tunnel routes via
// the real gateway, as on Linux. The gateway and interface the app sends are
// validated and IGNORED: the service reads the default route itself, at the
// moment it adds the routes. Returns the engine's pid.
func TunUp(ctx context.Context, e *Env, p TunUpParams) (int, error) {
	if err := p.check(); err != nil {
		return 0, err
	}
	self, err := e.Executable()
	if err != nil {
		return 0, fmt.Errorf("cannot locate the helper executable: %v", err)
	}
	bypass, err := acceptedBypassRoutes(p.BypassRoutes, e.Warn)
	if err != nil {
		return 0, err
	}
	remote := netip.MustParseAddr(p.RemoteHost) // check() proved it is IPv4
	var bypassPrefixes []netip.Prefix
	for _, b := range bypass {
		if pr, err := netip.ParsePrefix(b); err == nil {
			bypassPrefixes = append(bypassPrefixes, pr)
		}
	}

	var pid int
	err = withLock(ctx, e, func() (err error) {
		e.tunDown()
		up, err := defaultUplink()
		if err != nil {
			return err
		}
		tp, err := e.startEngine(self, p.SocksAddr)
		if err != nil {
			return err
		}
		defer func() {
			if err != nil {
				tp.stop()
				e.removeUplinkRoutes(tunIface)
			}
		}()
		tp.remote = remote
		for i := 0; i < tunPollTries && tp.luid == 0; i++ {
			select {
			case <-tp.done:
				return errors.New("tun2socks exited before the TUN interface appeared")
			case <-time.After(tunPollInterval):
			}
			tp.luid = adapterLUID(tunIface)
		}
		if tp.luid == 0 {
			return errors.New("TUN interface did not appear")
		}

		if err := e.replanKillswitch(tunIface, tp.luid); err != nil {
			return err
		}
		for _, pr := range append([]netip.Prefix{netip.PrefixFrom(remote, 32)}, bypassPrefixes...) {
			if err := e.addUplinkRoute(tunIface, up, pr); err != nil {
				return err
			}
		}
		mtu, _ := strconv.Atoi(tunMTU)
		if err := configureTunnel(tp.luid, []netip.Prefix{netip.MustParsePrefix(tunAddr)}, tunnelRoutes(true, false), uint32(mtu)); err != nil {
			return err
		}
		e.mu.Lock()
		e.tun = tp
		e.mu.Unlock()
		pid = tp.cmd.Process.Pid
		return nil
	})
	return pid, err
}

// TunDown stops the engine (its adapter, routes and DNS go with it), closes the
// DNS guard, and removes the routes on the real adapter, including those a
// crashed service left.
func TunDown(ctx context.Context, e *Env) error {
	return withLock(ctx, e, func() error { e.tunDown(); return nil })
}

func (e *Env) tunDown() {
	e.mu.Lock()
	tp := e.tun
	e.tun = nil
	e.mu.Unlock()
	if tp != nil {
		tp.stop()
		waitAdapterGone(tunIface)
	}
	e.closeDNSGuard(tunIface)
	e.removeUplinkRoutes(tunIface)
}

// startEngine self-execs the engine in the job object. Its argv carries what
// the Linux one does; -proxy is the one value it reads.
func (e *Env) startEngine(self, socks string) (*tunProcess, error) {
	job, err := e.jobObject()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(self, "_tun2socks",
		"-device", "tun://"+tunIface,
		"-proxy", "socks5://"+socks,
		"-mtu", tunMTU, "-loglevel", "silent")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start tun2socks: %v", err)
	}
	tp := &tunProcess{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(tp.done) }()
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, h)
		windows.CloseHandle(h)
	}
	if err != nil {
		tp.stop()
		return nil, fmt.Errorf("could not contain tun2socks: %v", err)
	}
	return tp, nil
}

// stop asks the engine to stop by closing its stdin, which lets it close its
// Wintun adapter (a killed engine leaves the adapter behind), and kills it if
// it has not exited within 5 s. It returns once the engine is gone.
func (tp *tunProcess) stop() {
	_ = tp.stdin.Close()
	select {
	case <-tp.done:
		return
	case <-time.After(5 * time.Second):
	}
	_ = tp.cmd.Process.Kill()
	select {
	case <-tp.done:
	case <-time.After(5 * time.Second):
	}
}

// jobObject is created once: every process in it is killed when the service's
// handle closes, which a crash closes too.
func (e *Env) jobObject() (windows.Handle, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.job != 0 {
		return e.job, nil
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("job object: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("job object: %w", err)
	}
	e.job = job
	return job, nil
}
