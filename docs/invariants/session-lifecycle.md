# Session lifecycle

Verified against live mainnet, not inferred from the protobufs. `npm run check:chain`
re-checks SL-2 to SL-4 against it (docs/testing.md).

- **[SL-1] Ending a session is two phases, and cancel/expiry are ONE path.** `x/session` has only
  `MsgCancelSession` / `MsgUpdateSession` (the node's proofs) / `MsgUpdateParams` — there
  is no settle or refund message. Phase 1 (the user's End, or the quota running out) sets
  `active → inactive_pending` and stamps `inactiveAt = now + statusTimeout`; phase 2 is
  the EndBlocker settling it there (`EventEnd`). **So End is NOT an instant refund** —
  it just performs phase 1 by hand. Don't word it as one. What settlement does, read in
  sentinelhub v12.0.2 (`x/node/keeper/hooks.go`, `x/subscription/keeper/hooks.go`) on
  2026-11-04: a P2P session pays the node pro rata for the usage it reported (per byte,
  or per nanosecond for an hourly one), capped at the deposit, and the rest of the
  deposit goes back to the account; a plan session's usage already came out of the
  allocation as the node reported it, so End only detaches it and the subscription keeps
  the rest. The End confirmation says exactly that, with the 2 hours, and never
  "forfeited", which was wrong for both kinds.
- **[SL-2] `statusTimeout` is 7200s (2h)** on mainnet — a governance param, so read it rather
  than hardcoding if it ever matters numerically.
- **[SL-3] `inactiveAt` means two different things by status.** On an `inactive_pending` row it
  is fixed at `statusAt + statusTimeout` — when the chain settles it. On an `active` row
  it is an **idle deadline pinned at `lastNodeProof + statusTimeout`**, so it is
  emphatically NOT `startAt + statusTimeout`. Each `MsgUpdateSession` jumps it back to
  2h out; between proofs it just ticks down in real time. #53647217 read `inactiveAt`
  06:24:52Z against a single proof at 04:24:52Z — the earlier "slid 74.5 min" reading was
  that one jump, not a smooth slide. Seen again 2026-10-07: #66486462 and #66488552 sat
  at start + 2h through an hour of use, until their node's report at 11:43:59Z moved
  both, in the same block, to 13:43:59Z. Since quota is metered, that is the only clock
  running on an idle session. **It therefore keeps falling while the UI says "connected"
  if the node isn't seeing the traffic** — which makes it a usable dead-tunnel tell, and
  is why the card says "unless the node reports usage" rather than "if unused".
- **[SL-4] The chain DELETES settled sessions.** `sessionsForAccount` returned
  `pagination.total = 2` for an account with a long purchase history, so nothing
  accumulates and `getActiveSessions`' `limit: 20` is in no danger of being crowded out.
  Expired rows leave the list on their own; the app deletes nothing.
- **[SL-5] Reconnect refuses a session that has used everything it was paid for.** `'active'`
  does not mean usable ([REL-24]): the chain meters past the cap and leaves the row active
  (#53647217: 5673s of a paid 3600s, status 1). The Sessions card withholds Reconnect
  there, and so does the tray ([REL-38]). Before that, the tray's "Reconnect last session"
  reached `CONNECTION_RECONNECT` with the newest session, and the tunnel it built cost a
  handshake and a polkit prompt and lived until the quota watchdog's next tick. Main scores the session (and its chain peer) the
  way the watchdog does, off the cached rows with their usage floors, and refuses an
  expired one before anything is mutated. Positive evidence only: no row, no refusal.
- Settlement pays the node for actual usage and returns only the remainder, so an
  **expired** session (quota fully consumed by definition) refunds ~nothing. The card
  deliberately promises no refund, and the End confirmation says "whatever is left".
- **[SL-6] A session is scored the way its node enforces it.** Read from source
  (sentinelhub v12.0.2, dvpnx 8.2.0 to 9.0.0, dvpnd 9.4.3) on 2026-10-29:
  - The node stores the caps at the handshake and cuts the peer there; nothing later
    changes them. A P2P session's caps are fixed by `MsgStartSession` (a gigabyte is
    10⁹ bytes), and there is no message that tops one up. A plan session's caps are
    computed on every chain read (data: used + allocation left; time: subscription end
    − session start), and `MsgRenewSubscription` replaces the period (it starts now,
    used data resets, the full price is charged), so the chain's caps for a live session
    grow while the node still cuts at the old ones.
  - The node counts data as download + upload, which is also what the chain bills.
  - The node counts time as wall-clock from its handshake to the last activity, gaps
    included ([REL-21]): a reconnect after a gap is charged the gap.

  So the app records what the node took at each fresh handshake (`NodeCaps`: the caps,
  when the handshake returned, the chain's duration then) in the session's saved config
  and in the live quota, and every scorer uses `src/shared/node-quota.ts`: the caps are
  the smaller of the chain's and the node's, data is down + up, and time is the larger of
  the metered figure and the node's clock. The watchdog reads that clock at the tunnel's
  last sign of life ([REL-20]); the [SL-5] refusal and the card read it at now, because
  a reconnect past the node's deadline is worse than useless: the first activity moves the
  node's duration past the paid time, the peer is cut, and the chain then takes the whole
  deposit instead of refunding the unused part. A chain's exit hop records nothing
  ([MH-12]: it meters nothing). Sessions with no recorded handshake are scored as before.
  Known limit: a dvpnd node that restarts would admit a fresh handshake on a new clock,
  while the refusal still reads the old one; End still works.
