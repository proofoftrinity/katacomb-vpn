import type { ReactNode } from 'react'
import { useNavigation } from '../contexts/NavigationContext'
import type { TopicId } from '../utils/help-topics'
import Tooltip from './Tooltip'

interface Props {
  /** What the label describes, for screen readers: "why", "more about DNS", … */
  label: string
  /** The Help topic that says it in full: "Learn more" in the panel, and a click on the "?". */
  topic?: TopicId
  children: ReactNode
}

/**
 * A "?" that reveals one paragraph of explanation on hover or keyboard focus ([RN-15]).
 *
 * Exists so a screen can keep every consequence on screen as one short line while the
 * reasoning behind it stays one hover away. Native `title=` is wrong for that job: it
 * waits ~1s, is drawn by the OS in its own palette, and never appears for a keyboard
 * user. The panel is a `Tooltip`, so the "?" can sit anywhere in a row.
 *
 * With a `topic`, the panel ends with "Learn more" and a click on the "?" opens the
 * Help panel on that topic. Without one, a click does nothing: hover and focus
 * already cover both input methods.
 */
export default function InfoTip({ label, topic, children }: Props) {
  const { openHelp } = useNavigation()
  return (
    <Tooltip content={children} topic={topic} className="relative shrink-0 align-middle">
      {(open, describedBy) => (
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-describedby={describedBy}
          onClick={(e) => {
            e.preventDefault()
            if (topic) openHelp(topic)
          }}
          className={`w-3.5 h-3.5 rounded-full border text-[9px] leading-none flex items-center justify-center transition-colors focus:outline-hidden focus:border-border-focus focus:text-accent ${
            open ? 'border-accent text-accent' : 'border-current text-text-tertiary'
          } ${topic ? 'cursor-pointer' : 'cursor-help'}`}
        >
          ?
        </button>
      )}
    </Tooltip>
  )
}
