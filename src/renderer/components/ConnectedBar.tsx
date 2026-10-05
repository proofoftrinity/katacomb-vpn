import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useConnection } from '../hooks/useConnection'
import { useExitIp, type ExitIp } from '../hooks/useExitIp'
import { protocolMeta } from '../utils/protocols'
import { formatDuration } from '../utils/format'
import type { ConnectionStatus } from '../types'
import CountryFlag from './CountryFlag'
import CopyButton from './CopyButton'
import IpDisplay from './IpDisplay'
import Spinner from './Spinner'
import { ChevronIcon, KeyIcon, RefreshIcon } from './Icons'

const UNREACHABLE_TEXT = 'Could not reach the internet through the tunnel. It may be up but not passing traffic.'

// The capsule only marks a signed reply (the teal key on the protocol chip). The
// other cases are said in the panel, where there is room to say why they matter.
const SIGNER_TEXT: Record<NonNullable<ConnectionStatus['handshakeSigner']>, { title: string; detail: string }> = {
  node: {
    title: "Signed by the node's own key",
    detail: 'The node signed its handshake reply with the key the chain knows it by, so the keys and addresses this connection uses came from that node.',
  },
  hotKey: {
    title: "Signed by a key the node's account authorised on chain",
    detail: 'The node signed its handshake reply with a key its account authorised on chain, so the keys and addresses this connection uses came from that node.',
  },
  unsigned: {
    title: 'Unsigned',
    detail: 'The node did not sign its handshake reply (only dvpnd 9.4 and later do), so someone on your network could have posed as it during the handshake. The Signed filter in the node list shows only nodes that sign.',
  },
}
const NOT_CHECKED = { title: 'Not checked', detail: 'This tunnel was restored from a saved config, with no new handshake.' }

// Capsule border by state. A tint rather than the full status colour while things
// are fine, so the border only shouts when something is wrong.
const TONE = {
  ok: 'border-[color:color-mix(in_srgb,var(--color-success)_35%,transparent)]',
  pending: 'border-[color:color-mix(in_srgb,var(--color-warning)_45%,transparent)]',
  fail: 'border-danger',
}

/**
 * The header's connection slot. Idle, it is the (blurred) real IP. With a tunnel up,
 * one capsule: status dot, node, protocol chip (with a key when the handshake was
 * signed) and exit IP, which opens a panel with the rest. The exit-IP state lives
 * here, once, because the idle view, the capsule and the panel all read it.
 */
export default function ConnectedBar() {
  const { status } = useConnection()
  const tunnelUp = status.state !== 'idle'
  const exitIp = useExitIp(tunnelUp, status.sessionId)

  if (!tunnelUp) return <IpDisplay {...exitIp} />
  return <ConnectionCapsule status={status} exitIp={exitIp} />
}

