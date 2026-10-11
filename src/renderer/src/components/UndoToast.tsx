import { useEffect, useState } from 'react'
import { displayTitle, useStore } from '../store'

const SHOW_MS = 6000

/** "Deleted … · Undo" after removing an entry from the history. */
export function UndoToast() {
  const lastDeleted = useStore((s) => s.lastDeleted)
  const restoreDeleted = useStore((s) => s.restoreDeleted)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!lastDeleted) return setVisible(false)
    setVisible(true)
    const id = setTimeout(() => setVisible(false), SHOW_MS)
    return () => clearTimeout(id)
  }, [lastDeleted])

  if (!visible || !lastDeleted) return null
  return (
    <div className="toast" role="status">
      <span className="toast-text">Deleted “{displayTitle(lastDeleted.tab)}”</span>
      <button className="toast-action" onClick={restoreDeleted}>
        Undo
      </button>
    </div>
  )
}

/** Short-lived messages from showToast(). */
export function Toast() {
  const toast = useStore((s) => s.toast)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!toast) return
    setVisible(true)
    const id = setTimeout(() => setVisible(false), 4000)
    return () => clearTimeout(id)
  }, [toast])
  if (!visible || !toast) return null
  return (
    <div className={`toast${toast.tone === 'error' ? ' error' : ''}`} role="status">
      <span className="toast-text">{toast.text}</span>
    </div>
  )
}

/** Shown while the workspace can't be written to disk, so history loss is never silent. */
export function SaveErrorToast() {
  const saveError = useStore((s) => s.saveError)
  if (!saveError) return null
  return (
    <div className="toast error" role="alert">
      <span className="toast-text">Couldn&rsquo;t save your history: {saveError}</span>
    </div>
  )
}
