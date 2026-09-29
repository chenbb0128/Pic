import { describe, expect, it } from 'vitest'
import { copyText, runCopyDownloadStep } from './clipboard'

describe('runCopyDownloadStep', () => {
  it('copies on the first click and only downloads on a later click', async () => {
    const events: string[] = []
    let copied = false

    copied = await runCopyDownloadStep(
      copied,
      async () => { events.push('copied'); return true },
      () => { events.push('downloaded') },
    )

    expect(copied).toBe(true)
    expect(events).toEqual(['copied'])

    copied = await runCopyDownloadStep(
      copied,
      async () => { events.push('copied-again'); return true },
      () => { events.push('downloaded') },
    )

    expect(copied).toBe(true)
    expect(events).toEqual(['copied', 'downloaded'])
  })
})

describe('copyText', () => {
  it('copies with the Clipboard API when it is available', async () => {
    let copied = ''
    let fallbackCalls = 0

    const success = await copyText(
      '下单文案',
      { writeText: async (text) => { copied = text } },
      () => { fallbackCalls += 1; return true },
    )

    expect(success).toBe(true)
    expect(copied).toBe('下单文案')
    expect(fallbackCalls).toBe(0)
  })

  it('uses the manual browser fallback when Clipboard API copying fails', async () => {
    let fallbackText = ''

    const success = await copyText(
      '备用文案',
      { writeText: async () => { throw new Error('permission denied') } },
      (text) => { fallbackText = text; return true },
    )

    expect(success).toBe(true)
    expect(fallbackText).toBe('备用文案')
  })
})