function ConnectionCapsule({ status, exitIp }: { status: ConnectionStatus; exitIp: ExitIp }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const reconnecting = status.state === 'reconnecting'
  const signed = status.handshakeSigner === 'node' || status.handshakeSigner === 'hotKey'
  const { ipInfo, loading, ipStale } = exitIp
  const ip = ipInfo?.ip
  const checking = loading || ipStale
  // Connected, and three attempts could not reach the IP service through the
  // tunnel: the signature of a tunnel that is up but carrying nothing.
  const unreachable = !reconnecting && !checking && !ip
  const tone = reconnecting ? TONE.pending : unreachable ? TONE.fail : TONE.ok

  return (
    <div className="relative flex items-center gap-2 min-w-0" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Connection details"
        className={`flex items-center gap-2 min-w-0 pl-2.5 pr-2 py-1 rounded-full border bg-bg-primary text-xs transition-colors hover:border-border-focus focus:outline-none focus-visible:border-border-focus ${tone}`}
      >
        <span className={`status-dot shrink-0 ${reconnecting ? 'status-dot-pending' : 'status-dot-active'}`} />
        {reconnecting && (
          <span className="text-warning whitespace-nowrap">
            Reconnecting {status.reconnectAttempt}/{status.reconnectMaxAttempts}
          </span>
        )}
        <NodeName status={status} />
        {!reconnecting && status.nodeType !== undefined && (
          <span className="flex items-center gap-1 shrink-0 px-1.5 py-px rounded-sm bg-bg-tertiary text-text-primary whitespace-nowrap">
            {signed && (
              <span className="text-info" title="Signed handshake">
                <KeyIcon className="w-3 h-3" />
              </span>
            )}
            {/* The short name only: a V2Ray transport summary ("VLESS/gRPC/TLS") is
                wider than the rest of the capsule can spare at the 960px minimum
                window, and the panel's Protocol row shows it in full. */}
            {protocolMeta(status.nodeType).short}
          </span>
        )}
        {!reconnecting && (
          checking ? (
            <Spinner className="shrink-0 text-text-tertiary" />
          ) : unreachable ? (
            <span className="shrink-0 text-danger" title={UNREACHABLE_TEXT}>unreachable</span>
          ) : (
            <span className="font-mono text-success truncate max-w-[110px]" title={ip}>{ip}</span>
          )
        )}
        <ChevronIcon direction={open ? 'up' : 'down'} className="w-3 h-3 shrink-0 text-text-tertiary" />
      </button>

      {status.killSwitchFailed && (
        <span
          className="shrink-0 px-1.5 py-0.5 border border-danger text-danger text-xs rounded-sm whitespace-nowrap"
          title="The kill switch could not be enabled, so your real IP is NOT protected if the tunnel drops. Try reconnecting; if it persists, check that the VPN helper/daemon is installed."
        >
          ⚠ Kill switch inactive
        </span>
      )}

      {open && <DetailsPanel status={status} exitIp={exitIp} signed={signed} />}
    </div>
  )
}

/**
 * On a chain, nodeMoniker is the ENTRY, the node this device dials. What the internet
 * sees is the exit, so the exit is the one named: otherwise the bar says Spain while
 * every site reports Turkey. The entry is a flag here (its name is in the tooltip and
 * the panel), because two names do not fit the capsule at the 960px minimum window.
 */
function NodeName({ status }: { status: ConnectionStatus }) {
  const exit = status.chainExit
  if (!exit) {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        {status.nodeCountry && <CountryFlag country={status.nodeCountry} />}
        {status.nodeMoniker && (
          <span className="truncate max-w-[140px] text-text-primary" title={status.nodeMoniker}>{status.nodeMoniker}</span>
        )}
      </span>
    )
  }
  return (
    <span
      className="flex items-center gap-1.5 min-w-0"
      title={`Two-hop chain. Your device dials ${status.nodeMoniker || 'the entry node'}; traffic leaves from ${exit.moniker || exit.address} in ${exit.country}.`}
    >
      {status.nodeCountry && <CountryFlag country={status.nodeCountry} />}
      <span className="text-text-tertiary">→</span>
      <CountryFlag country={exit.country} />
      <span className="truncate max-w-[140px] text-accent">{exit.moniker || exit.country}</span>
    </span>
  )
}

