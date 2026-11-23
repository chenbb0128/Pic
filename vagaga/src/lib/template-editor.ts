import { assetUrl, getTemplate } from './tauri'
import type { TemplateInfo } from '../types'

export function connectTemplateEditor(frame: Window | null | undefined, catalog: TemplateInfo[], onSave?: () => void) {
  if (!frame) return
  frame.__picFetchSavedTemplate = async id => {
    const saved = await getTemplate(id)
    if (!saved) throw new Error('找不到本机模板，请先同步模板。')
    const response = await fetch(assetUrl(saved.backgroundPath))
    if (!response.ok) throw new Error('无法读取模板底图。')
    return { template: saved.template, layout: saved.layout, background: await response.blob() }
  }
  frame.__picSaveLocalTemplate = onSave
  frame.__picSetTemplateCatalog?.(catalog)
}
