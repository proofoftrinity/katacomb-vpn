package server

// The Windows service's pipe. Declared on every platform so the Linux tests
// pin its access rules too ([PH-10]); only server_windows.go listens on it.

// PipePath is where the service listens. Only an administrator or SYSTEM can
// create a pipe under ProtectedPrefix\Administrators, so no user process can
// take the name before the service starts and receive the app's configs.
const PipePath = `\\.\pipe\ProtectedPrefix\Administrators\Katacomb VPN\daemon`

// pipeSDDL admits SYSTEM, the Administrators and the one user the service was
// installed for (%s), with read and write; nobody else can open the pipe. P
// protects the DACL from inherited entries.
const pipeSDDL = "O:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;%s)"
