interface Window {
  __picDoInject?: (data: {
    b64: string
    name: string
    mime: string
    template: string
    orderNumber?: string
    imageId?: string
    layoutNumber?: string | null
    numberingDraft?: { prefix: string; value: string }
  }) => Promise<void>
  __picReadOrderNumbering?: () => { orderNumber: string; prefix: string; value: string } | null
  __picHasPendingExport?: () => boolean
  __picAcknowledgeOrderExport?: () => void
  __picSetTemplateCatalog?: (templates: import('./types').TemplateInfo[]) => void
  __picFetchSavedTemplate?: (id: string) => Promise<{
    template: import('./types').TemplateInfo
    layout: unknown
    background: Blob
  }>
  __picOpenTemplate?: (id: string, reset?: boolean) => Promise<void>
  __picCaptureTemplate?: () => import('./types').TemplateDraft
  __picSaveLocalTemplate?: () => void
}
