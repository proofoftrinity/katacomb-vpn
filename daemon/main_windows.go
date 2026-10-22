// katacomb-vpn-helper.exe: the ONE privileged binary of Katacomb VPN on Windows.
//
//	katacomb-vpn-helper --version   the package version it was built for
//
// Windows has no pkexec door, so no tunnel verb is ever accepted on the command
// line: the app reaches root only through the service.
package main

import (
	"fmt"
	"os"
)

// usage names only what this binary accepts on Windows.
const usage = "Usage: katacomb-vpn-helper --version"

func main() {
	args := os.Args[1:]
	switch {
	case len(args) == 1 && args[0] == "--version":
		fmt.Println(version)
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(1)
	}
}
