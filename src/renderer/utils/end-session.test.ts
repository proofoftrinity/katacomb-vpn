import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { endSessions, type EndBeside } from './end-session.ts'
import { isUnreachableThroughTunnel } from './connect-errors.ts'

const UNANSWERED = "Error invoking remote method 'wallet:end-session': Error: UNREACHABLE_THROUGH_TUNNEL: Couldn't reach the blockchain through the VPN to end session #2002. (RPC connect timed out after 10000ms)"

/**
 * The steps as the Sessions tab wires them, each one logged. `fails` maps a session id to
 * how many of its End calls throw before one goes through, and with what.
 */
function run(connection: EndBeside, opts: {
  ids?: string[]
  fails?: Record<string, { times: number; message: string }>
  agree?: boolean | null
  rejoinError?: string | null
} = {}) {
  const log: string[] = []
  const fails = structuredClone(opts.fails ?? {})
  const result = endSessions({
    ids: opts.ids ?? ['2001'],
    connection,
    end: async (id) => {
      log.push(`end #${id}`)
      const f = fails[id]
      if (f && f.times-- > 0) throw new Error(f.message)
    },
    leave: async () => { log.push('leave') },
    reread: async () => { log.push('reread') },
    unreachable: isUnreachableThroughTunnel,
    goAround: opts.agree === null ? null : async (id) => {
      log.push(`ask #${id}`)
      return opts.agree ?? true
    },
    rejoin: async () => {
      log.push('rejoin')
      return opts.rejoinError ?? null
    },
  })
  return { log, result }
}

describe('[REL-49] ending a session from the Sessions tab', () => {
  test('[REL-49] beside a live connection, the session is ended through it: the connection is never left', async () => {
    const { log, result } = run('other', { ids: ['2001', '2002'] })
    assert.deepEqual(await result, { endError: null, rejoinError: null })
    assert.deepEqual(log, ['end #2001', 'end #2002', 'reread'])
  })

  test('[REL-49] the connection is left only when the chain did not answer through it and the user agrees, then it comes back', async () => {
    // A chain's second hop: the first ended through the tunnel, the second did not.
    const { log, result } = run('other', { ids: ['2001', '2002'], fails: { 2002: { times: 1, message: UNANSWERED } } })
    assert.deepEqual(await result, { endError: null, rejoinError: null })
    assert.deepEqual(log, ['end #2001', 'end #2002', 'ask #2002', 'leave', 'end #2002', 'reread', 'rejoin'],
      'asked about the session that failed, then only that one is ended again, and the list is read before the tunnel is back')
  })

  test('[REL-49] declined, nothing is left and the reason is shown', async () => {
    const { log, result } = run('other', { fails: { 2001: { times: 1, message: UNANSWERED } }, agree: false })
    assert.deepEqual(await result, { endError: UNANSWERED, rejoinError: null })
    assert.deepEqual(log, ['end #2001', 'ask #2001', 'reread'])
  })

  test('[REL-49] a refusal by the chain is not offered the way around: it would answer the same', async () => {
    const refused = "Error invoking remote method 'wallet:end-session': Error: INSUFFICIENT_FUNDS: The transaction was rejected"
    const { log, result } = run('other', { fails: { 2001: { times: 1, message: refused } } })
    assert.deepEqual(await result, { endError: refused, rejoinError: null })
    assert.deepEqual(log, ['end #2001', 'reread'])
  })

  test('[REL-49] with no connection to bring back, the way around is not offered', async () => {
    const { log, result } = run('other', { fails: { 2001: { times: 1, message: UNANSWERED } }, agree: null })
    assert.deepEqual(await result, { endError: UNANSWERED, rejoinError: null })
    assert.deepEqual(log, ['end #2001', 'reread'])
  })

  test('[REL-49] after going around, the connection comes back even when the End fails again, and both errors are reported', async () => {
    const { log, result } = run('other', { fails: { 2001: { times: 2, message: UNANSWERED } }, rejoinError: 'Reconnection failed' })
    assert.deepEqual(await result, { endError: UNANSWERED, rejoinError: 'Reconnection failed' })
    assert.deepEqual(log, ['end #2001', 'ask #2001', 'leave', 'end #2001', 'reread', 'rejoin'])
  })

  test('[REL-49] control: ending the sessions that carry the connection leaves it first, and nothing comes back', async () => {
    const { log, result } = run('these', { ids: ['2001', '2002'] })
    assert.deepEqual(await result, { endError: null, rejoinError: null })
    assert.deepEqual(log, ['leave', 'end #2001', 'end #2002', 'reread'])
  })

  test('[REL-49] control: with no connection, an unanswered End is only reported', async () => {
    const { log, result } = run('idle', { fails: { 2001: { times: 1, message: UNANSWERED } } })
    assert.deepEqual(await result, { endError: UNANSWERED, rejoinError: null })
    assert.deepEqual(log, ['end #2001', 'reread'])
  })
})
