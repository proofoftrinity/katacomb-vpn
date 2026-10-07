import type { ProviderDetailsInput } from '../../types'
import { PROVIDER_LIMITS, byteLength } from '../../../shared/provider-details'
import { isTestPlan } from '../../../shared/test-plan'
import { Note } from '../ConnectReview'
import { CheckIcon } from '../Icons'

/**
 * The four editable fields of a provider record, shared by registration and by
 * editing an existing provider.
 *
 * They are one component rather than two copies because the chain treats them as
 * one message: MsgRegisterProvider and MsgUpdateProviderDetails carry the exact
 * same four strings under the same limits, so a label or a cap that drifted
 * between the two screens would be a bug either way.
 *
 * Under the name, the catalog's test-account guess as you type: it is this app's
 * reading of the NAME, and this form is the only place to change it. `savedName` is
 * the name on chain when editing, so the line can also say when a rename clears it.
 */
export default function ProviderDetailsFields({ details, onChange, disabled, savedName }: {
  details: ProviderDetailsInput
  onChange: (next: ProviderDetailsInput) => void
  disabled?: boolean
  savedName?: string
}) {
  const set = (key: keyof ProviderDetailsInput) => (value: string) => onChange({ ...details, [key]: value })
  const name = details.name.trim()
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Field label="Name" value={details.name} onChange={set('name')} disabled={disabled}
          cap={PROVIDER_LIMITS.name} placeholder="Shown next to your plans" />
        {isTestPlan(name) ? (
          <Note>
            &quot;{name}&quot; reads as a test account, so this app&apos;s plan catalog files your plans
            under Test plans, which are hidden by default.
          </Note>
        ) : savedName !== undefined && isTestPlan(savedName) && name !== '' && (
          <p className="flex items-start gap-2 text-xs text-success bg-success-subtle rounded-md px-2.5 py-2">
            <CheckIcon className="w-3.5 h-3.5 mt-px shrink-0" />
            <span>This name does not read as a test account, so once it is saved your plans leave Test plans.</span>
          </p>
        )}
      </div>
      <Field label="Website" value={details.website} onChange={set('website')} disabled={disabled}
        cap={PROVIDER_LIMITS.website} placeholder="https://…" />
      <Field label="Identity" value={details.identity} onChange={set('identity')} disabled={disabled}
        cap={PROVIDER_LIMITS.identity} placeholder="Keybase identity (optional)" />
      {/* Three lines, because it holds 256 bytes and one line showed a fraction of
          that. No line breaks: the catalog prints it as one paragraph, so a break
          typed here would vanish there. */}
      <Field label="Description" value={details.description} onChange={(v) => set('description')(v.replace(/\r?\n/g, ' '))}
        disabled={disabled} cap={PROVIDER_LIMITS.description} placeholder="Optional" rows={3} />
    </div>
  )
}

/**
 * One labelled text input with a byte counter.
 *
 * The counter measures BYTES, not characters, because that is what the chain
 * caps: a name of 40 accented characters can be over the 64-byte limit while
 * looking well short of it, and the only other place that would surface is a
 * rejected transaction.
 */
function Field({ label, value, placeholder, cap, disabled, onChange, rows }: {
  label: string
  value: string
  placeholder?: string
  cap: number
  disabled?: boolean
  onChange: (v: string) => void
  /** A text area of this many lines instead of a one-line input. */
  rows?: number
}) {
  const used = byteLength(value)
  const over = used > cap
  const className = `mt-1 w-full bg-bg-tertiary border text-text-primary text-sm px-3 py-2 rounded-sm focus:outline-none disabled:opacity-40 ${
    over ? 'border-danger' : 'border-border focus:border-border-focus'
  }`
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-text-secondary text-xs font-medium uppercase tracking-wide">{label}</span>
        {(used > cap * 0.75 || over) && (
          <span className={`text-[10px] font-mono ${over ? 'text-danger' : 'text-text-tertiary'}`}>
            {used}/{cap}
          </span>
        )}
      </span>
      {rows ? (
        <textarea
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className={`${className} resize-none leading-snug`}
        />
      ) : (
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={className}
        />
      )}
    </label>
  )
}
