//go:build linux

package server

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

const (
	// SocketPath is fixed by the client (daemon-client.ts DAEMON_SOCKET_PATH).
	SocketPath = ops.RunDir + "/daemon.sock"
	// SocketGroup: only its members may drive the socket (mode 0660). The deb's
	// postinstall creates it and adds the installing user.
	SocketGroup = "katacomb-vpn"
)

func logStderr(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[katacomb-daemon] "+format+"\n", args...)
}

// Run is the `daemon` entry: refuses to run unprivileged (deviation 1: an
// unprivileged daemon used to bind a 0666 socket and then fail every op),
// binds the socket under umask 077 (deviation 2: no window at the default mode
// between listen and chmod), sets the group permissions, serves until SIGTERM/
// SIGINT, and unlinks the socket on the way out.
func Run(e *ops.Env) int {
	if os.Geteuid() != 0 {
		logStderr("daemon mode requires root (euid 0); refusing to start")
		return 1
	}
	e.Warn = func(msg string) { logStderr("warning: %s", msg) }
	s := New(e, logStderr)

	if err := os.MkdirAll(ops.RunDir, 0o755); err != nil {
		logStderr("cannot create %s: %v", ops.RunDir, err)
		return 1
	}
	_ = os.Remove(SocketPath) // stale socket from a previous instance
	old := syscall.Umask(0o077)
	ln, err := net.Listen("unix", SocketPath)
	syscall.Umask(old)
	if err != nil {
		logStderr("cannot listen on %s: %v", SocketPath, err)
		return 1
	}
	s.securePermissions(SocketPath, 0)
	logStderr("listening on %s (protocol v%d)", SocketPath, protocol.Version)

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigs
		ln.Close()
		_ = os.Remove(SocketPath)
		os.Exit(0)
	}()
	s.Serve(ln)
	_ = os.Remove(SocketPath)
	return 0
}

// lookupGid resolves the group through `getent` (NSS-aware), not os/user, which
// is pure-Go parsing of /etc/group in a static binary.
func (s *Server) lookupGid(group string) (int, bool) {
	getent, err := s.env.LookPath("getent")
	if err != nil {
		return 0, false
	}
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	out, _, err := s.env.Run(ctx, []string{getent, "group", group}, ops.RunOpt{})
	if err != nil {
		return 0, false
	}
	f := strings.Split(strings.TrimSpace(string(out)), ":") // name:x:gid:members
	if len(f) < 3 {
		return 0, false
	}
	gid, err := strconv.Atoi(f[2])
	if err != nil {
		return 0, false
	}
	return gid, true
}

// securePermissions locks the socket to uid:SocketGroup 0660 when the group
// exists, else falls back to 0666 (dev / unpackaged, where the group is absent
// and the app uses pkexec anyway) with the same log line the old daemon wrote.
func (s *Server) securePermissions(path string, uid int) {
	if gid, ok := s.lookupGid(SocketGroup); ok {
		if err := os.Chown(path, uid, gid); err == nil {
			if err := os.Chmod(path, 0o660); err == nil {
				return
			}
		} else {
			s.logf("could not group-restrict socket, falling back to 0666: %v", err)
		}
	}
	_ = os.Chmod(path, 0o666)
}
