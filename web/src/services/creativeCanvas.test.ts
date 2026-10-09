import { describe, expect, it } from 'vitest'
import { renderCreative, type CreativeSettings } from './creativeCanvas'

function baseSettings(kind: CreativeSettings['kind']): CreativeSettings {
  return {
    kind,
    image: null,
    widthMm: 25,
    heightMm: 25,
    text: 'A\nB',
    font: 'Arial',
    fontMm: 5,
    cellMm: 10,
    gapMm: 5,
    color: '#7c3aed',
    secondColor: '#ec4899',
    thirdColor: '#f59e0b',
    colorMode: 'solid',
    pattern: 'grid',
    polkaShape: 'circle',
    dotMm: 3,
    seed: 1,
    frameShape: 'circle',
    frameFit: 'cover',
    frameZoom: 1,
    offsetX: 0,
    offsetY: 0,
    textEffect: 'none',
  }
}

function fakeCanvas() {
  const calls: string[] = []
  const context = {
    clearRect: () => calls.push('clear'),
    beginPath: () => calls.push('path'),
    ellipse: () => undefined,
    rect: () => undefined,
    roundRect: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    closePath: () => undefined,
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    fillText: () => calls.push('text'),
    strokeText: () => calls.push('outline'),
    measureText: () => ({ width: 20 }),
    save: () => undefined,
    restore: () => undefined,
    clip: () => undefined,
    drawImage: () => undefined,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => undefined,
  } as unknown as CanvasRenderingContext2D
  const canvas = { width: 100, height: 100, getContext: () => context } as unknown as HTMLCanvasElement
  return { canvas, calls }
}

describe('renderCreative', () => {
  it('renders a deterministic grid of polka shapes', () => {
    const { canvas, calls } = fakeCanvas()
    const count = renderCreative(canvas, baseSettings('polka'))

    expect(count).toBe(9)
    expect(calls.filter((call) => call === 'fill')).toHaveLength(9)
  })

  it('renders text grid cells from each input line', () => {
    const { canvas, calls } = fakeCanvas()
    const count = renderCreative(canvas, baseSettings('text'))

    expect(count).toBe(4)
    expect(calls.filter((call) => call === 'text')).toHaveLength(4)
  })
})
