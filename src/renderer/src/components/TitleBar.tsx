import { useState } from 'react'
import { PanelLeft, Plus } from 'lucide-react'
import { isMac, modKey } from '../api'
import { activeTab, displayTitle, useStore } from '../store'
import { EnvBadge, useEnvironment } from './environment'
import { Logo } from './ui'

export function TitleBar() {
  const tab = useStore(activeTab)
  const historyOpen = useStore((s) => s.historyOpen)
  const setLayout = useStore((s) => s.setLayout)
  const newTab = useStore((s) => s.newTab)
  const renameTab = useStore((s) => s.renameTab)
  const environment = useEnvironment(tab?.target)
  const [editing, setEditing] = useState(false)

  return (
    <header className={`titlebar${isMac ? ' mac' : ''}`}>
      <div className="brand">
        <Logo size={18} />
        <span>Slate</span>
      </div>
      <button
        className={`titlebar-btn${historyOpen ? ' active' : ''}`}
        onClick={() => setLayout({ historyOpen: !historyOpen })}
        title={historyOpen ? 'Hide history' : 'Show history'}
        aria-label="Toggle history"
      >
        <PanelLeft size={15} />
      </button>
      <button className="titlebar-btn" onClick={() => newTab()} title={`New query (${modKey}+T)`} aria-label="New query">
        <Plus size={15} />
      </button>
      {tab && (
        <div className="titlebar-current" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {editing ? (
            <input
              className="history-rename"
              defaultValue={tab.title || displayTitle(tab)}
              autoFocus
              onFocus={(e) => e.target.select()}
              onBlur={(e) => {
                renameTab(tab.id, e.target.value)
                setEditing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setEditing(false)
              }}
              aria-label="Name"
            />
          ) : (
            <span className="titlebar-title">{displayTitle(tab)}</span>
          )}
          {environment && <EnvBadge env={environment} />}
        </div>
      )}
    </header>
  )
}
