import type { PaperSize, Placement } from './layout'

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
  let xMm = 0
  let yMm = 0
  let rowHeight = 0
  const merged: LockedGroup[] = []
  for (const group of groups) {
    if (group.widthMm > paper.widthMm || group.heightMm > paper.heightMm) return null
    if (xMm + group.widthMm > paper.widthMm) {
      xMm = 0
      yMm += rowHeight + gapYmm
      rowHeight = 0
    }
    if (yMm + group.heightMm > paper.heightMm) return null
    merged.push({ ...group, xMm, yMm })
    xMm += group.widthMm + gapXmm
    rowHeight = Math.max(rowHeight, group.heightMm)
  }
  return merged
}
