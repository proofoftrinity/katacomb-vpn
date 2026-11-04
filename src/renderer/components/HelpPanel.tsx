import { useEffect, useRef } from 'react'
import { useNavigation } from '../contexts/NavigationContext'
import { HELP_GROUPS, HELP_TOPICS } from '../utils/help-topics'
import { ChevronIcon, CloseIcon } from './Icons'

/**
 * The class a window's overlay takes while the Help panel is open, so the window moves
 * left instead of being covered: the panel is 360px wide, and at the 960px window
 * minimum a centred window would sit half under it. Spelled out in full for Tailwind.
 */
export function useHelpAside(): string {
  return useNavigation().helpTopic !== null ? 'pr-[360px]' : ''
}

/**
 * The Help panel ([RN-15]): a drawer on the right that holds, once, the explanations
 * the screens keep to one line. A "?" opens it on a topic ("Learn more"), the header's
 * Help button on the index. It sits above every window (z-60 against their z-50) and
 * leaves them usable: a window's overlay pads right while it is open (useHelpAside).
 *
 * Escape is caught in the capture phase and stopped there, so it closes the panel and
 * not the window under it, and focus goes back to where it was when the panel opened.
 */
export default function HelpPanel() {
  const { helpTopic, openHelp, closeHelp } = useNavigation()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const open = helpTopic !== null

  useEffect(() => {
    if (!open) return
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])

  // Every view starts at its heading, so a keyboard user lands on what they opened.
  useEffect(() => {
    if (helpTopic !== null) headingRef.current?.focus({ preventScroll: true })
  }, [helpTopic])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeHelp()
      if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, closeHelp])

  if (helpTopic === null) return null
  const topicId = helpTopic === 'index' ? null : helpTopic
  const topic = topicId ? HELP_TOPICS[topicId] : null
  const group = topicId ? HELP_GROUPS.find((g) => g.topics.includes(topicId))?.title : null

  return (
    <aside
      aria-label="Help"
      className="fixed top-0 right-0 bottom-0 w-[360px] z-[60] bg-bg-secondary border-l border-border shadow-overlay flex flex-col"
    >
      <div className="flex items-center justify-between gap-3 pl-5 pr-3 py-3 border-b border-border shrink-0">
        <h2
          ref={topic ? undefined : headingRef}
          tabIndex={-1}
          className="text-text-primary text-base font-semibold focus:outline-hidden"
        >
          Help
        </h2>
        <button
          type="button"
          onClick={closeHelp}
          aria-label="Close help"
          className="w-7 h-7 shrink-0 grid place-items-center rounded-sm text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-4 pb-6 space-y-3">
        {topic ? (
          <>
            <button
              type="button"
              onClick={() => openHelp('index')}
              className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-accent transition-colors"
            >
              <ChevronIcon direction="down" className="w-3.5 h-3.5 rotate-90" />
              All topics
            </button>
            {group && <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{group}</p>}
            <h3 ref={headingRef} tabIndex={-1} className="text-text-primary text-lg font-semibold focus:outline-hidden">
              {topic.title}
            </h3>
            {topic.body.map((p) => (
              <p key={p} className="text-sm text-text-secondary leading-relaxed">{p}</p>
            ))}
            {topic.related.length > 0 && (
              <div className="pt-2 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Related</p>
                <div className="flex flex-wrap gap-1.5">
                  {topic.related.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => openHelp(r)}
                      className="rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-accent hover:border-accent transition-colors"
                    >
                      {HELP_TOPICS[r].title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          HELP_GROUPS.map((g) => (
            <section key={g.title} className="space-y-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">{g.title}</h3>
              <ul>
                {g.topics.map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => openHelp(id)}
                      className="w-[calc(100%+1rem)] flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 -mx-2 text-left text-sm text-text-primary hover:bg-bg-tertiary transition-colors"
                    >
                      {HELP_TOPICS[id].title}
                      <ChevronIcon direction="down" className="w-3.5 h-3.5 -rotate-90 text-text-tertiary shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  )
}
