package main

// windowsCommand is the Windows helper's whole argv contract: what main_windows.go
// runs for args, or "" for the usage line. Windows has no pkexec door, so no
// tunnel verb is ever a command here ([PH-11]): the app reaches root only through
// the service's pipe, where every op is validated. Declared on every platform so
// the Linux tests pin it against the Linux one-shot's verbs.
func windowsCommand(args []string) string {
	switch {
	case len(args) == 1 && args[0] == "--version":
		return "--version"
	case len(args) == 2 && args[0] == "service" && (args[1] == "install" || args[1] == "uninstall" || args[1] == "teardown"):
		return "service " + args[1]
	case len(args) >= 1 && (args[0] == "daemon" || args[0] == "_tun2socks"):
		return args[0]
	}
	return ""
}
