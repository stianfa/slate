import { describe, expect, it } from 'vitest'
import { score } from '../src/renderer/src/lib/fuzzy'

describe('score', () => {
  it('matches substrings and scattered letters, preferring tighter matches', () => {
    expect(score('order_items', 'ordit')).not.toBeNull()
    expect(score('users', 'xyz')).toBeNull()
    expect(score('orders', 'orders')!).toBeGreaterThan(score('order_items', 'orders') ?? -1)
    expect(score('order_items', 'items')!).toBeGreaterThan(score('organizations', 'items') ?? -1)
    expect(score('New query', 'nq')!).toBeGreaterThan(0)
  })
})
