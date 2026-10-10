import { useState, useEffect, useRef } from 'react'
import Spinner from '../Spinner'
import CopyButton from '../CopyButton'
import { ArrowRightIcon, ChevronIcon, RefreshIcon } from '../Icons'
import { useBalance } from '../../hooks/useBalance'
import { useNavigation } from '../../contexts/NavigationContext'

interface Props {
  address: string | null
  name: string | null
  /**
   * The chain is unreachable because OUR tunnel is carrying the traffic, so the
   * balance is the cached one and refreshing it cannot work. Not the same as being
   * connected: proxy mode leaves routing alone, so the RPC endpoint stays reachable.
   */
  chainFrozen: boolean
}

export default function WalletPanel({ address, name, chainFrozen }: Props) {
  const { display: balance, refresh: refreshBalance } = useBalance()
  const { openSettings } = useNavigation()
  const [expanded, setExpanded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!expanded) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [expanded])

  async function refresh() {
    setRefreshing(true)
    try {
      await refreshBalance()
    } finally {
      setRefreshing(false)
    }
  }

  if (!address) return null

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title="Wallet details"
        className={`flex items-center gap-1.5 text-sm transition-colors ${
          expanded ? 'text-accent' : 'text-text-secondary hover:text-accent'
        }`}
      >
        Wallet
        <ChevronIcon direction={expanded ? 'up' : 'down'} className="w-3.5 h-3.5" />
      </button>

      {expanded && (
        <div className="absolute right-0 top-full mt-2 bg-bg-secondary border border-border w-[22rem] z-50 rounded-lg shadow-overlay divide-y divide-border">
          <div className="px-4 py-3 space-y-1">
            {name && <div className="text-text-primary text-sm font-semibold truncate">{name}</div>}
            <div className="flex items-start gap-1.5">
              <span className="text-text-tertiary font-mono text-[11px] break-all leading-relaxed">{address}</span>
              <CopyButton value={address} label="Copy address" className="mt-0.5" />
            </div>
          </div>

          <div className="px-4 py-2.5 flex items-center gap-2 text-sm">
            <span className="text-text-secondary text-xs">Balance</span>
            {chainFrozen && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full leading-none bg-bg-tertiary text-text-tertiary"
                title="Connected to the VPN, so the chain is unreachable through the tunnel. This is the balance from before you connected."
              >
                cached
              </span>
            )}
            <span className="ml-auto font-mono text-text-primary">
              {balance ?? '…'} <span className="text-text-tertiary text-xs">P2P</span>
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing || chainFrozen}
              className="text-text-tertiary hover:text-accent transition-colors disabled:opacity-30 disabled:hover:text-text-tertiary"
              title={chainFrozen ? 'Balance refresh is unavailable while connected (RPC routes through the tunnel)' : 'Refresh balance'}
              aria-label="Refresh balance"
            >
              {refreshing ? <Spinner className="text-accent" /> : <RefreshIcon className="w-3.5 h-3.5" />}
            </button>
          </div>

          <button
            type="button"
            onClick={() => { setExpanded(false); openSettings('wallets') }}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs text-text-secondary hover:text-accent hover:bg-bg-hover transition-colors rounded-b-lg"
            title="Switch, add or remove stored wallets"
          >
            Manage wallets
            <ArrowRightIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
