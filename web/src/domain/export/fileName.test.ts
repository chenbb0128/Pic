import { describe, expect, it } from 'vitest'
import { buildExportFileName, sanitizeFileName } from './fileName'

describe('export file names', () => {
  it('removes characters that are invalid in downloaded file names', () => {
    expect(sanitizeFileName('客户:/A?.png')).toBe('客户__A_')
  })

  it('uses the custom name once and appends png', () => {
    expect(buildExportFileName('订单-01.png', 'mixed', 300, 3461, 2480)).toBe('订单-01.png')
    expect(buildExportFileName('', 'full2', 600, 6921, 4961)).toBe(
      '转印贴_2CM铺满_600dpi_6921x4961_透明.png',
    )
  })
})
