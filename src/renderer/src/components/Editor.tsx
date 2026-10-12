import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { targetKey } from '@shared/types'
import { api } from '../api'
import { createExtensions, runText, schemaCompartment, setErrorMark, sqlLanguage, type RunMode } from '../editor/setup'
import { formatSql } from '../editor/format'
import type { GhostSource } from '../editor/ghost'
import { activeTab, useStore, type Tab } from '../store'

// One EditorView is shared by all tabs; each tab keeps its own EditorState (and undo history).
const states = new Map<string, EditorState>()

export const editorBridge = {
  view: null as EditorView | null,
  run(mode: RunMode) {
    if (this.view) runFromView(this.view, mode)
  },
  format() {
    if (this.view) formatView(this.view)
  },
  focus() {
    this.view?.focus()
  },
  /** Replaces the whole query; Cmd+Z brings the old one back. */
  replace(text: string) {
    const view = this.view
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } })
    view.focus()
  },
  insert(text: string) {
    const view = this.view
    if (!view) return
    view.dispatch(view.state.replaceSelection(text))
    view.focus()
  }
}

function runFromView(view: EditorView, mode: RunMode): boolean {
  const state = useStore.getState()
  const tab = activeTab(state)
  if (!tab) return true
  if (!tab.target) {
    state.setDialog(state.connections.length ? null : { type: 'connection' })
    return true
  }
  const { sql, offset } = runText(view.state, mode)
  view.dispatch({ effects: setErrorMark.of(null) })
  void state.run(tab.id, sql, offset)
  return true
}

/** Formats the selection, or the whole script when nothing is selected. */
function formatView(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  const from = sel.empty ? 0 : sel.from
  const to = sel.empty ? state.doc.length : sel.to
  const source = state.sliceDoc(from, to)
  if (!source.trim()) return true
  let formatted: string
  try {
    formatted = formatSql(source)
  } catch (e) {
    useStore.getState().showToast(`Couldn't format: ${(e as Error).message.split('\n')[0]}`, 'error')
    return true
  }
  if (sel.empty && state.doc.toString().endsWith('\n')) formatted += '\n'
  if (formatted === source) return true
  view.dispatch({
    changes: { from, to, insert: formatted },
    selection: sel.empty
      ? { anchor: Math.min(sel.head, from + formatted.length) }
      : { anchor: from, head: from + formatted.length },
    userEvent: 'input.format',
    scrollIntoView: true
  })
  return true
}

let latestRequest = ''
const ghostSource: GhostSource = {
  enabled() {
    const s = useStore.getState()
    return Boolean(s.settings?.aiEnabled && s.settings.aiReady && activeTab(s)?.target)
  },
  async fetch(prefix, suffix, signal) {
    const tab = activeTab(useStore.getState())
    if (!tab?.target) return null
    const requestId = Math.random().toString(36).slice(2)
    latestRequest = requestId
    const setAi = useStore.getState().setAi
    signal.addEventListener('abort', () => {
      void api.cancelCompletion(requestId)
      if (latestRequest === requestId) setAi({ status: 'idle' })
    })
    setAi({ status: 'thinking' })
    try {
      const text = await api.complete({ requestId, target: tab.target, prefix, suffix })
      if (latestRequest === requestId) setAi({ status: 'idle' })
      return text
    } catch (e) {
      if (latestRequest === requestId) setAi({ status: 'error', error: (e as Error).message })
      return null
    }
  }
}

function createState(tab: Tab): EditorState {
  const schema = tab.target ? useStore.getState().schemas[targetKey(tab.target)]?.data : undefined
  return EditorState.create({
    doc: tab.sql,
    extensions: createExtensions({
      schema,
      ghost: ghostSource,
      onRun: runFromView,
      onFormat: formatView,
      onChange: (text) => {
        const current = useStore.getState().activeTabId
        if (current) useStore.getState().updateTab(current, { sql: text })
      }
    })
  })
}

export function Editor({ tab }: { tab: Tab }) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const tabIdRef = useRef(tab.id)
  const schema = useStore((s) => (tab.target ? s.schemas[targetKey(tab.target)]?.data : undefined))

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: states.get(tab.id) ?? createState(tab) })
    viewRef.current = view
    editorBridge.view = view
    view.focus()
    return () => {
      states.set(tabIdRef.current, view.state)
      view.destroy()
      if (editorBridge.view === view) editorBridge.view = null
    }
    // The view is created once; tab switches swap its state below.
  }, [])

  // Swap editor state when the active tab changes.
  useEffect(() => {
    const view = viewRef.current
    if (!view || tabIdRef.current === tab.id) return
    states.set(tabIdRef.current, view.state)
    tabIdRef.current = tab.id
    view.setState(states.get(tab.id) ?? createState(tab))
    // Forget states of closed tabs.
    const open = new Set(useStore.getState().tabs.map((t) => t.id))
    for (const id of states.keys()) if (!open.has(id)) states.delete(id)
    view.focus()
  }, [tab.id])

  // Keep completions in sync with the tab's database.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: schemaCompartment.reconfigure(sqlLanguage(schema)) })
  }, [schema, tab.id])

  // SQL replaced from outside the editor (e.g. opening a table into this tab).
  useEffect(() => {
    const view = viewRef.current
    if (!view || tabIdRef.current !== tab.id) return
    const current = view.state.doc.toString()
    if (current !== tab.sql) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: tab.sql }, selection: { anchor: tab.sql.length } })
    }
  }, [tab.sql, tab.id])

  // Underline the error position reported by Postgres.
  useEffect(() => {
    const view = viewRef.current
    const position = tab.response?.error?.position
    if (!view || position === undefined || tab.runOffset === undefined) return
    view.dispatch({ effects: setErrorMark.of(tab.runOffset + position) })
  }, [tab.response, tab.runOffset])

  return <div className="editor-host" ref={host} />
}
