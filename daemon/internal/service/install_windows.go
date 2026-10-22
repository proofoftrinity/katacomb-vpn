package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"katacomb.vpn/daemon/internal/ops"
)

// Install registers the service for the user running the installer and starts
// it; over an existing install it stops the old service and rewrites its
// configuration. Run elevated, from the installed helper.
func Install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	user, err := installingUser()
	if err != nil {
		return fmt.Errorf("finding the installing user: %w", err)
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	cfg := mgr.Config{
		ServiceType:  windows.SERVICE_WIN32_OWN_PROCESS,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
		DisplayName:  DisplayName,
		Description:  description,
	}
	s, err := m.OpenService(Name)
	if err == nil {
		defer s.Close()
		if err := stop(s); err != nil {
			return err
		}
		cfg.BinaryPathName = syscall.EscapeArg(exe) + " daemon " + user.String()
		if err := s.UpdateConfig(cfg); err != nil {
			return fmt.Errorf("updating the service: %w", err)
		}
	} else {
		s, err = m.CreateService(Name, exe, cfg, "daemon", user.String())
		if err != nil {
			return fmt.Errorf("creating the service: %w", err)
		}
		defer s.Close()
	}
	// A crashed service comes back, so the app can reach root again; its kill
	// switch held meanwhile.
	restart := mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: 2 * time.Second}
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{restart, restart, restart}, 24*60*60); err != nil {
		return fmt.Errorf("setting recovery: %w", err)
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("starting the service: %w", err)
	}
	return nil
}

// Uninstall stops and deletes the service, then takes down whatever outlived
// it, the kill switch and the routes a crash left included, and removes the
// state directory: after it nothing of ours is left in the network stack.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(Name); err == nil {
		err = stop(s)
		if err == nil {
			err = s.Delete()
		}
		s.Close()
		if err != nil {
			return err
		}
	}
	if err := fullTeardown(); err != nil {
		return err
	}
	return os.RemoveAll(ops.StateDir())
}

// Teardown is the full teardown with the service kept: stop it, take down what
// outlived it, start it again. For support and the VM checks; the app's own
// disconnect is the normal path.
func Teardown() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return fullTeardown()
	}
	defer s.Close()
	if err := stop(s); err != nil {
		return err
	}
	if err := fullTeardown(); err != nil {
		return err
	}
	return s.Start()
}

func fullTeardown() error {
	dir := ops.StateDir()
	if err := ops.PrepareStateDir(dir); err != nil {
		return err
	}
	e := ops.NewEnv(dir)
	ctx, cancel := context.WithTimeout(context.Background(), ops.OpTimeout)
	defer cancel()
	ops.Heal(e)
	return ops.Teardown(ctx, e, true)
}

// stop asks the service to stop and waits until it has, which includes its own
// teardown of the tunnels.
func stop(s *mgr.Service) error {
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
		return fmt.Errorf("stopping the service: %w", err)
	}
	deadline := time.Now().Add(ops.OpTimeout + 5*time.Second)
	for time.Now().Before(deadline) {
		if st, err := s.Query(); err != nil || st.State == svc.Stopped {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return errors.New("the service did not stop")
}

var procWTSQuerySessionInformationW = windows.NewLazySystemDLL("wtsapi32.dll").NewProc("WTSQuerySessionInformationW")

const (
	wtsUserName   = 5
	wtsDomainName = 7
)

// installingUser is the user logged on to the session the installer runs in.
// The installer runs elevated, and with an administrator's credentials typed
// over a standard account, the elevated process is that administrator; the
// session's user is still the person who will run the app.
func installingUser() (*windows.SID, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err == nil && session != 0 {
		name, err1 := sessionString(session, wtsUserName)
		domain, err2 := sessionString(session, wtsDomainName)
		if err1 == nil && err2 == nil && name != "" {
			sid, _, _, err := windows.LookupSID("", domain+`\`+name)
			if err == nil {
				return sid, nil
			}
		}
	}
	// No interactive session (a deployment tool running as SYSTEM): the
	// process's own user.
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	return tu.User.Sid.Copy()
}

func sessionString(session, class uint32) (string, error) {
	var buf *uint16
	var n uint32
	r1, _, e1 := procWTSQuerySessionInformationW.Call(0, uintptr(session), uintptr(class), uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&n)))
	if r1 == 0 {
		return "", e1
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(buf)))
	return windows.UTF16PtrToString(buf), nil
}
