import { useEffect, useState, type ReactNode } from 'react'
import type { SentNode } from '../types'
import type { FundsCheck } from '../../shared/funds'
import { formatP2p, formatP2pCeil } from '../../shared/funds'
import { SOCKS_DISPLAY_ADDR } from '../../shared/socks'
import { v2rayEncryption } from '../utils/v2ray-connection'
import { protocolMeta } from '../utils/protocols'
import { versionSignsReplies } from '../../shared/node-signing'
import { switchFacts, type PreviousConnection } from '../utils/switch'
import CountryFlag from './CountryFlag'
import InfoTip from './InfoTip'
import Spinner from './Spinner'
import { AlertIcon, CheckIcon, ChevronIcon, CloseIcon } from './Icons'

// The pieces the three connect windows share: Nodes (ConnectionModal), Plans
// (PlanConnectModal) and Multi-hop (ChainReviewModal). Each answers the same three
// questions in the same order (where the traffic goes, what was checked, what it
// costs) with a footer that never scrolls away and always says what stops Pay. They
// were built once for the chain and then shared, so the windows read as one product.

export type Tone = 'success' | 'warning' | 'danger' | 'busy'

/**
 * The window: a header, a body that scrolls, and a footer that does not. Escape and a
 * click outside close it only while `closable`, which a window turns off for as long
 * as a purchase is in flight, so the purchase cannot outlive the window showing it.
 */
export function ReviewModal({ title, subtitle, closable, onClose, footer, className = 'max-w-xl', children }: {
  title: string
  subtitle?: ReactNode
  closable: boolean
  onClose: () => void
  footer?: ReactNode
  /** Width, and a fixed height for a window whose states differ a lot in size. */
  className?: string
  children: ReactNode
}) {
  useEffect(() => {
    if (!closable) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closable, onClose])

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={closable ? onClose : undefined}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-review-title"
        className={`bg-bg-secondary border border-border w-full mx-4 max-h-[90vh] flex flex-col rounded-lg shadow-overlay ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 shrink-0">
          <div className="min-w-0">
            <h2 id="connect-review-title" className="text-text-primary text-base font-semibold">{title}</h2>
            {subtitle && <p className="text-text-tertiary text-xs mt-0.5">{subtitle}</p>}
          </div>
          {closable && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 shrink-0 grid place-items-center rounded-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
            >
              <CloseIcon />
            </button>
          )}
        </div>
        <div className="px-6 pb-5 space-y-5 overflow-y-auto min-h-0 flex-1">{children}</div>
        {footer && <div className="shrink-0 border-t border-border px-6 pt-3.5 pb-4 space-y-2.5">{footer}</div>}
      </div>
    </div>
  )
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{title}</h3>
      <span className="text-xs font-medium">{children}</span>
    </div>
  )
}

export interface CheckSpec {
  id: string
  tone: Tone
  text: string
  tip?: string
  tipLabel?: string
  /** A fix on the same line, e.g. "Use encrypted DNS". */
  action?: ReactNode
  /** Whatever the row needs under it: a picker, a guide, an override. */
  body?: ReactNode
}

/**
 * The list of checks, headed by a one-word verdict: what needs fixing first, then
 * what is still being checked, then what to note, else that everything passed.
 */
export function ChecksSection({ title, checks }: { title: string; checks: CheckSpec[] }) {
  const n = (t: Tone) => checks.filter((c) => c.tone === t).length
  return (
    <section>
      <SectionHead title={title}>
        {n('danger') > 0 ? <span className="text-danger">{n('danger')} to fix</span>
          : n('busy') > 0 ? <span className="text-text-secondary">Checking…</span>
            : n('warning') > 0 ? <span className="text-warning">{n('warning')} to note</span>
              : <span className="text-success">All {checks.length} pass</span>}
      </SectionHead>
      <div className="space-y-0.5">
        {checks.map(({ id, ...c }) => <CheckRow key={id} {...c} />)}
      </div>
    </section>
  )
}

/**
 * One check: a graded icon, a short claim, an optional fix on the same line, the
 * reasoning behind a "?" at the row's right end (where InfoTip must sit), and the
 * body underneath. Only a row that needs attention is tinted.
 */
function CheckRow({ tone, text, tip, tipLabel, action, body }: Omit<CheckSpec, 'id'>) {
  const icon = tone === 'success' ? <CheckIcon className="w-4 h-4 text-success" />
    : tone === 'warning' ? <AlertIcon className="w-4 h-4 text-warning" />
      : tone === 'danger' ? <CloseIcon className="w-4 h-4 text-danger" />
        : <Spinner className="text-accent" />
  return (
    <div className={`grid grid-cols-[16px_minmax(0,1fr)_14px] gap-x-2.5 gap-y-2 items-start px-2.5 py-2 rounded-md ${
      tone === 'danger' ? 'bg-danger-subtle' : tone === 'warning' ? 'bg-warning-subtle' : ''
    }`}>
      <span className="pt-0.5">{icon}</span>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 min-w-0">
        <span className="text-sm text-text-primary">{text}</span>
        {action}
      </div>
      <span className="pt-[3px]">
        {tip && <InfoTip label={tipLabel ?? 'Why'}>{tip}</InfoTip>}
      </span>
      {body && <div className="col-start-2 text-xs text-text-secondary space-y-2 min-w-0">{body}</div>}
    </div>
  )
}

/**
 * `disabled` greys the whole switch (a string is the reason, shown on hover), and
 * `pending` puts a spinner on the option an on-chain change is moving to while the
 * current value stays selected: the Provider tab's plan status and visibility.
 */
export function Segmented<T extends string>({ label, value, options, onChange, disabled, pending }: {
  label: string
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  disabled?: boolean | string
  pending?: T | null
}) {
  const locked = Boolean(disabled) || (pending !== undefined && pending !== null)
  return (
    <span
      role="group"
      aria-label={label}
      title={typeof disabled === 'string' ? disabled : undefined}
      className="inline-flex p-0.5 bg-bg-primary border border-border rounded-md"
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          disabled={locked}
          onClick={() => { if (v !== value) onChange(v) }}
          className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors inline-flex items-center gap-1.5 disabled:cursor-not-allowed ${
            value === v ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary disabled:hover:text-text-secondary'
          } ${Boolean(disabled) ? 'opacity-60' : ''}`}
        >
          {pending === v && <Spinner size="sm" />}
          {text}
        </button>
      ))}
    </span>
  )
}