function DetailsPanel({ status, exitIp, signed }: { status: ConnectionStatus; exitIp: ExitIp; signed: boolean }) {
  // Mounted only while open, so the uptime ticks only while someone is reading it.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const reconnecting = status.state === 'reconnecting'
  const exit = status.chainExit
  const uptime = !reconnecting && status.connectedAt ? formatDuration((now - status.connectedAt) / 1000) : null
  const signer = status.handshakeSigner ? SIGNER_TEXT[status.handshakeSigner] : NOT_CHECKED
  const { ipInfo, loading, ipStale, refresh } = exitIp
  const geo = ipInfo?.country ? `${ipInfo.country}${ipInfo.city ? `, ${ipInfo.city}` : ''}` : ''

  return (
    <div
      role="dialog"
      aria-label="Connection details"
      className="absolute left-0 top-full mt-2 w-[360px] p-4 z-50 bg-bg-secondary border border-border rounded-lg shadow-overlay text-xs animate-fade-in"
    >
      <div className="flex items-center gap-2 pb-3 mb-3 border-b border-border">
        <span className={`status-dot ${reconnecting ? 'status-dot-pending' : 'status-dot-active'}`} />
        <span className="text-sm font-semibold text-text-primary">
          {reconnecting ? 'Reconnecting' : exit ? 'Connected through two hops' : 'Connected'}
        </span>
        {uptime && <span className="text-text-tertiary">· {uptime}</span>}
      </div>

      <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-3">
        <Row label={exit ? 'Entry' : 'Node'}>
          <NodeLines moniker={status.nodeMoniker} country={status.nodeCountry} address={status.nodeAddress} />
          {exit && status.sessionId && <SessionLine id={status.sessionId} />}
        </Row>
        {exit && (
          <Row label="Exit">
            <NodeLines moniker={exit.moniker} country={exit.country} address={exit.address} />
            {exit.sessionId && <SessionLine id={exit.sessionId} />}
          </Row>
        )}
        {status.nodeType !== undefined && (
          <Row label="Protocol">
            {protocolMeta(status.nodeType).label}
            {status.nodeType === 2 && status.v2raySummary && (
              <span className="text-text-secondary"> ({status.v2raySummary})</span>
            )}
            {exit && <div className="text-text-secondary">Exit: {protocolMeta(exit.type).label}</div>}
          </Row>
        )}
        <Row label="Handshake">
          <div className={`flex items-center gap-1.5 ${signed ? 'text-info' : 'text-text-primary'}`}>
            {signed && <KeyIcon className="w-3.5 h-3.5 shrink-0" />}
            {signer.title}
          </div>
          <p className="mt-0.5 leading-snug text-text-tertiary">
            {exit && 'This is the entry node\'s handshake. '}
            {signer.detail}
          </p>
        </Row>
        {!exit && status.sessionId && (
          <Row label="Session">
            <SessionLine id={status.sessionId} />
          </Row>
        )}
        <Row label="Exit IP">
          <div className="flex items-center gap-1.5">
            {loading || ipStale ? (
              <span className="flex items-center gap-1 text-text-secondary">
                <Spinner /> checking...
              </span>
            ) : ipInfo?.ip ? (
              <span className="font-mono text-success break-all">{ipInfo.ip}</span>
            ) : (
              <span className="text-danger">unreachable</span>
            )}
            <button
              onClick={refresh}
              disabled={loading}
              className="text-text-secondary hover:text-accent transition-colors disabled:opacity-30"
              title="Refresh IP"
              aria-label="Refresh IP"
            >
              <RefreshIcon className="w-3 h-3" />
            </button>
          </div>
          {!loading && !ipStale && !ipInfo?.ip && (
            <p className="mt-0.5 leading-snug text-text-tertiary">{UNREACHABLE_TEXT}</p>
          )}
          {geo && <div className="text-text-secondary">{geo}</div>}
          {ipInfo?.org && (
            <div className="text-text-tertiary">{ipInfo.org}{ipInfo.asn ? ` (${ipInfo.asn})` : ''}</div>
          )}
        </Row>
      </dl>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 text-text-primary">{children}</dd>
    </>
  )
}

function NodeLines({ moniker, country, address }: { moniker?: string; country?: string; address?: string }) {
  return (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        {country && <CountryFlag country={country} />}
        <span className="truncate">{moniker || '—'}</span>
      </div>
      {address && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-text-tertiary">
          <span className="truncate" title={address}>{address}</span>
          <CopyButton value={address} label="Copy address" />
        </div>
      )}
    </>
  )
}

function SessionLine({ id }: { id: string }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-text-secondary">
      #{id}
      <CopyButton value={id} label="Copy session ID" />
    </div>
  )
}
