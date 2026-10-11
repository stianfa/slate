import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Colors come from CSS variables so the editor follows the app's light/dark theme.
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    color: 'var(--text)',
    backgroundColor: 'transparent'
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.65',
    overflow: 'auto'
  },
  '.cm-content': { padding: '12px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 16px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-faint)',
    border: 'none',
    paddingLeft: '8px'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '28px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    color: 'inherit',
    outline: 'none'
  },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-match-strong)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow)',
    overflow: 'hidden'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '12.5px',
    maxHeight: '18em',
    padding: '4px'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '3px 8px',
    borderRadius: '5px',
    lineHeight: '1.5'
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text)'
  },
  '.cm-completionDetail': { color: 'var(--text-faint)', fontStyle: 'normal', marginLeft: '12px' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent)', fontWeight: '600' },
  // Letter badges instead of the default emoji-like glyphs.
  '.cm-completionIcon': {
    opacity: '1',
    width: '1.1em',
    paddingRight: '0.7em',
    fontFamily: 'var(--font-mono)',
    fontSize: '10.5px',
    fontWeight: '700',
    textAlign: 'center'
  },
  '.cm-completionIcon:after': { content: "'·'", color: 'var(--text-faint)' },
  '.cm-completionIcon-keyword:after': { content: "'K'", color: 'var(--syn-keyword)', opacity: '0.75' },
  '.cm-completionIcon-property:after': { content: "'C'", color: 'var(--accent)' },
  '.cm-completionIcon-class:after': { content: "'T'", color: 'var(--green)' },
  '.cm-completionIcon-interface:after': { content: "'V'", color: 'var(--green)' },
  '.cm-completionIcon-type:after': { content: "'#'", color: 'var(--syn-type)' },
  '.cm-completionIcon-function:after, .cm-completionIcon-method:after': { content: "'ƒ'", color: 'var(--syn-function)' },
  '.cm-completionIcon-namespace:after': { content: "'S'", color: 'var(--text-muted)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elevated)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font-ui)', fontSize: '12px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-input)',
    color: 'var(--text)',
    padding: '3px 8px'
  },
  '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--text-muted)' },
  '.cm-ghost': { color: 'var(--ghost)', fontStyle: 'normal', whiteSpace: 'pre' },
  '.cm-sql-error': {
    textDecoration: 'underline wavy var(--red)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px'
  },
  '.cm-stmt-line': { boxShadow: 'inset 2px 0 0 var(--statement-bar)' },
  '.cm-variable, .cm-variable span': { color: 'var(--syn-variable) !important' },
  '.cm-variable': { backgroundColor: 'var(--syn-variable-bg)', borderRadius: '3px' }
})

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.name)], color: 'var(--syn-function)' },
  { tag: [t.operator, t.punctuation, t.paren, t.bracket, t.separator], color: 'var(--syn-punct)' },
  { tag: t.special(t.name), color: 'var(--syn-quoted)' },
  { tag: t.variableName, color: 'var(--text)' }
])

export const editorHighlight = syntaxHighlighting(highlight)
