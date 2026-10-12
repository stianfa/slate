// Inline AI suggestions ("ghost text"): after a pause in typing, ask the model what
// comes next at the cursor and show it greyed out. Tab accepts, Esc dismisses,
// Ctrl/Cmd+Right accepts one word, Alt+\ asks right away.
import { completionStatus } from '@codemirror/autocomplete'
import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type ViewUpdate } from '@codemirror/view'

export interface GhostSource {
  enabled(): boolean
  fetch(prefix: string, suffix: string, signal: AbortSignal): Promise<string | null>
}

interface Suggestion {
  text: string
  pos: number
}

const DEBOUNCE_MS = 450
const ACCEPT_EVENT = 'input.ghost'

const setGhost = StateEffect.define<Suggestion | null>()

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostWidget) {
    return other.text === this.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ghost'
    span.textContent = this.text
    return span
  }
}

const ghostField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value
    if (!value) return null
    if (tr.docChanged) {
      // Typing the suggestion's own next characters keeps the rest of it on screen.
      let next: Suggestion | null = null
      let count = 0
      tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
        count++
        const text = inserted.toString()
        if (fromA === value.pos && toA === fromA && text && text.length < value.text.length && value.text.startsWith(text)) {
          next = { text: value.text.slice(text.length), pos: toB }
        }
      })
      return count === 1 ? next : null
    }
    if (tr.selection && tr.state.selection.main.head !== value.pos) return null
    return value
  },
  provide: (field) =>
    EditorView.decorations.from(field, (s) =>
      s ? Decoration.set([Decoration.widget({ widget: new GhostWidget(s.text), side: 1 }).range(s.pos)]) : Decoration.none
    )
})

function accept(view: EditorView, text: string, pos: number) {
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: ACCEPT_EVENT,
    scrollIntoView: true
  })
}

function acceptAll(view: EditorView): boolean {
  const s = view.state.field(ghostField, false)
  if (!s) return false
  accept(view, s.text, s.pos)
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

function acceptWord(view: EditorView): boolean {
  const s = view.state.field(ghostField, false)
  if (!s) return false
  const part = /^(\s*[\w$]+|\s*[^\w\s]+|\s+)/.exec(s.text)?.[0] ?? s.text
  accept(view, part, s.pos)
  return true
}

function dismiss(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

/** Suggestions only make sense at the end of a line (closing brackets and quotes after the cursor are fine). */
function cursorContext(state: EditorState): { prefix: string; suffix: string; pos: number } | null {
  const sel = state.selection.main
  if (!sel.empty) return null
  const pos = sel.head
  const line = state.doc.lineAt(pos)
  if (!/^[\s)\]'";,]*$/.test(line.text.slice(pos - line.from))) return null
  const prefix = state.doc.sliceString(0, pos)
  if (!prefix.trim()) return null
  return { prefix, suffix: state.doc.sliceString(pos), pos }
}

export function ghostText(source: GhostSource): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined
      controller: AbortController | null = null

      constructor(readonly view: EditorView) {}

      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet) return
        this.abort()
        if (u.state.field(ghostField, false)) return
        const typed = u.transactions.some(
          (tr) => tr.isUserEvent('input') && !tr.isUserEvent('input.paste') && !tr.isUserEvent(ACCEPT_EVENT)
        )
        if (typed) this.timer = setTimeout(() => void this.request(false), DEBOUNCE_MS)
      }

      abort() {
        clearTimeout(this.timer)
        this.controller?.abort()
        this.controller = null
      }

      async request(manual: boolean) {
        const { state } = this.view
        if (!source.enabled()) return
        if (!manual && completionStatus(state) === 'active') return
        const context = cursorContext(state)
        if (!context) return
        const controller = new AbortController()
        this.controller = controller
        try {
          const text = await source.fetch(context.prefix, context.suffix, controller.signal)
          if (controller.signal.aborted || !text) return
          const now = this.view.state
          if (now.doc !== state.doc || now.selection.main.head !== context.pos) return
          this.view.dispatch({ effects: setGhost.of({ text, pos: context.pos }) })
        } finally {
          if (this.controller === controller) this.controller = null
        }
      }

      destroy() {
        this.abort()
      }
    }
  )

  const trigger = (view: EditorView) => {
    const instance = view.plugin(plugin)
    if (!instance) return false
    instance.abort()
    void instance.request(true)
    return true
  }

  return [
    ghostField,
    plugin,
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: acceptAll },
        { key: 'Escape', run: dismiss },
        { key: 'Mod-ArrowRight', run: acceptWord },
        // Alt+\, matched by physical key like Shift+Alt+F in setup.ts: Option combinations type
        // characters on macOS (« on a US layout), so CodeMirror won't match them by name there.
        { any: (v, e) => e.code === 'Backslash' && e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && trigger(v) }
      ])
    )
  ]
}
