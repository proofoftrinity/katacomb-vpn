//go:build windows && (amd64 || arm64)

/* SPDX-License-Identifier: MIT
 *
 * Adapted from wireguard-windows tunnel/firewall/types_windows_64.go
 * Copyright (C) 2019-2021 WireGuard LLC. All Rights Reserved.
 */

package wfp

import "golang.org/x/sys/windows"

// FWPM_FILTER0 defined in fwpmtypes.h, with the 64-bit layout's padding.
type wtFwpmFilter0 struct {
	filterKey           windows.GUID
	displayData         wtFwpmDisplayData0
	flags               uint32
	providerKey         *windows.GUID
	providerData        wtFwpByteBlob
	layerKey            windows.GUID
	subLayerKey         windows.GUID
	weight              wtFwpValue0
	numFilterConditions uint32
	filterCondition     *wtFwpmFilterCondition0
	action              wtFwpmAction0
	offset1             [4]byte // layout correction
	providerContextKey  windows.GUID
	reserved            *windows.GUID
	filterID            uint64
	effectiveWeight     wtFwpValue0
}
