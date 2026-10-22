package server

import (
	"fmt"
	"net"

	"github.com/amnezia-vpn/amneziawg-go/v3/ipc/namedpipe"
	"golang.org/x/sys/windows"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// Listen opens the service's pipe for user ([PH-10]). The listener refuses
// remote clients, and fails rather than join a pipe that already exists.
func Listen(user *windows.SID) (net.Listener, error) {
	return listen(PipePath, user)
}

func listen(path string, user *windows.SID) (net.Listener, error) {
	sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf(pipeSDDL, user.String()))
	if err != nil {
		return nil, err
	}
	return (&namedpipe.ListenConfig{SecurityDescriptor: sd}).Listen(path)
}

// NewService is the server the Windows service runs: New, plus it records the
// session of whoever brings a tunnel up, so the tunnel goes when they log off.
func NewService(e *ops.Env, logf func(format string, args ...any)) *Server {
	s := New(e, logf)
	s.served = func(conn net.Conn, req protocol.Request, res protocol.Response) {
		switch req.Op {
		case "wireguard_up", "amneziawg_up", "tun_up":
		default:
			return
		}
		if !res.OK {
			return
		}
		if session, ok := clientSession(conn); ok {
			e.SetOwner(session)
		}
	}
	return s
}

// clientSession is the Windows session of the process at the other end.
func clientSession(conn net.Conn) (uint32, bool) {
	h, ok := conn.(interface{ Handle() windows.Handle })
	if !ok {
		return 0, false
	}
	var pid, session uint32
	if windows.GetNamedPipeClientProcessId(h.Handle(), &pid) != nil {
		return 0, false
	}
	if windows.ProcessIdToSessionId(pid, &session) != nil {
		return 0, false
	}
	return session, true
}
