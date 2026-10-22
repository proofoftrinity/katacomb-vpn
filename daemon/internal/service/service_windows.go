// Package service is the Windows service: the `daemon` entry the service
// control manager starts, and the `service install|uninstall|teardown` verbs
// the installer runs. The service is the only way to root on Windows; there is
// no elevation fallback.
package service

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
	"katacomb.vpn/daemon/internal/server"
)

const (
	// Name is the service's key name; DisplayName what services.msc shows.
	Name        = "KatacombVPN"
	DisplayName = "Katacomb VPN"
	description = "Brings Katacomb VPN tunnels up and down, and keeps the kill switch."

	logName    = "service.log"
	logMaxSize = 1 << 20
)

// Run is `katacomb-vpn-helper daemon <user SID>`, which only the service control
// manager starts: the SID is the one user the pipe admits.
func Run(args []string) int {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		fmt.Fprintln(os.Stderr, "katacomb-vpn-helper daemon runs as the Katacomb VPN service only")
		return 1
	}
	if len(args) != 1 {
		return 2
	}
	if err := svc.Run(Name, &handler{user: args[0]}); err != nil {
		return 1
	}
	return 0
}

type handler struct{ user string }

func (h *handler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending, WaitHint: 10000}
	dir := ops.StateDir()
	if err := ops.PrepareStateDir(dir); err != nil {
		return true, 1
	}
	logf := openLog(filepath.Join(dir, logName))
	user, err := windows.StringToSid(h.user)
	if err != nil {
		logf("invalid user SID: %v", err)
		return true, 2
	}
	e := ops.NewEnv(dir)
	e.Warn = func(msg string) { logf("warning: %s", msg) }
	ops.Heal(e)

	ln, err := server.Listen(user)
	if err != nil {
		logf("cannot listen on %s: %v", server.PipePath, err)
		return true, 3
	}
	go server.NewService(e, logf).Serve(ln)
	logf("listening on %s (protocol v%d) for %s", server.PipePath, protocol.Version, h.user)
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange}

	for c := range requests {
		switch c.Cmd {
		case svc.Interrogate:
			status <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending, WaitHint: uint32(ops.OpTimeout / time.Millisecond)}
			ln.Close()
			// The kill switch stays, as the iptables chain outlives a stopped
			// Linux daemon; the tunnels go, as systemd kills a stopped daemon's
			// children.
			teardown(e, false, logf)
			logf("stopped")
			return false, 0
		case svc.SessionChange:
			if c.EventType != windows.WTS_SESSION_LOGOFF || c.EventData == 0 {
				continue
			}
			// EventData is the address of the system's WTSSESSION_NOTIFICATION.
			session := (*(**windows.WTSSESSION_NOTIFICATION)(unsafe.Pointer(&c.EventData))).SessionID
			if owner, ok := e.Owner(); ok && owner == session {
				// The app normally disconnects itself at logoff; this is the
				// backstop for an app Windows killed before it could. Quitting
				// is a full disconnect, kill switch included.
				logf("session %d logged off: full teardown", session)
				go teardown(e, true, logf)
			}
		}
	}
	return false, 0
}

func teardown(e *ops.Env, full bool, logf func(string, ...any)) {
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	if err := ops.Teardown(ctx, e, full); err != nil {
		logf("teardown: %v", err)
	}
}

// openLog appends to the service's log in the state directory, starting it over
// once it passes logMaxSize. The service has no console; this is its journal.
func openLog(path string) func(string, ...any) {
	if fi, err := os.Stat(path); err == nil && fi.Size() > logMaxSize {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return func(string, ...any) {}
	}
	var mu sync.Mutex
	return func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(f, time.Now().Format("2006-01-02 15:04:05 ")+format+"\n", args...)
	}
}
