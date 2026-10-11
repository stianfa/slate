import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionSource
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { pickStatement, splitStatements } from '@shared/sql'
import type { SchemaInfo, TableInfo } from '@shared/types'
import { findPlaceholders } from '@shared/variables'
import { modKey } from '../api'
import { ghostText, type GhostSource } from './ghost'
import { editorHighlight, editorTheme } from './theme'

export type RunMode = 'smart' | 'all'

/** What Ctrl+Enter runs: the selection, else the statement under the cursor. */
export function runText(state: EditorState, mode: RunMode): { sql: string; offset: number } {
  const sel = state.selection.main
  if (mode === 'all') return { sql: state.doc.toString(), offset: 0 }
  if (!sel.empty) return { sql: state.sliceDoc(sel.from, sel.to), offset: sel.from }
  const statement = pickStatement(splitStatements(state.doc.toString()), sel.head)
  return statement ? { sql: statement.text, offset: statement.from } : { sql: '', offset: 0 }
}

// Marks the statement Ctrl+Enter would run when the script holds several.
const statementLine = Decoration.line({ class: 'cm-stmt-line' })
const statementHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const { state } = view
      if (state.doc.length > 200_000 || !state.selection.main.empty) return Decoration.none
      const statements = splitStatements(state.doc.toString())
      if (statements.length < 2) return Decoration.none
      const s = pickStatement(statements, state.selection.main.head)
      if (!s) return Decoration.none
      const builder = new RangeSetBuilder<Decoration>()
      const last = state.doc.lineAt(s.to).number
      for (let n = state.doc.lineAt(s.from).number; n <= last; n++) {
        const line = state.doc.line(n)
        builder.add(line.from, line.from, statementLine)
      }
      return builder.finish()
    }
  },
  { decorations: (v) => v.decorations }
)

// Colors :name and $1 placeholders so they read as variables, not SQL.
const variableMark = Decoration.mark({ class: 'cm-variable' })
const variableHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      const doc = view.state.doc
      if (doc.length > 500_000) return Decoration.none
      return Decoration.set(findPlaceholders(doc.toString()).map((p) => variableMark.range(p.from, p.to)))
    }
  },
  { decorations: (v) => v.decorations }
)

export const setErrorMark = StateEffect.define<number | null>()
const errorMark = Decoration.mark({ class: 'cm-sql-error' })
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setErrorMark)) continue
      if (effect.value === null) return Decoration.none
      const doc = tr.state.doc
      const from = Math.max(0, Math.min(effect.value, doc.length))
      const word = /^[\w$."]+/.exec(doc.sliceString(from, Math.min(doc.length, from + 200)))
      const to = Math.min(doc.length, from + (word ? word[0].length : 1))
      return to > from ? Decoration.set([errorMark.range(from, to)]) : Decoration.none
    }
    return tr.docChanged ? Decoration.none : deco
  },
  provide: (f) => EditorView.decorations.from(f)
})

export function completionSchema(info: SchemaInfo | undefined): SQLNamespace {
  if (!info) return {}
  const namespace: Record<string, Record<string, SQLNamespace>> = {}
  for (const t of info.tables) {
    namespace[t.schema] ??= {}
    namespace[t.schema][t.name] = {
      self: { label: t.name, type: t.kind === 'table' ? 'class' : 'interface', detail: t.kind === 'table' ? '' : t.kind },
      children: t.columns.map((c): Completion => ({ label: c.name, type: 'property', detail: c.type }))
    }
  }
  return namespace
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`
const TABLE_REF = new RegExp(String.raw`\b(?:from|join|update|into)\s+(${IDENT}(?:\s*\.\s*${IDENT})?)`, 'gi')
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s.toLowerCase())

/** Tables named after FROM/JOIN/UPDATE/INTO in a statement. */
function referencedTables(statement: string, info: SchemaInfo): TableInfo[] {
  const found = new Set<TableInfo>()
  for (const match of statement.matchAll(TABLE_REF)) {
    const parts = match[1].split(/\s*\.\s*/).map(unquote)
    const [schema, name] = parts.length === 2 ? parts : [null, parts[0]]
    const table =
      info.tables.find((t) => t.name === name && t.schema === (schema ?? 'public')) ??
      (schema ? undefined : info.tables.find((t) => t.name === name))
    if (table) found.add(table)
  }
  return [...found]
}

// The SQL language only completes columns after "table."; this offers the columns of the
// tables the current statement uses, so "where pl" suggests "plan".
function statementColumns(info: SchemaInfo | undefined): CompletionSource {
  return (context) => {
    if (!info) return null
    const word = context.matchBefore(/[\w$]+/)
    if (!word && !context.explicit) return null
    const from = word?.from ?? context.pos
    if (/[."]/.test(context.state.sliceDoc(from - 1, from))) return null
    const doc = context.state.doc.toString()
    const statement = pickStatement(splitStatements(doc), context.pos)
    const tables = referencedTables(statement ? doc.slice(statement.segmentFrom, statement.segmentTo) : doc, info)
    if (tables.length === 0) return null
    const options: Completion[] = tables.flatMap((t) =>
      t.columns.map((c) => ({
        label: c.name,
        type: 'property',
        detail: tables.length > 1 ? `${t.name} · ${c.type}` : c.type,
        boost: 1
      }))
    )
    return { from, options, validFor: /^[\w$]*$/ }
  }
}

export const schemaCompartment = new Compartment()

export function sqlLanguage(info: SchemaInfo | undefined): Extension {
  return [
    sql({ dialect: PostgreSQL, schema: completionSchema(info), defaultSchema: 'public', upperCaseKeywords: true }),
    PostgreSQL.language.data.of({ autocomplete: statementColumns(info) })
  ]
}

export function createExtensions(options: {
  schema: SchemaInfo | undefined
  ghost: GhostSource
  onRun(view: EditorView, mode: RunMode): boolean
  onChange(text: string): void
}): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ icons: true, filterStrict: true }),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorState.allowMultipleSelections.of(true),
    placeholder(`Write SQL here. ${modKey}+Enter runs the statement under the cursor.`),
    Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', run: (v) => options.onRun(v, 'smart') },
        { key: 'Shift-Mod-Enter', run: (v) => options.onRun(v, 'all') }
      ])
    ),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    editorTheme,
    editorHighlight,
    schemaCompartment.of(sqlLanguage(options.schema)),
    ghostText(options.ghost),
    statementHighlight,
    variableHighlight,
    errorField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) options.onChange(u.state.doc.toString())
    }),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' })
  ]
}
