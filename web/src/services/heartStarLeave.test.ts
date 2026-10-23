import { describe, expect, it } from 'vitest'
import { canLeaveHeartStar, heartStarNeedsSave } from './heartStarLeave'

describe('heart-star parent navigation guard', () => {
  it('asks before losing an edited iframe and honors cancel', () => {
    let calls = 0
    const frame = { contentWindow: { picHeartStar: { hasUnsavedChanges: () => true } } } as any
    expect(heartStarNeedsSave(frame)).toBe(true)
    expect(canLeaveHeartStar(frame, () => { calls++; return false })).toBe(false)
    expect(canLeaveHeartStar(frame, () => { calls++; return true })).toBe(true)
    expect(calls).toBe(2)
  })
  it('does not prompt before the iframe is ready or after it has been saved', () => {
    const frame = { contentWindow: { picHeartStar: { hasUnsavedChanges: () => false } } } as any
    for (const target of [null, frame, { contentWindow: {} } as any]) {
      expect(canLeaveHeartStar(target, () => { throw Error('must not prompt') })).toBe(true)
    }
  })
})
