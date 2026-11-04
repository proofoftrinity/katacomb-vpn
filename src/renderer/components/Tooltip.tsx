import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigation } from '../contexts/NavigationContext'
import { HELP_TOPICS, type TopicId } from '../utils/help-topics'

const GAP_PX = 6
const EDGE_PX = 8
const CLOSE_DELAY_MS = 150
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface Props {
  /** The reason behind the line on screen: one short paragraph. */
  content: ReactNode
  /** The Help topic that says it in full; adds "Learn more", which opens the Help panel. */
  topic?: TopicId
  /** The trigger. A function gets whether the panel is open and the id it describes the trigger with. */
  children: ReactNode | ((open: boolean, describedBy: string | undefined) => ReactNode)
  className?: string
}

/**
 * The app's own tooltip ([RN-15]): opens on hover and on keyboard focus, closes on
 * Escape, and can end with "Learn more", which opens the Help panel on a topic.
 *
 * The panel is drawn in a portal on `document.body` with fixed coordinates measured
 * from the trigger, so it can sit anywhere in a row, inside a scrolling window or a
 * virtualized table, and never be clipped: it opens below, flips above when there is
 * no room, and is clamped to the window. Native `title=` cannot do this job: it waits
 * about a second, is drawn by the OS, and never appears for a keyboard user.
 *
 * Because a portal sits at the end of the page, Tab from the trigger would skip the
 * panel, so Tab is steered: from the trigger into "Learn more", and from there on to
 * whatever follows the trigger (Shift+Tab goes back to it). React bubbles the panel's
 * events through the trigger's wrapper, which is where every handler lives.
 */
export default function Tooltip({ content, topic, children, className = '' }: Props) {
  const { openHelp } = useNavigation()
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const learnRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null)
  // A focus this component moved itself, which must not reopen the panel.
  const ignoreFocus = useRef(false)
  const id = useId()

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const hide = useCallback(() => {
    cancelClose()
    setOpen(false)
    setPos(null)
  }, [cancelClose])
  const show = () => { cancelClose(); setOpen(true) }
  // The delay bridges the gap between the trigger and the panel for a pointer moving across.
  const hideSoon = () => { cancelClose(); closeTimer.current = window.setTimeout(hide, CLOSE_DELAY_MS) }
  useEffect(() => cancelClose, [cancelClose])

  const place = useCallback(() => {
    const wrap = wrapRef.current
    const panel = panelRef.current
    if (!wrap || !panel) return
    const r = wrap.getBoundingClientRect()
    const w = panel.offsetWidth
    const h = panel.offsetHeight
    const left = Math.max(EDGE_PX, Math.min(r.right - w, window.innerWidth - w - EDGE_PX))
    const below = r.bottom + GAP_PX
    const top = below + h > window.innerHeight - EDGE_PX ? Math.max(EDGE_PX, r.top - h - GAP_PX) : below
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }))
  }, [])

  // Measured before paint on every render while open: the content can change under it.
  useLayoutEffect(() => { if (open) place() })
  useEffect(() => {
    if (!open) return
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  const trigger = () => wrapRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null
  const focusTrigger = () => {
    ignoreFocus.current = true
    trigger()?.focus({ preventScroll: true })
  }

  /** The first focusable element after the trigger, skipping the panel itself. */
  function focusAfterTrigger() {
    const wrap = wrapRef.current
    if (!wrap) return
    const next = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).find((el) =>
      !wrap.contains(el) && !panelRef.current?.contains(el) && el.offsetParent !== null &&
      (wrap.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    next?.focus()
  }

  function learnMore() {
    if (!topic) return
    // Focus goes back to the trigger first, so the Help panel returns there on Escape.
    focusTrigger()
    hide()
    openHelp(topic)
  }

  function onFocus(e: FocusEvent) {
    if (ignoreFocus.current) { ignoreFocus.current = false; return }
    const target = e.target as HTMLElement
    // A click focuses the trigger too; only a keyboard focus opens the panel, hover covers the pointer.
    if (panelRef.current?.contains(target) || target.matches(':focus-visible')) show()
  }

  function onBlur(e: FocusEvent) {
    const next = e.relatedTarget as Node | null
    if (next && (wrapRef.current?.contains(next) || panelRef.current?.contains(next))) return
    hide()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) return
    const inPanel = panelRef.current?.contains(document.activeElement) ?? false
    if (e.key === 'Escape') {
      // Only the panel closes, not the window under it.
      e.stopPropagation()
      hide()
      if (inPanel) focusTrigger()
      return
    }
    if (e.key !== 'Tab' || !learnRef.current) return
    if (!inPanel && !e.shiftKey) {
      e.preventDefault()
      learnRef.current.focus()
    } else if (inPanel) {
      e.preventDefault()
      if (e.shiftKey) focusTrigger()
      else { hide(); focusAfterTrigger() }
    }
  }

  return (
    <span
      ref={wrapRef}
      className={`inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      {typeof children === 'function' ? children(open, open ? id : undefined) : children}
      {open && createPortal(
        <div
          ref={panelRef}
          id={id}
          role="tooltip"
          onMouseEnter={cancelClose}
          onMouseLeave={hideSoon}
          // React carries a portal's clicks up its own tree: a press in the panel must not
          // reach what the trigger sits in (a node row, a checkbox's label).
          onClick={(e) => e.stopPropagation()}
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="fixed z-[70] w-64 bg-bg-tertiary border border-border rounded-md shadow-lg p-2.5 space-y-1.5 text-xs font-normal text-text-secondary text-left normal-case tracking-normal"
        >
          <div className="space-y-1.5">{content}</div>
          {topic && (
            <button
              ref={learnRef}
              type="button"
              onClick={learnMore}
              className="block text-left text-accent font-medium hover:underline focus:outline-hidden focus-visible:underline"
            >
              Learn more: {HELP_TOPICS[topic].title}
            </button>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}
