import { useState } from 'react'
import type { ExitIp } from '../hooks/useExitIp'
import Spinner from './Spinner'

/**
 * The header's IP while disconnected, i.e. the user's real address, so it stays
 * blurred until revealed. While a tunnel is up ConnectedBar shows the exit IP in its
 * capsule instead; this unmounts then and remounts on every disconnect, which is
 * what puts the blur back.
 */
export default function IpDisplay({ ipInfo, loading, ipStale, refresh }: ExitIp) {
  const [revealed, setRevealed] = useState(false)

  const ip = ipInfo?.ip
  const geoLabel = ipInfo?.country ? `${ipInfo.country}${ipInfo.city ? `, ${ipInfo.city}` : ''}` : ''

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-text-secondary">IP:</span>
      {loading || ipStale ? (
        <span className="flex items-center gap-1 text-text-secondary">
          <Spinner /> checking...
        </span>
      ) : (
        <span
          className={`font-mono text-text-primary ${revealed ? '' : 'blur-sm select-none'}`}
          title={ipInfo?.org ? `${ipInfo.org} (${ipInfo.asn})` : undefined}
        >
          {ip || '—'}
          {geoLabel && revealed && (
            <span className="text-text-secondary ml-1 font-sans">({geoLabel})</span>
          )}
        </span>
      )}
      {!loading && ip && (
        <button
          onClick={() => setRevealed((v) => !v)}
          className="text-text-secondary hover:text-accent transition-colors"
          title={revealed ? 'Hide IP' : 'Reveal IP'}
        >
          {revealed ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 2l12 12" />
              <path d="M4.5 4.5C3.1 5.5 2 7 2 8s2 4 6 4c1.3 0 2.4-.4 3.3-1" />
              <path d="M9.5 6.5a2 2 0 0 1-3 3" />
              <path d="M14 8c0-1-2-4-6-4-.7 0-1.3.1-1.9.3" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" />
              <circle cx="8" cy="8" r="2" />
            </svg>
          )}
        </button>
      )}
      <button
        onClick={refresh}
        disabled={loading}
        className="text-text-secondary hover:text-accent transition-colors disabled:opacity-30"
        title="Refresh IP"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M1 1v5h5" />
          <path d="M3.5 10a5.5 5.5 0 1 0 1-7.5L1 6" />
        </svg>
      </button>
    </div>
  )
}
