/** Fuzzy score: substring matches win, word starts count extra, misses return null. */
export function score(text: string, query: string): number | null {
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 0
  const at = t.indexOf(q)
  if (at >= 0) return 1000 - at * 2 - (t.length - q.length) * 0.1 + (at === 0 || /[\s._/]/.test(t[at - 1]) ? 100 : 0)
  let from = 0
  let last = -2
  let total = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, from)
    if (found < 0) return null
    total += found === last + 1 ? 6 : 1
    if (found === 0 || /[\s._/]/.test(t[found - 1])) total += 4
    last = found
    from = found + 1
  }
  return total
}
