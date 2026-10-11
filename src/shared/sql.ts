// Splits a SQL script into statements the way psql does: semicolons end a
// statement unless they sit inside a string, quoted identifier, dollar-quoted
// body or comment. Offsets point into the original text so error positions and
// editor highlights line up.

export interface Statement {
  /** Statement text without leading comments/whitespace or the trailing semicolon. */
  text: string
  /** Offset of the first code character. */
  from: number
  /** Offset just past the last code character. */
  to: number
  /** The span this statement owns in the script, from the previous separator to its own (inclusive). */
  segmentFrom: number
  segmentTo: number
}

const isIdentStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c)
export const isIdentChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c)

export type TokenKind = 'code' | 'string' | 'quoted' | 'dollar' | 'comment' | 'semicolon'

export interface Token {
  kind: TokenKind
  from: number
  to: number
}

/** Coarse lexer: strings, quoted identifiers, dollar-quoted bodies, comments, semicolons, and runs of everything else. */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  const n = sql.length
  let codeStart = -1
  let i = 0

  const push = (kind: TokenKind, from: number, to: number) => {
    if (codeStart >= 0) tokens.push({ kind: 'code', from: codeStart, to: from })
    codeStart = -1
    tokens.push({ kind, from, to: Math.min(to, n) })
  }

  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    const start = i

    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol < 0 ? n : eol
      push('comment', start, i)
      continue
    }

    if (c === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      push('comment', start, i)
      continue
    }

    if (c === "'") {
      const prev = sql[i - 1]
      const escapes = (prev === 'E' || prev === 'e') && !isIdentChar(sql[i - 2] ?? ' ')
      i++
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2
        else if (sql[i] === "'") {
          i++
          break
        } else i++
      }
      push('string', start, i)
      continue
    }

    if (c === '"') {
      i++
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2
        else if (sql[i] === '"') {
          i++
          break
        } else i++
      }
      push('quoted', start, i)
      continue
    }

    if (c === '$' && !isIdentChar(sql[i - 1] ?? ' ')) {
      // $tag$ ... $tag$ (tag may be empty); $1 parameters are not tags.
      let j = i + 1
      if (j < n && isIdentStart(sql[j])) {
        while (j < n && isIdentChar(sql[j]) && sql[j] !== '$') j++
      }
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1)
        const close = sql.indexOf(tag, j + 1)
        i = close < 0 ? n : close + tag.length
        push('dollar', start, i)
        continue
      }
    }

    if (c === ';') {
      i++
      push('semicolon', start, i)
      continue
    }

    if (codeStart < 0) codeStart = i
    i++
  }

  if (codeStart >= 0) tokens.push({ kind: 'code', from: codeStart, to: n })
  return tokens
}

export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  let segmentFrom = 0
  let first = -1
  let lastEnd = -1

  const finish = (segmentTo: number) => {
    if (first >= 0) {
      out.push({ text: sql.slice(first, lastEnd), from: first, to: lastEnd, segmentFrom, segmentTo })
    }
    segmentFrom = segmentTo
    first = -1
    lastEnd = -1
  }

  for (const t of tokenize(sql)) {
    if (t.kind === 'comment') continue
    if (t.kind === 'semicolon') {
      finish(t.to)
      continue
    }
    let from = t.from
    let to = t.to
    if (t.kind === 'code') {
      while (from < to && /\s/.test(sql[from])) from++
      while (to > from && /\s/.test(sql[to - 1])) to--
      if (from === to) continue
    }
    if (first < 0) first = from
    lastEnd = to
  }

  finish(sql.length)
  return out
}

/** The statement the cursor is in, falling back to the closest statement before it. */
export function statementAt(sql: string, offset: number): Statement | null {
  return pickStatement(splitStatements(sql), offset)
}

export function pickStatement(statements: Statement[], offset: number): Statement | null {
  if (statements.length === 0) return null
  let candidate: Statement | null = null
  for (const s of statements) {
    if (offset >= s.segmentFrom && offset <= s.segmentTo) {
      // A cursor right after "select 1;" belongs to that statement, not the next one.
      if (candidate && offset === candidate.segmentTo) return candidate
      return s
    }
    if (s.segmentTo <= offset) candidate = s
  }
  return candidate ?? statements[0]
}

/** First keyword of a statement, upper-cased: SELECT, UPDATE, WITH... */
export function leadingKeyword(text: string): string {
  const match = /^\(*\s*([A-Za-z]+)/.exec(text)
  return match ? match[1].toUpperCase() : ''
}

const READ_ONLY = new Set([
  'SELECT', 'SHOW', 'EXPLAIN', 'VALUES', 'TABLE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'ABORT', 'END',
  'SAVEPOINT', 'RELEASE', 'SET', 'RESET', 'FETCH', 'MOVE', 'CLOSE', 'DECLARE', 'DISCARD', 'LISTEN', 'UNLISTEN'
])

/**
 * Whether a statement only reads. Used to decide when to ask before running on production,
 * so it errs towards "writes": WITH ... UPDATE, SELECT ... INTO and EXPLAIN ANALYZE of a write
 * all count as writes. Functions called from a SELECT can't be seen into.
 */
export function isReadOnly(statement: string): boolean {
  const keyword = leadingKeyword(statement)
  const code = tokenize(statement)
    .filter((t) => t.kind === 'code')
    .map((t) => statement.slice(t.from, t.to))
    .join(' ')
    .toLowerCase()
  const writes = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|call)\b/
  if (keyword === 'WITH') return !writes.test(code)
  if (keyword === 'SELECT') return !/\binto\b/.test(code)
  if (keyword === 'EXPLAIN') return !(/\banaly[sz]e\b/.test(code) && writes.test(code))
  return READ_ONLY.has(keyword)
}

// Reserved words that cannot be used as bare table or column names.
const RESERVED = new Set(
  (
    'all analyse analyze and any array as asc asymmetric authorization binary both case cast check collate ' +
    'collation column concurrently constraint create cross current_catalog current_date current_role ' +
    'current_schema current_time current_timestamp current_user default deferrable desc distinct do else end ' +
    'except false fetch for foreign freeze from full grant group having ilike in initially inner intersect into ' +
    'is isnull join lateral leading left like limit localtime localtimestamp natural not notnull null offset on ' +
    'only or order outer overlaps placing primary references returning right select session_user similar some ' +
    'symmetric system_user table tablesample then to trailing true union unique user using variadic verbose ' +
    'when where window with'
  ).split(' ')
)

export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`
}

export function qualifiedName(schema: string, name: string): string {
  return schema === 'public' ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`
}
