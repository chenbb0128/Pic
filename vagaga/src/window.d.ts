interface Window {
  __picDoInject?: (data: {
    b64: string
    name: string
    mime: string
    template: string
    orderNumber?: string
    layoutNumber?: string | null
    numberingDraft?: { prefix: string; value: string }
  }) => Promise<void>
  __picReadOrderNumbering?: () => { orderNumber: string; prefix: string; value: string } | null
}
