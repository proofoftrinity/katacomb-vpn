import { useState } from 'react'
import { displayConnectError, isDnsProvisionFailure, isInsufficientFunds, isRpcUnreachable, setupItemsRequired } from '../utils/connect-errors'
import type { PreviousConnection } from '../utils/switch'
import { useReconnect } from '../hooks/useReconnect'
import InsufficientFunds from './InsufficientFunds'
import Spinner from './Spinner'
import SystemSetup from './SystemSetup'
import { useNavigation } from '../contexts/NavigationContext'

interface Props {
  error: string
  /**
   * The already-paid session, when one exists — i.e. the tx landed and only the
   * tunnel bring-up failed. Set it to null when the payment itself failed, or
   * when the session can't be retried; that falls back to plain "Try Again".
   */
  paidSessionId: string | null
  onRetryTunnel: () => void
  /**
   * Run the refused purchase again with the choices already made. Used only after
   * a setup refusal, which main raises before paying, so it buys nothing twice.
   */
  onRetryPurchase: () => void
  onStartOver: () => void
  /**
   * WireGuard/AmneziaWG only: retry with the tunnel's DNS stripped. Offered when
   * the failure was wg-quick/awg-quick not finding resolvconf.
   */
  onRetryWithoutDns?: () => void
  /**
   * A switch that failed after leaving the old connection ([RN-10]): offer that one
   * back, so a failed switch never leaves the user without the connection they had.
   * `onDone` runs once it is up again (the window closes).
   */
  goBack?: { from: PreviousConnection; onDone: () => void } | null
}

/**
 * Error panel shared by the connect flows. When the paying tx already landed,
 * the primary action retries the tunnel against that session — main still holds
 * its config until disconnect. Dropping the user back on the subscribe form
 * (the "Start over" path) would buy a second session.
 */
export default function ConnectErrorActions({
  error,
  paidSessionId,
  onRetryTunnel,
  onRetryPurchase,
  onStartOver,
  onRetryWithoutDns,
  goBack,
}: Props) {
  const dnsFailure = isDnsProvisionFailure(error)
  // The machine lacks something this connect needs. Not a fault to show in red:
  // install it here, then the button below carries on with the same choices (a
  // refused purchase spent nothing). It stays disabled until every row is Ready,
  // because pressing it earlier can only be refused again.
  const setupItems = setupItemsRequired(error)
  const [setupReady, setSetupReady] = useState(false)
  const setupHeld = setupItems !== null && !setupReady
  const { openSettings } = useNavigation()
  const back = goBack ? <GoBack from={goBack.from} onDone={goBack.onDone} /> : null

  // The chain was never reached, so retrying against the same endpoint mostly
  // repeats the wait. Point at the endpoint list, and keep the plain retry for
  // the case where it was a blip.
  if (isRpcUnreachable(error)) {
    return (
      <div className="space-y-3">
        <div className="bg-danger-subtle border border-danger p-3 rounded-md">
          <p className="text-danger text-sm">{displayConnectError(error)}</p>
        </div>
        <button onClick={() => openSettings('network')} className="btn btn-primary w-full">
          Open network settings
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="text-text-tertiary hover:text-text-secondary text-xs w-full text-center transition-colors"
        >
          Try again
        </button>
        {back}
      </div>
    )
  }

  // The wallet can't pay, so this isn't a tunnel failure to retry — it's a top-up
  // prompt. "Try Again" below returns to the form, which re-checks the balance.
  if (isInsufficientFunds(error)) {
    return (
      <div className="space-y-3">
        <InsufficientFunds message={displayConnectError(error)} />
        <button onClick={onStartOver} className="btn btn-primary w-full">
          Try Again
        </button>
        {back}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {setupItems ? (
        <>
          <p className="text-text-secondary text-sm">
            {!setupReady
              ? displayConnectError(error)
              : paidSessionId
                ? 'Ready to connect.'
                : 'Ready to connect. Nothing has been charged yet.'}
          </p>
          <SystemSetup only={setupItems} onReadyChange={setSetupReady} />
        </>
      ) : (
        <div className="bg-danger-subtle border border-danger p-3 rounded-md">
          <p className="text-danger text-sm">{displayConnectError(error)}</p>
        </div>
      )}

      {dnsFailure && onRetryWithoutDns && (
        <div className="space-y-2">
          <p className="text-text-tertiary text-xs">
            This system has no <span className="font-mono">resolvconf</span>, so the tunnel's DNS couldn't be
            applied. You can connect anyway using your system DNS, but then DNS queries may leave the tunnel
            and your provider can see which sites you look up.
          </p>
          <button onClick={onRetryWithoutDns} className="btn btn-primary w-full">
            Retry without VPN DNS
          </button>
        </div>
      )}

      {paidSessionId ? (
        <>
          <p className="text-text-tertiary text-xs">
            Session {paidSessionId} is already paid for, so retrying the connection won't charge you again.
          </p>
          <button
            onClick={onRetryTunnel}
            disabled={setupHeld}
            className={`${dnsFailure && onRetryWithoutDns ? 'btn btn-secondary' : 'btn btn-primary'} w-full disabled:opacity-30 disabled:cursor-not-allowed`}
          >
            Retry connection
          </button>
          <button
            type="button"
            onClick={onStartOver}
            className="text-text-tertiary hover:text-text-secondary text-xs w-full text-center transition-colors"
          >
            Start over
          </button>
        </>
      ) : setupItems ? (
        <>
          <button
            onClick={onRetryPurchase}
            disabled={setupHeld}
            className="btn btn-primary w-full disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Try Again
          </button>
          <button
            type="button"
            onClick={onStartOver}
            className="text-text-tertiary hover:text-text-secondary text-xs w-full text-center transition-colors"
          >
            Back
          </button>
        </>
      ) : (
        <button onClick={onStartOver} className="btn btn-primary w-full">
          Try Again
        </button>
      )}
      {back}
    </div>
  )
}

/**
 * Back to the connection a switch left. Its session was never touched, so this is a
 * plain reconnect: no transaction, and a chain comes back as both hops.
 */
function GoBack({ from, onDone }: { from: PreviousConnection; onDone: () => void }) {
  const reconnect = useReconnect()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionId = from.sessionId
  if (!sessionId) return null

  async function handleGoBack(id: string) {
    setBusy(true)
    setError(null)
    const result = await reconnect({ id })
    setBusy(false)
    if (result.ok) onDone()
    else setError(result.error ?? 'Reconnection failed')
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => void handleGoBack(sessionId)}
        disabled={busy}
        className="btn btn-secondary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? <><Spinner /> Reconnecting…</> : `Reconnect to ${from.label}`}
      </button>
      {error && <p className="text-danger text-xs">{displayConnectError(error)}</p>}
    </div>
  )
}
