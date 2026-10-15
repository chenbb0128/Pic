export interface CreativeFont {
  id: string
  label: string
  group: string
  value: string
  family?: string
  file?: string
  latinOnly?: boolean
}

function bundled(id: string, label: string, group: string, family: string, file: string, latinOnly = false): CreativeFont {
  return { id, label, group, family, file, latinOnly, value: `"${family}", sans-serif` }
}

export const creativeFonts: CreativeFont[] = [
  bundled('kuaile', '站酷快乐体', '可爱 / 圆润', 'StickerKuaiLe', 'ZCOOLKuaiLe-Regular.ttf'),
  bundled('huangyou', '站酷庆科黄油体', '可爱 / 圆润', 'StickerHuangYou', 'ZCOOLQingKeHuangYou-Regular.ttf'),
  bundled('marker', '霞鹜漫黑', '可爱 / 圆润', 'StickerMarker', 'LXGWMarkerGothic-Regular.ttf'),
  bundled('wenkai', '霞鹜文楷', '手写 / 文艺', 'StickerWenKai', 'LXGWWenKaiLite-Regular.ttf'),
  bundled('xiaowei', '站酷小薇体', '手写 / 文艺', 'StickerXiaoWei', 'ZCOOLXiaoWei-Regular.ttf'),
  bundled('mashan', '马善政楷书', '毛笔 / 草书', 'StickerMaShan', 'MaShanZheng-Regular.ttf'),
  bundled('longcang', '龙藏体', '毛笔 / 草书', 'StickerLongCang', 'LongCang-Regular.ttf'),
  bundled('liujian', '刘建毛草', '毛笔 / 草书', 'StickerLiuJian', 'LiuJianMaoCao-Regular.ttf'),
  bundled('zhimang', '志莽行书', '毛笔 / 草书', 'StickerZhiMang', 'ZhiMangXing-Regular.ttf'),
  bundled('patrick', 'Patrick Hand · 清新手写（仅英文）', '英文 / 花体', 'StickerPatrick', 'PatrickHand-Regular.ttf', true),
  bundled('caveat', 'Caveat · 随性手写（仅英文）', '英文 / 花体', 'StickerCaveat', 'Caveat.ttf', true),
  bundled('pacifico', 'Pacifico · 复古花体（仅英文）', '英文 / 花体', 'StickerPacifico', 'Pacifico-Regular.ttf', true),
  { id: 'sans', label: '系统无衬线', group: '系统字体', value: 'Arial, sans-serif' },
  { id: 'serif', label: '系统衬线', group: '系统字体', value: 'Georgia, serif' },
  { id: 'cursive', label: '系统手写', group: '系统字体', value: 'cursive' },
  { id: 'mono', label: '系统等宽', group: '系统字体', value: 'monospace' },
]

export const creativeFontGroups = [...new Set(creativeFonts.map(font => font.group))]
  .map(label => ({ label, fonts: creativeFonts.filter(font => font.group === label) }))

export function creativeFontCss(font: string, sizePx: number): string {
  return `${creativeFonts.find(option => option.value === font)?.file ? 400 : 700} ${sizePx}px ${font}`
}

const fontLoads = new Map<string, Promise<void>>()

export function ensureCreativeFont(font: string): Promise<void> {
  const option = creativeFonts.find(item => item.value === font)
  if (!option?.file || !option.family) return Promise.resolve()
  const cached = fontLoads.get(font)
  if (cached) return cached
  const loading = (async () => {
    if (typeof FontFace === 'undefined' || !document.fonts) throw new Error('浏览器不支持网页字体')
    const face = new FontFace(option.family!, `url("${import.meta.env.BASE_URL}fonts/${option.file}")`, { weight: '400', style: 'normal' })
    const loaded = await face.load()
    document.fonts.add(loaded)
  })().catch(() => {
    fontLoads.delete(font)
    throw new Error(`“${option.label}”字体加载失败，请检查网络后重试，或切换系统字体。`)
  })
  fontLoads.set(font, loading)
  return loading
}
