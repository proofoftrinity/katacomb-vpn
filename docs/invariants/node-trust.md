# Node-trust invariant

VPN node operators are adversaries in this app's threat model. Their handshake
data becomes config that the privileged helper runs as root. Read this before
adding any path that turns node-supplied data into a file, a spawn or a route.

**VPN node operators are adversaries in this app's threat model.** Their handshake
data becomes WireGuard/V2Ray configs and split-tunnel routes that the polkit helper
runs as **root** (`wg-quick`, `iptables`, `ip route`). A `wg-quick` config with a
`PostUp = …` directive executes shell as root — so any code path that turns
node-supplied (or renderer-supplied) data into a `.conf` / spawn / route MUST pass it
through `config-guard.ts` first. `vpn-manager.ts` enforces this at the sinks
(`connectWireGuard*`, `connectV2Ray*`, `bringUpTun`); never add a path that writes
node-derived data to disk or hands it to the helper without a `config-guard` check.
Likewise, tunnel credentials are only persisted when `safeStorage` is available —
never fall back to writing them in plaintext.

**And the channel that delivers a node's keys authenticates nothing.** The SDK's
handshake POST and `node-tester.ts` both set `rejectUnauthorized: false`, so the TLS pin,
the Reality public key, the port and `addrs` all arrive over a connection that accepts any
certificate — and those are precisely what the tunnel's confidentiality then rests on. An
on-path attacker (the ISP) can answer the handshake with its own metadata and become the
node; `normalizeTlsPin` and the config builders will faithfully pin the attacker's
certificate. There is **nothing on chain to verify against**: `sentinel/node/v3/node.proto`
gives `Node` only `{address, gigabyte_prices, hourly_prices, remote_addrs, inactive_at,
status, status_at}` — no certificate, fingerprint or public key. Trust-on-first-use
pinning is therefore the only option that exists, and it is deliberately **not
implemented** (it changes the failure mode of every connect and can't be validated without
live nodes). So never write UI copy implying that the TLS/Reality wrapping defeats the
local network; multihop's threat-model block states the limit instead.

**Except where the node signs its reply.** dvpnd nodes from 9.4 sign the handshake reply
with the key the chain knows the node by (`X-Dvpnd-Signature`; `protocols/reply-signature.ts`
checks it, written from dvpnd's spec and pinned to its digest vector). The node's address
IS on chain, so that is something to verify against: a reply whose signature does not hold,
or that a key the node account never granted signed, is refused and the session refunded,
always. What the attacker would keep is the downgrade: stripping the header makes a signing
node look like every other node. So the requirement follows the node: when the directory
(api.sentnodes.com, verified TLS, never the node itself) lists a node at dvpnd 9.4 or later,
an unsigned reply is refused, before paying when the node's own `X-Dvpnd-Reply-Signing`
header is missing and after the handshake (refunded) otherwise (`directorySaysSigns` in
ipc-handlers.ts). A node the directory lists below 9.4, or not at all, is not required to
sign; nothing says it can. There was a "Signed nodes only" setting instead until
2026-10-05: with it off, a 9.4 node's reply was accepted unsigned, so its signature
protected nothing; the Signed filter chip now does the setting's other job of hiding
non-signers. Every handshake goes through `signedHandshake` in chain-service.ts, and every
caller passes `requireSigned`; a new handshake path must do both.
UI copy may say a SIGNED connection came from the node; it must not say so of an unsigned
one.
