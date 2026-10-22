// Package server is daemon mode: one goroutine per connection, protocol v1
// framing, and one mutex that serialises every state-changing op (the read-only
// ops run concurrently). On Linux the listener is the AF_UNIX socket at
// /run/katacomb-vpn/daemon.sock and systemd runs it as root
// (`katacomb-vpn-helper daemon`); on Windows it is a named pipe and the service
// control manager runs it as LocalSystem. Either way the app talks to it so
// connect/disconnect never prompt for a password.
package server

import (
	"context"
	"errors"
	"net"
	"sync"

	"katacomb.vpn/daemon/internal/ops"
	"katacomb.vpn/daemon/internal/protocol"
)

// Server serves protocol v1 for one Env.
type Server struct {
	env  *ops.Env
	logf func(format string, args ...any)
	mu   sync.Mutex
	// served, when set, sees every request a connection was answered: the
	// Windows service records who brought a tunnel up, to tear it down when
	// that user logs off.
	served func(conn net.Conn, req protocol.Request, res protocol.Response)
}

// New builds a server; logf receives every line the daemon logs.
func New(e *ops.Env, logf func(format string, args ...any)) *Server {
	return &Server{env: e, logf: logf}
}

// Serve accepts connections until the listener closes.
func (s *Server) Serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.logf("accept: %v", err)
			continue
		}
		go s.handle(conn)
	}
}

// handle runs the per-connection loop. The server never closes a connection on
// its own except on a framing overflow (no reply, as before); pipelined
// requests are answered in order.
func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	rd := protocol.NewReader(conn)
	write := func(res protocol.Response) bool {
		_, err := conn.Write(append(res.Encode(), '\n'))
		return err == nil
	}
	for {
		line, err := rd.ReadLine()
		if err != nil {
			return // EOF, transport error, or the 256 KiB cap: drop silently
		}
		req, perr := protocol.ParseRequest(line)
		if perr != nil {
			if protocol.IsBlank(perr) {
				continue
			}
			if !write(protocol.Response{ID: 0, OK: false, Error: perr.Error()}) {
				return
			}
			continue
		}
		res := s.serve(req)
		if s.served != nil {
			s.served(conn, req, res)
		}
		if !res.OK {
			// Never the config body: the error strings carry line numbers and
			// reasons, and the log is the journal.
			s.logf("op %s rejected: %s", req.Op, res.Error)
		}
		if !write(res) {
			return
		}
	}
}

// lockedOp reports whether an op changes state and must therefore serialise on
// the server mutex. Only the read-only ops are exempt, the Windows-only ones
// included. Named rather than
// inlined so corpus_test.go can pin it against the shared protocol corpus, which
// is also what tells the TypeScript side which ops are safe to issue concurrently.
func lockedOp(op string) bool {
	switch op {
	case "status", "protocol_version", "xfrm_policies", "wireguard_handshake",
		"traffic_counters", "default_route", "other_vpns":
		return false
	}
	return true
}

// serve applies the mutex (read-only ops exempt) and the per-op budget.
func (s *Server) serve(req protocol.Request) protocol.Response {
	if lockedOp(req.Op) {
		s.mu.Lock()
		defer s.mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	return Dispatch(ctx, req, s.env)
}
