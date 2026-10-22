package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Teardown takes every tunnel down. full=false is a service stop: the kill
// switch stays in force, as the iptables chain outlives a stopped Linux daemon.
// full=true is the owning user logging off, or the uninstaller: the kill switch
// goes too, as it does when the app quits.
func Teardown(ctx context.Context, e *Env, full bool) error {
	return withLock(ctx, e, func() error {
		e.deviceDown()
		e.tunDown()
		if full {
			return e.killswitchOff()
		}
		return nil
	})
}

// Heal runs once when the service starts. No tunnel can be up then (each one
// lives in or under the service process), so any route still recorded belongs
// to a tunnel that died with a previous instance, and is removed. An armed kill
// switch is kept, and re-read so the next tunnel re-plans it.
func Heal(e *Env) {
	e.removeUplinkRoutes("")
	e.loadKillswitch()
}

// PrepareStateDir creates the state directory, owned by SYSTEM, with access for
// SYSTEM and Administrators only. %ProgramData% lets any user create a folder,
// so one found with another owner was planted, not left by us, and is replaced.
func PrepareStateDir(dir string) error {
	sd, err := windows.SecurityDescriptorFromString("O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	if fi, err := os.Lstat(dir); err == nil {
		if !fi.IsDir() || !ownedBySystem(dir) {
			if err := os.RemoveAll(dir); err != nil {
				return fmt.Errorf("replacing %s: %w", dir, err)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(p, sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return fmt.Errorf("creating %s: %w", dir, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil)
}

func ownedBySystem(path string) bool {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return false
	}
	owner, _, err := sd.Owner()
	if err != nil || owner == nil {
		return false
	}
	return owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)
}
