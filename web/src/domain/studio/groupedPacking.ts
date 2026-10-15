import type { LayoutItem, PaperSize, Placement, SmartGrouping } from './layout'
import { PAPER_MARGIN_MM as MARGIN } from './paperBounds'

// Work in inner/outer coordinates so rows and columns share the same rules.
export function arrangeGroupedItems(paper: PaperSize, ordered: LayoutItem[], gapXmm: number, gapYmm: number, reserved: Placement[], grouping: Exclude<SmartGrouping, 'free'>): Placement[] {
  const columns = grouping === 'columns'
  const innerEnd = (columns ? paper.heightMm : paper.widthMm) - MARGIN
  const outerEnd = (columns ? paper.widthMm : paper.heightMm) - MARGIN
  const innerGap = columns ? gapYmm : gapXmm
  const outerGap = columns ? gapXmm : gapYmm
  const locks = reserved.map((slot) => ({
    inner: columns ? slot.yMm : slot.xMm,
    outer: columns ? slot.xMm : slot.yMm,
    innerSize: columns ? slot.heightMm : slot.widthMm,
    outerSize: columns ? slot.widthMm : slot.heightMm,
  }))
  const placements: Placement[] = []
  let nextBand = MARGIN
  for (const item of ordered) {
    const innerSize = columns ? item.heightMm : item.widthMm
    const outerSize = columns ? item.widthMm : item.heightMm
    if (!Number.isFinite(innerSize) || !Number.isFinite(outerSize) || innerSize <= 0 || outerSize <= 0 ||
      innerSize > innerEnd - MARGIN + 1e-7 || outerSize > outerEnd - MARGIN + 1e-7) continue
    let remaining = item.quantity
    let band = nextBand
    while (remaining > 0 && band + outerSize <= outerEnd + 1e-7) {
      const active = locks.filter((lock) => band < lock.outer + lock.outerSize + outerGap - 1e-7 &&
        band + outerSize + outerGap > lock.outer + 1e-7)
      let spans: [number, number][] = [[MARGIN, innerEnd]]
      for (const lock of active) {
        const left = lock.inner - innerGap
        const right = lock.inner + lock.innerSize + innerGap
        spans = spans.flatMap(([start, end]) => {
          if (right <= start || left >= end) return [[start, end]] as [number, number][]
          const pieces: [number, number][] = []
          if (left > start) pieces.push([start, left])
          if (right < end) pieces.push([right, end])
          return pieces
        })
      }
      const before = remaining
      for (const [start, end] of spans) {
        const count = Math.min(remaining, Math.floor((end - start + innerGap + 1e-7) / (innerSize + innerGap)))
        for (let index = 0; index < count; index += 1) {
          const inner = start + index * (innerSize + innerGap)
          placements.push({ itemId: item.id, xMm: columns ? band : inner, yMm: columns ? inner : band, widthMm: item.widthMm, heightMm: item.heightMm })
        }
        remaining -= count
      }
      if (remaining < before) {
        // Never let another material fill this band's partial last row/column.
        nextBand = band + outerSize + outerGap
        band = nextBand
      } else {
        const exits = active.map((lock) => lock.outer + lock.outerSize + outerGap).filter((edge) => edge > band + 1e-7)
        if (!exits.length) break
        band = Math.min(...exits)
      }
    }
  }
  return placements
}
