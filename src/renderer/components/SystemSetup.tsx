import { useCallback, useEffect, useState } from 'react'
import type { SetupStatus } from '../types'
import { displayConnectError, type SetupItem } from '../utils/connect-errors'
import Spinner from './Spinner'
import DisconnectButton from './DisconnectButton'

interface Props {
  /** Only these rows: what a refused connect named. Absent = all three (Settings, System). */
  only?: SetupItem[]
  /**
   * A session is live, in any mode. Installing or updating the helper restarts the
   * daemon that holds the tunnel up, so main refuses it then; the button says so first.
   */
  connected?: boolean
  /**
   * Whether the caller's retry can go ahead: every row shown is Ready. Also true when
   * the check itself failed, since main's preflight re-checks anyway and a button
   * held off with no Recheck would be a dead end.
   */
  onReadyChange?: (ready: boolean) => void
}

const ROWS: { item: SetupItem; label: string; detail: string }[] = [
  {
    item: 'helper',
    label: 'VPN helper',
    detail: 'Brings the tunnel and firewall up as root. Needed for full-tunnel connections; local proxy mode works without it.',
  },
  { item: 'wireguard-tools', label: 'WireGuard tools', detail: 'Needed for WireGuard nodes.' },
  { item: 'openvpn', label: 'OpenVPN', detail: 'Needed for OpenVPN nodes.' },
  {
    item: 'resolvconf',
    label: 'VPN DNS (resolvconf)',
    detail: "Applies the VPN's DNS for WireGuard and AmneziaWG. Without it those connections can only use your system's DNS, outside the tunnel.",
  },
]

function isReady(item: SetupItem, status: SetupStatus): boolean {
  if (item === 'helper') return status.helper === 'ready'
  if (item === 'wireguard-tools') return status.wireguardTools
  if (item === 'resolvconf') return status.resolvconf
  return status.openvpn
}

/**
 * The machine's readiness for a connect, with one-click installs. Shown where a
 * connect was refused for it (ConnectErrorActions, the Sessions tab) and in
 * Settings. Each install is one pkexec password prompt, and main runs it async, so
 * the app stays usable while the prompt is open.
 */
export default function SystemSetup({ only, connected = false, onReadyChange }: Props) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // One install at a time: two password prompts at once would be anyone's guess.
  const [busy, setBusy] = useState<SetupItem | null>(null)
  const [errors, setErrors] = useState<Partial<Record<SetupItem, string>>>({})

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.api.setupStatus())
      setLoadError(null)
    } catch (err) {
      setLoadError(displayConnectError(err instanceof Error ? err.message : 'Could not check this system'))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const rows = only ? ROWS.filter((r) => only.includes(r.item)) : ROWS
  const allReady = loadError !== null || (status !== null && rows.every((r) => isReady(r.item, status)))
  useEffect(() => {
    onReadyChange?.(allReady)
  }, [allReady, onReadyChange])

  async function install(item: SetupItem) {
    setBusy(item)
    setErrors((prev) => ({ ...prev, [item]: undefined }))
    try {
      if (item === 'helper') await window.api.setupInstallHelper()
      else if (item === 'resolvconf') await window.api.setupInstallPackages([status!.resolvconfPackage!])
      else await window.api.setupInstallPackages([item])
      await refresh()
    } catch (err) {
      setErrors((prev) => ({
        ...prev,
        [item]: displayConnectError(err instanceof Error ? err.message : 'The install failed'),
      }))
    } finally {
      setBusy(null)
    }
  }

  if (loadError) return <p className="text-danger text-xs">{loadError}</p>
  if (!status) {
    return (
      <div className="text-text-secondary text-xs flex items-center gap-2">
        <Spinner /> Checking this system...
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {rows.map(({ item, label, detail }) => {
        const ready = isReady(item, status)
        const outdated = item === 'helper' && status.helper === 'outdated'
        const manualOnly = item === 'resolvconf' ? status.resolvconfPackage === null
          : item !== 'helper' && status.packageManager === null
        const helperBlocked = item === 'helper' && connected
        const error = errors[item]

        return (
          <div key={item} className="flex items-start justify-between gap-4 py-3 px-4 border border-border bg-bg-tertiary rounded-md">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-text-primary text-sm">{label}</span>
                <span className={`text-xs font-medium ${ready ? 'text-success' : outdated ? 'text-warning' : 'text-danger'}`}>
                  {ready ? 'Ready' : outdated ? 'Needs update' : 'Missing'}
                </span>
              </div>
              <p className="text-text-tertiary text-xs mt-0.5">
                {outdated
                  ? 'The installed helper is not the one this version of the app ships, and an older one can refuse configs this version builds.'
                  : detail}
              </p>
              {!ready && manualOnly && item === 'resolvconf' && (
                <p className="text-text-secondary text-xs mt-1">
                  This system doesn't use systemd-resolved, so there is no one-click fix. Set up a resolvconf provider
                  (for example <span className="font-mono">openresolv</span>) the way your distribution documents, then press Recheck.
                </p>
              )}
              {!ready && manualOnly && item !== 'resolvconf' && (
                <p className="text-text-secondary text-xs mt-1">
                  Install the <span className="font-mono">{item}</span> package with your system's package manager, then press Recheck.
                </p>
              )}
              {!ready && helperBlocked && (
                <div className="flex items-center gap-2 flex-wrap mt-1">
                  <p className="text-text-secondary text-xs">Disconnect first: this restarts the service that holds the tunnel up.</p>
                  <DisconnectButton />
                </div>
              )}
              {error && <p className="text-danger text-xs mt-1">{error}</p>}
            </div>
            {!ready && !manualOnly && (
              <button
                onClick={() => install(item)}
                disabled={busy !== null || helperBlocked}
                className="btn btn-primary text-xs px-3 py-1 shrink-0 flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {busy === item ? <><Spinner /> Installing...</> : outdated ? 'Update' : 'Install'}
              </button>
            )}
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => void refresh()}
        disabled={busy !== null}
        className="text-text-tertiary hover:text-text-secondary text-xs transition-colors disabled:opacity-50"
      >
        Recheck
      </button>
    </div>
  )
}
