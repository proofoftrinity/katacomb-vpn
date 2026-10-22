/* SPDX-License-Identifier: MIT
 *
 * Adapted from wireguard-windows tunnel/firewall/zsyscall_windows.go
 * Copyright (C) 2019-2021 WireGuard LLC. All Rights Reserved.
 *
 * Hand-written rather than generated, with the enumerate and delete calls the
 * upstream package never needed (its session is dynamic, so it never removes).
 */

package wfp

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modfwpuclnt = windows.NewLazySystemDLL("fwpuclnt.dll")

	procFwpmEngineOpen0              = modfwpuclnt.NewProc("FwpmEngineOpen0")
	procFwpmEngineClose0             = modfwpuclnt.NewProc("FwpmEngineClose0")
	procFwpmTransactionBegin0        = modfwpuclnt.NewProc("FwpmTransactionBegin0")
	procFwpmTransactionCommit0       = modfwpuclnt.NewProc("FwpmTransactionCommit0")
	procFwpmTransactionAbort0        = modfwpuclnt.NewProc("FwpmTransactionAbort0")
	procFwpmProviderAdd0             = modfwpuclnt.NewProc("FwpmProviderAdd0")
	procFwpmProviderDeleteByKey0     = modfwpuclnt.NewProc("FwpmProviderDeleteByKey0")
	procFwpmSubLayerAdd0             = modfwpuclnt.NewProc("FwpmSubLayerAdd0")
	procFwpmSubLayerDeleteByKey0     = modfwpuclnt.NewProc("FwpmSubLayerDeleteByKey0")
	procFwpmFilterAdd0               = modfwpuclnt.NewProc("FwpmFilterAdd0")
	procFwpmFilterDeleteById0        = modfwpuclnt.NewProc("FwpmFilterDeleteById0")
	procFwpmFilterCreateEnumHandle0  = modfwpuclnt.NewProc("FwpmFilterCreateEnumHandle0")
	procFwpmFilterEnum0              = modfwpuclnt.NewProc("FwpmFilterEnum0")
	procFwpmFilterDestroyEnumHandle0 = modfwpuclnt.NewProc("FwpmFilterDestroyEnumHandle0")
	procFwpmFreeMemory0              = modfwpuclnt.NewProc("FwpmFreeMemory0")
)

// Every Fwpm* call returns a DWORD: 0 on success, else the error code.
func rc(r1 uintptr) error {
	if r1 != 0 {
		return syscall.Errno(r1)
	}
	return nil
}

func fwpmEngineOpen0(session *wtFwpmSession0, engine *uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmEngineOpen0.Addr(), 0, cRPC_C_AUTHN_WINNT, 0, uintptr(unsafe.Pointer(session)), uintptr(unsafe.Pointer(engine)))
	return rc(r1)
}

func fwpmEngineClose0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmEngineClose0.Addr(), engine)
	return rc(r1)
}

func fwpmTransactionBegin0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmTransactionBegin0.Addr(), engine, 0)
	return rc(r1)
}

func fwpmTransactionCommit0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmTransactionCommit0.Addr(), engine)
	return rc(r1)
}

func fwpmTransactionAbort0(engine uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmTransactionAbort0.Addr(), engine)
	return rc(r1)
}

func fwpmProviderAdd0(engine uintptr, provider *wtFwpmProvider0) error {
	r1, _, _ := syscall.SyscallN(procFwpmProviderAdd0.Addr(), engine, uintptr(unsafe.Pointer(provider)), 0)
	return rc(r1)
}

func fwpmProviderDeleteByKey0(engine uintptr, key *windows.GUID) error {
	r1, _, _ := syscall.SyscallN(procFwpmProviderDeleteByKey0.Addr(), engine, uintptr(unsafe.Pointer(key)))
	return rc(r1)
}

func fwpmSubLayerAdd0(engine uintptr, sublayer *wtFwpmSublayer0) error {
	r1, _, _ := syscall.SyscallN(procFwpmSubLayerAdd0.Addr(), engine, uintptr(unsafe.Pointer(sublayer)), 0)
	return rc(r1)
}

func fwpmSubLayerDeleteByKey0(engine uintptr, key *windows.GUID) error {
	r1, _, _ := syscall.SyscallN(procFwpmSubLayerDeleteByKey0.Addr(), engine, uintptr(unsafe.Pointer(key)))
	return rc(r1)
}

func fwpmFilterAdd0(engine uintptr, filter *wtFwpmFilter0, id *uint64) error {
	r1, _, _ := syscall.SyscallN(procFwpmFilterAdd0.Addr(), engine, uintptr(unsafe.Pointer(filter)), 0, uintptr(unsafe.Pointer(id)))
	return rc(r1)
}

func fwpmFilterDeleteById0(engine uintptr, id uint64) error {
	r1, _, _ := syscall.SyscallN(procFwpmFilterDeleteById0.Addr(), engine, uintptr(id))
	return rc(r1)
}

func fwpmFilterCreateEnumHandle0(engine uintptr, enum *uintptr) error {
	r1, _, _ := syscall.SyscallN(procFwpmFilterCreateEnumHandle0.Addr(), engine, 0, uintptr(unsafe.Pointer(enum)))
	return rc(r1)
}

func fwpmFilterEnum0(engine, enum uintptr, want uint32, entries *unsafe.Pointer, got *uint32) error {
	r1, _, _ := syscall.SyscallN(procFwpmFilterEnum0.Addr(), engine, enum, uintptr(want), uintptr(unsafe.Pointer(entries)), uintptr(unsafe.Pointer(got)))
	return rc(r1)
}

func fwpmFilterDestroyEnumHandle0(engine, enum uintptr) {
	_, _, _ = syscall.SyscallN(procFwpmFilterDestroyEnumHandle0.Addr(), engine, enum)
}

// fwpmFreeMemory0 takes the ADDRESS of the pointer it frees, and zeroes it.
func fwpmFreeMemory0(p *unsafe.Pointer) {
	_, _, _ = syscall.SyscallN(procFwpmFreeMemory0.Addr(), uintptr(unsafe.Pointer(p)))
}
