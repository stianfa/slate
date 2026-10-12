import { Fragment, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { ArrowUp, Check, Copy, CornerDownLeft, MessageSquare, Replace, Square, Trash2, X } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { api, modKey } from '../api'
import { useStore, type Tab } from '../store'
import { editorBridge } from './Editor'
import { Spinner } from './ui'

type Segment = { kind: 'text' | 'sql'; content: string }

/** Splits an answer into prose and ```sql blocks. A block still streaming in has no closing fence yet. */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  const fence = /```[a-zA-Z]*\n?([\s\S]*?)(?:```|$)/g
  let last = 0
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', content: text.slice(last, m.index) })
    out.push({ kind: 'sql', content: m[1].replace(/\s+$/, '') })
    last = fence.lastIndex
  }
  if (last < text.length) out.push({ kind: 'text', content: text.slice(last) })
  return out.filter((s) => s.content.trim())
}

/** Paragraphs with `inline code`; the model is asked for plain prose around the query. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text
        .trim()
        .split(/\n{2,}/)
        .map((paragraph, i) => (
          <p key={i}>
            {paragraph.split(/(`[^`\n]+`)/).map((part, j) =>
              part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code key={j}>{part.slice(1, -1)}</code> : <Fragment key={j}>{part}</Fragment>
            )}
          </p>
        ))}
    </>
  )
}

function SqlBlock({ sql, done }: { sql: string; done: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="chat-sql-block">
      <pre className="chat-sql">{sql}</pre>
      {done && (
        <div className="chat-sql-actions">
          <button className="ghost-btn" onClick={() => editorBridge.replace(sql)} title="Replace the query in the editor (Cmd+Z undoes it)">
            <Replace size={12} /> Replace query
          </button>
          <button className="ghost-btn" onClick={() => editorBridge.insert(sql)} title="Insert at the cursor">
            <CornerDownLeft size={12} /> Insert
          </button>
          <button
            className="ghost-btn"
            onClick={() => {
              void api.copyText(sql)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} Copy
          </button>
        </div>
      )}
    </div>
  )
}

function Answer({ text, done }: { text: string; done: boolean }) {
  const parts = segments(text)
  return (
    <div className="chat-msg assistant">
      {parts.map((s, i) => (s.kind === 'sql' ? <SqlBlock key={i} sql={s.content} done={done} /> : <Prose key={i} text={s.content} />))}
      {!done && <span className="chat-caret" />}
    </div>
  )
}

function Message({ message }: { message: ChatMessage }) {
  return message.role === 'user' ? <div className="chat-msg user">{message.text}</div> : <Answer text={message.text} done />
}

/** Chat with the AI about the active query: it writes SQL from the schema, the editor text and the last error. */
export function ChatPanel({ tab }: { tab: Tab }) {
  const width = useStore((s) => s.chatWidth)
  const setLayout = useStore((s) => s.setLayout)
  const aiReady = useStore((s) => Boolean(s.settings?.aiReady))
  const setDialog = useStore((s) => s.setDialog)
  const sendChat = useStore((s) => s.sendChat)
  const stopChat = useStore((s) => s.stopChat)
  const clearChat = useStore((s) => s.clearChat)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const messages = tab.chat ?? []
  const pending = tab.chatPending

  useEffect(() => input.current?.focus(), [tab.id])
  // Follow the answer as it streams in.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [messages.length, pending?.text, tab.chatError])

  const send = () => {
    if (!draft.trim() || pending) return
    void sendChat(tab.id, draft)
    setDraft('')
  }

  const startResize = (e: PointerEvent) => {
    e.preventDefault()
    const move = (ev: globalThis.PointerEvent) => setLayout({ chatWidth: Math.min(720, Math.max(300, window.innerWidth - ev.clientX)) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-col')
    }
    document.body.classList.add('resizing-col')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  let notice: ReactNode = null
  if (!aiReady) {
    notice = (
      <div className="chat-notice">
        AI isn&rsquo;t set up yet.{' '}
        <button className="link-btn" onClick={() => setDialog({ type: 'settings' })}>
          Open Settings
        </button>
      </div>
    )
  } else if (!tab.target) {
    notice = <div className="chat-notice">Pick a database for this query first.</div>
  }

  return (
    <aside className="chat-panel" style={{ width }} aria-label="AI chat">
      <div className="chat-resize" onPointerDown={startResize} />
      <div className="chat-head">
        <MessageSquare size={14} />
        <span className="chat-title">Ask AI</span>
        {tab.target && <span className="muted small chat-db">{tab.target.database}</span>}
        <div className="grow" />
        {messages.length > 0 && (
          <button className="icon-btn" onClick={() => clearChat(tab.id)} title="Start over" aria-label="Clear chat">
            <Trash2 size={13} />
          </button>
        )}
        <button className="icon-btn" onClick={() => setLayout({ chatOpen: false })} title={`Close (${modKey}+J)`} aria-label="Close chat">
          <X size={14} />
        </button>
      </div>
      <div className="chat-list" ref={list}>
        {messages.length === 0 && !pending && (
          <div className="chat-empty muted small">
            <p>Describe the query you want, like &ldquo;orders per customer in the last 30 days&rdquo;, or ask to change the one in the editor.</p>
            <p>The AI sees this database&rsquo;s schema, the query in the editor and its last error. It never sees rows and doesn&rsquo;t run anything.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
        {pending &&
          (pending.text ? (
            <Answer text={pending.text} done={false} />
          ) : (
            <div className="chat-msg assistant thinking">
              <Spinner size={12} /> Thinking…
            </div>
          ))}
        {tab.chatError && <div className="chat-error">{tab.chatError}</div>}
      </div>
      {notice}
      <div className="chat-input">
        <textarea
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={messages.length ? 'Ask for a change…' : 'Describe the query you want…'}
          rows={3}
          disabled={!aiReady || !tab.target}
          aria-label="Message"
        />
        {pending ? (
          <button className="chat-send" onClick={() => stopChat(tab.id)} title="Stop" aria-label="Stop">
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="chat-send" onClick={send} disabled={!draft.trim() || !aiReady || !tab.target} title="Send (Enter)" aria-label="Send">
            <ArrowUp size={14} />
          </button>
        )}
      </div>
    </aside>
  )
}
