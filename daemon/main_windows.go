// katacomb-vpn-helper.exe: the ONE privileged binary of Katacomb VPN on Windows.
//
//	katacomb-vpn-helper --version                         the package version it was built for
//	katacomb-vpn-helper service install|uninstall|teardown  the installer's verbs (elevated)
//	katacomb-vpn-helper daemon <user SID>                 the service, started by the service control manager
//	katacomb-vpn-helper _tun2socks …                      hidden: the tun2socks engine, started by the service
//
// Windows has no pkexec door: no tunnel verb is accepted on the command line
// ([PH-11]), and the app reaches root only through the service's pipe.
package main

import (
	"fmt"
	"os"

	"katacomb.vpn/daemon/internal/service"
	"katacomb.vpn/daemon/internal/tun2socks"
)

// usage names only what this binary accepts on Windows.
const usage = "Usage: katacomb-vpn-helper {--version|service install|service uninstall|service teardown}"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	switch windowsCommand(args) {
	case "--version":
		fmt.Println(version)
		return 0
	case "service install":
		return report(service.Install())
	case "service uninstall":
		return report(service.Uninstall())
	case "service teardown":
		return report(service.Teardown())
	case "daemon":
		return service.Run(args[1:])
	case "_tun2socks":
		return tun2socks.Run(args[1:], os.Stderr)
	}
	fmt.Fprintln(os.Stderr, usage)
	return 1
}

func report(err error) int {
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		return 1
	}
	return 0
}