/** "On each hop / How much  [−] 1 [+] GB  1 5 10  ?" — the amount, its unit and presets. */
export function AmountStepper({ label, amount, onChange, unit, presets, tip }: {
  label: string
  amount: number
  onChange: (n: number) => void
  unit: string
  presets: number[]
  tip?: { label: string; text: string }
}) {
  const set = (n: number) => onChange(Math.min(1000, Math.max(1, n)))
  return (
    <div className="flex items-center gap-x-2.5 gap-y-2 flex-wrap">
      <span className="text-sm text-text-secondary">{label}</span>
      <div className="inline-flex items-stretch border border-border rounded-sm overflow-hidden">
        <button type="button" aria-label="Less" onClick={() => set(amount - 1)} className="w-7 bg-bg-tertiary text-text-primary hover:text-accent transition-colors">
          −
        </button>
        <input
          type="number"
          min={1}
          max={1000}
          value={amount}
          aria-label={label}
          onChange={(e) => set(parseInt(e.target.value) || 1)}
          className="w-14 bg-bg-primary text-text-primary text-center text-sm font-mono font-semibold py-1 focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button type="button" aria-label="More" onClick={() => set(amount + 1)} className="w-7 bg-bg-tertiary text-text-primary hover:text-accent transition-colors">
          +
        </button>
      </div>
      <span className="text-sm text-text-secondary">{unit}</span>
      <div className="flex gap-1">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={amount === p}
            onClick={() => set(p)}
            className={`min-w-[28px] px-1.5 py-0.5 rounded-sm border font-mono text-xs transition-colors ${
              amount === p ? 'border-accent text-accent bg-accent-subtle' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {p}
          </button>
        ))}
      </div>
      {tip && (
        <span className="ml-auto">
          <InfoTip label={tip.label}>{tip.text}</InfoTip>
        </span>
      )}
    </div>
  )
}

/** An amber line inside a section, e.g. the hours that a chain will not live to use. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-xs text-warning bg-warning-subtle rounded-md px-2.5 py-2">
      <AlertIcon className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/** The receipt's frame: one ReceiptLine per payment, and a total when there is more than one. */
export function Receipt({ children, total }: { children: ReactNode; total?: ReactNode }) {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-x-3 gap-y-2.5 items-start px-3.5 py-3 bg-bg-primary border border-border rounded-md text-sm">
      {children}
      {total && (
        <>
          <div className="col-span-3 border-t border-border" />
          {total}
        </>
      )}
    </div>
  )
}

/**
 * One payment: what it is and who pays, the arithmetic, the amount, and what the
 * paying wallet keeps afterwards (or how short it is). `funds` null = the balance is
 * unknown, so nothing is claimed about it.
 */
export function ReceiptLine({ country, label, payer, detail, amount, funds }: {
  country: string
  label: string
  payer: string | null
  detail: ReactNode
  amount: string | null
  funds: FundsCheck | null
}) {
  return (
    <>
      <span className="pt-1">{country ? <CountryFlag country={country} /> : null}</span>
      <div className="min-w-0">
        <div className="text-text-primary">
          {label} <span className="text-text-tertiary">· paid by</span>{' '}
          {payer ?? <span className="text-text-tertiary">no wallet yet</span>}
        </div>
        <div className="text-xs font-mono text-text-tertiary">{detail}</div>
      </div>
      <div className="text-right font-mono">
        {amount !== null && <div className="text-text-primary">{amount}</div>}
        {funds !== null && amount !== null && (
          funds.ok
            ? <div className="text-[11px] text-text-tertiary">{formatP2p(funds.available - funds.cost)} left</div>
            : <div className="text-[11px] text-danger">short by {formatP2pCeil(funds.shortfall)}</div>
        )}
      </div>
    </>
  )
}

export interface Limit {
  key: string
  tone: 'danger' | 'warning'
  label: string
  text: ReactNode
}

/**
 * What no check can fix: toggle chips that open one shared panel below them. Chips,
 * not InfoTips, because an InfoTip must sit at a row's right end and these sit
 * mid-row. The figure a decision turns on belongs in the label, not only the panel.
 */
export function LimitsSection({ title, limits }: { title: string; limits: Limit[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const shown = limits.find((l) => l.key === open)
  return (
    <section>
      <SectionHead title={title}>
        <span className="text-text-tertiary">Select one to read why</span>
      </SectionHead>
      <div className="flex flex-wrap gap-1.5">
        {limits.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-expanded={open === l.key}
            aria-controls="connect-limit-panel"
            onClick={() => setOpen(open === l.key ? null : l.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
              open === l.key ? 'border-accent text-text-primary' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {l.tone === 'danger'
              ? <CloseIcon className="w-3.5 h-3.5 text-danger" />
              : <AlertIcon className="w-3.5 h-3.5 text-warning" />}
            {l.label}
          </button>
        ))}
      </div>
      {shown && (
        <div id="connect-limit-panel" className="mt-2 border border-border rounded-md bg-bg-primary px-3 py-2.5 text-xs text-text-secondary">
          {shown.text}
        </div>
      )}
    </section>
  )
}

/**
 * What protects the setup request, for THIS connection. Nodes use self-signed
 * certificates with nothing on chain to check them against; what closes that gap is a
 * signed handshake reply. main requires one from every node the directory lists as
 * dvpnd 9.4+ (directorySaysSigns in ipc-handlers.ts), so a connection to such a node
 * either carries a verified signature or does not come up: no limit to state. Any
 * other node gets "Keys are self-signed". For a chain, both hops must sign.
 * `signs` null = not known yet (smart connect has not picked a node).
 *
 * History: there was a "Signed Nodes Only" setting, and with it off main accepted an
 * unsigned reply even from a 9.4 node, so this showed "Signature not required" under
 * a green signing check. The user asked why a node that signs anyway was not trusted;
 * the requirement moved to the node and the setting went (2026-10-05).
 */
export function keysLimit({ subject, signs }: { subject: 'node' | 'chain'; signs: boolean | null }): Limit | null {
  if (signs === true) return null
  return {
    key: 'keys',
    tone: 'warning',
    label: 'Keys are self-signed',
    text: (
      <>
        <p>
          {signs === null
            ? 'Most nodes do not sign their handshake replies yet.'
            : subject === 'chain' ? 'Not every hop here signs its handshake replies.' : 'This node does not sign its handshake replies.'}{' '}
          Nodes use self-signed certificates and there is nothing on chain to check them against, so
          whoever can intercept the setup request can answer it. Worth knowing when the observer you
          are avoiding is the network you are on.
        </p>
        <p className="mt-1.5">
          Nodes on dvpnd 9.4 or later sign their replies, and the app refuses a reply from them that
          is not signed. The Signed filter in the node list shows only those.
        </p>
      </>
    ),
  }
}

/**
 * The signing check for one node, from the directory's version, which main holds the
 * node to (see keysLimit). An unsigned node gets no row: most nodes do not sign yet,
 * and an amber row on almost every node would be noise; keysLimit states the gap.
 */
export function signingCheck(node: SentNode): CheckSpec | null {
  if (!versionSignsReplies(node.version)) return null
  return {
    id: 'signing',
    tone: 'success',
    text: 'Signs its handshake replies',
    tipLabel: 'What a signed reply proves',
    tip: 'Its version (dvpnd 9.4 or later) signs the keys and addresses it hands this app. The signature is checked against the key the chain knows the node by, and a reply without one is refused, so nobody on your network can answer in its place. A node that does not say it signs is refused before anything is bought.',
  }
}

/**
 * The one thing a single hop cannot do, said where the chain says what it splits.
 * Amber, not red (decided 2026-10-05): single hop is the everyday product, and this is
 * a property to know, not a fault. The link is the way to the product that fixes it.
 */
export function seesBothLimit(onOpenMultihop: () => void): Limit {
  return {
    key: 'sees-both',
    tone: 'warning',
    label: 'This node sees both ends',
    text: (
      <>
        <p>
          One node sees who you are and where you go: your IP, because your device connects to
          it, and the sites you visit, because your traffic leaves from it. HTTPS hides what you
          send, not where you send it.
        </p>
        <p className="mt-1.5">
          A two-hop chain splits the two between nodes in different countries, each paid from its
          own wallet.{' '}
          <button type="button" onClick={onOpenMultihop} className="text-accent hover:underline">
            Open Multi-hop
          </button>
        </p>
      </>
    ),
  }
}

/**
 * A FOLDED row of options: the current choice in the summary, the controls inside,
 * because they are set once and rarely changed.
 */
export function OptionsSection({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 flex-wrap border border-border rounded-md px-3 py-2 text-left hover:border-border-focus transition-colors"
      >
        <ChevronIcon direction="down" className={`w-3.5 h-3.5 text-text-tertiary transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-sm text-text-primary">Options</span>
        <span className="text-xs text-text-tertiary">{summary}</span>
      </button>
      {open && <div className="pt-3 px-1 space-y-4">{children}</div>}
    </section>
  )
}

/** Full tunnel or local proxy, with the one sentence that tells them apart. */
export function ModeField({ mode, onChange }: { mode: 'tunnel' | 'proxy'; onChange: (m: 'tunnel' | 'proxy') => void }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs text-text-secondary">Connection mode</div>
      <Segmented
        label="Connection mode"
        value={mode}
        options={[['tunnel', 'Full tunnel'], ['proxy', 'Local proxy']]}
        onChange={onChange}
      />
      <p className="text-text-tertiary text-xs">
        {mode === 'tunnel'
          ? 'Routes your whole device. Needs admin rights.'
          : `SOCKS5 on ${SOCKS_DISPLAY_ADDR}. No admin password, but only apps you point at it use the connection, and there is no kill switch.`}
      </p>
    </div>
  )
}

