import { useConnection } from '../hooks/useConnection'
import { protocolMeta } from '../utils/protocols'

export default function ConnectedBar() {
  const { status } = useConnection()
  const connected = status.state === 'connected'
  const reconnecting = status.state === 'reconnecting'

  if (!connected && !reconnecting) return null

  return (
    <div className="flex items-center gap-3 text-xs">
      {reconnecting ? (
        <>
          <span className="status-dot status-dot-pending" />
          <span className="text-warning">
            Reconnecting ({status.reconnectAttempt}/{status.reconnectMaxAttempts})...
          </span>
        </>
      ) : (
        <>
          <span className="status-dot status-dot-active" />
          {status.nodeType !== undefined && (
            <span className={`px-1.5 py-0.5 border text-xs rounded-sm ${
              status.nodeType === 1
                ? 'border-info text-info'
                : 'border-warning text-warning'
            }`}>
              {status.nodeType === 2 ? (status.v2raySummary || protocolMeta(2).short) : protocolMeta(status.nodeType).short}
            </span>
          )}
          {status.handshakeSigner && (
            <span
              className={`px-1.5 py-0.5 border text-xs rounded-sm ${
                status.handshakeSigner === 'unsigned' ? 'border-border text-text-tertiary' : 'border-info text-info'
              }`}
              title={
                status.handshakeSigner === 'node'
                  ? 'The node signed its handshake reply with the key the chain knows it by, so the keys and addresses this connection uses came from that node.'
                  : status.handshakeSigner === 'hotKey'
                    ? 'The node signed its handshake reply with a key its account authorised on chain, so the keys and addresses this connection uses came from that node.'
                    : 'The node did not sign its handshake reply (only dvpnd 9.4 and later do), so someone on your network could have posed as it during the handshake. Settings → Signed Nodes Only refuses such nodes.'
              }
            >
              {status.handshakeSigner === 'unsigned' ? 'Unsigned' : 'Signed'}
            </span>
          )}
          {status.killSwitchFailed && (
            <span
              className="px-1.5 py-0.5 border border-danger text-danger text-xs rounded-sm"
              title="The kill switch could not be enabled, so your real IP is NOT protected if the tunnel drops. Try reconnecting; if it persists, check that the VPN helper/daemon is installed."
            >
              ⚠ Kill switch inactive
            </span>
          )}
          {status.nodeMoniker && (
            <span className="text-text-primary">{status.nodeMoniker}</span>
          )}
          {status.sessionId && (
            <span className="text-text-secondary font-mono">#{status.sessionId}</span>
          )}
          {/* On a chain, nodeMoniker above is the ENTRY — the node this device
              dials. What the internet sees is the exit, so name it: otherwise the
              bar says Spain while every site reports Turkey. */}
          {status.chainExit && (
            <span
              className="text-accent"
              title={`Two-hop chain. Your device dials ${status.nodeMoniker || 'the entry node'}; traffic leaves from ${status.chainExit.moniker || status.chainExit.address} in ${status.chainExit.country}.`}
            >
              → {status.chainExit.moniker || status.chainExit.country}
              {status.chainExit.sessionId && (
                <span className="text-text-secondary font-mono ml-1.5">#{status.chainExit.sessionId}</span>
              )}
            </span>
          )}
        </>
      )}
    </div>
  )
}
