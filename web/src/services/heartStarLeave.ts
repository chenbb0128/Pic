type EditorWindow = Window & { picHeartStar?: { hasUnsavedChanges(): boolean } }

export function heartStarNeedsSave(frame: HTMLIFrameElement | null): boolean {
  try { return !!(frame?.contentWindow as EditorWindow | null)?.picHeartStar?.hasUnsavedChanges() }
  catch { return true } // If the editor is failing, do not silently discard it.
}

export function canLeaveHeartStar(frame: HTMLIFrameElement | null, confirm: (message: string) => boolean): boolean {
  return !heartStarNeedsSave(frame) || confirm('当前排版有未保存的修改或正在保存，离开会丢失未保存内容。确定离开吗？')
}