export function modeSummary(mode: 'tunnel' | 'proxy'): string {
  return mode === 'tunnel' ? 'Full tunnel, needs admin' : `Local proxy on ${SOCKS_DISPLAY_ADDR}`
}

/** The progress list under the strip: plain-language stages, the current one's detail. */
export function StepList({ stages, current, detail }: {
  stages: { id: string; label: string }[]
  /** Index into `stages`; anything before it is done. */
  current: number
  detail: string | null
}) {
  return (
    <div className="space-y-2.5">
      {stages.map((stage, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'pending'
        return (
          <div key={stage.id} className="text-sm">
            <div className="flex items-center gap-3">
              <span className={`status-dot ${
                state === 'done' ? 'status-dot-active' : state === 'active' ? 'status-dot-pending' : 'bg-border'
              }`} />
              <span className={state === 'pending' ? 'text-text-tertiary' : 'text-text-primary'}>{stage.label}</span>
            </div>
            {state === 'active' && detail && (
              <div className="text-text-tertiary text-xs pl-5 mt-0.5">{detail}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The footer's one line about why Pay is disabled. */
export function FooterReason({ text, tone = 'danger' }: { text: string; tone?: 'danger' | 'muted' | 'busy' }) {
  return (
    <p className={`flex items-center gap-2 text-xs ${tone === 'danger' ? 'text-danger' : 'text-text-secondary'}`}>
      {tone === 'busy' ? <Spinner className="text-accent" />
        : tone === 'danger' ? <CloseIcon className="w-3.5 h-3.5 shrink-0" />
          : <AlertIcon className="w-3.5 h-3.5 shrink-0" />}
      <span>{text}</span>
    </p>
  )
}

/**
 * The settings a review reads: the DNS resolver (the leak no connection closes by
 * itself), and the kill switch, which a switch lifts while it runs. null until read;
 * a failed read just leaves the DNS check out rather than guessing.
 */
export function useReviewSettings() {
  const [dnsResolver, setDnsResolver] = useState<string | null>(null)
  const [killSwitch, setKillSwitch] = useState(false)
  const [dnsBusy, setDnsBusy] = useState(false)
  const [dnsError, setDnsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.settingsGet()
      .then((s) => {
        if (cancelled) return
        setDnsResolver(s.dnsResolver)
        setKillSwitch(s.killSwitch)
      })
      .catch(() => { /* the DNS check simply doesn't render */ })
    return () => { cancelled = true }
  }, [])

  /**
   * Switch the app's resolver to encrypted DNS for this connection and every one
   * after. Not done silently: it is a global setting, so the user presses the button.
   */
  async function switchToEncryptedDns() {
    setDnsBusy(true)
    setDnsError(null)
    try {
      const updated = await window.api.settingsSet({ dnsResolver: '1.1.1.1' })
      setDnsResolver(updated.dnsResolver)
    } catch (err) {
      setDnsError(err instanceof Error ? err.message : 'Could not change the DNS setting')
    } finally {
      setDnsBusy(false)
    }
  }

  return { dnsResolver, killSwitch, dnsBusy, dnsError, switchToEncryptedDns }
}

/**
 * The switch row ([RN-10]), first in the checks while another connection is live:
 * Pay leaves it, so the window says what that costs before the press, not after.
 * Amber, a thing to note: being connected never blocks a connect.
 */
export function switchCheck(prev: PreviousConnection | null, s: ReturnType<typeof useReviewSettings>): CheckSpec | null {
  if (!prev) return null
  const facts = switchFacts(prev, s.killSwitch)
  return {
    id: 'switch',
    tone: 'warning',
    text: facts.text,
    tipLabel: 'Why the connection drops first',
    tip: facts.tip,
    body: <>{facts.lines.map((l) => <p key={l}>{l}</p>)}</>,
  }
}

/**
 * The DNS check. With the resolver on System Default and the kill switch off, DNS
 * goes to the LAN resolver, a more specific route than tun2socks' /1 halves, so it
 * never enters the tunnel: the ISP reads every domain the user is paying to hide.
 * Proxy mode routes nothing, so it says that instead. null = setting not read.
 */
export function dnsCheck(s: ReturnType<typeof useReviewSettings>, mode: 'tunnel' | 'proxy', through: string): CheckSpec | null {
  const error = s.dnsError ? <p className="text-danger">{s.dnsError}</p> : undefined
  if (mode === 'proxy') {
    return {
      id: 'dns',
      tone: 'warning',
      text: `Only apps you point at ${SOCKS_DISPLAY_ADDR} use ${through}`,
      tipLabel: 'More about local proxy mode',
      tip: 'No admin password is needed, because nothing about your routing changes. Everything you do not point at the proxy leaves your device as normal, and there is no kill switch.',
    }
  }
  if (s.dnsResolver === 'system') {
    return {
      id: 'dns',
      tone: 'warning',
      text: 'DNS would go to your own network',
      tipLabel: 'Why DNS escapes the tunnel',
      tip: `DNS is set to System Default, which is usually your router. That lookup is not routed through ${through}, so your provider still sees every domain you visit even though your traffic does not go near them.`,
      action: (
        <button
          type="button"
          onClick={() => void s.switchToEncryptedDns()}
          disabled={s.dnsBusy}
          className="btn btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"
        >
          {s.dnsBusy ? 'Applying…' : 'Use encrypted DNS'}
        </button>
      ),
      body: error,
    }
  }
  if (s.dnsResolver === null) return null
  return {
    id: 'dns',
    tone: 'success',
    text: `DNS goes to ${s.dnsResolver}, encrypted`,
    tipLabel: 'About the DNS setting',
    tip: `A chosen resolver is queried over encrypted DNS inside ${through}, so neither your network nor the node can read the names you look up. It is an app-wide setting, in Settings.`,
    body: error,
  }
}

export type OtherVpn = { type: string; name: string; iface?: string }

/**
 * Other VPNs found when the window OPENS (Mullvad, a manual wg link, ...), so the user
 * is told before choosing anything. Interface detection can false-positive (Tailscale
 * is a tun link too), so this only informs; the confirm at Pay stays the gate.
 */
export function useOtherVpns(): OtherVpn[] {
  const [found, setFound] = useState<OtherVpn[]>([])
  useEffect(() => {
    let cancelled = false
    window.api.connectionCheckVpn()
      .then((v) => { if (!cancelled) setFound(v) })
      .catch(() => { /* informational only */ })
    return () => { cancelled = true }
  }, [])
  return found
}

export function otherVpnCheck(vpns: OtherVpn[]): CheckSpec | null {
  if (vpns.length === 0) return null
  return {
    id: 'other-vpn',
    tone: 'warning',
    text: `Another VPN is active: ${vpns.map((v) => v.name).join(', ')}`,
    tipLabel: 'What another VPN does to this connection',
    tip: 'Found when this window opened. A WireGuard VPN is taken down when this connects; any other may fight it for the routing. You are asked again before paying.',
  }
}

/**
 * The confirm at Pay when another VPN is up: it replaces the Pay button, names each
 * VPN and what will happen to it, and continues only on a second, deliberate press.
 */
export function VpnConfirm({ vpns, onContinue, onCancel, disabled }: {
  vpns: OtherVpn[]
  onContinue: () => void
  onCancel: () => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2.5">
      <div className="bg-warning-subtle border border-warning p-3 rounded-md">
        <p className="text-warning text-sm font-medium mb-1.5">Another VPN is active</p>
        <ul className="text-text-secondary text-sm space-y-1">
          {vpns.map((v, i) => (
            <li key={i}>
              {v.name}{v.iface ? ` (${v.iface})` : ''}
              {v.type === 'wireguard'
                ? <span className="text-danger ml-2">(will be disconnected)</span>
                : <span className="text-warning ml-2">(may cause routing conflicts)</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2">
        <button onClick={onContinue} disabled={disabled} className="btn btn-primary flex-1 disabled:opacity-30 disabled:cursor-not-allowed">
          Continue anyway
        </button>
        <button onClick={onCancel} className="btn btn-secondary flex-1">Cancel</button>
      </div>
    </div>
  )
}

/**
 * How a node wraps its traffic, from the node list. V2Ray and XRAY publish it (and
 * v2rayEncryption reads Reality correctly); every other protocol this client runs
 * always encrypts, so its name is the answer.
 */
export function encryptionCheck(node: SentNode): CheckSpec {
  const meta = protocolMeta(node.type)
  const e = node.type === 2 || node.type === 4
    ? v2rayEncryption(node.connection)
    : { ok: true, text: `Encrypted: ${meta.label}`, detail: `${meta.label} always encrypts the tunnel to the node.` }
  return { id: 'encryption', tone: e.ok ? 'success' : 'warning', text: e.text, tipLabel: "About this node's encryption", tip: e.detail }
}

/** The active wallet's name, for a receipt's "paid by". null until read, or unreadable. */
export function useActiveWalletName(): string | null {
  const [name, setName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.walletList(), window.api.walletGetAddress()])
      .then(([list, addr]) => { if (!cancelled) setName(list.find((w) => w.address === addr)?.name ?? null) })
      .catch(() => { /* the receipt just doesn't name the wallet */ })
    return () => { cancelled = true }
  }, [])
  return name
}
