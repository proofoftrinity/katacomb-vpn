// Stands in for src/main/helper/daemon-protocol.ts inside a test bundle, with the
// socket path taken from KV_DAEMON_SOCKET instead of /run/katacomb-vpn, so the real
// daemon-client can be pointed at a socket the test serves. Everything else is the
// real module's.
export { DAEMON_DIR, DAEMON_PROTOCOL_VERSION, DAEMON_OPS } from '../../src/main/helper/daemon-protocol.ts'
export type { DaemonOp, DaemonRequest, DaemonResponse } from '../../src/main/helper/daemon-protocol.ts'

export const DAEMON_SOCKET_PATH = process.env.KV_DAEMON_SOCKET ?? '/nonexistent/kv-daemon.sock'
