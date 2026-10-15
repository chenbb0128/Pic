import type { PaperSize, Placement } from './layout'
import { PAPER_MARGIN_MM } from './paperBounds'

export interface LockedGroup {
  id: string
  name: string
  itemIds: string[]
  xMm: number
  yMm: number
  widthMm: number
  heightMm: number
  placements: Placement[]
}

export function lockGroup(id: string, name: string, itemIds: string[], placements: Placement[]): LockedGroup | null {
  const selected = placements.filter((placement) => itemIds.includes(placement.itemId))
  if (!selected.length) return null
  const xMm = Math.min(...selected.map((placement) => placement.xMm))
  const yMm = Math.min(...selected.map((placement) => placement.yMm))
  const widthMm = Math.max(...selected.map((placement) => placement.xMm + placement.widthMm)) - xMm
  const heightMm = Math.max(...selected.map((placement) => placement.yMm + placement.heightMm)) - yMm
  return {
    id, name, itemIds: [...itemIds], xMm, yMm, widthMm, heightMm,
    placements: selected.map((placement) => ({ ...placement, xMm: placement.xMm - xMm, yMm: placement.yMm - yMm })),
  }
}

export function flattenGroups(groups: LockedGroup[]): Placement[] {
  return groups.flatMap((group) => group.placements.map((placement) => ({
    ...placement,
    xMm: group.xMm + placement.xMm,
    yMm: group.yMm + placement.yMm,
  })))
}

export function mergeGroups(groups: LockedGroup[], paper: PaperSize, gapXmm: number, gapYmm: number): LockedGroup[] | null {
  let xMm = PAPER_MARGIN_MM
  let yMm = PAPER_MARGIN_MM
  let rowHeight = 0
  const merged: LockedGroup[] = []
  for (const group of groups) {
    if (group.widthMm > paper.widthMm - PAPER_MARGIN_MM * 2 || group.heightMm > paper.heightMm - PAPER_MARGIN_MM * 2) return null
    if (xMm + group.widthMm > paper.widthMm - PAPER_MARGIN_MM) {
      xMm = PAPER_MARGIN_MM
      yMm += rowHeight + gapYmm
      rowHeight = 0
    }
    if (yMm + group.heightMm > paper.heightMm - PAPER_MARGIN_MM) return null
    merged.push({ ...group, xMm, yMm })
    xMm += group.widthMm + gapXmm
    rowHeight = Math.max(rowHeight, group.heightMm)
  }
  return merged
}
