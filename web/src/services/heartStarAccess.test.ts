import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHeartStarAccess, hasHeartStarAccess, rememberHeartStarAccess } from './heartStarAccess'

describe('remembered heart-star access', () => {
  let records: Map<string, string>

  beforeEach(() => {
    records = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { records.set(key, value) },
      removeItem: (key: string) => { records.delete(key) },
    })
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('remembers access across visits for 30 days without storing the password', async () => {
    await rememberHeartStarAccess('87654321')
    expect([...records.values()].join('')).not.toContain('87654321')
    vi.mocked(Date.now).mockReturnValue(1_802_591_999_999)
    expect(await hasHeartStarAccess('87654321')).toBe(true)
  })

  it('expires exactly 30 days after unlocking, not 30 days after the latest visit', async () => {
    await rememberHeartStarAccess('87654321')
    vi.mocked(Date.now).mockReturnValue(1_802_500_000_000)
    expect(await hasHeartStarAccess('87654321')).toBe(true)
    vi.mocked(Date.now).mockReturnValue(1_802_592_000_000)
    expect(await hasHeartStarAccess('87654321')).toBe(false)
  })

  it('invalidates remembered access when the current password changes', async () => {
    await rememberHeartStarAccess('87654321')
    expect(await hasHeartStarAccess('new-password')).toBe(false)
    expect(await hasHeartStarAccess('87654321')).toBe(false)
  })

  it('clears remembered access when explicitly locked', async () => {
    await rememberHeartStarAccess('87654321')
    clearHeartStarAccess()
    expect(await hasHeartStarAccess('87654321')).toBe(false)
  })

  it('treats corrupted records as locked', async () => {
    await rememberHeartStarAccess('87654321')
    const key = [...records.keys()][0]!
    records.set(key, '{broken')
    expect(await hasHeartStarAccess('87654321')).toBe(false)
    records.set(key, JSON.stringify({ expiresAt: 'never', passwordVersion: 'bad' }))
    expect(await hasHeartStarAccess('87654321')).toBe(false)
  })

  it('does not break manual unlocking when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('Storage disabled') },
      setItem() { throw new Error('Storage disabled') },
      removeItem() { throw new Error('Storage disabled') },
    })
    await expect(rememberHeartStarAccess('87654321')).resolves.toBeUndefined()
    expect(await hasHeartStarAccess('87654321')).toBe(false)
    expect(() => clearHeartStarAccess()).not.toThrow()
  })
})
