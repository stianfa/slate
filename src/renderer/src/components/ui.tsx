import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520,
  className = ''
}: {
  title: string
  onClose(): void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${className}`} style={{ width }} role="dialog" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** A button that opens a floating panel; closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = 'left',
  className = ''
}: {
  trigger(open: boolean, toggle: () => void): ReactNode
  children(close: () => void): ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="popover-root" ref={root}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className={`popover ${align} ${className}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

/** A labelled form row. Use group for rows of buttons, where a <label> would press the first one on click. */
export function Field({ label, children, hint, group = false }: { label: string; children: ReactNode; hint?: ReactNode; group?: boolean }) {
  const content = (
    <>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </>
  )
  return group ? (
    <div className="field" role="group" aria-label={label}>
      {content}
    </div>
  ) : (
    <label className="field">{content}</label>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="slate-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8aa4ff" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#slate-logo)" />
      <rect x="8" y="9" width="16" height="3.2" rx="1.6" fill="#fff" opacity="0.95" />
      <rect x="8" y="14.4" width="11" height="3.2" rx="1.6" fill="#fff" opacity="0.75" />
      <rect x="8" y="19.8" width="14" height="3.2" rx="1.6" fill="#fff" opacity="0.55" />
    </svg>
  )
}
