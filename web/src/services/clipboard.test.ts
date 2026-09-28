import { describe, expect, it } from 'vitest'
import { copyText, copyThenDownload } from './clipboard'

describe('copyThenDownload', () => {
  it('starts copying before downloading without waiting for the copy to finish', async () => {
    const events: string[] = []
    let finishCopy: (() => void) | undefined

    const result = copyThenDownload(
      () => {
        events.push('copy-started')
        return new Promise<boolean>((resolve) => {
          finishCopy = () => {
            events.push('copy-finished')
            resolve(true)
          }
        })
      },
      () => { events.push('downloaded') },
    )

    expect(events).toEqual(['copy-started', 'downloaded'])

    finishCopy?.()
    await expect(result).resolves.toBe(true)
    expect(events).toEqual(['copy-started', 'downloaded', 'copy-finished'])
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
