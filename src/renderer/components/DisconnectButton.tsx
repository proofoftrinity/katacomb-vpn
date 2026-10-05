import { useState } from 'react'
import { useConnection } from '../hooks/useConnection'
import Spinner from './Spinner'
import { PowerIcon } from './Icons'

export default function DisconnectButton() {
  const { status, disconnect } = useConnection()
  const [disconnecting, setDisconnecting] = useState(false)

  if (status.state !== 'connected' && status.state !== 'reconnecting') return null

  async function handleDisconnect() {
    setDisconnecting(true)
    try {
      await disconnect()
    } finally {
      setDisconnecting(false)
    }
  }

  // A labelled pill rather than a bare icon: it is the one action the header offers
  // while connected, and a 15px glyph at 70% opacity read as decoration. Outline at
  // rest so it does not outshout the status beside it; filled on hover. No confirm:
  // this drops only the local tunnel, the on-chain session stays resumable.
  return (
    <button
      onClick={handleDisconnect}
      disabled={disconnecting}
      title="Disconnect"
      className="flex items-center gap-1.5 shrink-0 px-3 py-1 rounded-full border border-danger bg-danger-subtle text-danger text-xs font-medium whitespace-nowrap transition-colors hover:bg-danger hover:text-text-on-accent disabled:opacity-60 disabled:hover:bg-danger-subtle disabled:hover:text-danger"
    >
      {disconnecting ? (
        <>
          <Spinner />
          Disconnecting...
        </>
      ) : (
        <>
          <PowerIcon className="w-3.5 h-3.5" />
          Disconnect
        </>
      )}
    </button>
  )
}
