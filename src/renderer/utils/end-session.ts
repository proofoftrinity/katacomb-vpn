/**
 * [REL-49] What the Sessions tab's End does to the live connection
 * (docs/invariants/reliability.md). main ends a session through the live tunnel, so ending
 * one beside the connection leaves it up, kill switch and all. The connection goes only
 * when the chain did not answer through it and the user agrees to go around it; then it
 * comes back once the End has run, whether or not that worked.
 */

/** What carries the traffic: nothing, the sessions being ended, or another session. */
export type EndBeside = 'idle' | 'these' | 'other'

export async function endSessions(steps: {
  /** The session, then its chain peer when that is still open: one account's txs, in turn. */
  ids: string[]
  connection: EndBeside
  end: (id: string) => Promise<void>
  /** Takes the connection down: before ending the sessions it carries, or to go around it. */
  leave: () => Promise<void>
  /** Reads the list again. After going around, before the connection comes back. */
  reread: () => Promise<void>
  /** Did main say the chain never answered through the tunnel? */
  unreachable: (message: string) => boolean
  /** Asks to end `id` around the tunnel. null when there is no connection to bring back. */
  goAround: ((id: string, reason: string) => Promise<boolean>) | null
  /** Brings the connection back after going around: its error, or null. */
  rejoin: () => Promise<string | null>
}): Promise<{ endError: string | null; rejoinError: string | null }> {
  const failed = (err: unknown) => (err instanceof Error ? err.message : 'Failed to end session')
  let next = 0
  const endTheRest = async () => {
    for (; next < steps.ids.length; next++) await steps.end(steps.ids[next])
  }
  let endError: string | null = null
  try {
    if (steps.connection === 'these') await steps.leave()
    await endTheRest()
  } catch (err) {
    endError = failed(err)
  }
  if (endError === null || steps.connection !== 'other' || !steps.goAround || !steps.unreachable(endError) ||
    !(await steps.goAround(steps.ids[next], endError))) {
    await steps.reread()
    return { endError, rejoinError: null }
  }
  endError = null
  try {
    await steps.leave()
    await endTheRest()
  } catch (err) {
    endError = failed(err)
  }
  await steps.reread()
  return { endError, rejoinError: await steps.rejoin() }
}
