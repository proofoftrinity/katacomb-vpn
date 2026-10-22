/* SPDX-License-Identifier: MIT
 *
 * Adapted from wireguard-windows tunnel/firewall/types_windows.go
 * Copyright (C) 2019-2021 WireGuard LLC. All Rights Reserved.
 *
 * Trimmed to the structures and constants this package uses.
 */

package wfp

import "golang.org/x/sys/windows"

type wtFwpActionType uint32

const (
	cFWP_ACTION_FLAG_TERMINATING = 0x00001000

	cFWP_ACTION_BLOCK  wtFwpActionType = 0x00000001 | cFWP_ACTION_FLAG_TERMINATING
	cFWP_ACTION_PERMIT wtFwpActionType = 0x00000002 | cFWP_ACTION_FLAG_TERMINATING
)

// FWP_BYTE_BLOB defined in fwptypes.h
type wtFwpByteBlob struct {
	size uint32
	data *uint8
}

type wtFwpMatchType uint32

const (
	cFWP_MATCH_EQUAL         wtFwpMatchType = 0
	cFWP_MATCH_FLAGS_ALL_SET wtFwpMatchType = 6
)

// FWPM_ACTION0 defined in fwpmtypes.h
type wtFwpmAction0 struct {
	_type      wtFwpActionType
	filterType windows.GUID
}

// Condition fields, defined in fwpmu.h.
var (
	// 4cd62a49-59c3-4969-b7f3-bda5d32890a4
	cFWPM_CONDITION_IP_LOCAL_INTERFACE = windows.GUID{Data1: 0x4cd62a49, Data2: 0x59c3, Data3: 0x4969, Data4: [8]byte{0xb7, 0xf3, 0xbd, 0xa5, 0xd3, 0x28, 0x90, 0xa4}}
	// b235ae9a-1d64-49b8-a44c-5ff3d9095045
	cFWPM_CONDITION_IP_REMOTE_ADDRESS = windows.GUID{Data1: 0xb235ae9a, Data2: 0x1d64, Data3: 0x49b8, Data4: [8]byte{0xa4, 0x4c, 0x5f, 0xf3, 0xd9, 0x09, 0x50, 0x45}}
	// 3971ef2b-623e-4f9a-8cb1-6e79b806b9a7
	cFWPM_CONDITION_IP_PROTOCOL = windows.GUID{Data1: 0x3971ef2b, Data2: 0x623e, Data3: 0x4f9a, Data4: [8]byte{0x8c, 0xb1, 0x6e, 0x79, 0xb8, 0x06, 0xb9, 0xa7}}
	// 0c1ba1af-5765-453f-af22-a8f791ac775b
	cFWPM_CONDITION_IP_LOCAL_PORT = windows.GUID{Data1: 0x0c1ba1af, Data2: 0x5765, Data3: 0x453f, Data4: [8]byte{0xaf, 0x22, 0xa8, 0xf7, 0x91, 0xac, 0x77, 0x5b}}
	// c35a604d-d22b-4e1a-91b4-68f674ee674b
	cFWPM_CONDITION_IP_REMOTE_PORT = windows.GUID{Data1: 0xc35a604d, Data2: 0xd22b, Data3: 0x4e1a, Data4: [8]byte{0x91, 0xb4, 0x68, 0xf6, 0x74, 0xee, 0x67, 0x4b}}
	// 632ce23b-5167-435c-86d7-e903684aa80c
	cFWPM_CONDITION_FLAGS = windows.GUID{Data1: 0x632ce23b, Data2: 0x5167, Data3: 0x435c, Data4: [8]byte{0x86, 0xd7, 0xe9, 0x03, 0x68, 0x4a, 0xa8, 0x0c}}
)

const cFWP_CONDITION_FLAG_IS_LOOPBACK = 0x00000001

// Layers, defined in fwpmu.h.
var (
	// c38d57d1-05a7-4c33-904f-7fbceee60e82
	cFWPM_LAYER_ALE_AUTH_CONNECT_V4 = windows.GUID{Data1: 0xc38d57d1, Data2: 0x05a7, Data3: 0x4c33, Data4: [8]byte{0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82}}
	// e1cd9fe7-f4b5-4273-96c0-592e487b8650
	cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4 = windows.GUID{Data1: 0xe1cd9fe7, Data2: 0xf4b5, Data3: 0x4273, Data4: [8]byte{0x96, 0xc0, 0x59, 0x2e, 0x48, 0x7b, 0x86, 0x50}}
	// 4a72393b-319f-44bc-84c3-ba54dcb3b6b4
	cFWPM_LAYER_ALE_AUTH_CONNECT_V6 = windows.GUID{Data1: 0x4a72393b, Data2: 0x319f, Data3: 0x44bc, Data4: [8]byte{0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4}}
	// a3b42c97-9f04-4672-b87e-cee9c483257f
	cFWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6 = windows.GUID{Data1: 0xa3b42c97, Data2: 0x9f04, Data3: 0x4672, Data4: [8]byte{0xb8, 0x7e, 0xce, 0xe9, 0xc4, 0x83, 0x25, 0x7f}}
)

// FWP_DATA_TYPE defined in fwptypes.h
type wtFwpDataType uint

const (
	cFWP_UINT8        wtFwpDataType = 1
	cFWP_UINT16       wtFwpDataType = 2
	cFWP_UINT32       wtFwpDataType = 3
	cFWP_UINT64       wtFwpDataType = 4
	cFWP_V4_ADDR_MASK wtFwpDataType = 0x100
	cFWP_V6_ADDR_MASK wtFwpDataType = 0x101
)

// FWP_V4_ADDR_AND_MASK defined in fwptypes.h; both in host byte order.
type wtFwpV4AddrAndMask struct {
	addr uint32
	mask uint32
}

// FWP_V6_ADDR_AND_MASK defined in fwptypes.h
type wtFwpV6AddrAndMask struct {
	addr         [16]uint8
	prefixLength uint8
}

// FWP_VALUE0 defined in fwptypes.h: small integers inline, everything else by pointer.
type wtFwpValue0 struct {
	_type wtFwpDataType
	value uintptr
}

// FWPM_DISPLAY_DATA0 defined in fwptypes.h
type wtFwpmDisplayData0 struct {
	name        *uint16
	description *uint16
}

// FWPM_FILTER_CONDITION0 defined in fwpmtypes.h
type wtFwpmFilterCondition0 struct {
	fieldKey       windows.GUID
	matchType      wtFwpMatchType
	conditionValue wtFwpValue0
}

// FWPM_SESSION0 defined in fwpmtypes.h
type wtFwpmSession0 struct {
	sessionKey           windows.GUID
	displayData          wtFwpmDisplayData0
	flags                uint32
	txnWaitTimeoutInMSec uint32
	processId            uint32
	sid                  *windows.SID
	username             *uint16
	kernelMode           uint8
}

const cFWPM_SESSION_FLAG_DYNAMIC = 0x00000001

// FWPM_SUBLAYER0 defined in fwpmtypes.h
type wtFwpmSublayer0 struct {
	subLayerKey  windows.GUID
	displayData  wtFwpmDisplayData0
	flags        uint32
	providerKey  *windows.GUID
	providerData wtFwpByteBlob
	weight       uint16
}

// FWPM_PROVIDER0 defined in fwpmtypes.h
type wtFwpmProvider0 struct {
	providerKey  windows.GUID
	displayData  wtFwpmDisplayData0
	flags        uint32
	providerData wtFwpByteBlob
	serviceName  *uint16
}

// RPC_C_AUTHN_WINNT, defined in rpcdce.h
const cRPC_C_AUTHN_WINNT = 10
