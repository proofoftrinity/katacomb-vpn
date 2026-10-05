import { useState, useEffect, useCallback, useRef } from 'react'
import type { IpInfo } from '../types'

const POLL_IP_MS = 60_000

/**
 * The address the internet sees, for the header. One owner on purpose: the idle
 * view (IpDisplay), the connected capsule and its details panel all read this, and
 * two fetchers could disagree about which address is current.
 *
 * `connected` is "a tunnel exists", reconnecting included.
 */
export function useExitIp(connected: boolean, sessionId?: string | null) {
  const [ipInfo, setIpInfo] = useState<IpInfo | null>(null)
  const [loading, setLoading] = useState(true)
  // The connection's identity, not just its existence: switching sessions without
  // this hook seeing `connected` go false (the status poll can miss a fast
  // disconnect-connect) must still refetch, or the previous tunnel's exit IP stays
  // on screen in the green connected style. Ignore the id while disconnected, so
  // idle session-list churn doesn't refetch anything.
  const connKey = connected ? `up:${sessionId ?? ''}` : 'idle'
  const prevKey = useRef(connKey)
  const [ipStale, setIpStale] = useState(false)

  // Two stages so the IP is on screen as fast as the network allows. Stage 1 is
  // the IP itself (icanhazip, ~100ms, unmetered) — retried, rendered the moment
  // it lands, and the thing whose total failure means "unreachable". Stage 2 is
  // the geo enrichment (ipapi.co), best-effort and never retried: its free tier
  // meters the SOURCE address, which through a tunnel is the exit node's shared
  // IP, so on a busy node it answers 429 more often than not. Blocking the IP on
  // it was most of why the refresh felt slow.
  //
  // `clearOnFailure` is set only by the connect/disconnect effect below. Keeping
  // the previous answer there would leave the IP from BEFORE the transition on
  // screen — i.e. the user's real IP, in the green "connected" style, which reads
  // as proof the tunnel is up when it is in fact the proof it is not. A transient
  // blip on the idle poll or a manual refresh still keeps the last good value.
  const fetchIp = useCallback(async (retries = 2, includeGeo = true, clearOnFailure = false) => {
    setLoading(true)
    let ip = ''
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await window.api.networkGetIp(false)
        // Main reports an unreachable lookup as an empty ip rather than throwing
        // (it is not a fault worth a stack trace) — retry it like any other miss.
        if (!result.ip) throw new Error('no ip')
        ip = result.ip
        setIpInfo((prev) => {
          // Same IP as before: keep the geo already on screen. A different IP
          // makes the old geo wrong, so it blanks until stage 2 refills it.
          if (prev && prev.ip === ip) return { ...prev, ip }
          return { ip, country: '', city: '', asn: '', org: '' }
        })
        setIpStale(false)
        setLoading(false)
        break
      } catch {
        if (i < retries) {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    if (!ip) {
      if (clearOnFailure) setIpInfo(null)
      setIpStale(false)
      setLoading(false)
      return
    }
    if (includeGeo) {
      const geo = await window.api.networkGetIp(true).catch(() => null)
      // Apply only while the shown IP is still the one it describes — a
      // transition mid-lookup would otherwise pin the wrong location on it.
      if (geo?.ip) setIpInfo((prev) => (prev && prev.ip === geo.ip ? geo : prev))
    }
  }, [])

  useEffect(() => {
    fetchIp()
  }, [fetchIp])

  useEffect(() => {
    if (connKey !== prevKey.current) {
      prevKey.current = connKey
      setIpStale(true)
      setLoading(true)
      // No settle delay: `connected` flips at interface-up at the earliest,
      // when the tunnel is already routing traffic (usually later, at the
      // verified push), and the retry ladder above absorbs whatever the
      // transition still has in flight — a fixed pause only added latency.
      fetchIp(2, true, true)
    }
  }, [connKey, fetchIp])

  // Polled refresh — only when the window is visible and the VPN isn't
  // connected (connection-change effect above already refreshes on transitions).
  useEffect(() => {
    if (connected) return
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchIp(0, false)
      }
    }, POLL_IP_MS)
    return () => clearInterval(interval)
  }, [connected, fetchIp])

  const refresh = useCallback(() => fetchIp(0), [fetchIp])

  return { ipInfo, loading, ipStale, refresh }
}

export type ExitIp = ReturnType<typeof useExitIp>
