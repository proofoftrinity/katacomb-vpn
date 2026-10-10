import { useCallback, useEffect, useRef, useState } from 'react'
import type { TunnelProtocol } from '../types'
import { switchThenBuy, type PreviousConnection } from '../utils/switch'

/**
 * How long the path gets to settle after a tunnel drops before the chain is asked
 * anything: routes, the resolver and Chromium's socket pool are being restored, and a
 * dropped SYN in that window costs seconds (docs/renderer.md, "A probe grades the PATH").
 */
const PATH_SETTLE_MS = 2000

/**
 * Drop the live connection so the chain can be reached: a switch, or ending a session
 * other than the one carrying the traffic. Only the tunnel goes; its session stays open.
 */
export async function leaveConnection(): Promise<void> {
  await window.api.connectionDisconnect()
  await new Promise((r) => setTimeout(r, PATH_SETTLE_MS))
}

/** A switch in progress: the connection it leaves, and whether that one is down yet. */
export interface SwitchState {
  from: PreviousConnection
  /** The old tunnel is down, so going back to it is possible (and, on a failure, offered). */
  left: boolean
}

/**
 * The connect-flow state machine every paid connect shares: purchase, then the
 * separate CONNECTION_CONNECT tunnel bring-up, with the paid session kept
 * around so a failed bring-up retries WITHOUT buying again (main holds the
 * session config until disconnect). This existed three times, copy-pasted,
 * before it was a hook (ConnectionModal + the two retired plan modals).
 */
export function useConnectFlow() {
  const [connecting, setConnecting] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [stepDetail, setStepDetail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tunnelConnected, setTunnelConnected] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Protocol of the session already paid for; a failed bring-up retries against
  // that session instead of buying a second one.
  const [paidProtocol, setPaidProtocol] = useState<TunnelProtocol | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [switching, setSwitching] = useState<SwitchState | null>(null)
  // The mode the flow was STARTED with, so a retry keeps it.
  const modeRef = useRef<'tunnel' | 'proxy'>('tunnel')
  // The last purchase as started, with the user's choices already bound into it.
  const lastPurchaseRef = useRef<{
    purchase: () => Promise<{ sessionId: string; protocol: string }>
    opts?: { mode?: 'tunnel' | 'proxy'; switchFrom?: PreviousConnection | null }
  } | null>(null)

  useEffect(() => {
    const unsub = window.api.onConnectionProgress((step, detail) => {
      setCurrentStep(step)
      setStepDetail(detail ?? null)
    })
    return unsub
  }, [])

  const connectTunnelOnly = useCallback(async (protocol: TunnelProtocol, dnsFallback: boolean) => {
    setCurrentStep('5/5')
    await window.api.connectionConnect({
      protocol,
      ...(modeRef.current === 'proxy' ? { mode: 'proxy' as const } : {}),
      ...(dnsFallback ? { dnsFallback: true } : {}),
    })
    setTunnelConnected(true)
  }, [])

  /**
   * Run a purchase (any IPC that returns a paid session), then bring the tunnel
   * up. The purchase callback is the caller's: node subscribe, plan subscribe,
   * session-from-subscription or smart connect all fit. With `switchFrom`, the live
   * connection is left first ([RN-10]): main refuses a purchase while one is up.
   */
  const start = useCallback(async (
    purchase: () => Promise<{ sessionId: string; protocol: string }>,
    opts?: { mode?: 'tunnel' | 'proxy'; switchFrom?: PreviousConnection | null },
  ) => {
    lastPurchaseRef.current = { purchase, opts }
    modeRef.current = opts?.mode ?? 'tunnel'
    const from = opts?.switchFrom ?? null
    if (from) setSwitching({ from, left: false })
    setConnecting(true)
    setError(null)
    setCurrentStep(from ? 'switch' : '1/5')
    try {
      const res = await switchThenBuy({
        leave: from ? leaveConnection : null,
        onLeft: () => {
          if (from) setSwitching({ from, left: true })
          setCurrentStep('1/5')
        },
        purchase,
      })
      setSessionId(res.sessionId)
      const protocol = res.protocol as TunnelProtocol
      setPaidProtocol(protocol)
      await connectTunnelOnly(protocol, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }, [connectTunnelOnly])

  /**
   * Run the last purchase again with the same choices: the "Try Again" after main
   * refused it for missing setup. That refusal comes before any payment, so this
   * is the same purchase the user already chose, not a second one. Never call it
   * with a session already paid for; retryTunnel is that case.
   */
  const retryPurchase = useCallback(async () => {
    const last = lastPurchaseRef.current
    // Only a purchase refusal gets here, which comes after any leave: the old
    // connection is already down, so the retry must not leave again.
    if (last) await start(last.purchase, { ...last.opts, switchFrom: null })
  }, [start])

  /** Error-state retry when the payment succeeded but the tunnel didn't come up. */
  const retryTunnel = useCallback(async (dnsFallback = false) => {
    if (!paidProtocol) return
    setConnecting(true)
    setError(null)
    try {
      await connectTunnelOnly(paidProtocol, dnsFallback)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }, [paidProtocol, connectTunnelOnly])

  /**
   * Disconnect with the error surfaced instead of swallowed (the audited
   * catch-less handleDisconnect bug). Returns whether it succeeded, so the
   * caller only closes its modal on true.
   */
  const disconnect = useCallback(async (): Promise<boolean> => {
    setDisconnecting(true)
    try {
      await window.api.connectionDisconnect()
      setTunnelConnected(false)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Disconnect failed')
      return false
    } finally {
      setDisconnecting(false)
    }
  }, [])

  /** Drop the paid-session context: the "start over" action after an error. */
  const reset = useCallback(() => {
    setSwitching(null)
    setError(null)
    setCurrentStep(null)
    setStepDetail(null)
    setSessionId(null)
    setPaidProtocol(null)
    setTunnelConnected(false)
  }, [])

  return {
    connecting,
    currentStep,
    stepDetail,
    error,
    tunnelConnected,
    sessionId,
    paidProtocol,
    disconnecting,
    switching,
    start,
    retryPurchase,
    retryTunnel,
    disconnect,
    reset,
  }
}
