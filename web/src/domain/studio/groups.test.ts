import { describe, expect, it } from 'vitest'
import { flattenGroups, lockGroup, mergeGroups } from './groups'

describe('locked layout groups', () => {
  it('keeps selected placements at their original positions when locking', () => {
    const group = lockGroup('g1', '第一组', ['a'], [
      { itemId: 'a', xMm: 10, yMm: 5, widthMm: 10, heightMm: 10 },
      { itemId: 'a', xMm: 25, yMm: 5, widthMm: 10, heightMm: 10 },
      { itemId: 'b', xMm: 40, yMm: 5, widthMm: 10, heightMm: 10 },
    ])
    expect(group?.widthMm).toBe(25)
    expect(flattenGroups(group ? [group] : []).map(({ itemId, xMm, yMm }) => [itemId, xMm, yMm])).toEqual([
      ['a', 10, 5], ['a', 25, 5],
    ])
  })

  it('moves entire groups without changing positions inside each group', () => {
    const first = lockGroup('g1', '第一组', ['a'], [{ itemId: 'a', xMm: 25, yMm: 5, widthMm: 10, heightMm: 10 }])!
    const second = lockGroup('g2', '第二组', ['b'], [{ itemId: 'b', xMm: 25, yMm: 5, widthMm: 10, heightMm: 10 }])!
    const merged = mergeGroups([first, second], { widthMm: 50, heightMm: 20 }, 5, 5)
    expect(merged && flattenGroups(merged).map(({ itemId, xMm, yMm }) => [itemId, xMm, yMm])).toEqual([
      ['a', 0, 0], ['b', 15, 0],
    ])
  })
})
